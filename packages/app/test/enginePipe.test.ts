/**
 * The local engine's pipe (decision 0012 §2–§3): one host per base root, claimed by creating the pipe;
 * a client admitted only with the token in engine.json and the same contract; requests answered by the
 * host's handlers, errors as errors; pushes only to admitted clients; and a host that closes takes its
 * pipe and engine.json with it.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimEngine, type EngineHost } from "@jaira/service/engineHost";
import { connectEngine, type EngineClient } from "@jaira/service/engineClient";
import { engineFilePath, enginePipePath, readEngineFile } from "@jaira/service/enginePipe";
import type { PushMessage } from "@jaira/shared";

let base: string;
const hosts: EngineHost[] = [];
const clients: EngineClient[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jaira-engine-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0)) await host.close();
  rmSync(base, { recursive: true, force: true });
});

async function host(): Promise<EngineHost> {
  const claimed = await claimEngine({
    baseDir: base,
    kind: "desktop",
    version: "0.1.0",
    handlers: {
      "project:current": () => ({ dir: "/somewhere" }),
      "task:list": () => {
        throw Object.assign(new Error("project 'x' is not open"), { name: "Refusal" });
      },
    },
  });
  expect(claimed).toBeDefined();
  hosts.push(claimed!);
  return claimed!;
}

async function client(options: { token?: string } = {}): Promise<EngineClient> {
  const connected = await connectEngine({ baseDir: base, client: "test", version: "0.1.0", ...options });
  clients.push(connected);
  return connected;
}

describe("the engine's pipe", () => {
  it("is claimed once: a second host for the same base root is refused", async () => {
    await host();
    expect(await claimEngine({ baseDir: base, kind: "server", version: "0.1.0", handlers: {} })).toBeUndefined();
    expect(readEngineFile(base)).toMatchObject({ kind: "desktop", pid: process.pid, pipe: enginePipePath(base) });
  });

  it("answers an admitted client's requests with its handlers, and a handler's error as an error", async () => {
    await host();
    const c = await client();
    expect(c.host).toMatchObject({ kind: "desktop", version: "0.1.0" });
    expect(await c.invoke("project:current", undefined)).toEqual({ dir: "/somewhere" });
    await expect(c.invoke("task:list", {})).rejects.toMatchObject({ message: "project 'x' is not open", name: "Refusal" });
    await expect(c.invoke("nope:nothing", {})).rejects.toThrow(/does not answer 'nope:nothing'/);
  });

  it("refuses a client without the token", async () => {
    await host();
    await expect(connectEngine({ baseDir: base, client: "stranger", version: "0.1.0", token: "not-it" })).rejects.toThrow(/token does not match/);
  });

  it("sends pushes to admitted clients only", async () => {
    const h = await host();
    const c = await client();
    const heard: PushMessage[] = [];
    c.onPush((m) => heard.push(m));
    h.broadcast({ type: "store:invalidate", scope: "board" } as PushMessage);
    await new Promise((r) => setTimeout(r, 50));
    expect(heard).toEqual([{ type: "store:invalidate", scope: "board" }]);
    expect(h.admitted()).toBe(1);
  });

  it("welcomes a client before its own log line about it, which is itself a push", async () => {
    // The desktop's log publishes every entry, and so broadcasts it on the pipe: found on the real app.
    let claimed: EngineHost | undefined;
    claimed = await claimEngine({
      baseDir: base,
      kind: "desktop",
      version: "0.1.0",
      handlers: {},
      log: (_level, message) => claimed?.broadcast({ type: "log:entry", entry: { message } } as unknown as PushMessage),
    });
    hosts.push(claimed!);
    const c = await client();
    expect(c.host.kind).toBe("desktop");
  });

  it("takes its pipe and engine.json with it when it closes, and the client hears it", async () => {
    const h = await host();
    const c = await client();
    let closed = false;
    c.onClose(() => (closed = true));
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    expect(existsSync(engineFilePath(base))).toBe(false);
    await expect(c.invoke("project:current", undefined)).rejects.toThrow(/went away/);
    // …and the next process can claim it.
    expect(await claimEngine({ baseDir: base, kind: "server", version: "0.1.0", handlers: {} }).then((next) => (next !== undefined ? (hosts.push(next), true) : false))).toBe(true);
  });
});
