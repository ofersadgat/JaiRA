/**
 * The fleet (decision 0013 §1–§3): this machine, the machines it is paired with, and the connections
 * between them.
 *
 * - **The tailnet** (decision 0022). This machine signs in to Tailscale once (`tailnet.ts`): that makes it
 *   reachable, and shows every device on the tailnet, each asked whether JaiRA runs there.
 * - **Pairing, once per machine.** Pair on one machine asks the other to show a one-time code; the person
 *   types it on the first, which sends it with a token it issued for the other, and gets one issued for
 *   itself back. Both remember each other.
 * - **Introductions.** The paired machine's own fleet comes back with the answer. For each member it
 *   does not know yet, the newcomer asks the machine it paired with to introduce it. That machine, already
 *   trusted by the member, carries the newcomer's token over and the member's token back. So pairing with
 *   any one member joins the whole fleet (ruling 11).
 * - **Links.** An engine keeps a connection to every machine it knows, retrying with growing waits. An
 *   offline machine stays listed.
 * - **Phones** (amended 2026-09-30). A phone pairs with a code and runs no engine: it is issued a token
 *   and listed, and that is all. It is not among {@link Fleet.peers}, so nothing links to it, copies from
 *   it or places a task on it.
 * - **Phones nearby** (amended 2026-10-04). While Pair a phone shows a code, this machine also announces
 *   itself on the local network (`lanPairing.ts`), so a phone on the same Wi-Fi lists it and pairs by
 *   typing the code — proved by a code exchange, never sent — then joins the tailnet with Tailscale built
 *   in, its sign-in page opened here.
 */
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PAIRING_CODE_MS, engineUrlOf, machineFormOf, normalizePairingCode, type DeviceView, type MachineForm, type MachineOsTag, type MachinesView, type PairingDevice, type PeerView, type CopyChoice, type TailnetDeviceView, type TailnetJaira, type TailnetView } from "@jaira/shared";
import { askOnce, connectEngine, type EngineClient } from "./engineClient";
import type { EngineHost, PreAuthHandler } from "./engineHost";
import type { HostFrame, PeerMachine } from "./enginePipe";
import type { Handler } from "./handlers";
import { machineIdentity, updateMachineIdentity, type MachineIdentity } from "./machine";
import { LanPairing, type AnnouncePort, type LanActivity, type LanPairingHost, type PhoneJoin } from "./lanPairing";
import { MachineTokens, type TokenHolder } from "./machineTokens";
import { consoleUrlOf, defaultTailnet, type TailnetEvent, type TailnetPeer, type TailnetPort } from "./tailnet";

/** A paired machine, as this one remembers it. */
interface KnownMachine extends PeerMachine {
  addedAt: number;
  lastSeenAt?: number;
  version?: string;
}

interface FleetFile {
  machines: KnownMachine[];
  /** This machine is signed in to the tailnet (decision 0022 §3): wanted, and kept across restarts. */
  reachable?: boolean;
  /** Where it was last published, for the others to find it again. */
  url?: string;
  /** What it was on the tailnet, kept while signed out: still registered as this. */
  tailnet?: { node?: string; tailnet?: string; user?: string; consoleUrl?: string; removing?: boolean };
}

/** Where tokens this machine HOLDS for others are kept: the keychain, or a 0600 file where there is none. */
export interface SecretsPort {
  available(): boolean;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
}

export interface FleetOptions {
  baseDir: string;
  version: string;
  secrets?: SecretsPort;
  publish?: (view: MachinesView) => void;
  /** `raised`: the Settings item the entry is also shown as, so the log does not count it again. */
  log?: (level: "info" | "warn" | "error", message: string, raised?: string) => void;
  /** Tailscale went down (an error among Settings', {@link TAILNET_HEALTH}), or is back (`undefined`). */
  health?: (down: { detail: string; fix: string; reconnect: boolean } | undefined) => void;
  /** Which Tailscale (`tailnet.ts`); absent ⇒ the one this machine has — a seam for tests. */
  tailnet?: TailnetPort;
  /**
   * What this machine keeps a copy of when the person has not said (decision 0013 §6): a window's engine
   * what is not archived, a `jaira serve` with no window nothing (ruling 7).
   */
  copyByDefault?: CopyChoice["mode"];
  /** Tests: how long the first retry waits. */
  retryMs?: number;
  /** Tests: how long the first try to come back onto the tailnet waits, after Tailscale went down. */
  tailnetRetryMs?: number;
  /** Open a page where the person is: a phone's Tailscale sign-in page. */
  openPage?: (url: string) => void;
  /** How a pairing machine is announced to phones nearby; `false` announces nothing (tests). */
  announce?: AnnouncePort | false;
  /** Tests: where the pairing listener binds — loopback, so no firewall asks. */
  lanBindHost?: string;
}

