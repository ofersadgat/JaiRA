/**
 * The engine over the network (decision 0013 §2): the loopback listener answers who it is, upgrades
 * `/engine` to a WebSocket that Node's own client speaks, admits a paired machine by its token and
 * refuses anyone else, carries messages past 64 KB each way, hides this machine's paths from `who`, and
 * drops a machine whose pairing is revoked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectEngine, whoAt } from "@jaira/service/engineClient";
import { claimEngine, type EngineHost } from "@jaira/service/engineHost";
import { listenNetwork, type NetworkListener } from "@jaira/service/engineNet";
import { machineIdentity, machineTags, updateMachineIdentity } from "@jaira/service/machine";
import { MachineTokens } from "@jaira/service/machineTokens";

let base: string;
let host: EngineHost | undefined;
let net: NetworkListener | undefined;
let tokens: MachineTokens;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "jaira-net-"));
  tokens = new MachineTokens(base);
  host = await claimEngine({
    baseDir: base,
    kind: "desktop",
    version: "0.2.0",
    handlers: { "echo:it": (request: unknown) => request },
    authorizeNetwork: (token) => tokens.verify(token),
  });
  net = await listenNetwork({ host: host!, identity: () => machineIdentity(base), version: "0.2.0", port: 0 });
});

afterEach(async () => {
  await net?.close();
  await host?.close();
  rmSync(base, { recursive: true, force: true });
});

const url = (): string => `ws://127.0.0.1:${net!.port}/engine`;

describe("the engine's network listener", () => {
  it("says which machine it is", async () => {
    const identity = machineIdentity(base);
    const answer = (await (await fetch(`http://127.0.0.1:${net!.port}/.well-known/jaira`)).json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ jaira: true, machineId: identity.id, label: identity.label, version: "0.2.0" });
    expect((await fetch(`http://127.0.0.1:${net!.port}/other`)).status).toBe(404);
  });

  it("serves a granted artifact's files and blobs, each page sandboxed into an opaque origin", async () => {
    await net!.close();
    const token = "0123456789abcdef0123456789abcdef";
    net = await listenNetwork({
      host: host!,
      identity: () => machineIdentity(base),
      version: "0.2.0",
      port: 0,
      artifacts: {
        served: (t, path) => (t === token && path === "/project/Main.dc.html" ? { body: "<x-dc>main</x-dc>", mediaType: "text/html", policy: "canvas" } : undefined),
        blob: (id) => (id === "abc123" ? { body: Buffer.from([1, 2, 3]), mediaType: "image/png", policy: "canvas" } : undefined),
      },
    });
    const at = `http://127.0.0.1:${net.port}`;
    const page = await fetch(`${at}/artifact/${token}/project/Main.dc.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<x-dc>main</x-dc>");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toMatch(/; sandbox allow-scripts allow-popups$/);
    expect(page.headers.get("content-security-policy")).not.toMatch(/allow-same-origin/);
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
    const blob = await fetch(`${at}/_blob/abc123`);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    // Another token, another path, a token of the wrong shape: nothing.
    expect((await fetch(`${at}/artifact/${"f".repeat(32)}/project/Main.dc.html`)).status).toBe(404);
    expect((await fetch(`${at}/artifact/${token}/project/Other.dc.html`)).status).toBe(404);
    expect((await fetch(`${at}/artifact/nope/project/Main.dc.html`)).status).toBe(404);
    expect((await fetch(`${at}/_blob/ffff`)).status).toBe(404);
  });

  it("admits a paired machine by its token, and carries large messages both ways", async () => {
    const token = tokens.issue("m-laptop", "laptop");
    const client = await connectEngine({ baseDir: base, client: "desktop", version: "0.2.0", address: { url: url() }, token });
    const big = "x".repeat(200_000);
    expect(await client.invoke("echo:it", { big })).toEqual({ big });
    expect(host!.connected()).toEqual([expect.objectContaining({ transport: "network", machine: { id: "m-laptop", label: "laptop" } })]);
    client.close();
  });

  it("refuses a hello without a machine token, even with engine.json's", async () => {
    await expect(connectEngine({ baseDir: base, client: "stranger", version: "0.2.0", address: { url: url() }, token: "not-a-token" })).rejects.toThrow(/not paired/);
  });

  it("tells the network who it is without this machine's paths", async () => {
    const who = await whoAt({ url: url() });
    expect(who).toMatchObject({ kind: "desktop", version: "0.2.0", pipe: "", exe: "" });
  });

  it("drops a machine whose pairing is revoked, and refuses it after", async () => {
    const token = tokens.issue("m-laptop", "laptop");
    const client = await connectEngine({ baseDir: base, client: "desktop", version: "0.2.0", address: { url: url() }, token });
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    expect(tokens.revoke("m-laptop")).toBe(true);
    host!.dropMachine("m-laptop");
    await closed;
    await expect(connectEngine({ baseDir: base, client: "desktop", version: "0.2.0", address: { url: url() }, token })).rejects.toThrow(/not paired/);
  });
});

describe("this machine", () => {
  it("keeps one identity, renamed and tagged, with its OS always a tag", () => {
    const first = machineIdentity(base);
    expect(machineIdentity(base).id).toBe(first.id);
    const renamed = updateMachineIdentity(base, { label: "desk", tags: ["GPU", "gpu", first.os] });
    expect(renamed).toMatchObject({ id: first.id, label: "desk", tags: ["gpu"] });
    expect(machineTags(renamed)).toEqual([first.os, "gpu"]);
    expect(() => updateMachineIdentity(base, { tags: ["not a tag"] })).toThrow(/not a tag/);
  });
});
