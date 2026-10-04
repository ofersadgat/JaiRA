/**
 * The phone on the tailnet with Tailscale built in (decision 0013, amended 2026-10-04): its name there,
 * joining while pairing — each sign-in page passed on once, settled when the node runs, failed when it
 * fails — and the loopback URL the bridge connects to through the node's proxy.
 */
import { describe, expect, it } from "vitest";
import type { Tailnet, TailnetState } from "../../client/bridges/nearby";
import { engineOrigin, onTailnet, tailnetEngineUrl, tailnetHostname, tailnetJoin } from "../../client/bridges/tailnetJoin";

/** A node that says what the test tells it to. */
function fakeTailnet(): Tailnet & { say(state: TailnetState): void; started: string[]; proxied: string[] } {
  let current: TailnetState = { state: "stopped" };
  const listeners = new Set<(state: TailnetState) => void>();
  return {
    started: [],
    proxied: [],
    say(state) {
      current = state;
      for (const l of [...listeners]) l(state);
    },
    async start(hostname) {
      this.started.push(hostname);
    },
    state: () => current,
    onState(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async proxy(target) {
      this.proxied.push(target);
      return 52123;
    },
    logout: async () => undefined,
  };
}

describe("the phone's name on the tailnet", () => {
  it("is jaira- and its own name, as a host name spells it", () => {
    expect(tailnetHostname("Ofer's iPhone")).toBe("jaira-ofer-s-iphone");
    expect(tailnetHostname("Pixel 8 Pro")).toBe("jaira-pixel-8-pro");
    expect(tailnetHostname("Café ☕")).toBe("jaira-cafe");
    expect(tailnetHostname("☕")).toBe("jaira-phone");
    expect(tailnetHostname("x".repeat(80)).length).toBeLessThanOrEqual(46);
  });
});

describe("joining while pairing", () => {
  it("passes each sign-in page on once, and settles when the node runs", async () => {
    const node = fakeTailnet();
    const pages: string[] = [];
    const joined = tailnetJoin(node, "jaira-pixel").join((url) => pages.push(url));
    await Promise.resolve();
    node.say({ state: "starting" });
    node.say({ state: "needs-login", url: "https://login.tailscale.com/a/1" });
    node.say({ state: "needs-login", url: "https://login.tailscale.com/a/1" });
    node.say({ state: "needs-login", url: "https://login.tailscale.com/a/2" });
    node.say({ state: "running", dnsName: "jaira-pixel.tail4c2e.ts.net" });
    await joined;
    expect(pages).toEqual(["https://login.tailscale.com/a/1", "https://login.tailscale.com/a/2"]);
    expect(node.started).toEqual(["jaira-pixel"]);
  });

  it("settles at once for a node already on", async () => {
    const node = fakeTailnet();
    node.say({ state: "running" });
    await expect(tailnetJoin(node, "jaira-pixel").join(() => undefined)).resolves.toBeUndefined();
  });

  it("fails when the node fails, or is not approved in time", async () => {
    const node = fakeTailnet();
    const failing = tailnetJoin(node, "jaira-pixel").join(() => undefined);
    await Promise.resolve();
    node.say({ state: "error", message: "no network" });
    await expect(failing).rejects.toThrow("Tailscale on this phone failed: no network");
    await expect(tailnetJoin(fakeTailnet(), "jaira-pixel", 30).join(() => undefined)).rejects.toThrow("did not get onto the tailnet in time");
  });
});

describe("the engine through the node", () => {
  it("is the proxy's loopback port, to the engine's origin", async () => {
    const node = fakeTailnet();
    await expect(tailnetEngineUrl(node, "jaira-pixel", "https://desk.tail4c2e.ts.net")).resolves.toBe("ws://127.0.0.1:52123/engine");
    expect(node.proxied).toEqual(["https://desk.tail4c2e.ts.net"]);
  });

  it("keeps the scheme and a port the address says", () => {
    expect(engineOrigin("https://desk.tail4c2e.ts.net")).toBe("https://desk.tail4c2e.ts.net");
    expect(engineOrigin("https://desk.tail4c2e.ts.net:8443")).toBe("https://desk.tail4c2e.ts.net:8443");
    expect(engineOrigin("http://jaira-desk.tail4c2e.ts.net")).toBe("http://jaira-desk.tail4c2e.ts.net");
  });

  it("knows a tailnet address", () => {
    expect(onTailnet("https://desk.tail4c2e.ts.net")).toBe(true);
    expect(onTailnet("100.101.102.103")).toBe(true);
    expect(onTailnet("100.200.1.1")).toBe(false);
    expect(onTailnet("192.168.1.5")).toBe(false);
    expect(onTailnet("not an address at all")).toBe(false);
  });
});
