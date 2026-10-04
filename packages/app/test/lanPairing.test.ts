/**
 * Pairing a phone over the local network (decision 0013, amended 2026-10-04), end to end: an
 * `AppService` hosted by `hostEngine`, its fleet announcing the pairing code through a stand-in for
 * Bonjour, and the phone's half (`packages/client/bridges/lanPair.ts`) over Node's own `WebSocket`.
 *
 * - **Announced while a code is shown, and only then.** Showing a code announces this machine with its
 *   id, port and addresses; stopping it, spending it or trying it too often stops the announcement.
 * - **The code proves, never travels.** The right code pairs: a token the engine then welcomes. A wrong
 *   one is refused, and five tries void it.
 * - **The tailnet.** The phone's Tailscale sign-in page is opened on the machine — Tailscale's and no
 *   other — and Settings → Machines says which phone is joining.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppService, hostEngine, loopbackReach, type HostedEngine } from "@jaira/service";
import type { AnnouncePort } from "@jaira/service/lanPairing";
import { announcementOf, engineUrlOf, typedLanMachine, type LanAnnouncement, type MachinesView } from "@jaira/shared";
import { engineBridge } from "../../client/bridges/engineBridge";
import { pairNearby, type LanStep } from "../../client/bridges/lanPair";

let base: string;
let service: AppService;
let hosted: HostedEngine;
let announced: Array<{ name: string; type: string; port: number; txt: Record<string, string>; addresses: string[] } | undefined>;
const opened: string[] = [];

const announce: AnnouncePort = {
  async publish(service) {
    announced.push(service);
    return async () => {
      announced.push(undefined);
    };
  },
};

const PHONE = { id: "d-iphone-0123456789", label: "Ofer's iPhone", kind: "phone" as const };
const random = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "jaira-lan-"));
  announced = [];
  opened.length = 0;
  let host: HostedEngine | undefined;
  service = new AppService({ baseDir: base, version: "0.2.0", reach: loopbackReach, announce, lanBindHost: "127.0.0.1", openExternal: (url) => opened.push(url), watchWorkflows: false, publish: (m) => host?.host.broadcast(m) });
  host = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  hosted = host;
  service.fleet.rename("desk");
  await service.fleet.setReachable(true);
});

afterEach(async () => {
  await hosted.close();
  rmSync(base, { recursive: true, force: true });
});

/** Show a code, and read back what was announced for it the way a phone does. */
async function showCode(): Promise<{ code: string; machine: LanAnnouncement }> {
  const code = service.fleet.pairingCode().pairing!.code;
  await expect.poll(() => announced.at(-1)).toBeDefined();
  const published = announced.at(-1)!;
  expect(published.type).toBe("jaira");
  const machine = announcementOf(published.txt)!;
  // The test reaches the listener on loopback: what a phone reaches on the machine's network address.
  return { code, machine: { ...machine, addresses: ["127.0.0.1"] } };
}

const view = (): MachinesView => service.fleet.view();

