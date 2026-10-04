/**
 * The fleet as the window sees it (decision 0013 §1–§3): this machine, the machines it is paired with,
 * and the pairing code it is showing, for Settings → Machines.
 */
import type { ChatSettings } from "./operationVocabulary";

export type MachineOsTag = "windows" | "mac" | "linux";

/** How this machine is reached from the others. */
export interface MachineReach {
  /**
   * `off`: not published. `on`: published at {@link url}. `starting`: being published.
   * `unavailable`: wanted, but nothing can publish it — see {@link reason}.
   */
  state: "off" | "on" | "starting" | "unavailable";
  /** `https://desk.tail4c2e.ts.net` — what another machine types to pair with this one. */
  url?: string;
  /** Which Tailscale publishes it: the installed app, or JaiRA's bundled helper. */
  via?: "tailscale" | "helper";
  reason?: string;
  /** The helper needs a one-time sign-in to the tailnet: the page to open. */
  signInUrl?: string;
}

/**
 * What a machine IS, for the icon that stands for it. Guessed where the machine can tell (a battery is
 * a laptop) and the person's to correct, in Settings → Machines.
 */
export type MachineForm = "desktop" | "laptop" | "mini" | "server";

export const MACHINE_FORMS: readonly MachineForm[] = ["desktop", "laptop", "mini", "server"];

/** A stored or received form, when it is one; a machine that never said is a desktop. */
export function machineFormOf(raw: unknown): MachineForm {
  return MACHINE_FORMS.includes(raw as MachineForm) ? (raw as MachineForm) : "desktop";
}

export interface MachineView {
  id: string;
  label: string;
  os: MachineOsTag;
  form: MachineForm;
  /** The person's tags, not counting the OS. */
  tags: string[];
}

export interface PeerView extends MachineView {
  url?: string;
  /** `online`: connected now. `mismatch`: connected, but on another contract — see {@link version}. */
  state: "online" | "offline" | "connecting" | "mismatch";
  version?: string;
  lastSeenAt?: number;
  /** Why it is not online, when known. */
  reason?: string;
  /** It can reach this machine: it holds a token this machine issued. */
  canReachHere: boolean;
}

/**
 * A phone or a browser paired with this machine (decision 0013, amended 2026-09-30): a window onto its
 * engine, which holds a token this machine issued and nothing else. Listed so it can be forgotten.
 */
export interface DeviceView {
  id: string;
  label: string;
  kind: "phone" | "browser";
  pairedAt: number;
  /** When it last said hello with its token. */
  lastUsedAt?: number;
  /** It has a connection open now. */
  connected: boolean;
}

export interface MachinesView {
  /**
   * `copy`: what of the other machines' tasks this one keeps a copy of (decision 0013 §6). `port`: the
   * loopback port its engine listens on for other machines and devices, while it does — what Tailscale
   * publishes, and what `adb reverse` points an emulator at.
   */
  self: MachineView & { reach: MachineReach; version: string; copy: CopyChoice; port?: number };
  machines: PeerView[];
  /** The phones and browsers that hold a token for this machine. */
  devices: DeviceView[];
  /**
   * The code being shown under Pair a machine, while it is valid. `nearby`: phones on this machine's
   * local network can find it to pair (decision 0013, amended 2026-10-04).
   */
  pairing?: { code: string; expiresAt: number; nearby?: boolean };
  /**
   * A phone that proved the code over the local network and is joining the tailnet. `signInUrl`: its
   * Tailscale sign-in page, opened in the browser; approving it there lets the phone on.
   */
  phone?: { label: string; signInUrl?: string };
}

/**
 * What of the other machines' tasks this machine keeps a copy of (decision 0013 §6; the person,
 * 2026-09-27: "we can do not archived with everything as a choice"):
 *
 *  - `everything` — every task of every workspace;
 *  - `not-archived` — every task that is not archived: one archived on its machine leaves the copy;
 *  - `chosen` — the tasks that are not archived, of the projects in {@link projects} only;
 *  - `nothing` — no copy, and the one kept so far is removed.
 */
export interface CopyChoice {
  mode: "everything" | "not-archived" | "chosen" | "nothing";
  /** For `chosen`: the remote project keys (`jaira-machine://…`) to copy. */
  projects?: string[];
}

/** How long a pairing code works. */
export const PAIRING_CODE_MS = 10 * 60 * 1000;

