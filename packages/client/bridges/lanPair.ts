import { LanBox, PakePhone, lanPairingUrl, toHex, type LanAnnouncement, type LanFrame, type LanMachine, type LanSealed, type PairingDevice } from "@jaira/shared/browser";

/**
 * The phone's half of pairing over the local network (decision 0013, amended 2026-10-04; the machine's
 * half is `packages/service/src/lanPairing.ts`, the exchange `@jaira/shared`'s `lanPairing.ts`).
 *
 * 1. Connect to the machine the person picked from the list, at each address it announced, and keep
 *    the first that says it is that machine.
 * 2. Prove the code without sending it. A wrong code stops here, before the phone says anything about
 *    itself.
 * 3. Sealed from here on: say who the phone is, and get the token and the engine's tailnet address.
 * 4. Join the tailnet (Tailscale built into the app). Its sign-in page goes to the machine, which opens
 *    it in the person's browser; approving it there lets the phone on.
 *
 * Nothing of a platform is imported: the socket is the platform's own `WebSocket`, randomness and the
 * tailnet are handed in. Node's `WebSocket` runs it in the tests.
 */

/** What the person sees happen. */
export type LanStep =
  /** Reaching the machine on the local network. */
  | "reaching"
  /** Proving the code. */
  | "proving"
  /** Paired; joining the tailnet. */
  | "joining"
  /** The sign-in page is open on the machine: waiting for the person to approve it there. */
  | "approve";

/** The phone's way onto the tailnet, as pairing needs it. */
export interface TailnetJoin {
  /**
   * Join, or settle at once when already on. `onLogin` hears the sign-in page whenever the tailnet
   * asks for one.
   */
  join(onLogin: (url: string) => void): Promise<void>;
}

/** One of the machine's addresses being tried, for the screen to say. */
export interface LanAttempt {
  /** `192.168.1.32:47319`. */
  address: string;
  state: "trying" | "answered" | "failed";
  /** Why it failed. */
  reason?: string;
}

export interface LanPaired {
  /** The engine on the tailnet: `https://desk.tail4c2e.ts.net`. */
  address: string;
  token: string;
  machine: LanMachine;
}

export interface PairNearbyOptions {
  machine: LanAnnouncement;
  code: string;
  device: PairingDevice & { kind: "phone" };
  random: (bytes: number) => Uint8Array;
  /** Joining the tailnet; absent, pairing ends with the token (a phone without Tailscale built in). */
  tailnet?: TailnetJoin;
  /** The token, as soon as it is issued: kept before the tailnet is joined, which can take minutes. */
  onPaired: (paired: LanPaired) => Promise<void> | void;
  onStep?: (step: LanStep) => void;
  /** Each address tried while reaching the machine, as it goes. */
  onAttempt?: (attempt: LanAttempt) => void;
  /** How long reaching and proving may take. */
  timeoutMs?: number;
}

/** A failure that names what to do: the person reads `message` as it is. */
export class LanPairError extends Error {}

/** One message at a time off a socket, in order. */
class Inbox {
  private readonly queue: string[] = [];
  private waiting: { resolve: (text: string) => void; reject: (e: Error) => void } | undefined;
  private ended: Error | undefined;

  constructor(socket: WebSocket) {
    socket.onmessage = (event) => {
      const text = String(event.data);
      if (this.waiting !== undefined) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(text);
      } else this.queue.push(text);
    };
    const end = (): void => {
      this.ended ??= new LanPairError("the machine closed the connection");
      this.waiting?.reject(this.ended);
      this.waiting = undefined;
    };
    socket.onclose = end;
    socket.onerror = end;
  }

  next(timeoutMs: number, what: string): Promise<LanFrame> {
    const queued = this.queue.shift();
    const parse = (text: string): LanFrame => {
      try {
        return JSON.parse(text) as LanFrame;
      } catch {
        throw new LanPairError("that is not a JaiRA machine");
      }
    };
    if (queued !== undefined) return Promise.resolve(parse(queued));
    if (this.ended !== undefined) return Promise.reject(this.ended);
    return new Promise<LanFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new LanPairError(`the machine did not answer ${what}`));
      }, timeoutMs);
      this.waiting = {
        resolve: (text) => {
          clearTimeout(timer);
          try {
            resolve(parse(text));
          } catch (e) {
            reject(e as Error);
          }
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }
}

