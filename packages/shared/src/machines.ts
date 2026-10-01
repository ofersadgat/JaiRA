/**
 * The fleet as the window sees it (decision 0013 §1–§3): this machine, the machines it is paired with,
 * and the pairing code it is showing, for Settings → Machines.
 */
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

export interface MachineView {
  id: string;
  label: string;
  os: MachineOsTag;
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
  /** The code being shown under Pair a machine, while it is valid. */
  pairing?: { code: string; expiresAt: number };
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

export interface QueuedPlacement {
  taskId: string;
  project: string;
  requires: string[];
  since: number;
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