describe("pairing a phone over the local network", () => {
  it("says what each phone did, for Settings: connected, a wrong code, paired", async () => {
    const { code, machine } = await showCode();
    const wrong = code.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    await expect(pairNearby({ machine, code: wrong, device: PHONE, random, onPaired: () => undefined })).rejects.toThrow();
    await pairNearby({ machine, code, device: PHONE, random, onPaired: () => undefined });
    await expect.poll(() => view().nearbyLog?.map((e) => e.what)).toEqual(["connected", "wrong-code", "connected", "paired"]);
    expect(view().nearbyLog![0]!.from).toBe("127.0.0.1");
    expect(view().nearbyLog![3]!.detail).toBe("Ofer's iPhone");
  });

  it("pairs with a typed local address, whose machine is known only once it answers", async () => {
    const { code, machine } = await showCode();
    const typed = typedLanMachine(`192.168.1.32:${machine.port}`)!;
    expect(typed).toMatchObject({ id: "", port: machine.port });
    const attempts: string[] = [];
    // The test reaches it on loopback, as a phone would at the typed address.
    const paired = await pairNearby({ machine: { ...typed, addresses: ["127.0.0.1"] }, code, device: PHONE, random, onPaired: () => undefined, onAttempt: (a) => attempts.push(`${a.address} ${a.state}`) });
    expect(paired.machine.label).toBe("desk");
    expect(attempts).toEqual([`127.0.0.1:${machine.port} trying`, `127.0.0.1:${machine.port} answered`]);
  });

  it("says which addresses did not answer", async () => {
    const { code, machine } = await showCode();
    const attempts: string[] = [];
    await pairNearby({ machine: { ...machine, addresses: ["127.0.0.1", "127.0.0.2"], port: machine.port }, code, device: PHONE, random, onPaired: () => undefined, onAttempt: (a) => attempts.push(`${a.address} ${a.state}`) }).catch(() => undefined);
    expect(attempts).toContain(`127.0.0.1:${machine.port} answered`);
  });

  it("announces this machine while a code is shown, with its id, port and addresses", async () => {
    const { machine } = await showCode();
    expect(machine).toMatchObject({ id: service.fleet.identity().id, label: "desk", v: 1 });
    expect(machine.port).toBeGreaterThan(0);
    await expect.poll(() => view().pairing?.nearby).toMatchObject({ port: machine.port });
    expect(view().pairing?.nearby?.addresses).toEqual(announced.at(-1)!.addresses);
    service.fleet.cancelPairing();
    await expect.poll(() => announced.at(-1)).toBeUndefined();
    await expect.poll(() => view().pairing).toBeUndefined();
  });

  it("pairs by the code: a token the engine welcomes, the engine's address, and the code spent", async () => {
    const { code, machine } = await showCode();
    const steps: LanStep[] = [];
    let kept: unknown;
    const paired = await pairNearby({ machine, code: code.toLowerCase(), device: PHONE, random, onPaired: (p) => void (kept = p), onStep: (s) => steps.push(s) });
    expect(kept).toEqual(paired);
    expect(paired.machine).toMatchObject({ id: service.fleet.identity().id, label: "desk" });
    expect(paired.address).toBe(view().self.reach.url);
    expect(steps).toEqual(["reaching", "proving"]);
    expect(view().pairing).toBeUndefined();
    await expect.poll(() => announced.at(-1)).toBeUndefined();
    expect(view().devices).toEqual([expect.objectContaining({ id: PHONE.id, label: "Ofer's iPhone", kind: "phone" })]);
    const bridge = engineBridge({ url: engineUrlOf(paired.address), token: paired.token, client: PHONE.label, version: "0.2.0" });
    try {
      await expect(bridge.ready).resolves.toMatchObject({ version: "0.2.0" });
    } finally {
      bridge.close();
    }
  });

  it("refuses a wrong code before the phone says who it is, and five tries void the code", async () => {
    const { code, machine } = await showCode();
    const wrong = code.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    for (let i = 0; i < 4; i += 1) {
      await expect(pairNearby({ machine, code: wrong, device: PHONE, random, onPaired: () => undefined })).rejects.toThrow("that is not the code desk shows");
    }
    expect(view().devices).toEqual([]);
    expect(view().pairing).toBeDefined();
    await expect(pairNearby({ machine, code: wrong, device: PHONE, random, onPaired: () => undefined })).rejects.toThrow();
    expect(view().pairing).toBeUndefined();
    await expect.poll(() => announced.at(-1)).toBeUndefined();
    // Even the right code is too late now: nothing listens.
    await expect(pairNearby({ machine, code, device: PHONE, random, onPaired: () => undefined, timeoutMs: 2000 })).rejects.toThrow("could not reach desk");
  });

  it("opens the phone's Tailscale sign-in page on the machine, and says which phone is joining", async () => {
    const { code, machine } = await showCode();
    let approve: () => void = () => undefined;
    const joined = new Promise<void>((resolve) => (approve = resolve));
    const steps: LanStep[] = [];
    const pairing = pairNearby({
      machine,
      code,
      device: PHONE,
      random,
      onPaired: () => undefined,
      onStep: (s) => steps.push(s),
      tailnet: {
        join: async (onLogin) => {
          onLogin("https://login.tailscale.com/a/1a2b3c4d5e6f");
          await joined;
        },
      },
    });
    await expect.poll(() => opened).toEqual(["https://login.tailscale.com/a/1a2b3c4d5e6f"]);
    await expect.poll(() => view().phone).toEqual({ label: "Ofer's iPhone", signInUrl: "https://login.tailscale.com/a/1a2b3c4d5e6f" });
    approve();
    await pairing;
    expect(steps).toEqual(["reaching", "proving", "joining", "approve"]);
    await expect.poll(() => view().phone).toBeUndefined();
  });

  it("opens no page but Tailscale's sign-in", async () => {
    const { code, machine } = await showCode();
    await expect(
      pairNearby({
        machine,
        code,
        device: PHONE,
        random,
        onPaired: () => undefined,
        tailnet: {
          join: async (onLogin) => {
            onLogin("https://evil.example/a/1");
            await new Promise((r) => setTimeout(r, 300));
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(opened).toEqual([]);
  });

  it("will not pair while the machine is not reachable on the tailnet", async () => {
    const { code, machine } = await showCode();
    await service.fleet.setReachable(false);
    await expect(pairNearby({ machine, code, device: PHONE, random, onPaired: () => undefined })).rejects.toThrow("not reachable on the tailnet");
  });
});
