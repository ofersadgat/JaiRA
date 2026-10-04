/**
 * The machine's half of pairing a phone over the local network (decision 0013, amended 2026-10-04).
 *
 * While a pairing code is shown — and only then — this machine listens on its local-network addresses
 * on a port of its own and announces itself there as `_jaira._tcp` (Bonjour, mDNS), so a phone on the
 * same network lists it. The engine is not on this listener: it answers one WebSocket path, `/pair`,
 * which speaks the code exchange in `@jaira/shared`'s `lanPairing.ts` and nothing else. A connection
 * that has not proved the code can do nothing but spend one of the code's five tries.
 *
 * Once a phone proves the code, the code is spent: the announcement stops and no new connection is
 * taken. The phone's own connection stays open while it joins the tailnet, so it can hand over its
 * Tailscale sign-in page, which this machine opens where the person is (`openLogin`).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import {
  LAN_PAIRING_PATH,
  LAN_PAIRING_VERSION,
  LAN_SERVICE_TYPE,
  LanBox,
  announcementTxt,
  isTailscaleLogin,
  pakeMachine,
  phoneProofHolds,
  toHex,
  type LanFrame,
  type LanKeys,
  type LanMachine,
  type LanSealed,
} from "@jaira/shared";
import { acceptWebSocket, type WsConnection } from "./wsServer";

/** How a pairing machine is announced — Bonjour, or a stand-in in tests. */
export interface AnnouncePort {
  /** Announce; the returned function stops it. */
  publish(service: { name: string; type: string; port: number; txt: Record<string, string> }): Promise<() => Promise<void>>;
}

/** What the listener asks of the fleet. */
export interface LanPairingHost {
  identity(): LanMachine;
  /**
   * One try at the code shown now: the code, with a try spent, or why there is none (no code, expired,
   * tried too often).
   */
  tryCode(): { code: string } | { refused: string };
  /** The code was proved: it is spent. */
  spendCode(): void;
  /** A device that proved the code: its token and where the engine is, or why not. */
  pairDevice(device: unknown): { token: string; machine: LanMachine; address: string } | { refused: string };
  /** A phone's Tailscale sign-in page, opened where the person is. */
  openLogin(url: string, phone: string): void;
  /** A phone's progress, for Settings → Machines: undefined when it is finished or gone. */
  phoneChanged(phone: PhoneJoin | undefined): void;
  log?(level: "info" | "warn", message: string): void;
}

/** A phone joining through this machine, after it proved the code. */
export interface PhoneJoin {
  label: string;
  /** Its Tailscale sign-in page, opened in the browser: approving it there lets the phone onto the tailnet. */
  signInUrl?: string;
}

/** The largest frame a stranger may send: shares and proofs are a few hundred bytes. */
const MAX_FRAME_BYTES = 16 * 1024;
/** How long one phone's connection may take, sign-in included. */
const SESSION_MS = 10 * 60 * 1000;
/** How long a connection may take to prove the code. */
const PROVE_MS = 60 * 1000;

/**
 * This machine's addresses on the local network, the likeliest first: private IPv4 (home networks'
 * 192.168 before 10 and 172.16), no loopback, link-local, or tailnet (100.64/10) address.
 */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      const [p, q] = a.address.split(".").map(Number) as [number, number];
      if (p === 169 && q === 254) continue;
      if (p === 100 && q >= 64 && q < 128) continue;
      found.push(a.address);
    }
  }
  const rank = (address: string): number => (address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3);
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b));
}

/** Bonjour through `bonjour-service`: pure JavaScript, and a responder of its own beside the system's. */
export const bonjourAnnounce: AnnouncePort = {
  async publish(service) {
    const { Bonjour } = await import("bonjour-service");
    const bonjour = new Bonjour({}, () => undefined);
    const published = bonjour.publish({ name: service.name, type: service.type, port: service.port, txt: service.txt, probe: false });
    return () =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          bonjour.destroy();
          resolve();
        };
        try {
          published.stop?.(done);
        } catch {
          done();
        }
        setTimeout(done, 1000).unref?.();
      });
  },
};

export class LanPairing {
  private server: Server | undefined;
  private port: number | undefined;
  private unannounce: (() => Promise<void>) | undefined;
  private readonly sessions = new Set<WsConnection>();
  private readonly sockets = new Set<Duplex>();
  private starting: Promise<void> | undefined;

  constructor(
    private readonly host: LanPairingHost,
    private readonly announce: AnnouncePort = bonjourAnnounce,
    /** Tests: loopback only, so no firewall asks about the test runner. */
    private readonly bindHost?: string,
  ) {}

  /** Where it listens and is announced, while it is. */
  listening(): { port: number } | undefined {
    return this.port !== undefined ? { port: this.port } : undefined;
  }

  /** Listen and announce, for the code just shown. Doing it again re-announces: the name or addresses may have changed. */
  start(): Promise<void> {
    this.starting = (this.starting ?? Promise.resolve()).then(() => this.open()).catch((e: Error) => this.host.log?.("warn", `phones on this network cannot find this machine: ${e.message}`));
    return this.starting;
  }

