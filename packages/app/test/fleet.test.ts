/**
 * The fleet (decisions 0013 §1–§3 and 0022), three machines in one process — each its own base root,
 * engine host, network listener and fleet, on a loopback stand-in for the tailnet whose devices are the
 * other machines (and one where nothing answers). Every device is listed and asked whether JaiRA runs
 * there; Pair on A asks B to show a code, and the code typed on A pairs them, so they remember each
 * other and connect; C pairing with B is then introduced to A through B; a wrong code is refused, too
 * many void it, and a refused asker is refused again; forgetting a machine on one member forgets it on
 * all. Then the Tailscale row's states, on a scripted port: signing in, signed in, signed out, removed —
 * and down: Tailscale stopping unasked is an error in the log and among Settings', tried again by itself
 * and cleared once it is back.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimEngine, type EngineHost } from "@jaira/service/engineHost";
import { listenNetwork, type NetworkListener } from "@jaira/service/engineNet";
import { Fleet, TAILNET_HEALTH, type FleetOptions } from "@jaira/service/fleet";
import { updateMachineIdentity } from "@jaira/service/machine";
import { defaultTailnet, loopbackTailnet, type TailnetEvent, type TailnetPeer, type TailnetPort } from "@jaira/service/tailnet";

interface Machine {
  base: string;
  host: EngineHost;
  net: NetworkListener;
  fleet: Fleet;
}

const machines: Machine[] = [];
const bases: string[] = [];

afterEach(async () => {
  for (const m of machines.splice(0)) {
    m.fleet.close();
    await m.net.close();
    await m.host.close();
    rmSync(m.base, { recursive: true, force: true });
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const address = (m: Machine): string => `http://127.0.0.1:${m.net.port}`;

/** The tailnet as one machine sees it: every other machine, and a device where JaiRA is not running. */
function devicesSeenBy(self: () => Machine | undefined): TailnetPeer[] {
  const others = machines.filter((m) => m !== self()).map((m) => ({ id: address(m), name: `n-${m.fleet.identity().label}`, dnsName: `127.0.0.1:${m.net.port}`, os: "linux", online: true, ips: ["127.0.0.1"], addresses: [address(m)] }));
  return [...others, { id: "nothing", name: "build-box", dnsName: "127.0.0.1:9", os: "linux", online: true, ips: ["100.64.0.9"], addresses: ["http://127.0.0.1:9"] }];
}