/** The first of the machine's addresses that answers as that machine, with its greeting. */
async function reach(machine: LanAnnouncement, timeoutMs: number, onAttempt?: (attempt: LanAttempt) => void): Promise<{ socket: WebSocket; inbox: Inbox; hi: LanFrame & { t: "hi" } }> {
  const tries = machine.addresses.map(async (host) => {
    const address = `${host}:${machine.port}`;
    onAttempt?.({ address, state: "trying" });
    const socket = new WebSocket(lanPairingUrl(host, machine.port));
    const inbox = new Inbox(socket);
    try {
      const hi = await inbox.next(timeoutMs, "on the local network");
      // A typed address (no id yet) takes whichever machine answers there; the code proves which.
      if (hi.t !== "hi" || typeof hi.sid !== "string" || (machine.id !== "" && hi.machine?.id !== machine.id)) throw new LanPairError("another machine answered");
      onAttempt?.({ address, state: "answered" });
      return { socket, inbox, hi };
    } catch (e) {
      onAttempt?.({ address, state: "failed", reason: (e as Error).message === "the machine closed the connection" ? "nothing answers there" : (e as Error).message });
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      throw e;
    }
  });
  const won = await first(tries);
  // The others, should they answer later, are not needed.
  void Promise.allSettled(tries).then((all) => {
    for (const t of all) if (t.status === "fulfilled" && t.value.socket !== won?.socket) t.value.socket.close();
  });
  if (won === undefined) throw new LanPairError(`could not reach ${machine.label} on this network: is the phone on the same Wi-Fi, and is ${machine.label} still showing its code?`);
  return won;
}

/** The first promise to fulfil, or undefined when all reject (`Promise.any`, which not every engine has). */
function first<T>(promises: Promise<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    let left = promises.length;
    if (left === 0) resolve(undefined);
    for (const p of promises) {
      p.then(resolve, () => {
        left -= 1;
        if (left === 0) resolve(undefined);
      });
    }
  });
}

/** Pair with a machine found nearby, by the code it shows; then join its tailnet. */
export async function pairNearby(options: PairNearbyOptions): Promise<LanPaired> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  options.onStep?.("reaching");
  const { socket, inbox, hi } = await reach(options.machine, timeoutMs, options.onAttempt);
  const label = hi.machine?.label ?? options.machine.label;
  const close = (): void => {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  };
  const refusal = (frame: LanFrame): string | undefined => (frame.t === "refused" ? frame.reason : undefined);
  try {
    options.onStep?.("proving");
    const phone = new PakePhone(options.code, hi, options.random(64));
    socket.send(JSON.stringify({ t: "pake", y: phone.share } satisfies LanFrame));
    const answer = await inbox.next(timeoutMs, "the code");
    if (answer.t !== "pake") throw new LanPairError(refusal(answer) ?? `${label} did not take part in the pairing`);
    let keys: ReturnType<PakePhone["finish"]>;
    try {
      keys = phone.finish(answer);
    } catch {
      throw new LanPairError(`that is not the code ${label} shows`);
    }
    const box = LanBox.forPhone(keys);
    socket.send(JSON.stringify({ t: "confirm", mac: toHex(keys.phoneMac) } satisfies LanFrame));
    const send = (message: LanSealed): void => socket.send(JSON.stringify(box.seal(message)));
    const receive = async (what: string): Promise<LanSealed> => {
      const frame = await inbox.next(timeoutMs, what);
      if (frame.t === "refused") throw new LanPairError(frame.reason);
      if (frame.t !== "box") throw new LanPairError(`${label} broke off the pairing`);
      const message = box.open(frame);
      if (message.t === "refused") throw new LanPairError(message.reason);
      return message;
    };

    send({ t: "device", device: options.device });
    const paired = await receive("with a token");
    if (paired.t !== "paired" || typeof paired.token !== "string" || typeof paired.address !== "string") throw new LanPairError(`${label} did not pair`);
    const result: LanPaired = { address: paired.address, token: paired.token, machine: { id: paired.machine.id, label: paired.machine.label, os: paired.machine.os } };
    await options.onPaired(result);

    if (options.tailnet !== undefined) {
      options.onStep?.("joining");
      await options.tailnet.join((url) => {
        options.onStep?.("approve");
        try {
          send({ t: "login", url });
        } catch {
          // The connection is gone: the phone offers the page itself (Remote's fallback).
        }
      });
    }
    try {
      send({ t: "done" });
    } catch {
      // Already closed.
    }
    return result;
  } finally {
    close();
  }
}
