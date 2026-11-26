/**
 * Auto pair (decision 0022, amended 2026-11-25), with real engines in one process — each its own base
 * root, engine host, network listener and fleet — on a loopback stand-in for the tailnet, every machine
 * signed in to Tailscale as an account of its own choosing. Two machines of one account that both allow
 * auto pair pair by themselves, found again every rescan; Pair on a machine that allows it pairs with no
 * code; another account's machine is never auto paired, and Pair asks it for a code; an asker that is not
 * the machine it claims to be is refused, because the asked machine asks it back; and a machine unpaired by
 * hand is not auto paired again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askOnce } from "@jaira/service/engineClient";
import { claimEngine, type EngineHost } from "@jaira/service/engineHost";
import { listenNetwork, type NetworkListener } from "@jaira/service/engineNet";
import { Fleet } from "@jaira/service/fleet";
import { updateMachineIdentity } from "@jaira/service/machine";
import { loopbackTailnet, type TailnetPeer, type TailnetPort } from "@jaira/service/tailnet";

interface Machine {
  base: string;
  host: EngineHost;
  net: NetworkListener;
  fleet: Fleet;
  account: string;
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

const address = (m: Machine): string => `http://127.0.0.1:${m.net.port}`;

/** The tailnet as one machine sees it: every other machine, each signed in as its own account. */
function devicesSeenBy(self: () => Machine | undefined): TailnetPeer[] {
  return machines
    .filter((m) => m !== self())
    .map((m) => ({ id: address(m), name: `n-${m.fleet.identity().label}`, dnsName: `127.0.0.1:${m.net.port}`, os: "linux", online: true, ips: ["127.0.0.1"], user: m.account, addresses: [address(m)] }));
}