/**
 * The URL an engine's WebSocket is at, from the address a person types or a machine publishes.
 *
 * - A name is reached over TLS: `desk.tail4c2e.ts.net` is `wss://desk.tail4c2e.ts.net/engine`, which is
 *   what Tailscale serves.
 * - An address that says `http://` (or `ws://`) is taken at its word.
 * - A bare IP address or `localhost` is plain too, since nothing holds a certificate for one: the
 *   loopback listener itself, as an emulator reaches it through `adb reverse` (`127.0.0.1:47318`), or
 *   a tailnet address the helper serves without certificates.
 *
 * Read with a pattern rather than `URL`: a phone parses addresses too, and React Native's `URL` has no
 * setters.
 */
export function engineUrlOf(address: string): string {
  const parts = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?(?:[/?#].*)?$/i.exec(address.trim());
  if (parts === null) throw new Error(`'${address}' is not an address`);
  const scheme = parts[1]?.toLowerCase();
  const host = parts[2]!.toLowerCase();
  const literal = host === "localhost" || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const plain = scheme === undefined ? literal : scheme === "http" || scheme === "ws";
  const port = parts[3] !== undefined && Number(parts[3]) !== (plain ? 80 : 443) ? `:${Number(parts[3])}` : "";
  return `${plain ? "ws" : "wss"}://${host}${port}/engine`;
}

/** The host (and port) of an engine URL, for saying where something is. */
export function hostOfUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(url)?.[1] ?? url;
}

/** A pairing code as people read and type it: spaces, dots and case do not matter. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A repository's identity across clones and machines (decision 0013 §4): its remote URL with the scheme,
 * credentials, port, `.git` and the host's case taken off. `git@github.com:Me/Repo.git`,
 * `https://me@github.com/Me/Repo` and `ssh://git@github.com:22/Me/Repo.git` are all `github.com/Me/Repo`.
 * The path keeps its case: some forges treat it as significant. Undefined for something that is not a
 * remote URL.
 */
export function repositoryIdentity(remoteUrl: string): string | undefined {
  let text = remoteUrl.trim();
  if (text === "") return undefined;
  // scp-like: user@host:path
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text);
  if (scp !== null && !/^[a-z]+:\/\//i.test(text)) text = `ssh://${scp[1]}/${scp[2]}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") return undefined;
  const host = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname)
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (host === "" || path === "") return undefined;
  return `${host}/${path}`;
}

/** The last part of an identity or directory: what a grouped project is called. */
export function projectNameOf(identityOrDir: string): string {
  const parts = identityOrDir.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? identityOrDir;
}

const REMOTE_PREFIX = "jaira-machine://";

/**
 * The project key of a workspace on another machine (decision 0013 §7): every project-scoped channel
 * takes it like a local directory, and the engine forwards the request to that machine.
 */
export function remoteProjectKey(machineId: string, dir: string): string {
  return `${REMOTE_PREFIX}${machineId}/${encodeURIComponent(dir)}`;
}

