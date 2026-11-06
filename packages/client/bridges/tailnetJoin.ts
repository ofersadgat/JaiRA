import { engineUrlOf, hostOfUrl } from "@jaira/shared/browser";
import type { TailnetJoin } from "./lanPair";
import type { Tailnet, TailnetState } from "./nearby";

/**
 * The phone on the tailnet with Tailscale built in (decision 0013, amended 2026-10-04): the node's name,
 * joining it while pairing, and the loopback URL the engine bridge connects to through it.
 */

/** The phone's name on the tailnet: `jaira-` and its own name, as a host name may spell it. */
export function tailnetHostname(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "jaira-phone" : `jaira-${slug}`;
}

/** Joining while pairing: settles once the node runs, passing on each sign-in page it asks for. */
export function tailnetJoin(tailnet: Tailnet, hostname: string, timeoutMs = 10 * 60 * 1000): TailnetJoin {
  return {
    join: (onLogin) =>
      new Promise<void>((resolve, reject) => {
        let last = "";
        let off: () => void = () => undefined;
        const timer = setTimeout(() => finish(new Error("the phone did not get onto the tailnet in time: approve it in the Tailscale page on your machine, then try again")), timeoutMs);
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          off();
          if (error === undefined) resolve();
          else reject(error);
        };
        const hear = (state: TailnetState): void => {
          if (state.state === "running") return finish();
          if (state.state === "error") return finish(new Error(`Tailscale on this phone failed: ${state.message ?? "no reason given"}`));
          if (state.state === "needs-login" && state.url !== undefined && state.url !== last) {
            last = state.url;
            onLogin(state.url);
          }
        };
        off = tailnet.onState(hear);
        tailnet.start(hostname).then(
          () => hear(tailnet.state()),
          (e: Error) => finish(e),
        );
      }),
  };
}

/** `https://desk.tail4c2e.ts.net` (or `http://…`) for an engine address, as the proxy wants it. */
export function engineOrigin(address: string): string {
  const url = engineUrlOf(address);
  return `${url.startsWith("wss:") ? "https" : "http"}://${hostOfUrl(url)}`;
}

/** The URL the bridge connects to for an engine on the tailnet: the node's loopback proxy to it. */
/**
 * Asked before every attempt to connect (`engineBridge`'s `resolveUrl`), not once: the proxy's port may
 * not have outlived a suspension of the app, and the node hands out a new one when it did not. Waits for
 * the node to run, and rejects in words about THIS phone's Tailscale when it does not, so the line does
 * not blame the machine for what is the phone's.
 */
export async function tailnetEngineUrl(tailnet: Tailnet, hostname: string, address: string, waitMs = 10_000): Promise<string> {
  await tailnet.start(hostname);
  await tailnetRunning(tailnet, waitMs);
  const port = await tailnet.proxy(engineOrigin(address));
  return `ws://127.0.0.1:${port}/engine`;
}

/** Settles once the node runs; rejects with what it is doing instead when it fails, asks for a sign-in, or is still not running after `waitMs`. */
function tailnetRunning(tailnet: Tailnet, waitMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
      if (error === undefined) resolve();
      else reject(error);
    };
    const hear = (state: TailnetState): void => {
      if (state.state === "running") finish();
      else if (state.state === "error" || state.state === "needs-login" || state.state === "unavailable") finish(new Error(tailnetWords(state)));
    };
    off = tailnet.onState(hear);
    timer = setTimeout(() => finish(new Error(tailnetWords(tailnet.state()))), waitMs);
    hear(tailnet.state());
  });
}

/** What the phone's Tailscale is doing, in a line for the screen. */
export function tailnetWords(state: TailnetState): string {
  switch (state.state) {
    case "starting":
      return "Tailscale on this phone: starting…";
    case "needs-login":
      return "Tailscale on this phone: waiting for its sign-in to be approved";
    case "running":
      return `Tailscale on this phone: on the tailnet${state.dnsName ? ` as ${state.dnsName}` : ""}`;
    case "error":
      return `Tailscale on this phone failed: ${state.message ?? "no reason given"}`;
    case "unavailable":
      return "This build has no Tailscale built in";
    default:
      return "Tailscale on this phone: not started";
  }
}

/** Whether an address is on a tailnet: a `.ts.net` name or a 100.64/10 address. */
export function onTailnet(address: string): boolean {
  let host: string;
  try {
    host = hostOfUrl(engineUrlOf(address)).replace(/:\d+$/, "");
  } catch {
    return false;
  }
  if (host.endsWith(".ts.net")) return true;
  const ip = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return ip !== null && Number(ip[1]) >= 64 && Number(ip[1]) < 128;
}
