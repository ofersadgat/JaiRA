/**
 * Hosting and finding the engine (decision 0012 §2–§5): `who` without a token, a client of another
 * contract admitted only to the `engine:*` channels, per-connection state, a CLI command's claim that
 * builds no engine until a client asks, the loopback port when no pipe can be made, and discovery's
 * verdicts in the person's order.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineConnections } from "@jaira/service/connections";
import { connectEngine, whoAt, type EngineClient } from "@jaira/service/engineClient";
import { discoverEngine, listProcesses } from "@jaira/service/engineDiscovery";
import { claimEngine } from "@jaira/service/engineHost";
import { engineFilePath, enginePipePath, homeHash, readEngineFile, writeEngineFile } from "@jaira/service/enginePipe";
import { hostEngine, type HostedEngine } from "@jaira/service/hostEngine";
import type { AppService } from "@jaira/service";

let base: string;
const closers: Array<() => Promise<void> | void> = [];
/** A port no other test file uses, so parallel files do not collide. */
const PORT = 47_400 + (process.pid % 500);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jaira-hosting-"));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(base, { recursive: true, force: true });
});

function track<T extends { close(): unknown }>(thing: T): T {
  closers.push(() => void thing.close());
  return thing;
}

/** A pipe path that cannot be created: a plain path on Windows (EACCES), a path under a file elsewhere. */
function unmakeablePipe(): string {
  if (process.platform === "win32") return join(base, "not-a-pipe");
  writeFileSync(join(base, "file"), "");
  return join(base, "file", "x.sock");
}

/** Just enough of an engine for the channels these tests ask. */
function fakeService(): AppService & { built: number; watching: boolean[] } {
  const open = new Set<string>();
  const order: string[] = [];
  const fake = {
    built: 1,
    watching: [] as boolean[],
    open: async (dir: string) => {
      open.add(dir);
      order.push(dir);
      return { dir, recovered: [] };
    },
    init: async (dir: string) => ({ dir, recovered: [] }),
    current: () => (order.length > 0 ? { dir: order[order.length - 1]! } : null),
    inspect: (dir: string) => ({ dir, exists: true, project: true, open: open.has(dir) }),
    watchLimits: (watching: boolean) => void fake.watching.push(watching),
    listProjects: () => [...open],
    close: async () => undefined,
  };
  return fake as unknown as AppService & { built: number; watching: boolean[] };
}

describe("the host", () => {
  it("says who it is without a token, and nothing more", async () => {
    track(await claimEngine({ baseDir: base, kind: "server", version: "0.2.0", handlers: {} }).then((h) => h!));
    const who = await whoAt({ pipe: enginePipePath(base) });
    expect(who).toMatchObject({ kind: "server", version: "0.2.0", home: homeHash(base), pid: process.pid });
    expect(JSON.stringify(who)).not.toContain(readEngineFile(base)!.token);
  });

  it("admits a client of another contract to the engine:* channels only", async () => {
    track(
      await claimEngine({
        baseDir: base,
        kind: "server",
        version: "0.2.0",
        handlers: { "engine:info": () => ({ ok: true }), "task:list": () => [] },
      }).then((h) => h!),
    );
    const client = track(await connectEngine({ baseDir: base, client: "old desktop", version: "0.1.0", contract: "000000000000" }));
    expect(client.limited).toBe(true);
    expect(await client.invoke("engine:info")).toEqual({ ok: true });
    await expect(client.invoke("task:list", {})).rejects.toThrow(/another contract/);
  });

  it("listens on the loopback port when its pipe cannot be created, and is found there", async () => {
    const pipe = unmakeablePipe();
    const host = track(await claimEngine({ baseDir: base, kind: "server", version: "0.2.0", handlers: { "engine:info": () => "port" }, pipe, port: PORT }).then((h) => h!));
    expect(host.info.port).toBe(PORT);
    const found = await discoverEngine({ baseDir: base, pipe, port: PORT, processes: async () => [] });
    expect(found).toMatchObject({ kind: "found", via: "port" });
    const client = track(await connectEngine({ baseDir: base, client: "t", version: "0.2.0", address: { port: PORT } }));
    expect(await client.invoke("engine:info")).toBe("port");
  });
});

describe("per connection", () => {
  it("stands each connection at the project it opened, and watches the limits while any connection does", async () => {
    const service = fakeService();
    const connections = new EngineConnections(service);
    const a = connections.handlersFor("a") as Record<string, (r: unknown) => unknown>;
    const b = connections.handlersFor("b") as Record<string, (r: unknown) => unknown>;
    await a["project:open"]!({ dir: join(base, "one") });
    await b["project:open"]!({ dir: join(base, "two") });
    expect(a["project:current"]!(undefined)).toEqual({ dir: join(base, "one") });
    expect(b["project:current"]!(undefined)).toEqual({ dir: join(base, "two") });
    a["limits:watch"]!({ watching: true });
    b["limits:watch"]!({ watching: true });
    a["limits:watch"]!({ watching: false });
    expect(service.watching).toEqual([true]);
    connections.drop("b");
    expect(service.watching).toEqual([true, false]);
  });
});