const WORDS = [
  "amber", "anchor", "apple", "arrow", "aspen", "badge", "basil", "beacon", "birch", "bison", "blaze", "bloom", "brook", "cabin", "canal", "cedar",
  "cider", "cliff", "cloud", "clover", "comet", "coral", "crane", "creek", "delta", "dune", "eagle", "ember", "fern", "field", "flint", "forest",
  "frost", "garden", "glade", "grove", "harbor", "hazel", "heron", "island", "ivory", "jade", "juniper", "kettle", "lagoon", "lantern", "lark", "lemon",
  "linen", "lotus", "maple", "marsh", "meadow", "mint", "moss", "nectar", "oasis", "olive", "orchid", "otter", "pebble", "pine", "plum", "quartz",
  "raven", "reef", "ridge", "river", "robin", "saddle", "sage", "shore", "slate", "spruce", "stone", "summit", "thistle", "tide", "timber", "valley",
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_CODE_ATTEMPTS = 5;
/** How many times a minute other devices may ask this machine to show a code. */
const MAX_ASKS_PER_MINUTE = 6;
/** How long a device that was refused is refused again without asking the person. */
const REFUSED_MS = 60_000;
/** How long one probe of a device waits for `/.well-known/jaira`. */
const PROBE_MS = 4000;
/** Settings' item while Tailscale is down, and the log entries that say so. */
export const TAILNET_HEALTH = "tailnet";
/** After Tailscale went down, how long the first try to come back waits, and the longest any waits. */
const TAILNET_RETRY_MS = 15_000;
const TAILNET_RETRY_MAX_MS = 10 * 60_000;

const secretName = (machineId: string): string => `jaira.machine.${machineId}`;

export class Fleet {
  private readonly tokens: MachineTokens;
  private readonly links = new Map<string, { client?: EngineClient; state: PeerView["state"]; reason?: string; timer?: ReturnType<typeof setTimeout>; wait: number }>();
  private readonly peerPushListeners = new Set<(machineId: string, message: unknown) => void>();
  private readonly peerStateListeners = new Set<(machineId: string, online: boolean) => void>();
  /** The code shown under Pair a phone, for a phone nearby to prove. */
  private pairing: { code: string; expiresAt: number; attempts: number } | undefined;
  /** Phones on the local network, while a code is shown (`lanPairing.ts`). */
  private lan: LanPairing | undefined;
  private lanExpiry: ReturnType<typeof setTimeout> | undefined;
  /** A phone that proved the code and is joining the tailnet. */
  private phone: PhoneJoin | undefined;
  /** What phones did on the pairing listener lately, for Settings to say. */
  private lanLog: LanActivity[] = [];
  /** The code this machine shows because another asked (the pop-up's). */
  private asked: { code: string; expiresAt: number; attempts: number; by: NonNullable<MachinesView["asked"]>["by"]; byId: string } | undefined;
  private readonly askTimes: number[] = [];
  private readonly refused = new Map<string, number>();
  /** This machine asked a device to show a code, and waits for it to be typed here. */
  private asking: { device: string; url: string; expiresAt: number } | undefined;
  private tailnetState: TailnetView = { state: "off" };
  private tailnetPort: TailnetPort | undefined;
  private tailnetRunning = false;
  /** Coming back after Tailscale went down: the next try, and how long the one after it waits. */
  private tailnetRetry: { timer?: ReturnType<typeof setTimeout>; wait?: number; reason?: string } = {};
  private peersSeen: TailnetPeer[] = [];
  private readonly probes = new Map<string, { at: number; jaira?: TailnetJaira; none?: true }>();
  private readonly probing = new Set<string>();
  private checkedAt: number | undefined;
  private loopbackPort: number | undefined;
  private host: EngineHost | undefined;
  private stopped = false;

  constructor(private readonly options: FleetOptions) {
    this.tokens = new MachineTokens(options.baseDir);
  }

  // --- files --------------------------------------------------------------------------------------------

  private file(): string {
    return join(this.options.baseDir, "system", "fleet.json");
  }

  private read(): FleetFile {
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as Partial<FleetFile>;
      return {
        machines: Array.isArray(raw.machines) ? raw.machines : [],
        ...(raw.reachable === true ? { reachable: true } : {}),
        ...(typeof raw.url === "string" ? { url: raw.url } : {}),
        ...(typeof raw.tailnet === "object" && raw.tailnet !== null ? { tailnet: raw.tailnet } : {}),
      };
    } catch {
      return { machines: [] };
    }
  }

  private write(file: FleetFile): void {
    const path = this.file();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }

  private tokensFile(): string {
    return join(this.options.baseDir, "system", "fleet-tokens.json");
  }

  private heldToken(machineId: string): string | undefined {
    const secrets = this.options.secrets;
    if (secrets?.available() === true) return secrets.get(secretName(machineId));
    try {
      return (JSON.parse(readFileSync(this.tokensFile(), "utf8")) as Record<string, string>)[machineId];
    } catch {
      return undefined;
    }
  }

  private holdToken(machineId: string, token: string | undefined): void {
    const secrets = this.options.secrets;
    if (secrets?.available() === true) {
      if (token === undefined) secrets.remove(secretName(machineId));
      else secrets.set(secretName(machineId), token);
      return;
    }
    let all: Record<string, string> = {};
    try {
      all = JSON.parse(readFileSync(this.tokensFile(), "utf8")) as Record<string, string>;
    } catch {
      // first one
    }
    if (token === undefined) delete all[machineId];
    else all[machineId] = token;
    mkdirSync(dirname(this.tokensFile()), { recursive: true });
    writeFileSync(`${this.tokensFile()}.tmp`, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${this.tokensFile()}.tmp`, this.tokensFile());
  }

  // --- who is who ---------------------------------------------------------------------------------------

  identity(): MachineIdentity {
    return machineIdentity(this.options.baseDir);
  }

  /** This machine as others remember it. */
  selfPeer(): PeerMachine {
    const me = this.identity();
    const url = this.tailnetState.state === "on" && this.tailnetState.url !== undefined ? engineUrlOf(this.tailnetState.url) : this.read().url;
    return { id: me.id, label: me.label, os: me.os, form: me.form, tags: me.tags, ...(url !== undefined ? { url } : {}) };
  }

  private known(): KnownMachine[] {
    return this.read().machines;
  }

  private remember(machine: PeerMachine, patch: Partial<KnownMachine> = {}): void {
    if (machine.id === this.identity().id) return;
    const file = this.read();
    const before = file.machines.find((m) => m.id === machine.id);
    const next: KnownMachine = { ...(before ?? { addedAt: Date.now() }), ...machine, ...patch } as KnownMachine;
    file.machines = [...file.machines.filter((m) => m.id !== machine.id), next];
    this.write(file);
  }

  view(): MachinesView {
    const me = this.identity();
    const issued = new Set(this.tokens.list().map((t) => t.machineId));
    const machines: PeerView[] = this.known().map((m) => {
      const link = this.links.get(m.id);
      return {
        id: m.id,
        label: m.label,
        os: m.os,
        form: machineFormOf(m.form),
        tags: m.tags,
        ...(m.url !== undefined ? { url: m.url } : {}),
        state: link?.state ?? "offline",
        ...(m.version !== undefined ? { version: m.version } : {}),
        ...(m.lastSeenAt !== undefined ? { lastSeenAt: m.lastSeenAt } : {}),
        ...(link?.reason !== undefined ? { reason: link.reason } : {}),
        canReachHere: issued.has(m.id),
      };
    });
    const now = Date.now();
    const nearby = this.lan?.listening();
    const pairing = this.pairing !== undefined && this.pairing.expiresAt > now ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt, ...(nearby !== undefined ? { nearby } : {}) } : undefined;
    // What phones did lately: ten minutes is long enough to read what went wrong.
    const nearbyLog = this.lanLog.filter((e) => e.at > now - 10 * 60_000);
    const asked = this.asked !== undefined && this.asked.expiresAt > now ? { by: this.asked.by, code: this.asked.code, expiresAt: this.asked.expiresAt } : undefined;
    const asking = this.asking !== undefined && this.asking.expiresAt > now ? { device: this.asking.device, expiresAt: this.asking.expiresAt } : undefined;
    const port = this.loopbackPort;
    return {
      self: { id: me.id, label: me.label, os: me.os, form: me.form, tags: me.tags, tailnet: this.tailnetState, version: this.options.version, copy: this.copying(), ...(port !== undefined ? { port } : {}) },
      machines,
      devices: this.devices(),
      tailnetDevices: this.tailnetState.state === "on" || this.tailnetState.state === "removing" ? this.tailnetDevices() : [],
      ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(asking !== undefined ? { asking } : {}),
      ...(asked !== undefined ? { asked } : {}),
      ...(pairing !== undefined ? { pairing } : {}),
      ...(this.phone !== undefined ? { phone: this.phone } : {}),
      ...(nearbyLog.length > 0 ? { nearbyLog } : {}),
    };
  }

  /** The phones holding a token for this machine, and which of them are connected now. */
  private devices(): DeviceView[] {
    const live = new Set((this.host?.connected() ?? []).flatMap((client) => (client.device !== undefined ? [client.device.id] : [])));
    return this.tokens.list().flatMap((t) =>
      t.device === undefined
        ? []
        : [{ id: t.machineId, label: t.label, kind: t.device, pairedAt: t.issuedAt, ...(t.lastUsedAt !== undefined ? { lastUsedAt: t.lastUsedAt } : {}), connected: live.has(t.machineId) }],
    );
  }

  /** A client connected or went: a device's row says whether it is there. */
  clientsChanged(): void {
    if (!this.stopped) this.changed();
  }

  /** What this machine keeps a copy of: the person's choice, else the host's default. */
  copying(): CopyChoice {
    return this.identity().copy ?? { mode: this.options.copyByDefault ?? "nothing" };
  }

  /** Whether it keeps a copy of anything. */
  replicating(): boolean {
    return this.copying().mode !== "nothing";
  }

  /** Choose what to keep a copy of. */
  setCopy(choice: CopyChoice): MachinesView {
    const modes: ReadonlyArray<CopyChoice["mode"]> = ["everything", "not-archived", "chosen", "nothing"];
    if (!modes.includes(choice.mode)) throw new Error(`'${String(choice.mode)}' is not a choice of what to copy`);
    const copy: CopyChoice = choice.mode === "chosen" ? { mode: "chosen", projects: [...new Set(choice.projects ?? [])] } : { mode: choice.mode };
    updateMachineIdentity(this.options.baseDir, { copy });
    this.changed();
    return this.view();
  }

  private changed(): void {
    this.options.publish?.(this.view());
  }

  /** Tell every connected machine who this one is now: a new name, tags or address. */
  private announce(): void {
    const me = this.selfPeer();
    for (const link of this.links.values()) void link.client?.invoke("fleet:update", { machine: me }).catch(() => undefined);
  }

  rename(label: string): MachinesView {
    updateMachineIdentity(this.options.baseDir, { label });
    this.announce();
    this.changed();
    return this.view();
  }

  setTags(tags: string[]): MachinesView {
    updateMachineIdentity(this.options.baseDir, { tags });
    this.announce();
    this.changed();
    return this.view();
  }

  /** Say what this machine is — its icon, here and on every machine that knows it. */
  setForm(form: MachineForm): MachinesView {
    updateMachineIdentity(this.options.baseDir, { form });
    this.announce();
    this.changed();
    return this.view();
  }

  // --- the tailnet --------------------------------------------------------------------------------------

  private port(): TailnetPort {
    this.tailnetPort ??= this.options.tailnet ?? defaultTailnet(this.options.baseDir, () => this.identity().label);
    return this.tailnetPort;
  }

  /** What the Tailscale row says while signed out or never signed in: the registration kept, or the name to come. */
  private offState(reason?: string): TailnetView {
    const kept = this.read().tailnet;
    const node = kept?.node ?? this.port().nodeName();
    return {
      state: "off",
      via: this.port().via,
      ...(node !== undefined ? { node } : {}),
      ...(kept?.tailnet !== undefined ? { tailnet: kept.tailnet } : {}),
      ...(kept?.user !== undefined ? { user: kept.user } : {}),
      ...(kept?.consoleUrl !== undefined ? { consoleUrl: kept.consoleUrl } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private setTailnet(next: TailnetView): void {
    this.tailnetState = next;
    this.changed();
  }

  /** Come onto the tailnet when this machine wants to be on it, or leave it. */
  private async applyTailnet(): Promise<void> {
    const file = this.read();
    const port = this.port();
    const why = await port.unavailable().catch((e: unknown) => ({ reason: (e as Error).message }) as { reason: string; home?: string });
    if (why !== undefined) {
      // Wanted, and on the tailnet before: Tailscale went away (the app stopped, the helper is gone).
      if (why.home === undefined && this.wasOn(file)) return this.down(why.reason);
      this.setTailnet({ state: "unavailable", via: port.via, reason: why.reason, ...(why.home !== undefined ? { home: why.home } : {}) });
      return;
    }
    if (file.reachable !== true) {
      if (this.tailnetRunning && this.loopbackPort !== undefined) await port.stop(this.loopbackPort).catch(() => undefined);
      this.tailnetRunning = false;
      this.backUp();
      this.setTailnet(this.offState());
      return;
    }
    if (this.loopbackPort === undefined) {
      this.setTailnet({ state: "unavailable", via: port.via, reason: "this engine does not listen for other machines (a jaira command's engine never does)" });
      return;
    }
    if (this.tailnetRunning) return;
    this.tailnetRunning = true;
    this.setTailnet({ ...this.offState(), state: "signing-in" });
    try {
      await port.start(this.loopbackPort, (event) => this.heard(event));
    } catch (e) {
      this.tailnetRunning = false;
      if (this.wasOn(file)) return this.down((e as Error).message);
      this.setTailnet({ state: "unavailable", via: port.via, reason: (e as Error).message });
      this.options.log?.("warn", `this machine could not sign in to Tailscale: ${(e as Error).message}`);
    }
  }

  /** This machine wants to be on the tailnet, and has been on it: its registration is kept. */
  private wasOn(file: FleetFile): boolean {
    return file.reachable === true && file.tailnet?.node !== undefined;
  }

  /**
   * Tailscale went down while this machine wants to be on it: an error in the log and among Settings'
   * (the person, 2026-10-26: "if tailscale goes down, then that should be an error that surfaces both
   * through the logs and the error badge system"), said once per outage. Paired machines and phones
   * cannot reach this one meanwhile, and nobody may be at it to press anything, so JaiRA tries again by
   * itself, waiting longer each time.
   */
  private down(reason: string): void {
    // A try that fails as the last one did is not news: the tries in between pass through signing in.
    const before = this.tailnetRetry.reason;
    this.tailnetRetry.reason = reason;
    this.tailnetRunning = false;
    if (this.loopbackPort !== undefined) void this.port().stop(this.loopbackPort).catch(() => undefined);
    this.setTailnet({ ...this.offState(), state: "down", reason });
    if (before !== reason) {
      const node = this.tailnetState.node ?? "this machine";
      // One error per outage; a later try that fails another way says so, and Settings says the latest.
      if (before === undefined) this.options.log?.("error", `Tailscale went down: ${node} is off your tailnet, so your other machines and phones cannot reach it (${reason})`, TAILNET_HEALTH);
      else this.options.log?.("warn", `Tailscale is still down: ${reason}`, TAILNET_HEALTH);
      this.options.health?.({ detail: `${node} is off your tailnet: ${reason}`, fix: "JaiRA tries again by itself; Reconnect tries now", reconnect: true });
    }
    if (this.tailnetRetry.timer !== undefined || this.stopped) return;
    const wait = this.tailnetRetry.wait ?? this.options.tailnetRetryMs ?? TAILNET_RETRY_MS;
    this.tailnetRetry.wait = Math.min(wait * 2, TAILNET_RETRY_MAX_MS);
    this.tailnetRetry.timer = setTimeout(() => {
      this.tailnetRetry.timer = undefined;
      void this.applyTailnet();
    }, wait);
    this.tailnetRetry.timer.unref?.();
  }

  /** On the tailnet again, or no longer wanted there: nothing is down. */
  private backUp(): void {
    if (this.tailnetRetry.timer !== undefined) clearTimeout(this.tailnetRetry.timer);
    this.tailnetRetry = {};
    this.options.health?.(undefined);
  }

  /** What the Tailscale port said. */
  private heard(event: TailnetEvent): void {
    if (this.stopped) return;
    const via = this.port().via;
    switch (event.kind) {
      case "sign-in":
        this.setTailnet({ ...this.offState(), state: "signing-in", signInUrl: event.url });
        return;
      case "running": {
        const consoleUrl = consoleUrlOf(event.self.ips);
        const file = this.read();
        const removing = file.tailnet?.removing === true;
        this.write({
          ...file,
          ...(event.url !== undefined ? { url: engineUrlOf(event.url) } : {}),
          tailnet: { node: event.self.name, ...(event.tailnet !== undefined ? { tailnet: event.tailnet } : {}), ...(event.user !== undefined ? { user: event.user } : {}), ...(consoleUrl !== undefined ? { consoleUrl } : {}), ...(removing ? { removing } : {}) },
        });
        this.setTailnet({
          state: removing ? "removing" : "on",
          via,
          node: event.self.name,
          ...(event.user !== undefined ? { user: event.user } : {}),
          ...(event.tailnet !== undefined ? { tailnet: event.tailnet } : {}),
          ...(event.url !== undefined ? { url: event.url } : {}),
          ...(consoleUrl !== undefined ? { consoleUrl } : {}),
        });
        if (event.url !== undefined) this.options.log?.("info", `signed in to Tailscale as ${event.user ?? "?"}: this machine is reachable from your other machines at ${event.url}`);
        this.backUp();
        this.announce();
        for (const machine of this.known()) this.link(machine.id);
        return;
      }
      case "dropped": {
        const file = this.read();
        this.tailnetRunning = false;
        // The Tailscale app disconnected: it comes back by itself, and so does JaiRA's serve with it.
        if (via === "tailscale" && file.reachable === true) return this.down("the Tailscale app is not connected");
        if (file.tailnet?.removing === true) {
          // Removed in the admin console, as asked: this machine's identity on the tailnet goes too.
          this.port().forget();
          this.write({ ...file, reachable: undefined, tailnet: undefined } as FleetFile);
          this.peersSeen = [];
          this.probes.clear();
          this.options.log?.("info", "Tailscale removed this machine, so JaiRA forgot its registration");
          this.setTailnet(this.offState());
          return;
        }
        void this.port().stop(this.loopbackPort ?? 0).catch(() => undefined);
        this.write({ ...file, reachable: undefined } as FleetFile);
        // Off the tailnet until the person signs in again: an error too, with nothing to try again.
        const node = file.tailnet?.node ?? "this machine";
        this.options.log?.("error", `Tailscale signed ${node} out: its key expired, or it was removed in the admin console`, TAILNET_HEALTH);
        this.options.health?.({ detail: `Tailscale signed ${node} out: its key expired, or it was removed in the admin console`, fix: "Sign in to Tailscale again", reconnect: false });
        this.setTailnet(this.offState("Tailscale signed this machine out: its key expired, or it was removed in the admin console"));
        return;
      }
      case "devices":
        this.devicesHeard(event.devices);
        return;
      case "error":
        this.options.log?.("warn", `Tailscale: ${event.message}`);
        if (this.tailnetState.state === "signing-in") this.setTailnet({ ...this.tailnetState, reason: event.message });
        return;
      case "stopped":
        this.tailnetRunning = false;
        if (this.wasOn(this.read())) return this.down(event.reason);
        this.options.log?.("warn", event.reason);
        this.setTailnet({ state: "unavailable", via, reason: event.reason });
        return;
    }
  }

  /** Sign in to Tailscale: this machine is on the tailnet, and reachable from the machines paired with it. Kept across restarts. */
  async signIn(): Promise<MachinesView> {
    const file = this.read();
    this.write({ ...file, reachable: true });
    if (this.tailnetRunning && this.tailnetState.state === "signing-in") this.port().login();
    else await this.applyTailnet();
    return this.view();
  }

  /** Sign out, keeping the registration: signing in again, as anyone, is this same device on the tailnet. */
  async signOut(): Promise<MachinesView> {
    const port = this.port();
    if (port.via === "tailscale") throw new Error("this computer signs in and out of Tailscale in the Tailscale app");
    const file = this.read();
    this.write({ ...file, reachable: undefined, ...(file.tailnet !== undefined ? { tailnet: { ...file.tailnet, removing: undefined } } : {}) } as FleetFile);
    // Still signing in, there is nothing to sign out of: stopping is the Cancel.
    if (this.tailnetRunning && this.tailnetState.state === "signing-in") await port.stop(this.loopbackPort ?? 0);
    else if (this.tailnetRunning) await port.logout();
    this.tailnetRunning = false;
    this.backUp();
    this.peersSeen = [];
    this.probes.clear();
    this.options.log?.("info", "signed out of Tailscale");
    this.setTailnet(this.offState());
    return this.view();
  }

  /**
   * Remove this machine from the tailnet. Only the admin console (or Tailscale's API) can delete a device,
   * so the row shows this device's page there; signed in, the helper stays on until Tailscale drops it,
   * and then its identity is deleted. Signed out, nothing can see it go: the identity is deleted now.
   */
  async remove(): Promise<MachinesView> {
    const port = this.port();
    if (port.via === "tailscale") throw new Error("this computer is removed from the tailnet in the Tailscale app or the admin console");
    const file = this.read();
    if (this.tailnetRunning && this.tailnetState.state === "on") {
      this.write({ ...file, tailnet: { ...file.tailnet, removing: true } });
      this.setTailnet({ ...this.tailnetState, state: "removing" });
      this.options.log?.("info", "waiting for Tailscale to remove this machine (remove it in the admin console)");
      return this.view();
    }
    const consoleUrl = file.tailnet?.consoleUrl;
    if (this.tailnetRunning) await port.stop(this.loopbackPort ?? 0).catch(() => undefined);
    this.tailnetRunning = false;
    port.forget();
    this.backUp();
    this.write({ ...file, reachable: undefined, tailnet: undefined } as FleetFile);
    this.options.log?.("info", "forgot this machine's Tailscale registration");
    this.setTailnet({ ...this.offState(), ...(consoleUrl !== undefined ? { consoleUrl } : {}) });
    return this.view();
  }

  /** Stop waiting for Tailscale to remove this machine. */
  removeCancel(): MachinesView {
    const file = this.read();
    if (file.tailnet !== undefined) this.write({ ...file, tailnet: { ...file.tailnet, removing: undefined } } as FleetFile);
    if (this.tailnetState.state === "removing") this.setTailnet({ ...this.tailnetState, state: "on" });
    return this.view();
  }

  /** Ask every device on the tailnet again whether JaiRA runs there. */
  refresh(): MachinesView {
    this.probes.clear();
    this.port().devices();
    void this.probeAll(this.peersSeen);
    return this.view();
  }

  private devicesHeard(devices: TailnetPeer[]): void {
    const before = new Map(this.peersSeen.map((p) => [p.id, p]));
    this.peersSeen = devices;
    for (const device of devices) {
      // One that came online is asked again: JaiRA may have started there.
      if (device.online && before.get(device.id)?.online === false) this.probes.delete(device.id);
    }
    this.changed();
    void this.probeAll(devices);
  }

  private async probeAll(devices: readonly TailnetPeer[]): Promise<void> {
    const asked = devices.filter((d) => d.online && !this.probes.has(d.id) && !this.probing.has(d.id));
    if (asked.length === 0) {
      // Nothing left to ask (no device online, or each asked already): the list is as checked as it gets.
      if (this.probing.size === 0) this.checkedAt = Date.now();
      return;
    }
    await Promise.all(asked.map((d) => this.probe(d)));
    this.checkedAt = Date.now();
    this.changed();
  }

  /** Ask one device whether JaiRA runs there: `/.well-known/jaira`, in the places Tailscale may serve it. */
  private async probe(device: TailnetPeer): Promise<void> {
    this.probing.add(device.id);
    const bases = device.addresses ?? [`https://${device.dnsName}`, `http://${device.dnsName}`, `https://${device.dnsName}:8443`, `https://${device.dnsName}:10000`];
    try {
      const answers = await Promise.all(bases.map((base) => this.wellKnownAt(base).then((found) => ({ base, found }), () => undefined)));
      const hit = answers.find((a) => a !== undefined);
      this.probes.set(device.id, hit === undefined ? { at: Date.now(), none: true } : { at: Date.now(), jaira: { ...hit.found, url: hit.base } });
    } finally {
      this.probing.delete(device.id);
    }
  }

  /** What answers at `base`'s `/.well-known/jaira`, through the tailnet. */
  private async wellKnownAt(base: string): Promise<Omit<TailnetJaira, "url">> {
    const reach = await this.port().door(base);
    const response = await fetch(`${reach}/.well-known/jaira`, { signal: AbortSignal.timeout(PROBE_MS) });
    const body = (await response.json()) as { jaira?: boolean; machineId?: string; label?: string; os?: string; form?: string; version?: string; device?: { id?: string; label?: string; kind?: string } };
    if (body.jaira !== true) throw new Error("not JaiRA");
    const os = (["windows", "mac", "linux", "android", "ios"] as const).find((o) => o === body.os);
    if (typeof body.machineId === "string") {
      return { kind: "machine", id: body.machineId, label: String(body.label ?? body.machineId).slice(0, 80), version: String(body.version ?? "?"), ...(os !== undefined ? { os } : {}), form: machineFormOf(body.form) };
    }
    if (body.device !== undefined && typeof body.device.id === "string" && body.device.kind === "phone") {
      return { kind: "phone", id: body.device.id, label: String(body.device.label ?? "A phone").slice(0, 80), version: String(body.version ?? "?"), ...(os !== undefined ? { os } : {}) };
    }
    throw new Error("not JaiRA");
  }

  /** The tailnet's devices, as the list shows them. */
  private tailnetDevices(): TailnetDeviceView[] {
    const node = this.tailnetState.node;
    const older = node !== undefined ? new RegExp(`^${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`, "i") : undefined;
    return this.peersSeen.map((d) => {
      const probe = this.probes.get(d.id);
      const consoleUrl = consoleUrlOf(d.ips);
      return {
        id: d.id,
        name: d.name,
        dnsName: d.dnsName,
        os: d.os,
        online: d.online,
        ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
        ...(probe?.jaira !== undefined ? { jaira: probe.jaira } : {}),
        ...(probe?.none === true ? { noJaira: true } : {}),
        ...(older !== undefined && !d.online && (older.test(d.name) || older.test(d.dnsName.split(".")[0] ?? "")) ? { olderSelf: true } : {}),
        ...(consoleUrl !== undefined ? { consoleUrl } : {}),
      };
    });
  }

  /**
   * An engine URL (`wss://host/engine`) as this process can reach it: itself where the OS routes to the
   * tailnet, or through the door the helper opened to its host.
   */
  private async reachable(engineUrl: string): Promise<string> {
    const parts = /^(wss?):\/\/([^/]+)(\/.*)?$/.exec(engineUrl);
    if (parts === null) return engineUrl;
    const base = `${parts[1] === "wss" ? "https" : "http"}://${parts[2]}`;
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(parts[2]!)) return engineUrl;
    const door = await this.port().door(base);
    if (door === base) return engineUrl;
    return `${door.replace(/^http/, "ws")}${parts[3] ?? "/engine"}`;
  }

  // --- pairing, the shown side ------------------------------------------------------------------------

  private newCode(): string {
    const words = [WORDS[randomInt(WORDS.length)]!, WORDS[randomInt(WORDS.length)]!].map((w) => w.toUpperCase());
    let tail = "";
    for (let i = 0; i < 4; i += 1) tail += CODE_CHARS[randomInt(CODE_CHARS.length)];
    return `${words[0]} · ${words[1]} · ${tail}`;
  }

  /** Refuse the code another machine or a phone asked this one to show. */
  refuse(): MachinesView {
    if (this.asked !== undefined) {
      this.refused.set(this.asked.byId, Date.now());
      this.options.log?.("info", `refused to pair with ${this.asked.by.label}`);
    }
    this.asked = undefined;
    this.changed();
    return this.view();
  }

  /** Pair a phone: a new code, replacing any shown before, and this machine announced to phones nearby. */
  pairingCode(): MachinesView {
    this.pairing = { code: this.newCode(), expiresAt: Date.now() + PAIRING_CODE_MS, attempts: 0 };
    this.lanLog = [];
    this.announceNearby();
    this.changed();
    return this.view();
  }

  cancelPairing(): MachinesView {
    this.endPairing();
    this.changed();
    return this.view();
  }

  /** The code is spent, stopped or expired: phones nearby no longer find this machine. */
  private endPairing(): void {
    this.pairing = undefined;
    if (this.lanExpiry !== undefined) clearTimeout(this.lanExpiry);
    this.lanExpiry = undefined;
    void this.lan?.stop().then(() => this.changed());
  }

  /** While the code is shown: announced on the local network, until it expires. */
  private announceNearby(): void {
    if (this.options.announce === false || this.host === undefined || this.stopped) return;
    this.lan ??= new LanPairing(this.lanHost(), this.options.announce, this.options.lanBindHost);
    void this.lan.start().then(() => this.changed());
    if (this.lanExpiry !== undefined) clearTimeout(this.lanExpiry);
    this.lanExpiry = setTimeout(() => {
      if (this.pairing === undefined || this.pairing.expiresAt <= Date.now()) this.endPairing();
      this.changed();
    }, PAIRING_CODE_MS + 1000);
    this.lanExpiry.unref?.();
  }

  /** What the local-network listener asks of this fleet. */
  private lanHost(): LanPairingHost {
    return {
      identity: () => {
        const me = this.identity();
        return { id: me.id, label: me.label, os: me.os };
      },
      tryCode: () => {
        const pairing = this.pairing;
        if (pairing === undefined || pairing.expiresAt <= Date.now()) return { refused: "no pairing code is being shown on that machine, or it expired: show a new one" };
        // Spent before the proof, not after a wrong one: the machine's answer tells a guesser whether it
        // guessed right, so every exchange is a guess.
        pairing.attempts += 1;
        if (pairing.attempts >= MAX_CODE_ATTEMPTS) this.endPairing();
        this.changed();
        return { code: pairing.code };
      },
      spendCode: () => {
        this.endPairing();
        this.changed();
      },
      pairDevice: (asked) => {
        const address = this.tailnetState.state === "on" ? this.tailnetState.url : undefined;
        if (address === undefined) return { refused: "that machine is not on the tailnet: sign in to Tailscale in its Settings → Machines" };
        const answer = this.pairDevice(asked);
        if (answer.t !== "paired") return { refused: answer.t === "refused" ? answer.reason : "that machine did not pair" };
        return { token: answer.token, machine: { id: answer.machine.id, label: answer.machine.label, os: answer.machine.os }, address };
      },
      openLogin: (url, phone) => {
        this.options.log?.("info", `opened the Tailscale sign-in page for ${phone}: approving it lets the phone onto your tailnet`);
        this.options.openPage?.(url);
      },
      phoneChanged: (phone) => {
        this.phone = phone;
        this.changed();
      },
      activity: (event) => {
        this.lanLog = [...this.lanLog, event].slice(-8);
        this.changed();
      },
      log: (level, message) => this.options.log?.(level, message),
    };
  }

  /**
   * A frame before any hello (`EngineHost` hands it here): asked to show a code, told to stop, or the
   * code — the one shown because this device asked, or the one Pair a phone shows.
   */
  readonly preAuth: PreAuthHandler = async (frame) => {
    const refused = (reason: string): HostFrame => ({ t: "refused", reason });
    if (frame.t === "pair-ask") return this.heardAsk(frame);
    if (frame.t === "pair-cancel") {
      if (this.asked !== undefined && this.asked.byId === String(frame["id"])) {
        this.asked = undefined;
        this.changed();
      }
      return { t: "ok" };
    }
    if (frame.t !== "pair") return undefined;
    const me = this.identity().label;
    const askerId = frame["device"] !== undefined ? String((frame["device"] as { id?: unknown }).id) : String((frame["machine"] as { id?: unknown } | undefined)?.id);
    const refusedAt = this.refused.get(askerId);
    if (refusedAt !== undefined && Date.now() - refusedAt < REFUSED_MS) return refused(`pairing was refused on ${me}`);
    const now = Date.now();
    const asked = this.asked !== undefined && this.asked.expiresAt > now ? this.asked : undefined;
    const shown = this.pairing !== undefined && this.pairing.expiresAt > now ? this.pairing : undefined;
    if (asked === undefined && shown === undefined) return refused(`no code is showing on ${me}, or it ran out: press Pair again`);
    const typed = normalizePairingCode(String(frame["code"]));
    const spend =
      asked !== undefined && normalizePairingCode(asked.code) === typed
        ? () => void (this.asked = undefined)
        : shown !== undefined && normalizePairingCode(shown.code) === typed
          ? () => this.endPairing()
          : undefined;
    if (spend === undefined) {
      if (asked !== undefined && (asked.attempts += 1) >= MAX_CODE_ATTEMPTS) this.asked = undefined;
      if (shown !== undefined && (shown.attempts += 1) >= MAX_CODE_ATTEMPTS) this.endPairing();
      this.changed();
      return refused(`that is not the code showing on ${me}`);
    }
    if (frame["device"] !== undefined) return this.pairDevice(frame["device"], spend);
    const machine = frame["machine"] as PeerMachine | undefined;
    const token = frame["token"];
    if (machine === undefined || typeof machine.id !== "string" || typeof token !== "string") return refused("a pairing needs the asking machine and its token");
    if (machine.id === this.identity().id) return refused("a machine cannot pair with itself");
    spend();
    this.remember(sanitizePeer(machine));
    this.holdToken(machine.id, token);
    const issued = this.tokens.issue(machine.id, machine.label);
    this.options.log?.("info", `paired with ${machine.label}`);
    this.link(machine.id);
    this.changed();
    return { t: "paired", machine: this.selfPeer(), token: issued, fleet: this.known().map(peerOf) };
  };

  /** Pair was pressed for this machine elsewhere: show a code (the pop-up), and say until when. */
  private heardAsk(frame: Record<string, unknown>): HostFrame {
    const now = Date.now();
    while (this.askTimes.length > 0 && now - this.askTimes[0]! > 60_000) this.askTimes.shift();
    if (this.askTimes.length >= MAX_ASKS_PER_MINUTE) return { t: "refused", reason: "too many asks to pair in the last minute: wait a moment" };
    let by: NonNullable<MachinesView["asked"]>["by"];
    let byId: string;
    if (frame["device"] !== undefined) {
      const device = sanitizeDevice(frame["device"]);
      if (device === undefined) return { t: "refused", reason: "a phone's ask needs its id and its name" };
      const os = frame["os"] === "android" || frame["os"] === "ios" ? frame["os"] : undefined;
      by = { label: device.label, kind: "phone", ...(os !== undefined ? { os } : {}) };
      byId = device.id;
    } else {
      const raw = frame["machine"] as PeerMachine | undefined;
      if (raw === undefined || typeof raw.id !== "string") return { t: "refused", reason: "an ask to pair needs the asking machine" };
      const machine = sanitizePeer(raw);
      if (machine.id === this.identity().id) return { t: "refused", reason: "a machine cannot pair with itself" };
      by = { label: machine.label, kind: "machine", os: machine.os as MachineOsTag, ...(machine.form !== undefined ? { form: machine.form } : {}) };
      byId = machine.id;
    }
    const refusedAt = this.refused.get(byId);
    if (refusedAt !== undefined && now - refusedAt < REFUSED_MS) return { t: "refused", reason: `pairing was refused on ${this.identity().label}` };
    this.askTimes.push(now);
    const expiresAt = now + PAIRING_CODE_MS;
    this.asked = { code: this.newCode(), expiresAt, attempts: 0, by, byId };
    // The log is where a `jaira serve` with no window shows it.
    this.options.log?.("info", `${by.label} asked to pair with this machine: the code is ${this.asked.code}`);
    this.changed();
    return { t: "asked", expiresAt };
  }

  /**
   * A phone with the right code: issued a token, and remembered only as its holder. No token comes with
   * it and none is held for it — this machine never connects to a phone.
   */
  private pairDevice(asked: unknown, spend: () => void = () => this.endPairing()): HostFrame {
    const device = sanitizeDevice(asked);
    if (device === undefined) return { t: "refused", reason: "a phone's pairing needs its id and its name" };
    // An id that is a machine's would take that machine's token away with it.
    const machines = new Set([this.identity().id, ...this.known().map((m) => m.id), ...this.tokens.list().flatMap((t) => (t.device === undefined ? [t.machineId] : []))]);
    if (machines.has(device.id)) return { t: "refused", reason: "that id is a machine's, not a phone's" };
    spend();
    const issued = this.tokens.issue(device.id, device.label, device.kind);
    this.options.log?.("info", `paired with ${device.label}, a ${device.kind}`);
    this.changed();
    return { t: "paired", machine: this.selfPeer(), token: issued, fleet: [] };
  }

  // --- pairing, the typing side -----------------------------------------------------------------------

  /** A device on the tailnet where a JaiRA machine answered. */
  private jairaOn(deviceId: string): TailnetJaira {
    const jaira = this.probes.get(deviceId)?.jaira;
    if (jaira === undefined) throw new Error("JaiRA was not found on that device: start it there, then Refresh");
    return jaira;
  }

  /** Pair was pressed for a device: ask it to show a code, which the person then types here. */
  async pairAsk(deviceId: string): Promise<MachinesView> {
    const jaira = this.jairaOn(deviceId);
    const answer = await this.askAt(jaira.url);
    this.asking = { device: deviceId, url: jaira.url, expiresAt: answer.expiresAt };
    this.changed();
    return this.view();
  }

  /** The code the person typed, for the device asked. */
  async pair(deviceId: string, code: string): Promise<MachinesView> {
    const jaira = this.jairaOn(deviceId);
    await this.pairAt(jaira.url, code);
    this.asking = undefined;
    this.changed();
    return this.view();
  }

  /** Give up on the device asked: it stops showing its code. */
  async pairCancel(): Promise<MachinesView> {
    const asking = this.asking;
    this.asking = undefined;
    this.changed();
    if (asking !== undefined) {
      await this.reachable(engineUrlOf(asking.url))
        .then((url) => askOnce({ url }, { t: "pair-cancel", id: this.identity().id }, 5000))
        .catch(() => undefined);
    }
    return this.view();
  }

  /** Ask the machine at `address` to show a code. */
  async askAt(address: string): Promise<{ expiresAt: number }> {
    const url = await this.reachable(engineUrlOf(address));
    let answer: HostFrame;
    try {
      answer = await askOnce({ url }, { t: "pair-ask", machine: this.selfPeer() }, 15_000);
    } catch (e) {
      throw new Error(`could not reach ${address}: ${(e as Error).message}`);
    }
    if (answer.t !== "asked") throw new Error(answer.t === "refused" ? answer.reason : "that machine showed no code");
    return { expiresAt: answer.expiresAt };
  }

  /** Pair with the machine at `address` using the code it shows, then meet the rest of its fleet. */
  async pairAt(address: string, code: string): Promise<MachinesView> {
    const remembered = engineUrlOf(address);
    const url = await this.reachable(remembered);
    const them = await wellKnown(url);
    if (them.machineId === this.identity().id) throw new Error("that address is this machine");
    const forThem = this.tokens.issue(them.machineId, them.label);
    let answer: HostFrame;
    try {
      answer = await askOnce({ url }, { t: "pair", code, machine: this.selfPeer(), token: forThem }, 15_000);
    } catch (e) {
      this.tokens.revoke(them.machineId);
      throw new Error(`could not reach ${address}: ${(e as Error).message}`);
    }
    if (answer.t !== "paired") {
      this.tokens.revoke(them.machineId);
      throw new Error(answer.t === "refused" ? answer.reason : "that machine did not pair");
    }
    this.remember(sanitizePeer({ ...answer.machine, url: answer.machine.url ?? remembered }));
    this.holdToken(answer.machine.id, answer.token);
    this.options.log?.("info", `paired with ${answer.machine.label}`);
    this.link(answer.machine.id);
    this.changed();
    await this.meetFleetOf(answer.machine.id, answer.fleet);
    return this.view();
  }

  /** Ask `via` to introduce this machine to each member of its fleet this one does not know. */
  private async meetFleetOf(via: string, fleet: PeerMachine[]): Promise<void> {
    const me = this.identity().id;
    const known = new Set(this.known().map((m) => m.id));
    const client = await this.connected(via);
    if (client === undefined) return;
    for (const member of fleet) {
      if (member.id === me || known.has(member.id)) continue;
      const token = this.tokens.issue(member.id, member.label);
      try {
        const back = (await client.invoke("fleet:introduce", { to: member.id, machine: this.selfPeer(), token })) as { machine: PeerMachine; token: string };
        this.remember(sanitizePeer(back.machine));
        this.holdToken(back.machine.id, back.token);
        this.link(back.machine.id);
        this.options.log?.("info", `met ${back.machine.label} through ${this.known().find((m) => m.id === via)?.label ?? via}`);
      } catch (e) {
        // Offline now: met at the next connection to `via`, which asks again.
        this.tokens.revoke(member.id);
        this.options.log?.("info", `could not meet ${member.label} yet: ${(e as Error).message}`);
      }
    }
    this.changed();
  }

  /**
   * Forget a machine here and across the fleet: its tokens no longer open anything anywhere. A device is
   * forgotten here alone, where its one token is: revoked, and its connection dropped.
   */
  async forget(machineId: string): Promise<MachinesView> {
    const device = this.tokens.list().find((t) => t.machineId === machineId && t.device !== undefined);
    if (device !== undefined) {
      this.tokens.revoke(machineId);
      this.host?.dropMachine(machineId);
      this.options.log?.("info", `forgot ${device.label}`);
      this.changed();
      return this.view();
    }
    const target = this.known().find((m) => m.id === machineId);
    for (const [id, link] of this.links) if (id !== machineId) await link.client?.invoke("fleet:forget", { id: machineId }).catch(() => undefined);
    await this.links.get(machineId)?.client?.invoke("fleet:forget", { id: this.identity().id }).catch(() => undefined);
    this.drop(machineId);
    if (target !== undefined) this.options.log?.("info", `forgot ${target.label}`);
    this.changed();
    return this.view();
  }

  private drop(machineId: string): void {
    const link = this.links.get(machineId);
    if (link?.timer !== undefined) clearTimeout(link.timer);
    link?.client?.close();
    this.links.delete(machineId);
    this.tokens.revoke(machineId);
    this.host?.dropMachine(machineId);
    this.holdToken(machineId, undefined);
    const file = this.read();
    this.write({ ...file, machines: file.machines.filter((m) => m.id !== machineId) });
  }

  // --- what paired machines ask of this one -------------------------------------------------------------

  /** The `fleet:*` channels, answered for one paired machine's connection. */
  handlersFor(caller: { id: string; label: string }): Record<string, Handler> {
    return {
      "fleet:list": (() => this.known().map(peerOf)) as Handler,
      "fleet:update": ((request: { machine: PeerMachine }) => {
        if (request.machine?.id !== caller.id) throw new Error("a machine may only update itself");
        this.remember(sanitizePeer(request.machine));
        this.tokens.rename(caller.id, request.machine.label);
        this.changed();
        return null;
      }) as Handler,
      "fleet:introduce": (async (request: { to: string; machine: PeerMachine; token: string }) => {
        if (request.machine?.id !== caller.id) throw new Error("a machine may only introduce itself");
        const client = await this.connected(request.to);
        if (client === undefined) throw new Error(`${this.known().find((m) => m.id === request.to)?.label ?? request.to} is offline`);
        return client.invoke("fleet:meet", { machine: request.machine, token: request.token });
      }) as Handler,
      "fleet:meet": ((request: { machine: PeerMachine; token: string }) => {
        if (request.machine.id === this.identity().id) throw new Error("that is this machine");
        this.remember(sanitizePeer(request.machine));
        this.holdToken(request.machine.id, request.token);
        const issued = this.tokens.issue(request.machine.id, request.machine.label);
        this.options.log?.("info", `${caller.label} introduced ${request.machine.label}`);
        this.link(request.machine.id);
        this.changed();
        return { machine: this.selfPeer(), token: issued };
      }) as Handler,
      "fleet:forget": ((request: { id: string }) => {
        const forgotten = request.id === this.identity().id ? caller.id : request.id;
        this.drop(forgotten);
        this.changed();
        return null;
      }) as Handler,
    };
  }

  // --- links ------------------------------------------------------------------------------------------

  /** Hear what a paired machine's engine publishes: its runs and records (replication, decision 0013 §6). */
  onPeerPush(listener: (machineId: string, message: unknown) => void): () => void {
    this.peerPushListeners.add(listener);
    return () => this.peerPushListeners.delete(listener);
  }

  /** Hear a machine come online or go away: what federation refreshes and delivers on. */
  onPeerState(listener: (machineId: string, online: boolean) => void): () => void {
    this.peerStateListeners.add(listener);
    return () => this.peerStateListeners.delete(listener);
  }

  private peerState(machineId: string, online: boolean): void {
    for (const listener of this.peerStateListeners) listener(machineId, online);
  }

  /** The label a machine is known by here. */
  labelOf(machineId: string): string {
    return this.known().find((m) => m.id === machineId)?.label ?? machineId;
  }

  /** Every paired machine, with its link's state: what federation lists workspaces under. */
  peers(): Array<{ id: string; label: string; state: PeerView["state"]; os: PeerMachine["os"]; form: MachineForm }> {
    return this.known().map((m) => ({ id: m.id, label: m.label, state: this.links.get(m.id)?.state ?? "offline", os: m.os, form: machineFormOf(m.form) }));
  }

  /** The live connection to a machine, if it is online now. */
  client(machineId: string): EngineClient | undefined {
    const client = this.links.get(machineId)?.client;
    return client?.open === true ? client : undefined;
  }

  /** The connection to a machine, waiting briefly for one being made. */
  private async connected(machineId: string): Promise<EngineClient | undefined> {
    for (let i = 0; i < 20; i += 1) {
      const client = this.client(machineId);
      if (client !== undefined) return client;
      const link = this.links.get(machineId);
      if (link === undefined || link.state === "offline") return undefined;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }

  /** Keep a connection to one machine, retrying with growing waits while it is away. */
  private link(machineId: string): void {
    if (this.stopped || this.host === undefined) return;
    const existing = this.links.get(machineId);
    if (existing?.client?.open === true || existing?.state === "connecting") return;
    const link = existing ?? { state: "connecting" as PeerView["state"], wait: this.options.retryMs ?? 3000 };
    if (link.timer !== undefined) clearTimeout(link.timer);
    link.timer = undefined;
    link.state = "connecting";
    this.links.set(machineId, link);
    void this.dial(machineId, link);
  }

  private async dial(machineId: string, link: { client?: EngineClient; state: PeerView["state"]; reason?: string; timer?: ReturnType<typeof setTimeout>; wait: number }): Promise<void> {
    const machine = this.known().find((m) => m.id === machineId);
    const token = this.heldToken(machineId);
    const retry = (reason: string): void => {
      link.state = "offline";
      link.reason = reason;
      link.client = undefined;
      this.changed();
      if (this.stopped || !this.links.has(machineId)) return;
      link.timer = setTimeout(() => this.link(machineId), link.wait);
      link.timer.unref?.();
      link.wait = Math.min(link.wait * 2, 60_000);
    };
    if (machine?.url === undefined) return retry("it has not said where it can be reached: sign in to Tailscale there");
    if (token === undefined) return retry("this machine holds no token for it: pair again");
    try {
      const url = await this.reachable(machine.url);
      const client = await connectEngine({ baseDir: this.options.baseDir, client: `machine ${this.identity().label}`, version: this.options.version, address: { url }, token, timeoutMs: 10_000 });
      link.client = client;
      link.state = client.limited ? "mismatch" : "online";
      link.reason = client.limited
        ? client.host.version === this.options.version
          ? `it runs another build of JaiRA ${client.host.version}, which cannot share work with this one: update both to the same build`
          : `it runs JaiRA ${client.host.version}, which cannot share work with ${this.options.version}`
        : undefined;
      link.wait = this.options.retryMs ?? 3000;
      this.remember(machine, { lastSeenAt: Date.now(), version: client.host.version });
      client.onPush((message) => {
        for (const listener of this.peerPushListeners) listener(machineId, message);
      });
      client.onClose(() => {
        this.remember(machine, { lastSeenAt: Date.now() });
        retry("the connection dropped");
        this.peerState(machineId, false);
      });
      this.changed();
      if (!client.limited) this.peerState(machineId, true);
      if (!client.limited) {
        void client.invoke("fleet:update", { machine: this.selfPeer() }).catch(() => undefined);
        // Members met through this machine that are still strangers: meet them now.
        void client.invoke("fleet:list").then((fleet) => this.meetFleetOf(machineId, fleet as PeerMachine[]), () => undefined);
      }
    } catch (e) {
      retry((e as Error).message);
    }
  }

  // --- the host this fleet lives in -------------------------------------------------------------------

  /** Start: the engine now listens for other machines on `loopbackPort`. */
  async attach(host: EngineHost, loopbackPort: number): Promise<void> {
    this.host = host;
    this.loopbackPort = loopbackPort;
    this.stopped = false;
    for (const machine of this.known()) this.link(machine.id);
    await this.applyTailnet();
  }

  authorize(token: string): TokenHolder | undefined {
    return this.tokens.verify(token);
  }

  /** Stop linking and leave the tailnet: still signed in, and back on it at the next start. */
  close(): void {
    this.stopped = true;
    if (this.lanExpiry !== undefined) clearTimeout(this.lanExpiry);
    void this.lan?.stop(true);
    if (this.tailnetRetry.timer !== undefined) clearTimeout(this.tailnetRetry.timer);
    this.tailnetPort?.close();
    this.tailnetRunning = false;
    for (const link of this.links.values()) {
      if (link.timer !== undefined) clearTimeout(link.timer);
      link.client?.close();
    }
    this.links.clear();
  }
}

function peerOf(machine: KnownMachine): PeerMachine {
  return { id: machine.id, label: machine.label, os: machine.os, ...(machine.form !== undefined ? { form: machine.form } : {}), tags: machine.tags, ...(machine.url !== undefined ? { url: machine.url } : {}) };
}

/** A peer as another machine described it: only the fields a peer has, shaped. */
function sanitizePeer(machine: PeerMachine): PeerMachine {
  const os = machine.os === "windows" || machine.os === "mac" || machine.os === "linux" ? machine.os : "linux";
  return {
    id: String(machine.id),
    label: String(machine.label ?? "machine").slice(0, 80),
    os,
    form: machineFormOf(machine.form),
    tags: Array.isArray(machine.tags) ? machine.tags.filter((t): t is string => typeof t === "string").slice(0, 32) : [],
    ...(typeof machine.url === "string" && /^wss?:\/\//.test(machine.url) ? { url: machine.url } : {}),
  };
}

/** A device as it described itself: an id that is only an id, a name of sensible length, one of the kinds. */
function sanitizeDevice(asked: unknown): PairingDevice | undefined {
  const device = asked as Partial<PairingDevice> | null;
  if (typeof device !== "object" || device === null) return undefined;
  if (typeof device.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(device.id)) return undefined;
  if (device.kind !== "phone") return undefined;
  const label = typeof device.label === "string" ? device.label.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return { id: device.id, label: label === "" ? "A phone" : label, kind: device.kind };
}

/** Which machine answers at an engine URL (one this process can reach), before pairing: its `/.well-known/jaira`. */
async function wellKnown(engineUrl: string): Promise<{ machineId: string; label: string; version: string }> {
  const url = new URL(engineUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "/.well-known/jaira";
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(`nothing answered at ${url.host}: ${(e as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as { jaira?: boolean; machineId?: string; label?: string; version?: string };
  if (body.jaira !== true || typeof body.machineId !== "string") throw new Error(`${url.host} is not a JaiRA machine`);
  return { machineId: body.machineId, label: body.label ?? url.hostname, version: body.version ?? "?" };
}
