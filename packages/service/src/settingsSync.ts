/**
 * Settings that follow the person across their machines (decision 0026): the Shared and Just you
 * settings layers, the person's settings for each project, the keys and tokens in JaiRA's keychain, the
 * forge sign-ins, and the sign-ins of the agents JaiRA signs in — kept in step between every machine of
 * the fleet, piece by piece.
 *
 * - **A piece** is one setting (`settingsSync.ts` in `@jaira/shared` cuts a layer into them), one
 *   secret, one forge sign-in's mark, or one agent's sign-in. Each is known here by a key —
 *   `base:["appearance","mode"]`, `secret:GITHUB_TOKEN`, `mark:GITHUB_TOKEN`, `login:claude-cli`. A
 *   setting of the person's for one project is keyed by the project as well as its path —
 *   `projectYou:["github.com_me_atlas","appearance","mode"]` — the project by its settings key
 *   (`projectSettingsKey`), which is its repository identity and so the same on every machine with a
 *   clone of it. A clone with no remote is keyed by where it is on its machine, which names nothing on
 *   another: its settings stay where they are (the engine's `projectKeys` names only the others).
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
 * - **Agents' sign-ins** (amended 2026-11-19). Only a sign-in that could work is sent or taken: not one
 *   the agent wiped after a refused refresh (Claude Code empties both tokens and keeps the account), not
 *   one expired, not one this machine's check or a run found not working (`loginStateOf`, `loginWorks`).
 *   A machine whose own sign-in works keeps it and passes over another's, since two machines refreshing
 *   one copy spend each other's refresh token; once its own stops working, it asks every machine for
 *   theirs and takes the newest different one that could work (`recoverLogin`).
 * - **What another machine sends is checked** as a settings save is: laid into the layer it belongs
 *   to, the layer must still load with every open project. One that would not is left out, and said.
 * - **Files** (amended 2026-11-18). The permission sets, workflows and prompts of Shared, Just you and
 *   the person's for each project — `permission-sets/`, `workflows/` and `prompts/` under `<base>/`,
 *   `<base>/personal/` and `<base>/projects/<key>/` (`SYNCED_FILE_FOLDERS`) — each file a piece,
 *   `file:["you","permission-sets","work","careful.json"]`, `file:["projectYou","<key>","workflows",…]`,
 *   its value the file's bytes. Nothing outside those folders is read to be sent. Written whole, as they
 *   are, as a hand edit would be: a file is not a setting and is not checked. A link is never followed,
 *   a file over 1 MB stays where it is (and the log says so), and a path another machine sends is taken
 *   only when every name on it is one file name inside its folder.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import {
  canonicalJson,
  isProjectSettingsKey,
  isSyncedFilePath,
  jairaBasePaths,
  layPiece,
  PERSONAL_LAYER_DIR_NAME,
  PROJECT_SETTINGS_DIR_NAME,
  settingsPieces,
  SYNCED_FILE_FOLDERS,
  SYNCED_FILE_MAX_BYTES,
  type SettingsSyncView,
  type SyncedFileLayer,
  type SyncedLayer,
} from "@jaira/shared";
import { loginStateOf, type AgentLoginStore } from "./agentLogins";
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
  /** Whether it has looked at its files before: the first look at them, on a machine that had looked at its settings, stamps them by their age too. */
  lookedFiles?: boolean;
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
  /**
   * Whether this machine's own sign-in for an agent works, as far as this machine has seen: `false` when
   * its check found it signed out or a run's call on it was refused, `true` when it was seen to work,
   * undefined when nothing has said. A sign-in that does not work is neither sent nor kept over one
   * another machine sends. Absent: never known.
   */
  loginWorks?(agent: string): boolean | undefined;
  /**
   * The settings keys of this machine's projects whose person's settings follow: those keyed by a
   * repository identity (`projectSettingsKey`), never a clone with no remote. Absent: none follow.
   */
  projectKeys?(): string[];
  /** The person's settings for one project, by its key, as on disk now (`null`: no file); undefined when it cannot be read. */
  readProjectLayer?(key: string): { doc: JsonValue | null; at: number } | undefined;
  /** Throw, naming the field, when the person's settings for this project written this way would not load. */
  checkProjectLayer?(key: string, doc: JsonValue): void;
  writeProjectLayer?(key: string, doc: JsonValue): void;
  /**
   * Something another machine sent was laid in here: what kinds, for the engine to re-read, and which
   * agents' sign-ins were written.
   */
  changed(kinds: ReadonlySet<PieceKind>, logins?: ReadonlySet<string>): void;
  log(level: "info" | "warn", message: string): void;
}

