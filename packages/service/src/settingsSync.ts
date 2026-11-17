/**
 * Settings that follow the person across their machines (decision 0026): the Shared and Just you
 * settings layers, the keys and tokens in JaiRA's keychain, the forge sign-ins, and the sign-ins of the
 * agents JaiRA signs in — kept in step between every machine of the fleet, piece by piece.
 *
 * - **A piece** is one setting (`settingsSync.ts` in `@jaira/shared` cuts a layer into them), one
 *   secret, one forge sign-in's mark, or one agent's sign-in. Each is known here by a key —
 *   `base:["appearance","mode"]`, `secret:GITHUB_TOKEN`, `mark:GITHUB_TOKEN`, `login:claude-cli`.
 * - **Stamps.** Every piece carries when it was last changed and by which machine. A change made here
 *   is stamped later than anything this machine has heard of (a clock that never runs backwards, past
 *   every stamp received), so the same piece changed on two machines keeps the change made last, and
 *   one machine's clock running behind cannot make a later change lose. The stamps, and a hash of what
 *   each piece held — never the value — are kept in `<base>/system/settings-sync.json`.
 * - **Noticing a change.** After every write JaiRA makes (a settings save, a key stored, a sign-in),
 *   and once a minute for what changed by hand or by an agent refreshing its own sign-in, the pieces
 *   are read again and compared with their hashes.
 * - **Telling the others.** What changed here is offered to every machine online (`settings:offer`);
 *   each takes what is newer than its own. A machine that comes online, and every five minutes, asks
 *   each machine for what it holds newer (`settings:pull`, with its own stamps). So a machine that was
 *   away catches up when it is back, and nothing needs a hub.
 * - **The first look.** A piece seen for the first time, before this machine ever looked, is stamped as
 *   old as the file it is in (a secret, as old as anything): joining a fleet takes the fleet's settings
 *   where they were changed more recently, and keeps the newcomer's where they were not.
 * - **Removals.** A setting or a forge sign-in's mark gone from its file is gone everywhere. A secret
 *   or an agent's sign-in is removed everywhere only when it is removed through JaiRA — a key cleared,
 *   a forge or an agent signed out — never because it could not be read here, so a keychain that will
 *   not open cannot sign every machine out.
 * - **What another machine sends is checked** as a settings save is: laid into the layer it belongs
 *   to, the layer must still load with every open project. One that would not is left out, and said.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { canonicalJson, layPiece, settingsPieces, type SettingsSyncView, type SyncedLayer } from "@jaira/shared";
import type { AgentLoginStore } from "./agentLogins";
import type { Fleet } from "./fleet";

/** When and by which machine a piece was last changed. */
export interface SyncStamp {
  at: number;
  by: string;
}

/** A piece as it travels between machines; no `value` means it was removed. */
export interface SyncedPiece extends SyncStamp {
  key: string;
  value?: JsonValue;
}

/** What this machine knows of a piece: its stamp, and a hash of what it held (absent: removed). */
interface HeldPiece extends SyncStamp {
  hash?: string;
}

interface SyncFile {
  /** The latest stamp made or heard of: a change made here is stamped after it. */
  clock: number;
  /** Whether this machine has looked at its pieces before (the first look stamps them by their age). */
  looked?: boolean;
  /** When a change was last taken from or given to another machine. */
  at?: number;
  pieces: Record<string, HeldPiece>;
  /** Pieces heard of and not taken — this machine's own here, or refused: remembered so they are not sent again. */
  passed?: Record<string, SyncStamp>;
  refused?: Array<{ what: string; why: string; at: number }>;
}

/** A store of secrets this machine keeps for JaiRA — its keychain, or the shared root's `.env.local`. */
export interface SyncSecretStore {
  names(): string[];
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
}