/** The machine and directory of a remote project key, or undefined for a local one. */
export function parseRemoteProjectKey(key: string | undefined): { machineId: string; dir: string } | undefined {
  if (key === undefined || !key.startsWith(REMOTE_PREFIX)) return undefined;
  const rest = key.slice(REMOTE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return { machineId: rest.slice(0, slash), dir: decodeURIComponent(rest.slice(slash + 1)) };
}

/** One workspace in a project's placement order (decision 0013 §5). */
export interface PlacementWorkspace {
  /** The workspace's project key: a directory here, a remote key elsewhere. */
  project: string;
  /** `machineId|dir`, what the order and caps are written by. */
  key: string;
  machineId: string;
  label: string;
  dir: string;
  self: boolean;
  cap?: number;
  running: number;
  /** Why it would take no new run now; absent when it would. */
  why?: string;
}

export interface PlacementView {
  identity?: string;
  workspaces: PlacementWorkspace[];
  /** Whether the person has set an order, or it is the default (other machines first). */
  ordered: boolean;
}

/**
 * Where the person asked for a task to run (decision 0013 §5, amended 2026-10-02). Absent: anywhere —
 * the first of the project's workspaces with room. A choice is kept: a task sent to a machine or a
 * workspace that has no room WAITS for it, and is never started somewhere else instead.
 */
export interface RunTarget {
  /** A machine, by id: the first of ITS workspaces with room. */
  machine?: string;
  /** One workspace, by its project key (a directory here, a remote key elsewhere). Wins over `machine`. */
  project?: string;
}

/** One workspace asked whether it has room, and what it answered. */
export interface PlacementAsk {
  at: number;
  /** The workspace's project key. */
  project: string;
  machineId: string;
  /** The machine's name. */
  label: string;
  dir: string;
  /** Why it took no new run; absent when it had room. */
  why?: string;
}

/** One thing done to get a placed task going, once it had somewhere to run. */
export interface StartStep {
  at: number;
  /** `workspace`: its worktree was made. `pin`: its workflow was frozen as it stood. */
  kind: "workspace" | "pin";
  /** What it was done to: the worktree's branch, the workflow's id. */
  what: string;
  tookMs: number;
}

/**
 * How a task came to run where it does — written once, when it starts, and drawn above the message
 * that started it (`jaira.placed`, `hostRows.ts`).
 */
export interface PlacementNote {
  /** When placing began. */
  since: number;
  /** When a workspace took it. */
  at: number;
  target?: RunTarget;
  /** Workspaces asked in all, and how many of those had no room. */
  asked: number;
  refused: number;
  /** How many times it waited before asking again. */
  waits: number;
  /** The round that placed it: every workspace asked, the one that took it last. */
  asks: PlacementAsk[];
  on: { project: string; machineId: string; label: string; dir: string };
  /** A person sent it there by hand ("Run on…"), room or none. */
  byHand?: true;
  /** What starting it then did. */
  steps?: StartStep[];
}

/** A task that has not started because nothing it may run on has room — or that is being placed now. */
export interface QueuedPlacement {
  taskId: string;
  project: string;
  requires: string[];
  since: number;
  /** `placing`: its workspaces are being asked for the first time. `waiting`: none had room. */
  phase: "placing" | "waiting";
  target?: RunTarget;
  /** What the composer picked for the start it waits for: the chips read it while there is no run to read. */
  settings?: ChatSettings;
  asked: number;
  refused: number;
  waits: number;
  /** The latest round. */
  asks: PlacementAsk[];
  /** When it last asked, and when it asks again. */
  askedAt?: number;
  nextAt?: number;
}

/** What a workspace's checkout says of itself: the git half of a session's shell environment. */
export interface WorkspaceGit {
  /** Absent when detached. */
  branch?: string;
  /** Commits on the branch that its upstream does not have. Absent with no upstream. */
  ahead?: number;
  /** Lines added and removed in the working tree since the last commit. */
  added?: number;
  removed?: number;
  /** The open merge request (or pull request) of the branch, when its forge has one and can be asked. */
  mergeRequest?: { provider: "gitlab" | "github"; number: number; url: string; state: "open" | "merged" | "closed"; draft?: true };
}

/** One workspace a conversation could run in. */
export interface EnvironmentWorkspace {
  /** Its project key: a directory here, a remote key elsewhere. */
  project: string;
  dir: string;
  /** Its folder's name. */
  label: string;
  /** Tasks running in it (a parked one is still running), and tasks waiting for it. */
  running: number;
  queued: number;
  git?: WorkspaceGit;
  /** Why it would take no new run now; absent when it would. */
  why?: string;
}

/** One machine of the fleet that has a workspace of the project, with how busy it is. */
export interface EnvironmentMachine {
  id: string;
  label: string;
  self: boolean;
  os: MachineOsTag;
  form: MachineForm;
  state: PeerView["state"];
  /** Its load, when it answered: cores, the share of them working (0–1), and memory in bytes. */
  cores?: number;
  cpu?: number;
  memoryFree?: number;
  memoryTotal?: number;
  workspaces: EnvironmentWorkspace[];
}

/**
 * Where a project's conversations can run, in the order tasks are placed (decision 0013 §5): what the
 * bar under the composer says and the list it opens offers.
 */
export interface EnvironmentView {
  identity?: string;
  machines: EnvironmentMachine[];
}

/** One folder's folders, for the picker (decision 0013 §8). */
export interface FolderListing {
  dir: string;
  /** The folder above, absent at a root. */
  parent?: string;
  entries: Array<{ name: string; path: string; project: boolean; git: boolean }>;
  /** The machine's roots to jump to: its home, and its drives on Windows. */
  roots: string[];
}

/** An answer waiting for a machine that is offline (decision 0013 §7). */
export interface OutboxView {
  id: string;
  /** The machine it waits for. */
  machine: string;
  /** What it is, in words: "a decision at a gate". */
  what: string;
  at: number;
}