export type PieceKind = "base" | "you" | "projectYou" | "secret" | "mark" | "login" | "file";

/** Names in the keychain that are the machine's own: the tokens it holds for other machines. */
const isMachineSecret = (name: string): boolean => name.startsWith("jaira.");

const LAYERS: readonly SyncedLayer[] = ["base", "you"];

/** How many files one synced folder may hold before the rest are left out of a look (and said). */
const MAX_FILES_PER_FOLDER = 5_000;

export function pieceKey(kind: PieceKind, id: string | readonly string[]): string {
  return `${kind}:${typeof id === "string" ? id : JSON.stringify(id)}`;
}

/**
 * A key's kind; undefined for one this JaiRA does not know — which is how a newer machine's pieces are
 * passed over by an older one (an engine before 2026-11-18 passes over `file`), and how this one passes
 * over what a newer one may add.
 */
function kindOf(key: string): PieceKind | undefined {
  const kind = key.slice(0, key.indexOf(":"));
  return kind === "base" || kind === "you" || kind === "projectYou" || kind === "secret" || kind === "mark" || kind === "login" || kind === "file" ? kind : undefined;
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

/** A `projectYou` key's project and the path in its settings; undefined when it is not one. */
function projectPathOf(key: string): { project: string; path: string[] } | undefined {
  const all = pathOf(key);
  if (all === undefined || all.length < 2) return undefined;
  const [project, ...path] = all;
  return isProjectSettingsKey(project!) ? { project: project!, path } : undefined;
}

/** A file that follows, where it is: its layer, the project for the person's own in one, and its path under the layer's root. */
interface FilePlace {
  layer: SyncedFileLayer;
  project?: string;
  /** Starting with its synced folder: `["permission-sets","work","careful.json"]`. */
  path: string[];
}

/**
 * A `file` key's place; undefined when it names no file that follows — a layer that is not one of the
 * three, a project key that is not one folder name, a path that is not one file inside a synced folder.
 */
function fileOf(key: string): FilePlace | undefined {
  if (kindOf(key) !== "file") return undefined;
  const [layer, ...rest] = pathOf(key) ?? [];
  if (layer === "base" || layer === "you") return isSyncedFilePath(rest) ? { layer, path: rest } : undefined;
  if (layer !== "projectYou") return undefined;
  const [project, ...path] = rest;
  return project !== undefined && isProjectSettingsKey(project) && isSyncedFilePath(path) ? { layer, project, path } : undefined;
}

const fileKey = (place: FilePlace): string => pieceKey("file", [place.layer, ...(place.project !== undefined ? [place.project] : []), ...place.path]);

/** The folders from the shared root down to a layer's root: none for Shared. */
const rootPartsOf = (layer: SyncedFileLayer, project?: string): string[] =>
  layer === "base" ? [] : layer === "you" ? [PERSONAL_LAYER_DIR_NAME] : [PROJECT_SETTINGS_DIR_NAME, project!];

/** The folder a file's removal is told against: `file:you:permission-sets`, `file:projectYou:<key>:workflows`. */
const folderUnit = (layer: SyncedFileLayer, project: string | undefined, folder: string): string => `file:${layer}${project !== undefined ? `:${project}` : ""}:${folder}`;

/** The project a piece is the person's for — a setting of theirs for it, or a file of theirs in it. */
function projectOf(key: string): string | undefined {
  const kind = kindOf(key);
  return kind === "projectYou" ? projectPathOf(key)?.project : kind === "file" ? fileOf(key)?.project : undefined;
}

/**
 * What a removal is told against: the file a piece is in was read (`base`, `you`, `mark`,
 * `projectYou:<key>`), or for a file, the whole folder it is in (`file:base:permission-sets`).
 */
function unitOf(key: string): string | undefined {
  const kind = kindOf(key);
  if (kind === "file") {
    const at = fileOf(key);
    return at === undefined ? undefined : folderUnit(at.layer, at.project, at.path[0]!);
  }
  if (kind !== "projectYou") return kind;
  const project = projectPathOf(key)?.project;
  return project === undefined ? undefined : `projectYou:${project}`;
}

/** A file's bytes from a piece's value (`{base64}`); undefined when the value is not one. */
function bytesOf(value: JsonValue | undefined): Buffer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) return undefined;
  const text = (value as Record<string, JsonValue>)["base64"];
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.from(text, "base64");
  // Only the one spelling a machine sends, so what is written reads back as the value that came.
  return bytes.toString("base64") === text ? bytes : undefined;
}