/** What the sync reads and writes on this machine; the engine (`AppService`) fills it in. */
export interface SettingsSyncPorts {
  /** A layer as it is on disk now (`null` when there is no file), and when it was written; undefined when it cannot be read. */
  readLayer(layer: SyncedLayer): { doc: JsonValue | null; at: number } | undefined;
  /** Throw, naming the field, when a layer written this way would not load. */
  checkLayer(layer: SyncedLayer, doc: JsonValue): void;
  writeLayer(layer: SyncedLayer, doc: JsonValue): void;
  /** Where JaiRA keeps secrets here; undefined when it cannot be reached now. */
  secrets(): SyncSecretStore | undefined;
  /** The forge sign-in marks, without where each token is kept here; undefined when the file cannot be read. */
  readMarks(): { marks: Record<string, JsonValue>; at: number } | undefined;
  writeMarks(marks: Record<string, JsonValue>): void;
  logins(): AgentLoginStore[];
  /** Something another machine sent was laid in here: what kinds, for the engine to re-read. */
  changed(kinds: ReadonlySet<PieceKind>): void;
  log(level: "info" | "warn", message: string): void;
}

export type PieceKind = "base" | "you" | "secret" | "mark" | "login";

/** Names in the keychain that are the machine's own: the tokens it holds for other machines. */
const isMachineSecret = (name: string): boolean => name.startsWith("jaira.");

const LAYERS: readonly SyncedLayer[] = ["base", "you"];

export function pieceKey(kind: PieceKind, id: string | readonly string[]): string {
  return `${kind}:${typeof id === "string" ? id : JSON.stringify(id)}`;
}

function kindOf(key: string): PieceKind | undefined {
  const kind = key.slice(0, key.indexOf(":"));
  return kind === "base" || kind === "you" || kind === "secret" || kind === "mark" || kind === "login" ? kind : undefined;
}

const idOf = (key: string): string => key.slice(key.indexOf(":") + 1);

function pathOf(key: string): string[] | undefined {
  try {
    const path = JSON.parse(idOf(key)) as unknown;
    return Array.isArray(path) && path.length > 0 && path.every((p) => typeof p === "string") ? (path as string[]) : undefined;
  } catch {
    return undefined;
  }
}

const hashOf = (value: JsonValue): string => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32);

/** Is `a` a later change than `b`? Ties go to the machine whose id sorts last, the same on every machine. */
export function newer(a: SyncStamp, b: SyncStamp | undefined): boolean {
  return b === undefined || a.at > b.at || (a.at === b.at && a.by > b.by);
}

/** What a piece is called in a sentence. */
function wordsOf(key: string): string {
  const kind = kindOf(key);
  if (kind === "base" || kind === "you") return `${kind === "base" ? "Shared" : "Just you"} ${pathOf(key)?.join(".") ?? idOf(key)}`;
  if (kind === "secret") return `the key ${idOf(key)}`;
  if (kind === "mark") return `the sign-in for ${idOf(key)}`;
  return `${idOf(key)}'s sign-in`;
}

export interface SettingsSyncOptions {
  baseDir: string;
  fleet: Fleet;
  ports: SettingsSyncPorts;
  /** Tests: how long after a change it is offered; and the timers' periods. */
  settleMs?: number;
  scanMs?: number;
  pullMs?: number;
}

export class SettingsSync {
  private kickTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly scanTimer: ReturnType<typeof setInterval>;
  private readonly pullTimer: ReturnType<typeof setInterval>;
  private readonly pulling = new Set<string>();
  /** Changes stamped here but not by a look (a removal through JaiRA): offered with the next look's. */
  private readonly unoffered = new Set<string>();
  private closed = false;

  constructor(private readonly options: SettingsSyncOptions) {
    options.fleet.onPeerState((machineId, online) => {
      if (online) setTimeout(() => void this.pullFrom(machineId), 250).unref?.();
    });
    this.scanTimer = setInterval(() => this.kick(0), options.scanMs ?? 60_000);
    this.scanTimer.unref?.();
    this.pullTimer = setInterval(() => {
      for (const peer of options.fleet.peers()) if (peer.state === "online") void this.pullFrom(peer.id);
    }, options.pullMs ?? 5 * 60_000);
    this.pullTimer.unref?.();
  }

  private get self(): string {
    return this.options.fleet.identity().id;
  }

  // --- the switch ---------------------------------------------------------------------------------------

  /** Whether this machine keeps its settings in step: on unless the person turned it off here. */
  on(): boolean {
    return this.options.fleet.identity().syncSettings !== false;
  }

