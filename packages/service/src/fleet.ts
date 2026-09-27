/**
 * The fleet (decision 0013 §1–§3): this machine, the machines it is paired with, and the connections
 * between them.
 *
 * - **Pairing, once per machine.** This machine shows a one-time code. Another one sends it with a token
 *   it issued for this machine, and gets one issued for itself back. Both remember each other.
 * - **Introductions.** The paired machine's own fleet comes back with the answer. For each member it
 *   does not know yet, the newcomer asks the machine it paired with to introduce it. That machine, already
 *   trusted by the member, carries the newcomer's token over and the member's token back. So pairing with
 *   any one member joins the whole fleet (ruling 11).
 * - **Links.** An engine keeps a connection to every machine it knows, retrying with growing waits. An
 *   offline machine stays listed.
 * - **Reach.** This machine is published on the tailnet by the installed Tailscale app (`tailscale.ts`),
 *   or by the bundled helper when there is none.
 */
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PAIRING_CODE_MS, engineUrlOf, normalizePairingCode, type MachineReach, type MachinesView, type PeerView, type CopyChoice } from "@jaira/shared";
import { askOnce, connectEngine, type EngineClient } from "./engineClient";
import type { EngineHost, PreAuthHandler } from "./engineHost";
import type { HostFrame, PeerMachine } from "./enginePipe";
import type { Handler } from "./handlers";
import { machineIdentity, updateMachineIdentity, type MachineIdentity } from "./machine";
import { MachineTokens } from "./machineTokens";
import { tailscaleServe, tailscaleStatus, tailscaleUnserve } from "./tailscale";
import { autoReach } from "./tailnetHelper";

/** A paired machine, as this one remembers it. */
interface KnownMachine extends PeerMachine {
  addedAt: number;
  lastSeenAt?: number;
  version?: string;
}

interface FleetFile {
  machines: KnownMachine[];
  /** This machine is published on the tailnet. */
  reachable?: boolean;
  /** Where it was last published, for the others to find it again. */
  url?: string;
}

/** Where tokens this machine HOLDS for others are kept: the keychain, or a 0600 file where there is none. */
export interface SecretsPort {
  available(): boolean;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
}

/** How Tailscale is driven — a seam for tests. */
export interface ReachPort {
  /** `progress` hears a sign-in the reach needs first (the helper's one-time tailnet sign-in). */
  publish(loopbackPort: number, progress?: (update: { signInUrl?: string }) => void): Promise<{ url: string; via: "tailscale" | "helper" }>;
  unpublish(loopbackPort: number): Promise<void>;
  /** Stop anything the reach runs (the helper) with the engine. */
  close?(): void;
  /** Why this machine cannot be published, or undefined when it can. */
  unavailable(): Promise<string | undefined>;
}

export const installedTailscale: ReachPort = {
  publish: async (port) => ({ ...(await tailscaleServe(port)), via: "tailscale" as const }),
  unpublish: (port) => tailscaleUnserve(port),
  unavailable: async () => {
    const status = await tailscaleStatus();
    return status.running ? undefined : status.reason;
  },
};

/**
 * `JAIRA_REACH=loopback`: publish the engine's loopback address as it is — for trying the fleet with
 * several base roots on one machine, where no tailnet is needed. Development only, like `JAIRA_CAPTURE`.
 */
export const loopbackReach: ReachPort = {
  publish: async (port) => ({ url: `http://127.0.0.1:${port}`, via: "tailscale" }),
  unpublish: async () => undefined,
  unavailable: async () => undefined,
};

/** Tailscale however this machine has it — the app or JaiRA's helper — or loopback in development. */
function defaultReach(baseDir: string, hostname: () => string): ReachPort {
  return process.env["JAIRA_REACH"] === "loopback" ? loopbackReach : autoReach(baseDir, hostname);
}