/** A machine signed in to the loopback tailnet as `account`, asking its devices again every 100 ms. */
async function machine(label: string, account = "you@example.com"): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-autopair-${label}-`));
  updateMachineIdentity(base, { label });
  let me: Machine | undefined;
  const loopback = loopbackTailnet(() => devicesSeenBy(() => me));
  const tailnet: TailnetPort = { ...loopback, start: (port, hear) => loopback.start(port, (event) => hear(event.kind === "running" ? { ...event, user: account } : event)) };
  const fleet = new Fleet({ baseDir: base, version: "0.2.0", tailnet, announce: false, retryMs: 50, rescanMs: 100 });
  const host = (await claimEngine({
    baseDir: base,
    kind: "desktop",
    version: "0.2.0",
    handlers: {},
    authorizeNetwork: (token) => fleet.authorize(token),
    preAuth: (frame, transport) => fleet.preAuth(frame, transport),
    connect: (client) => ({ handlers: client.machine !== undefined ? fleet.handlersFor(client.machine) : {} }),
  }))!;
  const net = await listenNetwork({ host, identity: () => fleet.identity(), autoPair: () => fleet.allowsAutoPair(), version: "0.2.0", port: 0 });
  me = { base, host, net, fleet, account };
  machines.push(me);
  await fleet.attach(host, net.port);
  await fleet.signIn();
  return me;
}

const names = (m: Machine): string[] => m.fleet.view().machines.map((p) => p.label).sort();
const online = async (m: Machine, label: string): Promise<void> => {
  await expect.poll(() => m.fleet.view().machines.find((p) => p.label === label)?.state, { timeout: 5000 }).toBe("online");
};
/** The tailnet device that is `other`, once `m` has found JaiRA there and whether it allows auto pair. */
const found = async (m: Machine, other: Machine): Promise<string> => {
  await expect.poll(() => m.fleet.view().tailnetDevices.find((d) => d.id === address(other))?.jaira?.autoPair === (other.fleet.allowsAutoPair() || undefined), { timeout: 5000 }).toBe(true);
  return address(other);
};
const quiet = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("auto pair", () => {
  it("is off until allowed, and said at /.well-known/jaira and to the list", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    expect(a.fleet.view().self.autoPair).toBe(false);
    expect(b.fleet.setAutoPair(true).self.autoPair).toBe(true);
    const device = await found(a, b);
    expect(a.fleet.view().tailnetDevices.find((d) => d.id === device)).toMatchObject({ user: "you@example.com", jaira: { autoPair: true } });
    // Not allowed here: nothing pairs by itself.
    await quiet(400);
    expect(names(a)).toEqual([]);
    expect(names(b)).toEqual([]);
  });

  it("pairs two machines of one account by themselves once both allow it, found again without Refresh", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    a.fleet.setAutoPair(true);
    b.fleet.setAutoPair(true);
    await expect.poll(() => names(a), { timeout: 5000 }).toEqual(["mac-mini"]);
    await expect.poll(() => names(b), { timeout: 5000 }).toEqual(["desk"]);
    await online(a, "mac-mini");
    await online(b, "desk");
    // A third that allows it joins the group by itself, and is introduced to the rest.
    const c = await machine("studio");
    c.fleet.setAutoPair(true);
    await expect.poll(() => names(c), { timeout: 5000 }).toEqual(["desk", "mac-mini"]);
    await expect.poll(() => names(a), { timeout: 5000 }).toEqual(["mac-mini", "studio"]);
    await expect.poll(() => names(b), { timeout: 5000 }).toEqual(["desk", "studio"]);
  });

  it("pairs with no code when Pair is pressed for a machine that allows it", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    b.fleet.setAutoPair(true);
    const device = await found(a, b);
    await a.fleet.pairAsk(device);
    expect(b.fleet.view().asked).toBeUndefined();
    expect(names(a)).toEqual(["mac-mini"]);
    expect(names(b)).toEqual(["desk"]);
    await online(a, "mac-mini");
  });

  it("never auto pairs another account's machine: Pair asks it for a code", async () => {
    const a = await machine("desk");
    const b = await machine("their-box", "them@example.com");
    a.fleet.setAutoPair(true);
    b.fleet.setAutoPair(true);
    const device = await found(a, b);
    await quiet(400);
    expect(names(a)).toEqual([]);
    expect(names(b)).toEqual([]);
    await a.fleet.pairAsk(device);
    expect(b.fleet.view().asked?.by).toMatchObject({ label: "desk" });
    expect(names(a)).toEqual([]);
  });

  it("refuses an asker the tailnet says is another account's, and one that does not confirm it asked", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const them = await machine("their-box", "them@example.com");
    b.fleet.setAutoPair(true);
    await found(b, a);
    await found(b, them);
    const asking = (who: Machine) => ({ t: "pair-auto", machine: { ...who.fleet.selfPeer(), url: `ws://127.0.0.1:${who.net.port}/engine` }, token: "t".repeat(43), nonce: "n".repeat(32) });
    // Published where the tailnet says another account's machine is.
    await expect(askOnce({ url: `ws://127.0.0.1:${b.net.port}/engine` }, asking(them), 10_000)).resolves.toMatchObject({ t: "refused", reason: expect.stringMatching(/another account/) });
    // Claims to be desk, which — asked back where desk is published — never asked.
    await expect(askOnce({ url: `ws://127.0.0.1:${b.net.port}/engine` }, asking(a), 10_000)).resolves.toMatchObject({ t: "refused", reason: expect.stringMatching(/did not confirm it asked/) });
    expect(names(b)).toEqual([]);
    // Not allowed: refused before anything is checked.
    b.fleet.setAutoPair(false);
    await expect(askOnce({ url: `ws://127.0.0.1:${b.net.port}/engine` }, asking(a), 10_000)).resolves.toMatchObject({ t: "refused", reason: expect.stringMatching(/does not allow auto pair/) });
  });

  it("does not auto pair again a machine unpaired by hand: it pairs again only by a code", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    a.fleet.setAutoPair(true);
    b.fleet.setAutoPair(true);
    await expect.poll(() => names(a), { timeout: 5000 }).toEqual(["mac-mini"]);
    await online(b, "desk");
    await a.fleet.forget(b.fleet.identity().id);
    await expect.poll(() => names(b), { timeout: 5000 }).toEqual([]);
    await quiet(500);
    expect(names(a)).toEqual([]);
    expect(names(b)).toEqual([]);
    const device = await found(a, b);
    await a.fleet.pairAsk(device);
    const code = b.fleet.view().asked?.code;
    expect(code).toBeDefined();
    await a.fleet.pair(device, code!);
    expect(names(a)).toEqual(["mac-mini"]);
    expect(names(b)).toEqual(["desk"]);
  });
});