async function machine(label: string): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-fleet-${label}-`));
  updateMachineIdentity(base, { label });
  let me: Machine | undefined;
  const fleet = new Fleet({ baseDir: base, version: "0.2.0", tailnet: loopbackTailnet(() => devicesSeenBy(() => me)), announce: false, retryMs: 50 });
  const host = (await claimEngine({
    baseDir: base,
    kind: "desktop",
    version: "0.2.0",
    handlers: {},
    authorizeNetwork: (token) => fleet.authorize(token),
    preAuth: (frame, transport) => fleet.preAuth(frame, transport),
    connect: (client) => ({ handlers: client.machine !== undefined ? fleet.handlersFor(client.machine) : {} }),
  }))!;
  const net = await listenNetwork({ host, identity: () => fleet.identity(), version: "0.2.0", port: 0 });
  me = { base, host, net, fleet };
  machines.push(me);
  await fleet.attach(host, net.port);
  await fleet.signIn();
  return me;
}

const names = (m: Machine): string[] => m.fleet.view().machines.map((p) => p.label).sort();
const online = async (m: Machine, label: string): Promise<void> => {
  await expect.poll(() => m.fleet.view().machines.find((p) => p.label === label)?.state, { timeout: 5000 }).toBe("online");
};
/** The tailnet device that is `other`, once `m` has asked it whether JaiRA runs there. */
const found = async (m: Machine, other: Machine): Promise<string> => {
  m.fleet.refresh();
  await expect.poll(() => m.fleet.view().tailnetDevices.find((d) => d.id === address(other))?.jaira?.label, { timeout: 5000 }).toBe(other.fleet.identity().label);
  return address(other);
};
/** Pair `a` with `b` the way a person does: Pair on a, the code b shows typed on a. */
const pair = async (a: Machine, b: Machine): Promise<void> => {
  const device = await found(a, b);
  await a.fleet.pairAsk(device);
  await a.fleet.pair(device, b.fleet.view().asked!.code);
};

describe("the fleet", () => {
  it("lists every device on the tailnet, and which run JaiRA", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    expect(a.fleet.view().self.tailnet).toMatchObject({ state: "on", url: address(a), user: "you" });
    await found(a, b);
    await expect.poll(() => a.fleet.view().tailnetDevices.find((d) => d.id === "nothing")?.noJaira, { timeout: 5000 }).toBe(true);
    expect(a.fleet.view().tailnetDevices.find((d) => d.id === address(b))?.jaira).toMatchObject({ kind: "machine", id: b.fleet.identity().id, version: "0.2.0", url: address(b) });
    expect(a.fleet.view().checkedAt).toBeGreaterThan(0);
  });

  it("pairs by Pair: the other machine shows a code, typed here", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const device = await found(a, b);
    await a.fleet.pairAsk(device);
    expect(a.fleet.view().asking).toMatchObject({ device });
    const asked = b.fleet.view().asked!;
    expect(asked.by).toMatchObject({ label: "desk", kind: "machine" });
    await a.fleet.pair(device, asked.code.toLowerCase());
    expect(names(a)).toEqual(["mac-mini"]);
    expect(names(b)).toEqual(["desk"]);
    await online(a, "mac-mini");
    await online(b, "desk");
    expect(b.fleet.view().asked).toBeUndefined();
    expect(a.fleet.view().asking).toBeUndefined();
    expect(a.fleet.view().machines[0]).toMatchObject({ canReachHere: true, version: "0.2.0" });
  });

  it("says nothing runs JaiRA where it does not, and will not pair with it", async () => {
    const a = await machine("desk");
    await expect.poll(() => a.fleet.view().tailnetDevices.find((d) => d.id === "nothing")?.noJaira, { timeout: 5000 }).toBe(true);
    await expect(a.fleet.pairAsk("nothing")).rejects.toThrow(/JaiRA was not found/);
  });

  it("introduces a machine paired with one member to the rest", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const c = await machine("studio");
    await pair(a, b);
    await online(b, "desk");
    await pair(c, b);
    expect(names(c)).toEqual(["desk", "mac-mini"]);
    await expect.poll(() => names(a), { timeout: 5000 }).toEqual(["mac-mini", "studio"]);
    await online(c, "desk");
    await online(a, "studio");
  });

  it("refuses a wrong code, and voids the code after five tries", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const device = await found(a, b);
    await a.fleet.pairAsk(device);
    for (let i = 0; i < 5; i += 1) await expect(a.fleet.pair(device, "RIVER MAPLE AAAA")).rejects.toThrow(/not the code|no code is showing/);
    expect(b.fleet.view().asked).toBeUndefined();
    expect(names(a)).toEqual([]);
  });

  it("stops showing the code when the asker gives up, and a refused asker is refused again for a while", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const device = await found(a, b);
    await a.fleet.pairAsk(device);
    await a.fleet.pairCancel();
    await expect.poll(() => b.fleet.view().asked, { timeout: 5000 }).toBeUndefined();
    await a.fleet.pairAsk(device);
    const code = b.fleet.view().asked!.code;
    b.fleet.refuse();
    await expect(a.fleet.pair(device, code)).rejects.toThrow(/refused on mac-mini/);
    await expect(a.fleet.pairAsk(device)).rejects.toThrow(/refused on mac-mini/);
  });

  it("forgets a machine across the fleet", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const c = await machine("studio");
    await pair(a, b);
    await online(b, "desk");
    await pair(c, b);
    await online(a, "studio");
    await online(b, "studio");
    await a.fleet.forget(c.fleet.identity().id);
    expect(names(a)).toEqual(["mac-mini"]);
    await expect.poll(() => names(b), { timeout: 5000 }).toEqual(["desk"]);
    await expect.poll(() => names(c), { timeout: 5000 }).toEqual(["mac-mini"]);
  });
});

/** What a fleet logged as errors, and what it raised among Settings' (`undefined`: cleared). */
function sayings(): { options: Partial<FleetOptions>; errors: Array<{ message: string; raised?: string }>; health: Array<{ detail: string; fix: string; reconnect: boolean } | undefined> } {
  const errors: Array<{ message: string; raised?: string }> = [];
  const health: Array<{ detail: string; fix: string; reconnect: boolean } | undefined> = [];
  return {
    errors,
    health,
    options: {
      log: (level, message, raised) => {
        if (level === "error") errors.push({ message, ...(raised !== undefined ? { raised } : {}) });
      },
      health: (down) => {
        if (down !== undefined || health.at(-1) !== undefined || health.length === 0) health.push(down);
      },
    },
  };
}

/** A Tailscale port a test drives: what it hears is said by the test, and what it is asked is written down. */
function scripted(): TailnetPort & { say: (event: TailnetEvent) => void; asked: string[] } {
  let hear: ((event: TailnetEvent) => void) | undefined;
  const asked: string[] = [];
  return {
    via: "helper",
    asked,
    say: (event) => hear?.(event),
    unavailable: async () => undefined,
    nodeName: () => "jaira-desk",
    start: async (_port, listener) => {
      asked.push("start");
      hear = listener;
    },
    login: () => void asked.push("login"),
    logout: async () => void asked.push("logout"),
    devices: () => undefined,
    door: async (base) => base,
    stop: async () => void asked.push("stop"),
    forget: () => void asked.push("forget"),
    close: () => {
      hear = undefined;
    },
  };
}

async function signedInFleet(
  more: Partial<FleetOptions> = {},
  port = scripted(),
): Promise<{ fleet: Fleet; port: ReturnType<typeof scripted>; host: EngineHost; base: string }> {
  const base = mkdtempSync(join(tmpdir(), "jaira-fleet-tailnet-"));
  bases.push(base);
  const fleet = new Fleet({ baseDir: base, version: "0.2.0", tailnet: port, ...more });
  const host = (await claimEngine({ baseDir: base, kind: "desktop", version: "0.2.0", handlers: {} }))!;
  await fleet.attach(host, 47_399);
  return { fleet, port, host, base };
}

describe("the Tailscale sign-in", () => {
  it("signs in, on a page the person opens, and says who and what this machine is", async () => {
    const { fleet, port, host } = await signedInFleet();
    try {
      expect(fleet.view().self.tailnet).toMatchObject({ state: "off", node: "jaira-desk" });
      await fleet.signIn();
      port.say({ kind: "sign-in", url: "https://login.tailscale.com/a/abc" });
      expect(fleet.view().self.tailnet).toMatchObject({ state: "signing-in", signInUrl: "https://login.tailscale.com/a/abc" });
      port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", tailnet: "tail1.ts.net", url: "http://jaira-desk.tail1.ts.net" });
      expect(fleet.view().self.tailnet).toEqual({ state: "on", via: "helper", node: "jaira-desk", user: "me@example.com", tailnet: "tail1.ts.net", url: "http://jaira-desk.tail1.ts.net", consoleUrl: "https://login.tailscale.com/admin/machines/100.64.0.2" });
      expect(fleet.selfPeer().url).toBe("ws://jaira-desk.tail1.ts.net/engine");
      port.say({ kind: "devices", devices: [{ id: "n1", name: "jaira-desk-1", dnsName: "jaira-desk-1.tail1.ts.net", os: "windows", online: false, ips: ["100.64.0.7"] }] });
      expect(fleet.view().tailnetDevices).toEqual([{ id: "n1", name: "jaira-desk-1", dnsName: "jaira-desk-1.tail1.ts.net", os: "windows", online: false, olderSelf: true, consoleUrl: "https://login.tailscale.com/admin/machines/100.64.0.7" }]);
    } finally {
      fleet.close();
      await host.close();
    }
  });

  it("signs out keeping the registration, and a sign-in still being made is cancelled by stopping", async () => {
    const { fleet, port, host } = await signedInFleet();
    try {
      await fleet.signIn();
      await fleet.signOut();
      expect(port.asked).toEqual(["start", "stop"]);
      await fleet.signIn();
      port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", tailnet: "tail1.ts.net" });
      await fleet.signOut();
      expect(port.asked.slice(-1)).toEqual(["logout"]);
      expect(fleet.view().self.tailnet).toMatchObject({ state: "off", node: "jaira-desk", user: "me@example.com", tailnet: "tail1.ts.net" });
      expect(fleet.view().tailnetDevices).toEqual([]);
    } finally {
      fleet.close();
      await host.close();
    }
  });

  it("removes this machine: waits for Tailscale to drop it, then forgets its identity", async () => {
    const { fleet, port, host } = await signedInFleet();
    try {
      await fleet.signIn();
      port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", tailnet: "tail1.ts.net" });
      await fleet.remove();
      expect(fleet.view().self.tailnet).toMatchObject({ state: "removing", consoleUrl: "https://login.tailscale.com/admin/machines/100.64.0.2" });
      expect(port.asked).not.toContain("forget");
      port.say({ kind: "dropped" });
      expect(port.asked).toContain("forget");
      expect(fleet.view().self.tailnet).toEqual({ state: "off", via: "helper", node: "jaira-desk" });
    } finally {
      fleet.close();
      await host.close();
    }
  });

  it("says so when Tailscale signs it out unasked: an error, with nothing to try again", async () => {
    const said = sayings();
    const { fleet, port, host } = await signedInFleet(said.options);
    try {
      await fleet.signIn();
      port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com" });
      port.say({ kind: "dropped" });
      expect(fleet.view().self.tailnet).toMatchObject({ state: "off", user: "me@example.com", reason: expect.stringMatching(/signed this machine out/) });
      expect(port.asked).not.toContain("forget");
      expect(said.errors).toEqual([{ message: expect.stringMatching(/^Tailscale signed jaira-desk out/), raised: TAILNET_HEALTH }]);
      expect(said.health.at(-1)).toMatchObject({ detail: expect.stringMatching(/signed jaira-desk out/), reconnect: false });
      // Signing in again clears it.
      await fleet.signIn();
      port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com" });
      expect(said.health.at(-1)).toBeUndefined();
    } finally {
      fleet.close();
      await host.close();
    }
  });

  it("is an error when Tailscale goes down: logged once, among Settings', tried again, and cleared once back", async () => {
    const said = sayings();
    const { fleet, port, host } = await signedInFleet({ ...said.options, tailnetRetryMs: 20 });
    const running = (): void => port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", url: "http://jaira-desk.tail1.ts.net" });
    try {
      await fleet.signIn();
      running();
      expect(said.health).toEqual([undefined]);
      port.say({ kind: "stopped", reason: "the Tailscale helper stopped (exit 0)" });
      expect(fleet.view().self.tailnet).toMatchObject({ state: "down", node: "jaira-desk", reason: "the Tailscale helper stopped (exit 0)" });
      expect(said.errors).toEqual([{ message: expect.stringMatching(/^Tailscale went down: jaira-desk is off your tailnet/), raised: TAILNET_HEALTH }]);
      expect(said.health.at(-1)).toEqual({ detail: "jaira-desk is off your tailnet: the Tailscale helper stopped (exit 0)", fix: expect.any(String), reconnect: true });
      // Nobody pressed anything: it starts the helper again by itself.
      await expect.poll(() => port.asked.filter((a) => a === "start").length).toBe(2);
      // A try that fails as the last one did is not said again.
      port.say({ kind: "stopped", reason: "the Tailscale helper stopped (exit 0)" });
      expect(said.errors).toHaveLength(1);
      await expect.poll(() => port.asked.filter((a) => a === "start").length).toBe(3);
      running();
      expect(fleet.view().self.tailnet).toMatchObject({ state: "on" });
      expect(said.health.at(-1)).toBeUndefined();
    } finally {
      fleet.close();
      await host.close();
    }
  });

  it("comes up down when it was on the tailnet and Tailscale will not start, and a stop while signing in for the first time is no error", async () => {
    const said = sayings();
    let fail = true;
    const port = scripted();
    const start = port.start;
    port.start = async (p, listener) => {
      await start(p, listener);
      if (fail) throw new Error("the Tailscale helper stopped (exit 0)");
    };
    const { fleet, host, base } = await signedInFleet({ ...said.options, tailnetRetryMs: 60_000 }, port);
    try {
      // Never on the tailnet: failing to start is the row's to say, not an error.
      await fleet.signIn();
      expect(fleet.view().self.tailnet.state).toBe("unavailable");
      expect(said.errors).toEqual([]);
      fleet.close();
      await host.close();
      // On it before, and wanted: the next start that fails is Tailscale gone.
      writeFileSync(join(base, "system", "fleet.json"), JSON.stringify({ machines: [], reachable: true, tailnet: { node: "jaira-desk", user: "me@example.com" } }));
      const again = new Fleet({ baseDir: base, version: "0.2.0", tailnet: port, ...said.options, tailnetRetryMs: 60_000 });
      const host2 = (await claimEngine({ baseDir: base, kind: "desktop", version: "0.2.0", handlers: {} }))!;
      try {
        await again.attach(host2, 47_399);
        expect(again.view().self.tailnet).toMatchObject({ state: "down", reason: "the Tailscale helper stopped (exit 0)" });
        expect(said.errors).toHaveLength(1);
        // Reconnect is a sign-in that tries now.
        fail = false;
        await again.signIn();
        port.say({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com" });
        expect(again.view().self.tailnet.state).toBe("on");
        expect(said.health.at(-1)).toBeUndefined();
      } finally {
        again.close();
        await host2.close();
      }
    } finally {
      fleet.close();
      await host.close().catch(() => undefined);
    }
  });

  it("never connects from a home that is not the default one", async () => {
    const base = mkdtempSync(join(tmpdir(), "jaira-fleet-home-"));
    bases.push(base);
    const saved = process.env["JAIRA_REACH"];
    delete process.env["JAIRA_REACH"];
    try {
      expect(await defaultTailnet(base, () => "desk").unavailable()).toEqual({ reason: "only JaiRA's default home, ~/.jaira, connects to Tailscale", home: base });
    } finally {
      if (saved !== undefined) process.env["JAIRA_REACH"] = saved;
    }
  });
});