export interface FleetOptions {
  baseDir: string;
  version: string;
  secrets?: SecretsPort;
  publish?: (view: MachinesView) => void;
  log?: (level: "info" | "warn", message: string) => void;
  reach?: ReachPort;
  /**
   * What this machine keeps a copy of when the person has not said (decision 0013 §6): a window's engine
   * what is not archived, a `jaira serve` with no window nothing (ruling 7).
   */
  copyByDefault?: CopyChoice["mode"];
  /** Tests: how long the first retry waits. */
  retryMs?: number;
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

const secretName = (machineId: string): string => `jaira.machine.${machineId}`;

export class Fleet {
  private readonly tokens: MachineTokens;
  private readonly links = new Map<string, { client?: EngineClient; state: PeerView["state"]; reason?: string; timer?: ReturnType<typeof setTimeout>; wait: number }>();
  private readonly peerPushListeners = new Set<(machineId: string, message: unknown) => void>();
  private readonly peerStateListeners = new Set<(machineId: string, online: boolean) => void>();
  private pairing: { code: string; expiresAt: number; attempts: number } | undefined;
  private reach: MachineReach = { state: "off" };
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
      return { machines: Array.isArray(raw.machines) ? raw.machines : [], ...(raw.reachable === true ? { reachable: true } : {}), ...(typeof raw.url === "string" ? { url: raw.url } : {}) };
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
    const url = this.reach.state === "on" && this.reach.url !== undefined ? engineUrlOf(this.reach.url) : this.read().url;
    return { id: me.id, label: me.label, os: me.os, tags: me.tags, ...(url !== undefined ? { url } : {}) };
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
        tags: m.tags,
        ...(m.url !== undefined ? { url: m.url } : {}),
        state: link?.state ?? "offline",
        ...(m.version !== undefined ? { version: m.version } : {}),
        ...(m.lastSeenAt !== undefined ? { lastSeenAt: m.lastSeenAt } : {}),
        ...(link?.reason !== undefined ? { reason: link.reason } : {}),
        canReachHere: issued.has(m.id),
      };
    });
    const pairing = this.pairing !== undefined && this.pairing.expiresAt > Date.now() ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined;
    return {
      self: { id: me.id, label: me.label, os: me.os, tags: me.tags, reach: this.reach, version: this.options.version, copy: this.copying() },
      machines,
      ...(pairing !== undefined ? { pairing } : {}),
    };
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

  // --- reach --------------------------------------------------------------------------------------------

  /** Publish this machine on the tailnet, or stop. Kept across restarts. */
  async setReachable(on: boolean): Promise<MachinesView> {
    const file = this.read();
    this.write({ ...file, ...(on ? { reachable: true } : {}), ...(on ? {} : { reachable: undefined }) } as FleetFile);
    await this.applyReach();
    return this.view();
  }

  private async applyReach(): Promise<void> {
    const want = this.read().reachable === true;
    const port = this.loopbackPort;
    const reach = this.reachPort();
    if (!want) {
      if (this.reach.state === "on" && port !== undefined) await reach.unpublish(port).catch(() => undefined);
      this.reach = { state: "off" };
      this.changed();
      return;
    }
    if (port === undefined) {
      this.reach = { state: "unavailable", reason: "this engine is not listening for other machines (a jaira command's engine never does)" };
      this.changed();
      return;
    }
    this.reach = { state: "starting" };
    this.changed();
    try {
      const why = await reach.unavailable();
      if (why !== undefined) throw new Error(why);
      const published = await reach.publish(port, (update) => {
        if (update.signInUrl !== undefined) {
          this.reach = { state: "starting", via: "helper", signInUrl: update.signInUrl, reason: "sign in to your tailnet to finish" };
          this.changed();
        }
      });
      this.reach = { state: "on", url: published.url, via: published.via };
      const file = this.read();
      this.write({ ...file, url: engineUrlOf(published.url) });
      this.options.log?.("info", `this machine is reachable from your other machines at ${published.url}`);
      this.announce();
    } catch (e) {
      this.reach = { state: "unavailable", reason: (e as Error).message };
      this.options.log?.("warn", `this machine could not be made reachable: ${(e as Error).message}`);
    }
    this.changed();
  }

  private reachInUse: ReachPort | undefined;

  private reachPort(): ReachPort {
    this.reachInUse ??= this.options.reach ?? defaultReach(this.options.baseDir, () => this.identity().label);
    return this.reachInUse;
  }

  // --- pairing, the shown side ------------------------------------------------------------------------

  /** A new one-time code, replacing any shown before. */
  pairingCode(): MachinesView {
    const words = [WORDS[randomInt(WORDS.length)]!, WORDS[randomInt(WORDS.length)]!].map((w) => w.toUpperCase());
    let tail = "";
    for (let i = 0; i < 4; i += 1) tail += CODE_CHARS[randomInt(CODE_CHARS.length)];
    this.pairing = { code: `${words[0]} · ${words[1]} · ${tail}`, expiresAt: Date.now() + PAIRING_CODE_MS, attempts: 0 };
    this.changed();
    return this.view();
  }

  cancelPairing(): MachinesView {
    this.pairing = undefined;
    this.changed();
    return this.view();
  }

  /** A `pair` frame from a machine that was shown this one's code (`EngineHost` hands it here). */
  readonly preAuth: PreAuthHandler = async (frame) => {
    if (frame.t !== "pair") return undefined;
    const pairing = this.pairing;
    const refused = (reason: string): HostFrame => ({ t: "refused", reason });
    if (pairing === undefined || pairing.expiresAt <= Date.now()) return refused("no pairing code is being shown on that machine, or it expired: show a new one");
    if (normalizePairingCode(String(frame["code"])) !== normalizePairingCode(pairing.code)) {
      pairing.attempts += 1;
      if (pairing.attempts >= MAX_CODE_ATTEMPTS) this.pairing = undefined;
      this.changed();
      return refused("that is not the code shown on that machine");
    }
    const machine = frame["machine"] as PeerMachine | undefined;
    const token = frame["token"];
    if (machine === undefined || typeof machine.id !== "string" || typeof token !== "string") return refused("a pairing needs the asking machine and its token");
    if (machine.id === this.identity().id) return refused("a machine cannot pair with itself");
    this.pairing = undefined;
    this.remember(sanitizePeer(machine));
    this.holdToken(machine.id, token);
    const issued = this.tokens.issue(machine.id, machine.label);
    this.options.log?.("info", `paired with ${machine.label}`);
    this.link(machine.id);
    this.changed();
    return { t: "paired", machine: this.selfPeer(), token: issued, fleet: this.known().map(peerOf) };
  };

  // --- pairing, the typing side -----------------------------------------------------------------------

  /** Pair with the machine at `address` using the code it shows, then meet the rest of its fleet. */
  async add(address: string, code: string): Promise<MachinesView> {
    const url = engineUrlOf(address);
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
    this.remember(sanitizePeer({ ...answer.machine, url: answer.machine.url ?? url }));
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

  /** Forget a machine here and across the fleet: its tokens no longer open anything anywhere. */
  async forget(machineId: string): Promise<MachinesView> {
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
  peers(): Array<{ id: string; label: string; state: PeerView["state"] }> {
    return this.known().map((m) => ({ id: m.id, label: m.label, state: this.links.get(m.id)?.state ?? "offline" }));
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
    if (machine?.url === undefined) return retry("it has not said where it can be reached: turn on Reachable from my other machines there");
    if (token === undefined) return retry("this machine holds no token for it: pair again");
    try {
      const client = await connectEngine({ baseDir: this.options.baseDir, client: `machine ${this.identity().label}`, version: this.options.version, address: { url: machine.url }, token, timeoutMs: 10_000 });
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
    await this.applyReach();
  }

  authorize(token: string): { id: string; label: string } | undefined {
    return this.tokens.verify(token);
  }

  /** Stop linking and leave the tailnet mapping in place — it is the machine's, kept across restarts. */
  close(): void {
    this.stopped = true;
    this.reachInUse?.close?.();
    for (const link of this.links.values()) {
      if (link.timer !== undefined) clearTimeout(link.timer);
      link.client?.close();
    }
    this.links.clear();
  }
}

function peerOf(machine: KnownMachine): PeerMachine {
  return { id: machine.id, label: machine.label, os: machine.os, tags: machine.tags, ...(machine.url !== undefined ? { url: machine.url } : {}) };
}

/** A peer as another machine described it: only the fields a peer has, shaped. */
function sanitizePeer(machine: PeerMachine): PeerMachine {
  const os = machine.os === "windows" || machine.os === "mac" || machine.os === "linux" ? machine.os : "linux";
  return {
    id: String(machine.id),
    label: String(machine.label ?? "machine").slice(0, 80),
    os,
    tags: Array.isArray(machine.tags) ? machine.tags.filter((t): t is string => typeof t === "string").slice(0, 32) : [],
    ...(typeof machine.url === "string" && /^wss?:\/\//.test(machine.url) ? { url: machine.url } : {}),
  };
}

/** Which machine answers at an engine URL, before pairing: its `/.well-known/jaira`. */
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
