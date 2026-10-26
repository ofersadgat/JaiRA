/**
 * This machine on the tailnet (decision 0022): the one Tailscale sign-in, whichever Tailscale does it.
 *
 * - **The bundled helper** (`tailnetHelper.ts`) where the Tailscale app is not installed: JaiRA's own
 *   node, which JaiRA signs in and out, and which opens local doors for this process to reach the other
 *   devices, since only the helper is on the tailnet.
 * - **The Tailscale app** (`tailscale.ts`) where it is: the app signs in and out, and the OS routes to
 *   the other devices.
 * - **Loopback**, `JAIRA_REACH=loopback`: no tailnet at all, for trying the fleet with several homes on
 *   one machine. Development only, like `JAIRA_CAPTURE`.
 *
 * Only the default home connects (§2): any other gets a port that says why it cannot.
 */
import { isDefaultHome } from "@jaira/shared";
import { tailscaleApp, tailscaleCli } from "./tailscale";
import { HelperTailnet } from "./tailnetHelper";

/** This machine as the tailnet calls it. */
export interface TailnetSelf {
  id?: string;
  name: string;
  dnsName: string;
  ips: string[];
}

/** Another device on the tailnet. */
export interface TailnetPeer {
  id: string;
  name: string;
  dnsName: string;
  os: string;
  online: boolean;
  lastSeenAt?: number;
  ips: string[];
  /** Where to ask it whether JaiRA runs there; absent ⇒ the usual places on {@link dnsName}. */
  addresses?: string[];
}

/** What a port says while it runs. */
export type TailnetEvent =
  /** Waiting for the person to sign in on this page. */
  | { kind: "sign-in"; url: string }
  /** Signed in and on the tailnet; `url` is where this machine's engine is published. */
  | { kind: "running"; self: TailnetSelf; user?: string; tailnet?: string; url?: string }
  /** It was running, and Tailscale signed it out: its key expired, or it was removed in the admin console. */
  | { kind: "dropped" }
  | { kind: "devices"; devices: TailnetPeer[] }
  | { kind: "error"; message: string }
  /** It stopped without being asked to. */
  | { kind: "stopped"; reason: string };

export interface TailnetPort {
  readonly via: "helper" | "tailscale";
  /** Why it cannot be used here, or undefined when it can; `home` when it is because this is not the default home. */
  unavailable(): Promise<{ reason: string; home?: string } | undefined>;
  /** The name this machine has (or will have) on the tailnet, when known before signing in. */
  nodeName(): string | undefined;
  /** Come onto the tailnet — signing in when it must — and publish the engine's loopback `port`. */
  start(port: number, hear: (event: TailnetEvent) => void): Promise<void>;
  /** A new sign-in page, while it runs. */
  login(): void;
  /** Sign out, keeping the registration, and stop. The Tailscale app's port refuses: signing out is the app's. */
  logout(): Promise<void>;
  /** Say the devices now (a `devices` event). */
  devices(): void;
  /**
   * An address this process can use to reach `base` (`https://host[:port]`) on the tailnet: `base` itself
   * where the OS routes there, or a loopback door the helper opened.
   */
  door(base: string): Promise<string>;
  /** Off the tailnet, still signed in: stop publishing, and stop the helper. */
  stop(port: number): Promise<void>;
  /** Delete this machine's identity on the tailnet (the helper's state), once Tailscale has dropped it. */
  forget(): void;
  /** Stop anything it runs, with the engine. */
  close(): void;
}

/** The admin console's page for a device, by its tailnet address. */
export function consoleUrlOf(ips: readonly string[]): string | undefined {
  const ip = ips.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? ips[0];
  return ip === undefined ? undefined : `https://login.tailscale.com/admin/machines/${ip}`;
}

/** The name JaiRA's own node takes on the tailnet: `jaira-` and this machine's name, as a host name. */
export function helperNodeName(label: string): string {
  return `jaira-${label.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/**
 * Loopback: this machine "published" at its loopback address, and the other devices the ones named in
 * `JAIRA_LOOPBACK_PEERS` (comma-separated loopback addresses), or the ones `peers` says.
 */
export function loopbackTailnet(peers?: () => TailnetPeer[]): TailnetPort {
  let hear: ((event: TailnetEvent) => void) | undefined;
  const listed = (): TailnetPeer[] =>
    peers?.() ??
    (process.env["JAIRA_LOOPBACK_PEERS"] ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a !== "")
      .map((address) => {
        const base = /^https?:\/\//.test(address) ? address : `http://${address}`;
        const host = base.replace(/^https?:\/\//, "");
        return { id: base, name: `loopback-${host.split(":").pop() ?? host}`, dnsName: host, os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macOS" : "linux", online: true, ips: ["127.0.0.1"], addresses: [base] };
      });
  return {
    via: "helper",
    unavailable: async () => undefined,
    nodeName: () => "loopback",
    start: async (port, listener) => {
      hear = listener;
      listener({ kind: "running", self: { name: "loopback", dnsName: `127.0.0.1:${port}`, ips: ["127.0.0.1"] }, user: "you", tailnet: "loopback", url: `http://127.0.0.1:${port}` });
      listener({ kind: "devices", devices: listed() });
    },
    login: () => undefined,
    logout: async () => undefined,
    devices: () => hear?.({ kind: "devices", devices: listed() }),
    door: async (base) => base,
    stop: async () => {
      hear = undefined;
    },
    forget: () => undefined,
    close: () => {
      hear = undefined;
    },
  };
}

/** A home that is not the default one: it never connects (decision 0022 §2). */
function otherHome(baseDir: string): TailnetPort {
  const no = (): never => {
    throw new Error("only JaiRA's default home connects to Tailscale");
  };
  return {
    via: "helper",
    unavailable: async () => ({ reason: "only JaiRA's default home, ~/.jaira, connects to Tailscale", home: baseDir }),
    nodeName: () => undefined,
    start: async () => no(),
    login: () => undefined,
    logout: async () => no(),
    devices: () => undefined,
    door: async () => no(),
    stop: async () => undefined,
    forget: () => undefined,
    close: () => undefined,
  };
}

/** The Tailscale this engine uses: loopback when asked for, none in another home, else the app or the helper. */
export function defaultTailnet(baseDir: string, label: () => string): TailnetPort {
  if (process.env["JAIRA_REACH"] === "loopback") return loopbackTailnet();
  if (!isDefaultHome(baseDir)) return otherHome(baseDir);
  return tailscaleCli() !== undefined ? tailscaleApp() : new HelperTailnet(baseDir, () => helperNodeName(label()));
}
