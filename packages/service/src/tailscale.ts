/**
 * The installed Tailscale app, as JaiRA uses it (decisions 0013 §2 and 0022): read who this machine is on
 * the tailnet and which devices share it, and publish the engine's loopback listener as HTTPS with
 * `tailscale serve` — never `funnel`, so nothing reaches it from outside the tailnet. Signing in and out
 * is the app's: JaiRA never runs `tailscale logout`, which would take the whole computer off the tailnet.
 *
 * `serve` takes one of the three HTTPS ports Tailscale allows (443, 8443, 10000). One already serving
 * something else is left alone: the person may be using it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TailnetEvent, TailnetPeer, TailnetPort } from "./tailnet";

export interface TailscaleState {
  /** The CLI was found. */
  installed: boolean;
  /** Logged in and connected to a tailnet. */
  running: boolean;
  /** This machine's MagicDNS name, without the trailing dot: `desk.tail4c2e.ts.net`. */
  dnsName?: string;
  ips: string[];
  /** Why it is not running, in the CLI's words. */
  reason?: string;
}

const HTTPS_PORTS = [443, 8443, 10_000] as const;

/** Where the CLI is: on the PATH, or where each platform's installer puts it. */
export function tailscaleCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [join(env["ProgramFiles"] ?? "C:\\Program Files", "Tailscale", "tailscale.exe")]
      : process.platform === "darwin"
        ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
  for (const dir of (env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    const file = join(dir, process.platform === "win32" ? "tailscale.exe" : "tailscale");
    if (existsSync(file)) return file;
  }
  return candidates.find((file) => existsSync(file));
}

