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
