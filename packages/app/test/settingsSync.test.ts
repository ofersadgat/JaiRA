/**
 * Settings that follow the person across their machines (decision 0026): two engines in one process, each
 * its own base root, keychain and agent sign-ins, paired on loopback. What one machine changes — a Shared
 * setting, a Just you setting, a key, a forge sign-in, an agent's sign-in — reaches the other; what is the
 * machine's own (where agents run, a local MCP server, an agent's binary path, the machine tokens) stays.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppService, hostEngine, loopbackTailnet, type AgentLoginStore, type HostedEngine, type KeychainPort } from "@jaira/service";
import { pairMachines } from "./pairMachines";

interface Machine {
  base: string;
  service: AppService;
  hosted: HostedEngine;
  keychain: Map<string, string>;
  logins: Map<string, string>;
}

const made: Machine[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const m of made.splice(0)) await m.hosted.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryKeychain(store: Map<string, string>): KeychainPort {
  return {
    available: () => true,
    get: (name) => store.get(name),
    set: (name, value) => void store.set(name, value),
    remove: (name) => void store.delete(name),
    names: () => [...store.keys()],
  };
}

function memoryLogin(agent: string, store: Map<string, string>, unavailable?: string): AgentLoginStore {
  return {
    agent,
    unavailable: () => unavailable,
    read: () => (store.has(agent) ? { value: store.get(agent)!, at: 0 } : undefined),
    write: (value) => void store.set(agent, value),
    remove: () => void store.delete(agent),
  };
}

async function machine(label: string, opts: { codexRefused?: boolean } = {}): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-sync-${label}-`));
  dirs.push(base);
  const keychain = new Map<string, string>();
  const logins = new Map<string, string>();
  let hosted: HostedEngine | undefined;
  const service = new AppService({
    baseDir: base,
    version: "0.2.0",
    tailnet: loopbackTailnet(),
    announce: false,
    watchWorkflows: false,
    keychain: memoryKeychain(keychain),
    agentLogins: [memoryLogin("claude-cli", logins), memoryLogin("codex-cli", logins, opts.codexRefused === true ? "the keychain did not let JaiRA read it" : undefined)],
    settingsSyncTimings: { settleMs: 30 },
    publish: (m) => hosted?.host.broadcast(m),
  });
  hosted = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  service.fleet.rename(label);
  await service.fleet.signIn();
  const m: Machine = { base, service, hosted, keychain, logins };
  made.push(m);
  return m;
}

async function paired(): Promise<[Machine, Machine]> {
  const a = await machine("desk");
  const b = await machine("mini");
  await pairMachines(a.service.fleet, b.service.fleet);
  await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 8000 }).toBe("online");
  await expect.poll(() => b.service.fleet.view().machines[0]?.state, { timeout: 8000 }).toBe("online");
  return [a, b];
}

const layer = (m: Machine, which: "base" | "you"): Record<string, unknown> => {
  const view = m.service.readConfig();
  return ((which === "base" ? view.base : view.you) ?? {}) as Record<string, unknown>;
};

describe("settings that follow the person", { timeout: 60_000 }, () => {
  it("carries Shared and Just you settings to the other machine, and keeps each machine's own", async () => {
    const [a, b] = await paired();
    // B's own: where its agents run, a server it starts, its claude binary.
    b.service.writeConfig({ layer: "base", config: { execEnvironment: "windows", mcp: { servers: { files: { command: "npx", args: ["files"] } } } } });
    b.service.writeConfig({ layer: "you", config: { agents: { claudeCli: { command: "/opt/homebrew/bin/claude" } } } });

    a.service.writeConfig({
      layer: "base",
      config: {
        integrations: { forges: { work: { provider: "gitlab", host: "gitlab.work.example", credential: "WORK_TOKEN" } } },
        mcp: { servers: { linear: { url: "https://mcp.linear.app/sse" }, mine: { url: "http://localhost:3000/mcp" } } },
        autopilot: { askBelow: 0.4 },
      },
    });
    a.service.writeConfig({ layer: "you", config: { appearance: { mode: "dark" }, agents: { claudeCli: { enabled: false, command: "/usr/local/bin/claude" } } } });

    await expect.poll(() => (layer(b, "base")["autopilot"] as { askBelow?: number } | undefined)?.askBelow, { timeout: 8000 }).toBe(0.4);
    expect(layer(b, "base")).toEqual({
      execEnvironment: "windows",
      integrations: { forges: { work: { provider: "gitlab", host: "gitlab.work.example", credential: "WORK_TOKEN" } } },
      // The loopback server stays on A; B's own command server stays on B.
      mcp: { servers: { files: { command: "npx", args: ["files"] }, linear: { url: "https://mcp.linear.app/sse" } } },
      autopilot: { askBelow: 0.4 },
    });
    await expect.poll(() => (layer(b, "you")["appearance"] as { mode?: string } | undefined)?.mode, { timeout: 8000 }).toBe("dark");
    // A's switch came; B's binary path stayed.
    expect(layer(b, "you")["agents"]).toEqual({ claudeCli: { enabled: false, command: "/opt/homebrew/bin/claude" } });
    // Nothing of B's own went the other way.
    expect(layer(a, "base")["execEnvironment"]).toBeUndefined();
    expect((layer(a, "base")["mcp"] as { servers: Record<string, unknown> }).servers["files"]).toBeUndefined();

    // A removal travels too.
    const { autopilot: _gone, ...rest } = layer(a, "base");
    a.service.writeConfig({ layer: "base", config: rest as never });
    await expect.poll(() => layer(b, "base")["autopilot"], { timeout: 8000 }).toBeUndefined();
  });

  it("keeps both machines' changes to different settings, and the later of two changes to one", async () => {
    const [a, b] = await paired();
    // Both have had their first look (at the pull each made as the other came online).
    for (const m of [a, b]) await expect.poll(() => existsSync(join(m.base, "system", "settings-sync.json")), { timeout: 8000 }).toBe(true);
    // Each changes something by hand, which neither offers until it looks again.
    writeFileSync(join(a.base, "personal-settings.json"), JSON.stringify({ appearance: { mode: "dark", palette: "ink" } }));
    a.service.settingsSync.scan();
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(b.base, "personal-settings.json"), JSON.stringify({ appearance: { mode: "light", sizeApp: 14 } }));
    b.service.settingsSync.scan();
    const bId = b.service.fleet.identity().id;
    const aId = a.service.fleet.identity().id;
    await a.service.settingsSync.pullFrom(bId);
    await b.service.settingsSync.pullFrom(aId);
    // B's mode was changed later; A's palette and B's size were each changed on one machine only.
    expect(layer(a, "you")["appearance"]).toEqual({ mode: "light", palette: "ink", sizeApp: 14 });
    expect(layer(b, "you")["appearance"]).toEqual({ mode: "light", palette: "ink", sizeApp: 14 });
  });

  it("carries keys and forge sign-ins, but never the tokens a machine holds for the others", async () => {
    const [a, b] = await paired();
    a.service.setSecret({ name: "GITHUB_TOKEN", value: "ghp_desk", target: "keychain" });
    await expect.poll(() => b.keychain.get("GITHUB_TOKEN"), { timeout: 8000 }).toBe("ghp_desk");
    // Each holds a token for the other under `jaira.machine.*`: neither travelled.
    expect([...a.keychain.keys()].filter((k) => k.startsWith("jaira.")).every((k) => b.keychain.get(k) !== a.keychain.get(k))).toBe(true);

    // A sign-in's mark travels with its token, and says where B keeps it.
    const file = join(a.base, "user-settings.json");
    const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(join(a.base, "user-settings.json"), JSON.stringify({ ...settings, forgeSignIns: { GITHUB_TOKEN: { provider: "github", host: "github.com", source: "keychain", at: 1 } } }));
    a.service.settingsSync.kick(0);
    await expect.poll(() => b.service.readSettings().forgeSignIns?.["GITHUB_TOKEN"], { timeout: 8000 }).toEqual({ provider: "github", host: "github.com", source: "keychain", at: 1 });

    // Cleared on one machine, cleared on the other.
    a.service.setSecret({ name: "GITHUB_TOKEN", value: "", target: "keychain" });
    await expect.poll(() => b.keychain.has("GITHUB_TOKEN"), { timeout: 8000 }).toBe(false);
  });

  it("carries an agent's sign-in and its sign-out, but not into a store this machine cannot reach", async () => {
    const a = await machine("desk");
    const b = await machine("mini", { codexRefused: true });
    await pairMachines(a.service.fleet, b.service.fleet);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 8000 }).toBe("online");
    a.logins.set("claude-cli", '{"claudeAiOauth":{"accessToken":"a1"}}');
    a.logins.set("codex-cli", '{"tokens":{"access_token":"c1"}}');
    a.service.settingsSync.kick(0);
    await expect.poll(() => b.logins.get("claude-cli"), { timeout: 8000 }).toBe('{"claudeAiOauth":{"accessToken":"a1"}}');
    expect(b.logins.has("codex-cli")).toBe(false);
    expect(b.service.fleet.view().self.settings?.logins).toEqual([
      { agent: "claude-cli", synced: true },
      { agent: "codex-cli", synced: false, why: "the keychain did not let JaiRA read it" },
    ]);

    // The agent refreshed its own sign-in on A: B follows at A's next look.
    a.logins.set("claude-cli", '{"claudeAiOauth":{"accessToken":"a2"}}');
    a.service.settingsSync.kick(0);
    await expect.poll(() => b.logins.get("claude-cli"), { timeout: 8000 }).toBe('{"claudeAiOauth":{"accessToken":"a2"}}');

    // Signed out through JaiRA on A.
    a.logins.delete("claude-cli");
    a.service.settingsSync.removed("login", "claude-cli");
    await expect.poll(() => b.logins.has("claude-cli"), { timeout: 8000 }).toBe(false);
  });

  it("catches up when it is turned back on, and says what it would not take", async () => {
    const [a, b] = await paired();
    b.service.setSyncSettings(false);
    a.service.writeConfig({ layer: "base", config: { archive: { keepLatest: 9 } } });
    await new Promise((r) => setTimeout(r, 300));
    expect(layer(b, "base")["archive"]).toBeUndefined();
    b.service.setSyncSettings(true);
    await expect.poll(() => (layer(b, "base")["archive"] as { keepLatest?: number } | undefined)?.keepLatest, { timeout: 8000 }).toBe(9);

    // A setting that would not load here is left out, and said.
    b.service.settingsSync.take([{ key: 'base:["appearance","mode"]', at: Date.now() + 60_000, by: "zz-other", value: "purple" }], "a broken machine");
    expect(layer(b, "base")["appearance"]).toBeUndefined();
    expect(b.service.fleet.view().self.settings?.refused?.[0]).toMatchObject({ what: "Shared appearance.mode" });
    expect(existsSync(join(b.base, "system", "settings-sync.json"))).toBe(true);
    // The file holds stamps and hashes, never a value.
    expect(readFileSync(join(b.base, "system", "settings-sync.json"), "utf8")).not.toContain("keepLatest\": 9");
  });
});
