/**
 * A phone paired with two machines that are not one fleet (decision 0015, amended 2026-10-04: "the ui
 * populates the projects based on the machines it can connect to"), with the real pieces: two engines
 * hosted by `hostEngine`, their listeners, the phone's engine bridge to each over Node's `WebSocket`, and
 * the fleet bridge over both (`packages/client/bridges/fleetBridge.ts`) — the projects of both listed, and
 * a request about a project answered by the machine it is on.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { AppService, hostEngine, loopbackReach, type HostedEngine } from "@jaira/service";
import type { MachinesView, PairingDevice, ProjectSummary } from "@jaira/shared";
import { engineBridge, pairDevice, type EngineBridge } from "../../client/bridges/engineBridge";
import { fleetBridge, type FleetMember } from "../../client/bridges/fleetBridge";

interface Machine {
  base: string;
  service: AppService;
  hosted: HostedEngine;
}

const dirs: string[] = [];
const bridges: EngineBridge[] = [];
const machines: Machine[] = [];
const PHONE: PairingDevice = { id: "d-iphone-0123456789", label: "iPhone", kind: "phone" };

async function machine(label: string): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-fleet-${label}-`));
  dirs.push(base);
  let host: HostedEngine | undefined;
  const service = new AppService({ baseDir: base, version: "0.2.0", reach: loopbackReach, announce: false, watchWorkflows: false, publish: (m) => host?.host.broadcast(m) });
  host = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  service.fleet.rename(label);
  const made = { base, service, hosted: host };
  machines.push(made);
  return made;
}

function project(on: Machine): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-fleet-project-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  initProject(dir, on.base);
  return dir;
}

/** The phone pairs with a machine and reaches it: a fleet member, knowing the fleet it says it is in. */
async function reach(on: Machine): Promise<FleetMember> {
  const pairing = await pairDevice(`127.0.0.1:${on.hosted.networkPort()!}`, on.service.fleet.pairingCode().pairing!.code, PHONE);
  const bridge = engineBridge({ url: pairing.url, token: pairing.token, client: "iPhone", version: "0.2.0", retryMs: 20, maxRetryMs: 80 });
  bridges.push(bridge);
  await bridge.ready;
  const view = await bridge.invoke("machines:view", undefined as never) as MachinesView;
  return { id: view.self.id, bridge, connected: true, fleet: new Set([view.self.id, ...view.machines.map((m) => m.id)]) };
}

beforeEach(() => undefined);
afterEach(async () => {
  for (const b of bridges.splice(0)) b.close();
  for (const m of machines.splice(0)) await m.hosted.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a phone paired with two machines", () => {
  it("lists the projects of both, and asks each about its own", async () => {
    const desk = await machine("desk");
    const mini = await machine("mini");
    const a = project(desk);
    const b = project(mini);
    const deskMember = await reach(desk);
    const miniMember = await reach(mini);
    // Each machine opens and remembers its project, as a person standing on it would.
    await deskMember.bridge.invoke("project:open", { dir: a, remember: true } as never);
    await miniMember.bridge.invoke("project:open", { dir: b, remember: true } as never);

    const fleet = fleetBridge();
    fleet.setMembers([deskMember, miniMember]);
    expect(fleet.answering().map((m) => m.id)).toEqual([deskMember.id, miniMember.id]);
    const listed = (await fleet.bridge.invoke("project:list", undefined as never)) as ProjectSummary[];
    const dirsListed = listed.map((p) => p.project);
    expect(dirsListed).toContain(a);
    expect(dirsListed).toContain(b);
    // One shared root, not one per machine.
    expect(listed.filter((p) => p.kind === "shared")).toHaveLength(1);

    // Standing on a project is said to the machine it is on, and what names nothing goes there after.
    await fleet.bridge.invoke("project:open", { dir: b } as never);
    expect(await fleet.bridge.invoke("project:current", undefined as never)).toEqual({ dir: b });
    await fleet.bridge.invoke("project:open", { dir: a } as never);
    expect(await fleet.bridge.invoke("project:current", undefined as never)).toEqual({ dir: a });
  }, 60_000);

  it("answers through one machine when both are one fleet's", async () => {
    const desk = await machine("desk");
    const deskMember = await reach(desk);
    // The same machine reached twice stands for a fleet of two that list each other.
    const again = await reach(desk);
    const fleet = fleetBridge();
    fleet.setMembers([deskMember, { ...again, id: "other", fleet: new Set([deskMember.id, "other"]) }]);
    expect(fleet.answering().map((m) => m.id)).toEqual([deskMember.id]);
  }, 60_000);
});