/** The size cap as a sentence says it. */
const CAP_WORDS = `${SYNCED_FILE_MAX_BYTES / (1024 * 1024)} MB`;

const hashOf = (value: JsonValue): string => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32);

/** Is `a` a later change than `b`? Ties go to the machine whose id sorts last, the same on every machine. */
export function newer(a: SyncStamp, b: SyncStamp | undefined): boolean {
  return b === undefined || a.at > b.at || (a.at === b.at && a.by > b.by);
}

/** What a piece is called in a sentence. */
function wordsOf(key: string): string {
  const kind = kindOf(key);
  if (kind === "base" || kind === "you") return `${kind === "base" ? "Shared" : "Just you"} ${pathOf(key)?.join(".") ?? idOf(key)}`;
  if (kind === "projectYou") {
    const at = projectPathOf(key);
    return at !== undefined ? `Just you in ${at.project} ${at.path.join(".")}` : `Just you in a project ${idOf(key)}`;
  }
  if (kind === "file") {
    const at = fileOf(key);
    if (at === undefined) return `the file ${idOf(key)}`;
    return `${at.layer === "base" ? "Shared" : at.layer === "you" ? "Just you" : `Just you in ${at.project}`} ${at.path.join("/")}`;
  }
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
  /** What the log has been told about a file left here, so a look once a minute says it once. */
  private readonly told = new Set<string>();
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
        ...(raw.lookedFiles === true ? { lookedFiles: true } : {}),
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
   * the files whose removals can be told (they were read): `base`, `you`, `mark`, `projectYou:<key>`,
   * and each synced folder read whole (`file:you:permission-sets`); and the files seen and not sent
   * (over the cap, a link, unreadable), which are not removals either.
   */
  private collect(file: SyncFile = this.read()): { here: Map<string, { value: JsonValue; hash: string; age: number }>; read: Set<string>; kept: Set<string> } {
    const here = new Map<string, { value: JsonValue; hash: string; age: number }>();
    const read = new Set<string>();
    const kept = new Set<string>();
    const ports = this.options.ports;
    const places: Array<{ layer: SyncedFileLayer; project?: string }> = [{ layer: "base" }, { layer: "you" }, ...this.projectKeys(file, true).map((project) => ({ layer: "projectYou" as const, project }))];
    for (const place of places) {
      for (const folder of SYNCED_FILE_FOLDERS) {
        if (this.readFolder({ ...place, path: [folder] }, here, kept)) read.add(folderUnit(place.layer, place.project, folder));
      }
    }
    for (const layer of LAYERS) {
      const found = ports.readLayer(layer);
      if (found === undefined) continue;
      read.add(layer);
      for (const piece of settingsPieces(found.doc)) here.set(pieceKey(layer, piece.path), { value: piece.value, hash: hashOf(piece.value), age: found.at });
    }
    for (const project of this.projectKeys(file)) {
      const found = ports.readProjectLayer?.(project);
      if (found === undefined) continue;
      read.add(`projectYou:${project}`);
      for (const piece of settingsPieces(found.doc)) here.set(pieceKey("projectYou", [project, ...piece.path]), { value: piece.value, hash: hashOf(piece.value), age: found.at });
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
      // Only a sign-in that could work is offered: not one the agent wiped after a refused refresh, not
      // one expired, not one this machine's check or a run found not working. Not being here is not a
      // removal (`scan`), so the last good one's stamp stays and nothing is sent until it works again.
      if (login === undefined || !loginStateOf(store.agent, login.value).usable || ports.loginWorks?.(store.agent) === false) continue;
      here.set(pieceKey("login", store.agent), { value: login.value, hash: hashOf(login.value), age: login.at });
    }
    return { here, read, kept };
  }

  /**
   * The projects whose person's settings and files are kept in step here: this machine's own, keyed by
   * a repository identity, and every one another machine has sent either for — a project not cloned here
   * keeps them for when it is, and their later changes and removals still travel. `files`: asked for the
   * files, which an engine with nowhere to keep a project's settings still keeps.
   */
  private projectKeys(file: SyncFile, files = false): string[] {
    if (!files && this.options.ports.readProjectLayer === undefined) return [];
    const keys = new Set((this.options.ports.projectKeys?.() ?? []).filter(isProjectSettingsKey));
    for (const key of [...Object.keys(file.pieces), ...Object.keys(file.passed ?? {})]) {
      const project = projectOf(key);
      if (project !== undefined) keys.add(project);
    }
    return [...keys];
  }

  /** Say something about a file left here once, not at every look. */
  private tellOnce(what: string, message: string): void {
    if (this.told.has(what)) return;
    this.told.add(what);
    this.options.ports.log("info", message);
  }

  /**
   * The files of one synced folder (`place.path` is the folder alone) into `here`, and what was seen and
   * not sent into `kept`. Returns whether the folder was read whole — only then is a file missing from it
   * a removal. A folder that is not there is read, and empty. A link, on the way down to it or inside it,
   * is never followed.
   */
  private readFolder(place: FilePlace, here: Map<string, { value: JsonValue; hash: string; age: number }>, kept: Set<string>): boolean {
    const folder = place.path[0]!;
    let dir = jairaBasePaths(this.options.baseDir).baseDir;
    for (const part of [...rootPartsOf(place.layer, place.project), folder]) {
      dir = join(dir, part);
      let stat: Stats;
      try {
        stat = lstatSync(dir);
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        this.tellOnce(`link:${dir}`, `settings sync does not follow ${dir}: it is ${stat.isSymbolicLink() ? "a link" : "not a folder"}, so what is in it stays on this machine`);
        return false;
      }
    }
    let whole = true;
    let count = 0;
    const walk = (at: string, path: string[]): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(at, { withFileTypes: true });
      } catch {
        whole = false;
        return;
      }
      for (const entry of entries) {
        if (!whole) return;
        const parts = [...path, entry.name];
        const key = fileKey({ ...place, path: parts });
        if (!isSyncedFilePath(parts)) {
          // Hidden files and an editor's backups are not news; a name another machine may not hold is.
          if (!entry.name.startsWith(".") && !entry.name.endsWith("~")) this.tellOnce(`name:${key}`, `${wordsOf(key)} stays on this machine: not every machine can hold a file by that name, or that deep`);
          continue;
        }
        const full = join(at, entry.name);
        if (entry.isSymbolicLink()) {
          kept.add(key);
          this.tellOnce(`link:${full}`, `${wordsOf(key)} is a link, which settings sync does not follow, so it stays on this machine`);
          continue;
        }
        if (entry.isDirectory()) {
          walk(full, parts);
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        if (count > MAX_FILES_PER_FOLDER) {
          whole = false;
          this.tellOnce(`many:${folderUnit(place.layer, place.project, folder)}`, `${wordsOf(key).replace(/\/.*$/, "/")} holds more than ${MAX_FILES_PER_FOLDER} files: the rest stay on this machine`);
          return;
        }
        try {
          const stat = statSync(full);
          if (stat.size > SYNCED_FILE_MAX_BYTES) {
            kept.add(key);
            this.tellOnce(`big:${key}`, `${wordsOf(key)} is over ${CAP_WORDS}, so it stays on this machine`);
            continue;
          }
          const value: JsonValue = { base64: readFileSync(full).toString("base64") };
          here.set(key, { value, hash: hashOf(value), age: stat.mtimeMs });
        } catch {
          // Unreadable this moment: neither sent nor a removal.
          kept.add(key);
        }
      }
    };
    walk(dir, [folder]);
    return whole;
  }

  /**
   * Write one file another machine sent where its key says, whether or not the project is cloned here,
   * or remove it (`bytes` undefined). Every folder on the way down from the shared root is looked at
   * first: a link is not followed, a file is not taken for a folder, and a name here in another case —
   * the same file on a disk that ignores case — is not laid over. Written to a hidden file beside it and
   * renamed into place, so nothing reads half a file.
   */
  private placeFile(place: FilePlace, bytes: Buffer | undefined): void {
    const base = jairaBasePaths(this.options.baseDir).baseDir;
    const parts = [...rootPartsOf(place.layer, place.project), ...place.path];
    const target = resolve(base, ...parts);
    const rel = relative(base, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("it is outside its folder");
    let dir = base;
    for (const [i, part] of parts.entries()) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        break; // Not there: neither is anything below it.
      }
      const shown = parts.slice(0, i + 1).join("/");
      if (!names.includes(part)) {
        if (names.some((name) => name.toLowerCase() === part.toLowerCase())) throw new Error(`${shown} is here under a name in another case`);
        break;
      }
      const at = join(dir, part);
      const stat = lstatSync(at);
      if (stat.isSymbolicLink()) throw new Error(`${shown} is a link here, which settings sync does not follow`);
      const last = i === parts.length - 1;
      if (!last && !stat.isDirectory()) throw new Error(`${shown} is a file here, not a folder`);
      if (last && !stat.isFile()) throw new Error(`${shown} is a folder here`);
      if (last && stat.size > SYNCED_FILE_MAX_BYTES) throw new Error(`the file here is over ${CAP_WORDS}, which stays on this machine`);
      dir = at;
    }
    if (bytes === undefined) {
      rmSync(target, { force: true });
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.${parts[parts.length - 1]}.jaira-sync`);
    writeFileSync(temp, bytes);
    renameSync(temp, target);
  }

  /**
   * Read every piece again and stamp what changed since the last look. Returns the keys that changed.
   * The first look ever stamps each piece as old as its file says, not now.
   */
  scan(): string[] {
    if (!this.on()) return [];
    const file = this.read();
    const { here, read, kept } = this.collect(file);
    const changed: string[] = [];
    const first = file.looked !== true;
    // Files are looked at for the first time on a machine that had looked at its settings before them
    // (an engine from before 2026-11-18): they too are as old as they are, not changed now.
    const firstFiles = file.lookedFiles !== true;
    // A project's settings, or its files, first kept in step now — a workspace of it opened here since
    // the first look — were not changed now: they are stamped by their file's age, as the first look
    // stamps everything.
    const everKey = [...Object.keys(file.pieces), ...Object.keys(file.passed ?? {})];
    const known = { projectYou: new Set<string>(), file: new Set<string>() };
    for (const key of everKey) {
      const kind = kindOf(key);
      const project = projectOf(key);
      if ((kind === "projectYou" || kind === "file") && project !== undefined) known[kind].add(project);
    }
    for (const [key, piece] of here) {
      const held = file.pieces[key];
      if (held?.hash === piece.hash) continue;
      const kind = kindOf(key);
      const project = projectOf(key);
      const lateProject = (kind === "projectYou" || kind === "file") && project !== undefined && !known[kind].has(project);
      const fresh = held === undefined && (first || (kind === "file" && firstFiles) || lateProject);
      const at = fresh ? Math.min(piece.age, Date.now()) : this.tick(file);
      file.clock = Math.max(file.clock, at);
      file.pieces[key] = { at, by: this.self, hash: piece.hash };
      changed.push(key);
    }
    for (const [key, held] of Object.entries(file.pieces)) {
      const kind = kindOf(key);
      const unit = unitOf(key);
      // A setting, a mark or a file gone from what was read is removed; a secret or a sign-in only
      // through `removed`; a file seen and not sent (over the cap, a link) is not gone.
      if (held.hash === undefined || here.has(key) || kept.has(key) || kind === undefined || kind === "secret" || kind === "login" || unit === undefined || !read.has(unit)) continue;
      file.pieces[key] = { at: this.tick(file), by: this.self };
      changed.push(key);
    }
    if (first || firstFiles || changed.length > 0) this.write({ ...file, looked: true, lookedFiles: true });
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

  /** What this machine holds that is newer than `theirs`: the answer to `settings:pull` — only `only`'s keys, when named. */
  answer(theirs: Record<string, SyncStamp>, only?: readonly string[]): SyncedPiece[] {
    if (!this.on()) return [];
    this.scan();
    const file = this.read();
    const asked = only !== undefined ? new Set(only) : undefined;
    const keys = new Set(Object.entries(file.pieces).filter(([key, held]) => (asked === undefined || asked.has(key)) && newer(held, theirs[key])).map(([key]) => key));
    return this.piecesOf(keys);
  }

  /** The pieces named, with what each holds here now; a removal travels without a value. */
  private piecesOf(keys: ReadonlySet<string>): SyncedPiece[] {
    const file = this.read();
    const { here } = this.collect(file);
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
    const layDocument = (
      pieces: readonly SyncedPiece[],
      io: { name: string; read: () => { doc: JsonValue | null; at: number } | undefined; check: (doc: JsonValue) => void; write: (doc: JsonValue) => void; pathIn: (key: string) => string[] | undefined; keyOf: (path: string[]) => string },
    ): boolean => {
      if (pieces.length === 0) return false;
      const found = io.read();
      if (found === undefined) {
        // Unreadable here: nothing is laid over it, and the pieces are asked for again next time.
        ports.log("warn", `${io.name} could not be read, so ${from}'s changes to them wait`);
        return false;
      }
      let doc: JsonValue | null = found.doc;
      const laid: SyncedPiece[] = [];
      const lay = (onto: JsonValue | null, piece: SyncedPiece): { doc: JsonValue; kept: boolean } | undefined => {
        const path = io.pathIn(piece.key);
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
      if (laid.length === 0) return false;
      let accepted: SyncedPiece[] = laid;
      try {
        io.check(whole ?? {});
        doc = whole;
      } catch {
        accepted = [];
        for (const piece of laid) {
          const next = lay(doc, piece)!;
          try {
            io.check(next.doc);
            doc = next.doc;
            accepted.push(piece);
          } catch (e) {
            pass(piece, (e as Error).message);
          }
        }
      }
      if (accepted.length === 0) return false;
      try {
        io.write(doc ?? {});
      } catch (e) {
        for (const piece of accepted) pass(piece, (e as Error).message);
        return false;
      }
      // The hash of each as this machine now reads it back, so the next look sees no change of its own.
      const back = new Map(settingsPieces(doc).map((p) => [io.keyOf(p.path), hashOf(p.value)]));
      for (const piece of accepted) hold(piece, back.get(piece.key));
      return true;
    };
    for (const layer of LAYERS) {
      const laid = layDocument(
        wanted.filter((p) => kindOf(p.key) === layer),
        {
          name: `${layer === "base" ? "Shared" : "Just you"} settings`,
          read: () => ports.readLayer(layer),
          check: (doc) => ports.checkLayer(layer, doc),
          write: (doc) => ports.writeLayer(layer, doc),
          pathIn: pathOf,
          keyOf: (path) => pieceKey(layer, path),
        },
      );
      if (laid) taken.add(layer);
    }
    // The person's settings for each project, a project at a time — written where that project's key
    // says, whether or not it is cloned here.
    const byProject = new Map<string, SyncedPiece[]>();
    for (const piece of wanted.filter((p) => kindOf(p.key) === "projectYou")) {
      const project = projectPathOf(piece.key)?.project;
      if (project === undefined) {
        pass(piece, "not a project's settings");
        continue;
      }
      byProject.set(project, [...(byProject.get(project) ?? []), piece]);
    }
    const { readProjectLayer, checkProjectLayer, writeProjectLayer } = ports;
    for (const [project, pieces] of byProject) {
      // An engine with nowhere to keep them: asked for again at the next pull.
      if (readProjectLayer === undefined || checkProjectLayer === undefined || writeProjectLayer === undefined) break;
      const laid = layDocument(pieces, {
        name: `your settings for ${project}`,
        read: () => readProjectLayer(project),
        check: (doc) => checkProjectLayer(project, doc),
        write: (doc) => writeProjectLayer(project, doc),
        pathIn: (key) => projectPathOf(key)?.path,
        keyOf: (path) => pieceKey("projectYou", [project, ...path]),
      });
      if (laid) taken.add("projectYou");
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
    const wroteLogins = new Set<string>();
    for (const piece of wanted.filter((p) => kindOf(p.key) === "login")) {
      const agent = idOf(piece.key);
      const store = stores.get(agent);
      // Not followed here (agents in WSL, a keychain that refused): asked for again at the next pull.
      if (store === undefined || store.unavailable() !== undefined) continue;
      if (piece.value !== undefined && typeof piece.value !== "string") {
        pass(piece, "not a sign-in");
        continue;
      }
      // A sign-in that could not work is never laid over anything (an older JaiRA still sends them).
      if (piece.value !== undefined && !loginStateOf(agent, piece.value).usable) {
        pass(piece, "it is signed out or expired");
        continue;
      }
      // A sign-in that works here is kept: two machines refreshing one copy spend each other's refresh
      // token, so each keeps its own while it works, and takes another's only when its own stops
      // (`recoverLogin`). Passed without a word: nothing went wrong.
      if (piece.value !== undefined && this.loginWorksHere(store)) {
        pass(piece);
        continue;
      }
      try {
        if (piece.value === undefined) store.remove();
        else store.write(piece.value);
        hold(piece, piece.value === undefined ? undefined : hashOf(store.read()?.value ?? piece.value));
        taken.add("login");
        wroteLogins.add(agent);
      } catch (e) {
        pass(piece, (e as Error).message);
      }
    }

    // Files, one at a time, written whole where the key says — a project's whether or not it is cloned
    // here. A path that is not one file inside a synced folder, a project key that is not one folder
    // name, and anything over the cap are passed over, and said.
    for (const piece of wanted.filter((p) => kindOf(p.key) === "file")) {
      const place = fileOf(piece.key);
      if (place === undefined) {
        pass(piece, "it is not a permission set, workflow or prompt inside its folder");
        continue;
      }
      const bytes = piece.value === undefined ? undefined : bytesOf(piece.value);
      if (piece.value !== undefined && bytes === undefined) {
        pass(piece, "not a file");
        continue;
      }
      if (bytes !== undefined && bytes.length > SYNCED_FILE_MAX_BYTES) {
        pass(piece, `it is over ${CAP_WORDS}`);
        continue;
      }
      try {
        this.placeFile(place, bytes);
        hold(piece, piece.value === undefined ? undefined : hashOf(piece.value));
        taken.add("file");
      } catch (e) {
        pass(piece, (e as Error).message);
      }
    }

    const count = wanted.filter((p) => file.pieces[p.key]?.at === p.at && file.pieces[p.key]?.by === p.by).length;
    if (count > 0) file.at = Date.now();
    this.write(file);
    if (taken.size > 0) {
      ports.log("info", `took ${count} setting${count === 1 ? "" : "s"} from ${from}`);
      ports.changed(taken, wroteLogins);
    }
    return count;
  }

  /** Whether this machine's own sign-in for this agent is there, could work, and is not known not to. */
  private loginWorksHere(store: AgentLoginStore): boolean {
    let mine: { value: string } | undefined;
    try {
      mine = store.read();
    } catch {
      return false;
    }
    return mine !== undefined && loginStateOf(store.agent, mine.value).usable && this.options.ports.loginWorks?.(store.agent) !== false;
  }

  /**
   * This machine's sign-in for an agent stopped working: ask every machine online for the one it holds,
   * and lay in the newest that could work and is not the one here — even one passed over earlier while
   * this machine's own still worked. Returns the label of the machine it came from, or undefined when
   * no machine had a different one to give (so a sign-in that fails everywhere is not taken back and
   * forth).
   */
  async recoverLogin(agent: string): Promise<string | undefined> {
    if (!this.on() || this.closed) return undefined;
    const store = this.options.ports.logins().find((one) => one.agent === agent);
    if (store === undefined || store.unavailable() !== undefined) return undefined;
    const key = pieceKey("login", agent);
    let mine: string | undefined;
    try {
      mine = store.read()?.value;
    } catch {
      mine = undefined;
    }
    const mineHash = mine !== undefined ? hashOf(mine) : undefined;
    // Every stamp but this one's, so a machine answers with its sign-in however old; `keys` keeps a
    // newer JaiRA's answer to it alone, and an older one's answer is filtered here.
    const stamps = this.stamps();
    delete stamps[key];
    let best: { piece: SyncedPiece & { value: string }; from: string } | undefined;
    for (const peer of this.options.fleet.peers()) {
      const client = this.options.fleet.client(peer.id);
      if (client === undefined || peer.state !== "online") continue;
      let pieces: unknown;
      try {
        pieces = ((await client.invoke("settings:pull", { stamps, keys: [key] })) as { pieces?: unknown } | null)?.pieces;
      } catch {
        continue;
      }
      for (const piece of Array.isArray(pieces) ? (pieces as SyncedPiece[]) : []) {
        if (piece?.key !== key || typeof piece.value !== "string" || typeof piece.at !== "number" || typeof piece.by !== "string") continue;
        if (!loginStateOf(agent, piece.value).usable || hashOf(piece.value) === mineHash) continue;
        if (best === undefined || newer(piece, best.piece)) best = { piece: piece as SyncedPiece & { value: string }, from: this.options.fleet.labelOf(peer.id) };
      }
    }
    if (best === undefined) return undefined;
    try {
      store.write(best.piece.value);
    } catch (e) {
      this.options.ports.log("warn", `${agent}'s sign-in from ${best.from} could not be written here: ${(e as Error).message}`);
      return undefined;
    }
    const file = this.read();
    file.clock = Math.max(file.clock, best.piece.at);
    let back: string | undefined;
    try {
      back = store.read()?.value;
    } catch {
      back = undefined;
    }
    file.pieces[key] = { at: best.piece.at, by: best.piece.by, hash: hashOf(back ?? best.piece.value) };
    if (file.passed?.[key] !== undefined) delete file.passed[key];
    file.at = Date.now();
    this.write(file);
    this.options.ports.log("info", `${agent}'s sign-in here stopped working: took the one ${best.from} holds`);
    this.options.ports.changed(new Set(["login"]), new Set([agent]));
    return best.from;
  }

  // --- what Settings shows ----------------------------------------------------------------------------------

  view(): SettingsSyncView {
    const file = this.read();
    const counts = { settings: 0, secrets: 0, signIns: 0, logins: 0, files: 0 };
    for (const [key, held] of Object.entries(file.pieces)) {
      if (held.hash === undefined) continue;
      const kind = kindOf(key);
      if (kind === "base" || kind === "you" || kind === "projectYou") counts.settings += 1;
      else if (kind === "secret") counts.secrets += 1;
      else if (kind === "mark") counts.signIns += 1;
      else if (kind === "login") counts.logins += 1;
      else if (kind === "file") counts.files += 1;
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
      "settings:pull": ((request: { stamps?: Record<string, SyncStamp>; keys?: unknown }) => {
        const keys = Array.isArray(request?.keys) ? request.keys.filter((key): key is string => typeof key === "string").slice(0, 100) : undefined;
        return { pieces: this.answer(typeof request?.stamps === "object" && request.stamps !== null ? request.stamps : {}, keys) };
      }) as (request: never) => unknown,
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