function run(cli: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cli, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function tailscaleStatus(cli = tailscaleCli()): Promise<TailscaleState> {
  if (cli === undefined) return { installed: false, running: false, ips: [], reason: "Tailscale is not installed" };
  const result = await run(cli, ["status", "--json"]);
  if (result.code !== 0 && result.stdout.trim() === "") return { installed: true, running: false, ips: [], reason: result.stderr.trim() || "tailscale status failed" };
  try {
    const status = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    const running = status.BackendState === "Running";
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    return {
      installed: true,
      running,
      ...(dnsName !== undefined && dnsName !== "" ? { dnsName } : {}),
      ips: status.Self?.TailscaleIPs ?? [],
      ...(running ? {} : { reason: `Tailscale is ${status.BackendState ?? "not running"}` }),
    };
  } catch {
    return { installed: true, running: false, ips: [], reason: "tailscale status said something that is not JSON" };
  }
}

/** What `tailscale serve` does now, by HTTPS port: the proxy target of `/` on each. */
export async function serveTargets(cli: string): Promise<Map<number, string>> {
  const result = await run(cli, ["serve", "status", "--json"]);
  const targets = new Map<number, string>();
  try {
    const config = JSON.parse(result.stdout || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      const port = Number(hostPort.split(":").pop());
      const proxy = web.Handlers?.["/"]?.Proxy;
      if (Number.isInteger(port) && proxy !== undefined) targets.set(port, proxy);
    }
  } catch {
    // Nothing served, or an older CLI: treat every port as free.
  }
  return targets;
}

/**
 * Publish `http://127.0.0.1:<loopbackPort>` on the tailnet over HTTPS. Answers the URL other machines
 * use: `https://<dnsName>[:port]`.
 */
export async function tailscaleServe(loopbackPort: number, cli = tailscaleCli()): Promise<{ url: string; httpsPort: number }> {
  if (cli === undefined) throw new Error("Tailscale is not installed");
  const status = await tailscaleStatus(cli);
  if (!status.running || status.dnsName === undefined) throw new Error(status.reason ?? "Tailscale is not running");
  const target = `http://127.0.0.1:${loopbackPort}`;
  const targets = await serveTargets(cli);
  const already = [...targets].find(([, proxy]) => proxy === target)?.[0];
  const httpsPort = already ?? HTTPS_PORTS.find((port) => !targets.has(port));
  if (httpsPort === undefined) throw new Error("tailscale serve already uses 443, 8443 and 10000 for other things");
  if (already === undefined) {
    const result = await run(cli, ["serve", "--bg", `--https=${httpsPort}`, target], 30_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `tailscale serve failed (exit ${result.code})`);
  }
  return { url: `https://${status.dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`, httpsPort };
}

/** Stop publishing the engine: only the HTTPS port that points at it. */
export async function tailscaleUnserve(loopbackPort: number, cli = tailscaleCli()): Promise<void> {
  if (cli === undefined) return;
  const target = `http://127.0.0.1:${loopbackPort}`;
  for (const [port, proxy] of await serveTargets(cli)) {
    if (proxy === target) await run(cli, ["serve", `--https=${port}`, "off"], 30_000);
  }
}

interface CliStatus {
  BackendState?: string;
  Self?: CliPeer & { UserID?: number };
  Peer?: Record<string, CliPeer>;
  User?: Record<string, { LoginName?: string }>;
  CurrentTailnet?: { MagicDNSSuffix?: string };
  MagicDNSSuffix?: string;
}
interface CliPeer {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  LastSeen?: string;
  TailscaleIPs?: string[];
}

async function cliStatus(cli: string): Promise<CliStatus | undefined> {
  const result = await run(cli, ["status", "--json"]);
  try {
    return JSON.parse(result.stdout) as CliStatus;
  } catch {
    return undefined;
  }
}

/** The devices `tailscale status` lists. */
export function peersOf(status: CliStatus): TailnetPeer[] {
  return Object.values(status.Peer ?? {}).flatMap((p) => {
    const dnsName = (p.DNSName ?? "").replace(/.$/, "");
    if (p.ID === undefined || dnsName === "") return [];
    const seen = p.LastSeen !== undefined ? Date.parse(p.LastSeen) : NaN;
    // A machine served by the app may be on any of serve's three ports.
    return [{ id: p.ID, name: p.HostName ?? dnsName.split(".")[0] ?? p.ID, dnsName, os: p.OS ?? "", online: p.Online === true, ...(Number.isFinite(seen) && seen > 0 ? { lastSeenAt: seen } : {}), ips: p.TailscaleIPs ?? [] }];
  });
}

/** The Tailscale app as a {@link TailnetPort}: the devices read every 20 seconds while it is used. */
export function tailscaleApp(cli = tailscaleCli()): TailnetPort {
  let hear: ((event: TailnetEvent) => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const say = async (): Promise<void> => {
    if (cli === undefined || hear === undefined) return;
    const status = await cliStatus(cli);
    if (status === undefined) return;
    if (status.BackendState !== "Running") {
      hear({ kind: "dropped" });
      return;
    }
    hear({ kind: "devices", devices: peersOf(status) });
  };
  const halt = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    hear = undefined;
  };
  return {
    via: "tailscale",
    unavailable: async () => {
      const status = await tailscaleStatus(cli);
      return status.running ? undefined : { reason: `${status.reason ?? "Tailscale is not running"}: sign in in the Tailscale app` };
    },
    nodeName: () => undefined,
    start: async (port, listener) => {
      if (cli === undefined) throw new Error("Tailscale is not installed");
      hear = listener;
      const published = await tailscaleServe(port, cli);
      const status = await cliStatus(cli);
      const self = status?.Self;
      const user = self?.UserID !== undefined ? status?.User?.[String(self.UserID)]?.LoginName : undefined;
      const tailnet = status?.CurrentTailnet?.MagicDNSSuffix ?? status?.MagicDNSSuffix;
      listener({
        kind: "running",
        self: { ...(self?.ID !== undefined ? { id: self.ID } : {}), name: self?.HostName ?? "", dnsName: (self?.DNSName ?? "").replace(/.$/, ""), ips: self?.TailscaleIPs ?? [] },
        ...(user !== undefined ? { user } : {}),
        ...(tailnet !== undefined ? { tailnet } : {}),
        url: published.url,
      });
      if (status !== undefined) listener({ kind: "devices", devices: peersOf(status) });
      timer ??= setInterval(() => void say(), 20_000);
      timer.unref?.();
    },
    login: () => undefined,
    logout: async () => {
      throw new Error("this computer signs in and out of Tailscale in the Tailscale app");
    },
    devices: () => void say(),
    door: async (base) => base,
    stop: async (port) => {
      halt();
      await tailscaleUnserve(port, cli);
    },
    forget: () => undefined,
    close: halt,
  };
}