  // --- the file -----------------------------------------------------------------------------------------

  private file(): string {
    return join(this.options.baseDir, "system", "settings-sync.json");
  }

  private read(): SyncFile {
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as Partial<SyncFile>;
      return {
        clock: typeof raw.clock === "number" ? raw.clock : 0,
        ...(raw.looked === true ? { looked: true } : {}),
        ...(typeof raw.at === "number" ? { at: raw.at } : {}),
        pieces: typeof raw.pieces === "object" && raw.pieces !== null ? raw.pieces : {},
        ...(typeof raw.passed === "object" && raw.passed !== null ? { passed: raw.passed } : {}),
        ...(Array.isArray(raw.refused) ? { refused: raw.refused } : {}),
      };
    } catch {
      return { clock: 0, pieces: {} };
    }
  }

  private write(file: SyncFile): void {
    const path = this.file();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }

  private tick(file: SyncFile): number {
    file.clock = Math.max(Date.now(), file.clock + 1);
    return file.clock;
  }

  // --- what is here ---------------------------------------------------------------------------------------

  /**
   * Every piece this machine holds now, with what it holds and how old the first look takes it to be;
   * and the kinds whose removals can be told (their file was read).
   */
  private collect(): { here: Map<string, { value: JsonValue; hash: string; age: number }>; read: Set<PieceKind> } {
    const here = new Map<string, { value: JsonValue; hash: string; age: number }>();
    const read = new Set<PieceKind>();
    const ports = this.options.ports;
    for (const layer of LAYERS) {
      const found = ports.readLayer(layer);
      if (found === undefined) continue;
      read.add(layer);
      for (const piece of settingsPieces(found.doc)) here.set(pieceKey(layer, piece.path), { value: piece.value, hash: hashOf(piece.value), age: found.at });
    }
    const secrets = ports.secrets();
    if (secrets !== undefined) {
      for (const name of secrets.names()) {
        if (isMachineSecret(name)) continue;
        const value = secrets.get(name);
        if (value !== undefined && value !== "") here.set(pieceKey("secret", name), { value, hash: hashOf(value), age: 0 });
      }
    }
    const marks = ports.readMarks();
    if (marks !== undefined) {
      read.add("mark");
      for (const [name, mark] of Object.entries(marks.marks)) here.set(pieceKey("mark", name), { value: mark, hash: hashOf(mark), age: marks.at });
    }
    for (const store of ports.logins()) {
      if (store.unavailable() !== undefined) continue;
      const login = store.read();
      if (login !== undefined) here.set(pieceKey("login", store.agent), { value: login.value, hash: hashOf(login.value), age: login.at });
    }
    return { here, read };
  }

  /**
   * Read every piece again and stamp what changed since the last look. Returns the keys that changed.
   * The first look ever stamps each piece as old as its file says, not now.
   */
  scan(): string[] {
    if (!this.on()) return [];
    const file = this.read();
    const { here, read } = this.collect();
    const changed: string[] = [];
    const first = file.looked !== true;
    for (const [key, piece] of here) {
      const held = file.pieces[key];
      if (held?.hash === piece.hash) continue;
      const at = first && held === undefined ? Math.min(piece.age, Date.now()) : this.tick(file);
      file.clock = Math.max(file.clock, at);
      file.pieces[key] = { at, by: this.self, hash: piece.hash };
      changed.push(key);
    }
    for (const [key, held] of Object.entries(file.pieces)) {
      const kind = kindOf(key);
      // A setting or a mark gone from a file that was read is removed; a secret or a sign-in only through `removed`.
      if (held.hash === undefined || here.has(key) || kind === undefined || kind === "secret" || kind === "login" || !read.has(kind)) continue;
      file.pieces[key] = { at: this.tick(file), by: this.self };
      changed.push(key);
    }
    if (first || changed.length > 0) this.write({ ...file, looked: true });
    return changed;
  }

  /**
   * A secret or an agent's sign-in removed through JaiRA (a key cleared, a forge or an agent signed
   * out): removed on every machine.
   */
  removed(kind: "secret" | "login", id: string): void {
    if (!this.on() || (kind === "secret" && isMachineSecret(id))) return;
    const file = this.read();
    const key = pieceKey(kind, id);
    if (file.pieces[key]?.hash === undefined) return;
    file.pieces[key] = { at: this.tick(file), by: this.self };
    this.write(file);
    this.unoffered.add(key);
    this.kick();
  }

  // --- telling the others --------------------------------------------------------------------------------

  /** Something here may have changed: look again shortly, and offer what did to every machine online. */
  kick(settleMs = this.options.settleMs ?? 400): void {
    if (this.closed) return;
    if (this.kickTimer !== undefined) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.offer();
    }, settleMs);
    this.kickTimer.unref?.();
  }

  /** Look again now, and offer every machine online what changed. */
  async offer(): Promise<void> {
    let changed: string[];
    try {
      changed = this.scan();
    } catch (e) {
      this.options.ports.log("warn", `settings sync could not read this machine's settings: ${(e as Error).message}`);
      return;
    }
    const keys = new Set([...changed, ...this.unoffered]);
    this.unoffered.clear();
    if (keys.size === 0) return;
    const pieces = this.piecesOf(keys);
    if (pieces.length === 0) return;
    let gave = false;
    for (const peer of this.options.fleet.peers()) {
      const client = this.options.fleet.client(peer.id);
      if (client === undefined || peer.state !== "online") continue;
      try {
        await client.invoke("settings:offer", { pieces });
        gave = true;
      } catch {
        // An older JaiRA there, or the link dropped: it asks when it is back.
      }
    }
    if (gave) this.stampExchange();
  }

  /** Ask one machine for what it holds newer than this one, and lay it in. */
  async pullFrom(machineId: string): Promise<number> {
    if (!this.on() || this.closed || this.pulling.has(machineId)) return 0;
    const client = this.options.fleet.client(machineId);
    if (client === undefined) return 0;
    this.pulling.add(machineId);
    try {
      this.scan();
      const answer = (await client.invoke("settings:pull", { stamps: this.stamps() })) as { pieces?: SyncedPiece[] } | null;
      const taken = this.take(Array.isArray(answer?.pieces) ? answer.pieces : [], this.options.fleet.labelOf(machineId));
      this.stampExchange();
      return taken;
    } catch {
      // An older JaiRA there, or the link dropped.
      return 0;
    } finally {
      this.pulling.delete(machineId);
    }
  }

  /** Every stamp this machine holds — what it sends when it asks, so the other sends only what is newer. */
  stamps(): Record<string, SyncStamp> {
    const file = this.read();
    const out: Record<string, SyncStamp> = {};
    for (const [key, stamp] of Object.entries(file.passed ?? {})) out[key] = { at: stamp.at, by: stamp.by };
    for (const [key, held] of Object.entries(file.pieces)) if (newer(held, out[key])) out[key] = { at: held.at, by: held.by };
    return out;
  }

  /** What this machine holds that is newer than `theirs`: the answer to `settings:pull`. */
  answer(theirs: Record<string, SyncStamp>): SyncedPiece[] {
    if (!this.on()) return [];
    this.scan();
    const file = this.read();
    const keys = new Set(Object.entries(file.pieces).filter(([key, held]) => newer(held, theirs[key])).map(([key]) => key));
    return this.piecesOf(keys);
  }

  /** The pieces named, with what each holds here now; a removal travels without a value. */
  private piecesOf(keys: ReadonlySet<string>): SyncedPiece[] {
    const file = this.read();
    const { here } = this.collect();
    const out: SyncedPiece[] = [];
    for (const key of keys) {
      const held = file.pieces[key];
      if (held === undefined) continue;
      if (held.hash === undefined) {
        out.push({ key, at: held.at, by: held.by });
        continue;
      }
      const now = here.get(key);
      // Held but not readable this moment (a keychain that will not open): sent later, never as a removal.
      if (now === undefined || now.hash !== held.hash) continue;
      out.push({ key, at: held.at, by: held.by, value: now.value });
    }
    return out;
  }

  private stampExchange(): void {
    const file = this.read();
    this.write({ ...file, at: Date.now() });
  }

  // --- taking what another machine sent -------------------------------------------------------------------

  /**
   * Lay in what another machine sent, each piece only when it is newer than what is here. Returns how
   * many were taken.
   */
  take(incoming: readonly SyncedPiece[], from = "another machine"): number {
    if (!this.on() || incoming.length === 0) return 0;
    // What changed here first gets its stamp, so it is weighed against what came as the change it is.
    this.scan();
    const file = this.read();
    const ports = this.options.ports;
    const wanted = incoming.filter((piece) => {
      if (typeof piece?.key !== "string" || typeof piece.at !== "number" || typeof piece.by !== "string") return false;
      if (kindOf(piece.key) === undefined || piece.by === this.self) return false;
      file.clock = Math.max(file.clock, piece.at);
      const passed = file.passed?.[piece.key];
      return newer(piece, file.pieces[piece.key]) && newer(piece, passed);
    });
    const taken = new Set<PieceKind>();
    const pass = (piece: SyncedPiece, why?: string): void => {
      file.passed = { ...(file.passed ?? {}), [piece.key]: { at: piece.at, by: piece.by } };
      if (why !== undefined) {
        file.refused = [...(file.refused ?? []), { what: wordsOf(piece.key), why, at: Date.now() }].slice(-8);
        ports.log("warn", `${wordsOf(piece.key)} from ${from} was not taken: ${why}`);
      }
    };
    const hold = (piece: SyncedPiece, hash: string | undefined): void => {
      file.pieces[piece.key] = { at: piece.at, by: piece.by, ...(hash !== undefined ? { hash } : {}) };
      if (file.passed?.[piece.key] !== undefined) delete file.passed[piece.key];
    };

    // Settings, a layer at a time: laid in together, checked as a save is, and piece by piece when the
    // whole will not load, so one bad piece costs only itself.
    for (const layer of LAYERS) {
      const pieces = wanted.filter((p) => kindOf(p.key) === layer);
      if (pieces.length === 0) continue;
      const found = ports.readLayer(layer);
      if (found === undefined) {
        // Unreadable here: nothing is laid over it, and the pieces are asked for again next time.
        ports.log("warn", `${layer === "base" ? "Shared" : "Just you"} settings could not be read, so ${from}'s changes to them wait`);
        continue;
      }
      let doc: JsonValue | null = found.doc;
      const laid: SyncedPiece[] = [];
      const lay = (onto: JsonValue | null, piece: SyncedPiece): { doc: JsonValue; kept: boolean } | undefined => {
        const path = pathOf(piece.key);
        return path === undefined ? undefined : layPiece(onto, path, piece.value);
      };
      let whole: JsonValue | null = doc;
      for (const piece of pieces) {
        const next = lay(whole, piece);
        if (next === undefined || next.kept) pass(piece);
        else {
          whole = next.doc;
          laid.push(piece);
        }
      }
      if (laid.length === 0) continue;
      let accepted: SyncedPiece[] = laid;
      try {
        ports.checkLayer(layer, whole ?? {});
        doc = whole;
      } catch {
        accepted = [];
        for (const piece of laid) {
          const next = lay(doc, piece)!;
          try {
            ports.checkLayer(layer, next.doc);
            doc = next.doc;
            accepted.push(piece);
          } catch (e) {
            pass(piece, (e as Error).message);
          }
        }
      }
      if (accepted.length === 0) continue;
      try {
        ports.writeLayer(layer, doc ?? {});
      } catch (e) {
        for (const piece of accepted) pass(piece, (e as Error).message);
        continue;
      }
      // The hash of each as this machine now reads it back, so the next look sees no change of its own.
      const back = new Map(settingsPieces(doc).map((p) => [pieceKey(layer, p.path), hashOf(p.value)]));
      for (const piece of accepted) hold(piece, back.get(piece.key));
      taken.add(layer);
    }

    const secrets = ports.secrets();
    for (const piece of wanted.filter((p) => kindOf(p.key) === "secret")) {
      const name = idOf(piece.key);
      // No store reachable now: asked for again at the next pull.
      if (secrets === undefined) continue;
      if (isMachineSecret(name) || (piece.value !== undefined && typeof piece.value !== "string")) {
        pass(piece, "not a key");
        continue;
      }
      try {
        if (piece.value === undefined) secrets.remove(name);
        else secrets.set(name, piece.value);
        // Hashed as it reads back, which a store may write differently, so the next look sees no change of its own.
        hold(piece, piece.value === undefined ? undefined : hashOf(secrets.get(name) ?? piece.value));
        taken.add("secret");
      } catch (e) {
        pass(piece, (e as Error).message);
      }
    }

    const markPieces = wanted.filter((p) => kindOf(p.key) === "mark");
    if (markPieces.length > 0) {
      const found = ports.readMarks();
      if (found !== undefined) {
        const marks = { ...found.marks };
        for (const piece of markPieces) {
          if (piece.value === undefined) delete marks[idOf(piece.key)];
          else marks[idOf(piece.key)] = piece.value;
          hold(piece, piece.value === undefined ? undefined : hashOf(piece.value));
        }
        try {
          ports.writeMarks(marks);
          taken.add("mark");
        } catch (e) {
          for (const piece of markPieces) pass(piece, (e as Error).message);
        }
      }
    }

    const stores = new Map(ports.logins().map((store) => [store.agent, store]));
    for (const piece of wanted.filter((p) => kindOf(p.key) === "login")) {
      const store = stores.get(idOf(piece.key));
      // Not followed here (agents in WSL, a keychain that refused): asked for again at the next pull.
      if (store === undefined || store.unavailable() !== undefined) continue;
      if (piece.value !== undefined && typeof piece.value !== "string") {
        pass(piece, "not a sign-in");
        continue;
      }
      try {
        if (piece.value === undefined) store.remove();
        else store.write(piece.value);
        hold(piece, piece.value === undefined ? undefined : hashOf(store.read()?.value ?? piece.value));
        taken.add("login");
      } catch (e) {
        pass(piece, (e as Error).message);
      }
    }

    const count = wanted.filter((p) => file.pieces[p.key]?.at === p.at && file.pieces[p.key]?.by === p.by).length;
    if (count > 0) file.at = Date.now();
    this.write(file);
    if (taken.size > 0) {
      ports.log("info", `took ${count} setting${count === 1 ? "" : "s"} from ${from}`);
      ports.changed(taken);
    }
    return count;
  }

  // --- what Settings shows ----------------------------------------------------------------------------------

  view(): SettingsSyncView {
    const file = this.read();
    const counts = { settings: 0, secrets: 0, signIns: 0, logins: 0 };
    for (const [key, held] of Object.entries(file.pieces)) {
      if (held.hash === undefined) continue;
      const kind = kindOf(key);
      if (kind === "base" || kind === "you") counts.settings += 1;
      else if (kind === "secret") counts.secrets += 1;
      else if (kind === "mark") counts.signIns += 1;
      else if (kind === "login") counts.logins += 1;
    }
    return {
      on: this.on(),
      ...(file.at !== undefined ? { at: file.at } : {}),
      counts,
      logins: this.options.ports.logins().map((store) => {
        const why = store.unavailable();
        const where = store.where?.();
        return { agent: store.agent, synced: why === undefined, ...(why !== undefined ? { why } : {}), ...(where !== undefined ? { where } : {}) };
      }),
      ...(file.refused !== undefined && file.refused.length > 0 ? { refused: file.refused } : {}),
    };
  }

  /** The `settings:*` channels, answered for one paired machine's connection. */
  handlersFor(caller: { id: string; label: string }): Record<string, (request: never) => unknown> {
    return {
      "settings:pull": ((request: { stamps?: Record<string, SyncStamp> }) =>
        ({ pieces: this.answer(typeof request?.stamps === "object" && request.stamps !== null ? request.stamps : {}) })) as (request: never) => unknown,
      "settings:offer": ((request: { pieces?: SyncedPiece[] }) => {
        this.take(Array.isArray(request?.pieces) ? request.pieces.slice(0, 5_000) : [], caller.label);
        return null;
      }) as (request: never) => unknown,
    };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.scanTimer);
    clearInterval(this.pullTimer);
    if (this.kickTimer !== undefined) clearTimeout(this.kickTimer);
  }
}
