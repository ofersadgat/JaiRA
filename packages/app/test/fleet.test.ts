/**
 * The fleet (decision 0013 §1–§3), three machines in one process — each its own base root, engine host,
 * network listener and fleet, published by a stand-in for Tailscale that hands out the loopback URL.
 * Pairing A with B by B's code makes them remember each other and connect; C pairing with B is then
 * introduced to A through B, so pairing with one member joins the fleet; a wrong code is refused, and
 * too many void it; forgetting a machine on one member forgets it on all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimEngine, type EngineHost } from "@jaira/service/engineHost";
import { listenNetwork, type NetworkListener } from "@jaira/service/engineNet";
import { Fleet, type ReachPort } from "@jaira/service/fleet";
import { updateMachineIdentity } from "@jaira/service/machine";

interface Machine {
  base: string;
  host: EngineHost;
  net: NetworkListener;
  fleet: Fleet;
}

const machines: Machine[] = [];

afterEach(async () => {
  for (const m of machines.splice(0)) {
    m.fleet.close();
    await m.net.close();
    await m.host.close();
    rmSync(m.base, { recursive: true, force: true });
  }
});

const loopbackReach: ReachPort = {
  publish: async (port) => ({ url: `http://127.0.0.1:${port}`, via: "tailscale" }),
  unpublish: async () => undefined,
  unavailable: async () => undefined,
};

async function machine(label: string): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-fleet-${label}-`));
  updateMachineIdentity(base, { label });
  const fleet = new Fleet({ baseDir: base, version: "0.2.0", reach: loopbackReach, announce: false, retryMs: 50 });
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
  await fleet.attach(host, net.port);
  await fleet.setReachable(true);
  const m = { base, host, net, fleet };
  machines.push(m);
  return m;
}

const address = (m: Machine): string => `http://127.0.0.1:${m.net.port}`;
const names = (m: Machine): string[] => m.fleet.view().machines.map((p) => p.label).sort();
const online = async (m: Machine, label: string): Promise<void> => {
  await expect.poll(() => m.fleet.view().machines.find((p) => p.label === label)?.state, { timeout: 5000 }).toBe("online");
};

describe("the fleet", () => {
  it("pairs two machines by a code, and they connect to each other", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    expect(a.fleet.view().self.reach).toMatchObject({ state: "on", url: address(a) });
    const code = b.fleet.pairingCode().pairing!.code;
    await a.fleet.add(address(b), code.toLowerCase());
    expect(names(a)).toEqual(["mac-mini"]);
    expect(names(b)).toEqual(["desk"]);
    await online(a, "mac-mini");
    await online(b, "desk");
    expect(b.fleet.view().pairing).toBeUndefined();
    expect(a.fleet.view().machines[0]).toMatchObject({ canReachHere: true, version: "0.2.0" });
  });

  it("introduces a machine paired with one member to the rest", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const c = await machine("build-box");
    await a.fleet.add(address(b), b.fleet.pairingCode().pairing!.code);
    await online(b, "desk");
    await c.fleet.add(address(b), b.fleet.pairingCode().pairing!.code);
    expect(names(c)).toEqual(["desk", "mac-mini"]);
    await expect.poll(() => names(a), { timeout: 5000 }).toEqual(["build-box", "mac-mini"]);
    await online(c, "desk");
    await online(a, "build-box");
  });

  it("refuses a wrong code, and voids the code after five tries", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    b.fleet.pairingCode();
    for (let i = 0; i < 5; i += 1) await expect(a.fleet.add(address(b), "RIVER MAPLE AAAA")).rejects.toThrow(/not the code|no pairing code/);
    expect(b.fleet.view().pairing).toBeUndefined();
    expect(names(a)).toEqual([]);
  });

  it("forgets a machine across the fleet", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const c = await machine("build-box");
    await a.fleet.add(address(b), b.fleet.pairingCode().pairing!.code);
    await online(b, "desk");
    await c.fleet.add(address(b), b.fleet.pairingCode().pairing!.code);
    await online(a, "build-box");
    await online(b, "build-box");
    await a.fleet.forget(c.fleet.identity().id);
    expect(names(a)).toEqual(["mac-mini"]);
    await expect.poll(() => names(b), { timeout: 5000 }).toEqual(["desk"]);
    await expect.poll(() => names(c), { timeout: 5000 }).toEqual(["mac-mini"]);
  });
});