describe("a CLI command's claim", () => {
  it("builds no engine until a client asks it something, and stopping it is refused", async () => {
    let built = 0;
    const hosted = await hostEngine({
      baseDir: base,
      kind: "cli",
      version: "0.2.0",
      service: () => {
        built += 1;
        return fakeService();
      },
      stopRefusal: "a jaira command holds the engine; it ends by itself",
    });
    closers.push(() => hosted!.close());
    const client = track(await connectEngine({ baseDir: base, client: "desktop", version: "0.2.0" }));
    expect(await client.invoke("engine:info")).toMatchObject({ host: { kind: "cli" }, clients: [{ name: "desktop" }] });
    await expect(client.invoke("engine:stop")).rejects.toThrow(/ends by itself/);
    expect(built).toBe(0);
    await client.invoke("project:open", { dir: join(base, "p") });
    expect(await client.invoke("project:current")).toEqual({ dir: join(base, "p") });
    expect(built).toBe(1);
  });

  it("a server's stop is answered, then carried out", async () => {
    let hosted: HostedEngine | undefined;
    let stopped = false;
    hosted = await hostEngine({
      baseDir: base,
      kind: "server",
      version: "0.2.0",
      service: fakeService(),
      stop: async () => {
        await hosted!.close();
        stopped = true;
      },
    });
    const client: EngineClient = await connectEngine({ baseDir: base, client: "jaira server stop", version: "0.2.0" });
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    expect(await client.invoke("engine:stop")).toEqual({ stopping: true });
    await closed;
    await expect.poll(() => stopped).toBe(true);
    expect(existsSync(engineFilePath(base))).toBe(false);
  });
});

describe("discovery", () => {
  it("reads the real process list, which has this process in it", async () => {
    const processes = await listProcesses();
    // `node`, or on Linux the title a test runner gives its worker (`node (vitest 3)`).
    expect(processes.find((p) => p.pid === process.pid)?.name).toMatch(/^node(\.exe)?( \(.*\))?$/i);
  }, 20_000);

  it("finds a host on its pipe", async () => {
    track(await claimEngine({ baseDir: base, kind: "desktop", version: "0.2.0", handlers: {} }).then((h) => h!));
    expect(await discoverEngine({ baseDir: base, port: PORT, processes: async () => [] })).toMatchObject({ kind: "found", via: "pipe", host: { kind: "desktop" } });
  });

  it("finds a host through engine.json when its pipe is not the one this process computes", async () => {
    const elsewhere = process.platform === "win32" ? `\\\\.\\pipe\\jaira-test-${process.pid}-${Date.now()}` : join(base, "else.sock");
    track(await claimEngine({ baseDir: base, kind: "server", version: "0.2.0", handlers: {}, pipe: elsewhere }).then((h) => h!));
    expect(await discoverEngine({ baseDir: base, port: PORT, processes: async () => [] })).toMatchObject({ kind: "found", via: "file" });
  });

  it("calls a live JaiRA process that engine.json names, with nothing answering, stuck", async () => {
    writeEngineFile(base, {
      kind: "desktop",
      pid: process.pid,
      version: "0.2.0",
      contract: "x",
      pipe: unmakeablePipe(),
      home: homeHash(base),
      exe: process.execPath,
      startedAt: Date.now(),
      token: "t",
    });
    const found = await discoverEngine({ baseDir: base, port: PORT, processes: async () => [{ pid: process.pid, name: "JaiRA" }] });
    expect(found).toMatchObject({ kind: "stuck", pid: process.pid, name: "JaiRA" });
  });

  it("removes an engine.json whose process is gone, and finds nobody", async () => {
    writeEngineFile(base, {
      kind: "server",
      pid: 2_000_000_000,
      version: "0.2.0",
      contract: "x",
      pipe: unmakeablePipe(),
      home: homeHash(base),
      exe: process.execPath,
      startedAt: Date.now(),
      token: "t",
    });
    const found = await discoverEngine({ baseDir: base, port: PORT, processes: async () => [{ pid: 4242, name: "JaiRA" }], listOthers: true });
    expect(found).toEqual({ kind: "none", others: [{ pid: 4242, name: "JaiRA" }] });
    expect(existsSync(engineFilePath(base))).toBe(false);
  });
});
