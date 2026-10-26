/**
 * A phone as a WINDOW onto one engine (decisions 0013, amended 2026-09-30, and 0022), with the real
 * pieces end to end: an `AppService` hosted by `hostEngine`, its loopback listener, and the bridge a
 * device installs (`packages/client/bridges/engineBridge.ts`) over Node's own `WebSocket`.
 *
 * - **Pairing.** The phone asks the machine to show a code (`pair-ask`), and the code pairs it: it is
 *   issued a token and listed, and is NOT a machine — nothing is remembered in the fleet, held for it, or
 *   linked to it. The code is spent; a wrong one is refused, and too many void it.
 * - **Admission.** Its `hello` is welcomed as a window: the service's channels, this connection's own
 *   current project, every push, and writes — less the host's own channels and the engine's controls.
 * - **Revocation.** Forgetting it drops its connection and refuses its next hello, which the bridge
 *   reports as final.
 * - **The bridge.** A dropped connection is retried with a fresh hello, the store is told to read again,
 *   and another contract is said, not retried.
 * - **The client's files.** The listener serves no client (a browser is not a device until the website
 *   exists); the window's own protocol resolves the built client read-only, and nothing outside it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { AppService, askOnce, clientFile, connectEngine, hostEngine, loopbackTailnet, type HostedEngine } from "@jaira/service";
import { peersFile } from "@jaira/service/machineTokens";
import type { MachinesView, PairingDevice, PushMessage } from "@jaira/shared";
import { engineBridge, pairDevice, type BridgeState, type EngineBridge, type Pairing } from "../../client/bridges/engineBridge";

let base: string;
let client: string;
let service: AppService;
let hosted: HostedEngine;
const dirs: string[] = [];
const bridges: EngineBridge[] = [];

const PHONE: PairingDevice = { id: "d-pixel8-0123456789", label: "Pixel 8", kind: "phone" };
const TAB: PairingDevice = { id: "d-tablet-0123456789", label: "Pixel Tablet", kind: "phone" };

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "jaira-device-"));
  client = mkdtempSync(join(tmpdir(), "jaira-device-client-"));
  dirs.push(base, client);
  mkdirSync(join(client, "assets"));
  writeFileSync(join(client, "index.html"), "<html><head><script>window.a=1</script></head><body>index</body></html>");
  writeFileSync(join(client, "native.html"), "<html><body>native</body></html>");
  writeFileSync(join(client, "assets", "app-abc123.js"), "export const app = 1;\n");
  // Beside the client, not in it: what a traversal would reach.
  writeFileSync(join(client, "..", "jaira-device-secret.txt"), "secret");
  let host: HostedEngine | undefined;
  service = new AppService({ baseDir: base, version: "0.2.0", tailnet: loopbackTailnet(), announce: false, watchWorkflows: false, publish: (m) => host?.host.broadcast(m) });
  host = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  hosted = host;
  service.fleet.rename("desk");
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  await hosted.close();
  rmSync(join(client, "..", "jaira-device-secret.txt"), { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const port = (): number => hosted.networkPort()!;
const address = (): string => `127.0.0.1:${port()}`;
const view = (): MachinesView => service.fleet.view();
/** What a phone does before typing a code: ask the machine to show one. */
async function code(device: PairingDevice = PHONE): Promise<string> {
  const answer = await askOnce({ url: `ws://${address()}/engine` }, { t: "pair-ask", device }, 5000);
  if (answer.t !== "asked") throw new Error(answer.t === "refused" ? answer.reason : "no code");
  return view().asked!.code;
}

async function paired(device: PairingDevice = PHONE): Promise<Pairing> {
  return pairDevice(address(), await code(device), device);
}

function bridgeOf(pairing: Pairing, options: { contract?: string } = {}): EngineBridge {
  const bridge = engineBridge({ url: pairing.url, token: pairing.token, client: "Pixel 8", version: "0.2.0", retryMs: 20, maxRetryMs: 80, ...options });
  bridges.push(bridge);
  return bridge;
}

/** Every state a bridge goes through from now on. */
function statesOf(bridge: EngineBridge): BridgeState["state"][] {
  const seen: BridgeState["state"][] = [];
  bridge.onState((s) => seen.push(s.state));
  return seen;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-device-project-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  initProject(dir, base);
  return dir;
}

