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

export interface MachinesView {
  self: MachineView & { reach: MachineReach; version: string };
  machines: PeerView[];
  /** The code being shown under Pair a machine, while it is valid. */
  pairing?: { code: string; expiresAt: number };
}

/** How long a pairing code works. */
export const PAIRING_CODE_MS = 10 * 60 * 1000;

/** The URL an engine's WebSocket is at, from the address a person types or a machine publishes. */
export function engineUrlOf(address: string): string {
  let text = address.trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = "/engine";
  url.search = "";
  url.hash = "";
  return url.toString();
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