  private async open(): Promise<void> {
    if (this.server === undefined) {
      const server = createServer((_request, response) => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not here\n");
      });
      server.on("upgrade", (request, socket, head) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        if (request.url !== LAN_PAIRING_PATH) {
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          return;
        }
        const connection = acceptWebSocket(request, socket, head, { maxMessageBytes: MAX_FRAME_BYTES, pingMs: 15_000 });
        if (connection !== undefined) this.session(connection);
      });
      this.port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        // Every interface: a phone on the Wi-Fi comes in on the machine's network address. Only `/pair` answers.
        const listening = (): void => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        };
        if (this.bindHost !== undefined) server.listen(0, this.bindHost, listening);
        else server.listen(0, listening);
      });
      this.server = server;
      this.host.log?.("info", `listening for a phone to pair on port ${this.port} of this machine's local network`);
    }
    await this.unannounce?.().catch(() => undefined);
    this.unannounce = undefined;
    const me = this.host.identity();
    const addresses = lanAddresses();
    if (addresses.length === 0) {
      this.host.log?.("warn", "this machine has no local-network address, so no phone can find it");
      return;
    }
    this.unannounce = await this.announce.publish({
      // Unique on the network even beside another machine of the same name; the phone shows the TXT label.
      name: `${me.label.slice(0, 50)} (${me.id.slice(-4)})`,
      type: LAN_SERVICE_TYPE,
      port: this.port!,
      txt: announcementTxt({ id: me.id, label: me.label, os: me.os, port: this.port!, addresses, v: LAN_PAIRING_VERSION }),
    });
  }

  /**
   * No code any more: stop announcing and taking connections. A phone that proved the code keeps its
   * connection until it is done; `everything` ends those too (the engine is closing).
   */
  async stop(everything = false): Promise<void> {
    await this.starting;
    const unannounce = this.unannounce;
    this.unannounce = undefined;
    await unannounce?.().catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (everything) {
      for (const session of this.sessions) session.destroy();
      for (const socket of this.sockets) socket.destroy();
    }
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private session(connection: WsConnection): void {
    this.sessions.add(connection);
    const sid = new Uint8Array(randomBytes(16));
    const me = this.host.identity();
    let step: "pake" | "confirm" | "sealed" = "pake";
    let keys: LanKeys | undefined;
    let box: LanBox | undefined;
    let phone: string | undefined;
    const send = (frame: LanFrame): void => connection.send(JSON.stringify(frame));
    const seal = (message: LanSealed): void => send(box!.seal(message));
    const refuse = (reason: string): void => {
      if (box !== undefined) seal({ t: "refused", reason });
      else send({ t: "refused", reason });
      connection.close(1000, "refused");
    };
    const prove = setTimeout(() => {
      if (step !== "sealed") refuse("the code was not proved in time");
    }, PROVE_MS);
    const whole = setTimeout(() => connection.close(1000, "too long"), SESSION_MS);
    prove.unref?.();
    whole.unref?.();
    connection.onClose(() => {
      clearTimeout(prove);
      clearTimeout(whole);
      this.sessions.delete(connection);
      if (phone !== undefined) this.host.phoneChanged(undefined);
    });

    send({ t: "hi", v: LAN_PAIRING_VERSION, sid: toHex(sid), machine: { id: me.id, label: me.label, os: me.os } });
    connection.onMessage((text) => {
      let frame: LanFrame;
      try {
        frame = JSON.parse(text) as LanFrame;
      } catch {
        return refuse("that is not a pairing frame");
      }
      try {
        if (step === "pake") {
          if (frame.t !== "pake" || typeof frame.y !== "string") return refuse("a pairing starts with the phone's share");
          const tried = this.host.tryCode();
          if ("refused" in tried) return refuse(tried.refused);
          const answer = pakeMachine(tried.code, sid, me.id, frame.y, new Uint8Array(randomBytes(64)));
          keys = answer.keys;
          step = "confirm";
          return send({ t: "pake", y: answer.share, mac: toHex(answer.keys.machineMac) });
        }
        if (step === "confirm") {
          if (frame.t !== "confirm" || typeof frame.mac !== "string" || !phoneProofHolds(keys!, frame.mac)) return refuse("that is not the code shown on this machine");
          clearTimeout(prove);
          this.host.spendCode();
          box = LanBox.forMachine(keys!);
          step = "sealed";
          return;
        }
        if (frame.t !== "box") return refuse("after the code, everything is sealed");
        const message = box!.open(frame);
        switch (message.t) {
          case "device": {
            const paired = this.host.pairDevice({ ...message.device, kind: "phone" });
            if ("refused" in paired) return refuse(paired.refused);
            phone = typeof message.device?.label === "string" ? message.device.label.slice(0, 80) : "A phone";
            this.host.phoneChanged({ label: phone });
            return seal({ t: "paired", machine: paired.machine, token: paired.token, address: paired.address });
          }
          case "login": {
            if (phone === undefined) return refuse("say which device first");
            if (typeof message.url !== "string" || !isTailscaleLogin(message.url)) return refuse("only a Tailscale sign-in page is opened");
            this.host.phoneChanged({ label: phone, signInUrl: message.url });
            this.host.openLogin(message.url, phone);
            return seal({ t: "opened" });
          }
          case "done":
            connection.close(1000, "done");
            return;
          default:
            return refuse("not a frame this machine takes");
        }
      } catch (e) {
        return refuse(step === "sealed" ? "a sealed frame did not open" : `the pairing failed: ${(e as Error).message}`);
      }
    });
  }
}