describe("pairing a device", { timeout: 60_000 }, () => {
  it("issues it a token by the shown code, lists it, and remembers no machine", async () => {
    const pairing = await paired();
    expect(pairing).toMatchObject({ url: `ws://127.0.0.1:${port()}/engine`, machine: { id: service.fleet.identity().id, label: "desk" } });
    expect(pairing.token).toMatch(/^[\w-]{40,}$/);

    expect(view().devices).toEqual([{ id: PHONE.id, label: "Pixel 8", kind: "phone", pairedAt: expect.any(Number), connected: false }]);
    // Not a machine: nothing to link to, copy from, introduce or place a task on.
    expect(view().machines).toEqual([]);
    expect(service.fleet.peers()).toEqual([]);
    expect(existsSync(join(base, "system", "fleet.json")) ? (JSON.parse(readFileSync(join(base, "system", "fleet.json"), "utf8")) as { machines?: unknown[] }).machines ?? [] : []).toEqual([]);
    // Nothing is held FOR it: this machine never connects to a device.
    expect(existsSync(join(base, "system", "fleet-tokens.json"))).toBe(false);
    // Only the token's hash stays here, marked as a device's.
    const issued = (JSON.parse(readFileSync(peersFile(base), "utf8")) as { issued: Array<Record<string, unknown>> }).issued;
    expect(issued).toEqual([expect.objectContaining({ machineId: PHONE.id, label: "Pixel 8", device: "phone" })]);
    expect(JSON.stringify(issued)).not.toContain(pairing.token);
    // The code is spent.
    expect(view().asked).toBeUndefined();
  });

  it("refuses a spent code, a wrong one, and voids the code after too many", async () => {
    const shown = await code();
    await pairDevice(address(), shown, PHONE);
    await expect(pairDevice(address(), shown, TAB)).rejects.toThrow(/no code is showing/);

    await code(TAB);
    for (let i = 0; i < 5; i += 1) await expect(pairDevice(address(), "AMBER RIVER 0000", TAB)).rejects.toThrow(/not the code/);
    expect(view().asked).toBeUndefined();
    expect(view().devices.map((d) => d.id)).toEqual([PHONE.id]);
  });

  it("refuses a device that is not one, or that takes a machine's id", async () => {
    const me = service.fleet.identity().id;
    await expect(pairDevice(address(), await code(), { ...PHONE, id: me })).rejects.toThrow(/a machine's/);
    await expect(pairDevice(address(), await code(), { ...PHONE, id: "../x" })).rejects.toThrow(/needs its id/);
    await expect(pairDevice(address(), await code(), { ...PHONE, kind: "browser" as never })).rejects.toThrow(/needs its id/);
    await expect(askOnce({ url: `ws://${address()}/engine` }, { t: "pair-ask", device: { ...PHONE, kind: "browser" as never } }, 5000)).resolves.toMatchObject({ t: "refused" });
    expect(view().devices).toEqual([]);
  });

  it("gives a device that pairs again a new token in place of its old one", async () => {
    const first = await paired();
    const second = await paired();
    expect(second.token).not.toBe(first.token);
    expect(view().devices).toHaveLength(1);
    const stale = bridgeOf(first);
    await expect(stale.ready).rejects.toThrow(/not paired|pairing was removed/);
    expect(stale.state().state).toBe("refused");
    await expect(bridgeOf(second).ready).resolves.toMatchObject({ kind: "desktop" });
  });
});

describe("a device's connection", { timeout: 60_000 }, () => {
  it("is admitted as a window: the service's channels, its own current project, every push, and writes", async () => {
    const phone = bridgeOf(await paired(PHONE));
    const tab = bridgeOf(await paired(TAB));
    expect(await phone.ready).toMatchObject({ kind: "desktop", version: "0.2.0", pipe: "", exe: "" });
    await tab.ready;

    // Listed as connected, as a device and not a machine.
    expect(view().devices.map((d) => [d.label, d.connected])).toEqual([
      ["Pixel 8", true],
      ["Pixel Tablet", true],
    ]);
    expect(hosted.host.connected().map((c) => [c.transport, c.device?.label, c.machine])).toEqual([
      ["network", "Pixel 8", undefined],
      ["network", "Pixel Tablet", undefined],
    ]);

    // Per-connection state: each stands on the project it opened.
    const one = project();
    const two = project();
    await phone.invoke("project:open", { dir: one });
    await tab.invoke("project:open", { dir: two });
    expect(await phone.invoke("project:current", undefined)).toEqual({ dir: one });
    expect(await tab.invoke("project:current", undefined)).toEqual({ dir: two });

    // A write, and the push it causes reaching every device.
    const heard: PushMessage[] = [];
    tab.subscribe((m) => heard.push(m));
    const renamed = await phone.invoke("machines:rename", { label: "desk-2" });
    expect(renamed.self.label).toBe("desk-2");
    expect(service.fleet.identity().label).toBe("desk-2");
    await expect.poll(() => heard.some((m) => m.type === "machines:changed" && m.view.self.label === "desk-2")).toBe(true);

    // The whole fleet's routing is a window's too: the root's lists answer, as they do for the desktop.
    expect(Array.isArray(await phone.invoke("task:all", undefined))).toBe(true);
  });

  it("is not offered this machine's screen, the desktop's own channels, or the engine's controls", async () => {
    const phone = bridgeOf(await paired());
    await phone.ready;
    const ask = (channel: string, request?: unknown): Promise<unknown> => (phone.invoke as (c: string, r: unknown) => Promise<unknown>)(channel, request);
    await expect(ask("project:choose", { mode: "open" })).rejects.toThrow(/own screen.*not offered to a phone/);
    await expect(ask("shell:reveal", { file: base })).rejects.toThrow(/own screen/);
    await expect(ask("update:state")).rejects.toThrow(/desktop app's own/);
    await expect(ask("engine:stop")).rejects.toThrow(/engine's own host/);
    await expect(ask("engine:restore")).rejects.toThrow(/engine's own host/);
    expect(await ask("engine:info")).toMatchObject({ host: { kind: "desktop" } });
    // …while a machine on the same listener is still a machine: no device token opens `fleet:*`.
    await expect(ask("fleet:list")).rejects.toThrow(/does not answer/);
  });

  it("is dropped when it is forgotten, and refused after", async () => {
    const pairing = await paired();
    const phone = bridgeOf(pairing);
    await phone.ready;
    const states = statesOf(phone);
    const after = await service.fleet.forget(PHONE.id);
    expect(after.devices).toEqual([]);
    await expect.poll(() => phone.state().state, { timeout: 5000 }).toBe("refused");
    // Dropped, tried again with its token, and told no: final.
    expect(states).toEqual(["waiting", "refused"]);
    await expect(phone.invoke("machines:view", undefined)).rejects.toThrow(/not paired|pairing was removed/);
    expect(hosted.host.connected()).toEqual([]);
    // Node's own client with the same token fares no better.
    await expect(connectEngine({ baseDir: base, client: "x", version: "0.2.0", address: { url: pairing.url }, token: pairing.token })).rejects.toThrow(/not paired/);
  });
});

describe("the device's bridge", { timeout: 60_000 }, () => {
  it("says hello again after a drop, and tells the store to read everything again", async () => {
    const phone = bridgeOf(await paired());
    await phone.ready;
    await phone.invoke("limits:watch", { watching: true });
    const heard: PushMessage[] = [];
    phone.subscribe((m) => heard.push(m));
    const states = statesOf(phone);
    const inFlight = phone.invoke("machines:view", undefined);
    // The connection goes, the pairing stays: what a network change or a restarted engine looks like.
    hosted.host.dropMachine(PHONE.id);
    await expect(inFlight.then(() => "answered", (e: Error) => e.message)).resolves.toMatch(/answered|dropped/);
    await expect.poll(() => states.filter((s) => s === "connected").length, { timeout: 5000 }).toBe(1);
    expect(states[0]).toBe("waiting");
    expect((await phone.invoke("machines:view", undefined)).devices[0]).toMatchObject({ id: PHONE.id, connected: true });
    const scopes = heard.flatMap((m) => (m.type === "store:invalidate" && m.project === undefined ? [m.scope] : []));
    expect(scopes).toEqual(expect.arrayContaining(["tasks", "board", "task", "workflows", "config", "availability"]));
    // One connection, not one per attempt.
    expect(hosted.host.connected()).toHaveLength(1);
  });

  it("keeps trying while nothing answers, and refuses requests meanwhile", async () => {
    const pairing = await paired();
    const away = bridgeOf({ ...pairing, url: "ws://127.0.0.1:9/engine" });
    await expect.poll(() => away.state().state, { timeout: 5000 }).toBe("waiting");
    await expect(away.invoke("machines:view", undefined)).rejects.toThrow(/nothing answers|did not answer|could not reach/);
  });

  it("says so when the machine speaks another contract, and stops", async () => {
    const other = bridgeOf(await paired(), { contract: "another" });
    await expect(other.ready).rejects.toThrow(/another build of JaiRA 0\.2\.0/);
    expect(other.state().state).toBe("mismatch");
    await new Promise((r) => setTimeout(r, 100));
    expect(hosted.host.connected()).toEqual([]);
  });
});

/** A request whose path is sent as written: `fetch` would fold a `..` away before it left. */
function raw(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: port(), path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the client's files", { timeout: 60_000 }, () => {
  it("are not served by the engine's listener, which answers its two paths alone", async () => {
    expect((await raw("/")).status).toBe(404);
    expect((await raw("/index.html")).status).toBe(404);
    expect((await raw("/assets/app-abc123.js")).status).toBe(404);
    expect(JSON.parse((await raw("/.well-known/jaira")).body)).toMatchObject({ jaira: true });
    expect((await raw("/engine")).status).toBe(404);
  });

  it("are resolved for the window's own protocol, and nothing outside them", () => {
    expect(clientFile(client, "/")).toMatchObject({ file: join(client, "index.html"), html: true });
    expect(clientFile(client, "/native")).toMatchObject({ file: join(client, "native.html"), html: true });
    expect(clientFile(client, "/assets/app-abc123.js")).toMatchObject({ html: false, type: "text/javascript; charset=utf-8" });
    for (const path of ["/../jaira-device-secret.txt", "/assets/../../jaira-device-secret.txt", "/..%2Fjaira-device-secret.txt", "/%2e%2e/jaira-device-secret.txt", "/..%2f..%2fetc%2fpasswd"]) {
      expect([path, (clientFile(client, path) as { status?: number }).status]).toEqual([path, 403]);
    }
    expect(clientFile(join(client, "nowhere"), "/")).toMatchObject({ status: 404 });
  });
});
