/**
 * Settings that follow the person across their machines (decision 0026): two engines in one process, each
 * its own base root, keychain and agent sign-ins, paired on loopback. What one machine changes — a Shared
 * setting, a Just you setting, a key, a forge sign-in, an agent's sign-in — reaches the other; what is the
 * machine's own (where agents run, a local MCP server, an agent's binary path, the machine tokens) stays.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppService, hostEngine, loopbackTailnet, type AgentLoginStore, type HostedEngine, type KeychainPort } from "@jaira/service";
import { initProject } from "@jaira/persistence";
import { SYNCED_FILE_MAX_BYTES } from "@jaira/shared";
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

async function machine(label: string, opts: { codexRefused?: boolean; works?: Map<string, boolean> } = {}): Promise<Machine> {
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
    // Whether each agent's sign-in works here: what a test says, never the real agents on this machine.
    agentLoginWorks: (agent) => opts.works?.get(agent),
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

/** A clone of `remote` (none: a folder with no remote) set up as a project on one machine's disk. */
function clone(m: Machine, name: string, remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `jaira-sync-${name}-`));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  if (remote !== undefined) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  initProject(dir, m.base);
  return dir;
}

/** The person's settings for one project, as a machine reads them for a workspace. */
const mine = (m: Machine, dir: string): Record<string, unknown> => (m.service.readConfig(dir).projectYou ?? {}) as Record<string, unknown>;

const layer = (m: Machine, which: "base" | "you"): Record<string, unknown> => {
  const view = m.service.readConfig();
  return ((which === "base" ? view.base : view.you) ?? {}) as Record<string, unknown>;
};

/** Write a file under a machine's shared root by hand, as a person or an editor would. */
function put(m: Machine, rel: string, text: string): void {
  const file = join(m.base, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A file under a machine's shared root, or undefined when it is not there. */
const at = (m: Machine, rel: string): string | undefined => (existsSync(join(m.base, rel)) ? readFileSync(join(m.base, rel), "utf8") : undefined);

/** Which layers hold a permission set, as Settings → Permission sets reads them. */
const setLayers = (m: Machine, id: string, project?: string): string[] | undefined =>
  m.service.readPermissionSetSettings({ ...(project !== undefined ? { project } : {}), usedBy: false }).records.find((r) => r.id === id)?.files.map((f) => f.layer);

const STATE = `${JSON.stringify({ label: "Nightly", operation: { kind: "prompt", prompt: "Tidy up." } }, null, 2)}\n`;

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
    // Both have had their first look, and finished the pull each made as the other came online — before
    // that pull is answered, a change made by hand below could still be taken by it, and then taken out.
    for (const m of [a, b]) await expect.poll(() => existsSync(join(m.base, "system", "settings-sync.json")), { timeout: 8000 }).toBe(true);
    for (const m of [a, b]) await expect.poll(() => m.service.settingsSync.view().at, { timeout: 8000 }).toBeDefined();
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

  it("carries an agent's sign-in to a machine with none, and its sign-out, but not into a store this machine cannot reach", async () => {
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

    // Signed out through JaiRA on A.
    a.logins.delete("claude-cli");
    a.service.settingsSync.removed("login", "claude-cli");
    await expect.poll(() => b.logins.has("claude-cli"), { timeout: 8000 }).toBe(false);
  });

  it("keeps a machine's own sign-in while it works, and takes another's once it stops (2026-11-19)", async () => {
    const works = new Map<string, boolean>();
    const a = await machine("desk");
    const b = await machine("mini", { works });
    await pairMachines(a.service.fleet, b.service.fleet);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 8000 }).toBe("online");
    // Both have looked before: what changes next is stamped now, not by its age.
    a.service.settingsSync.scan();
    b.service.settingsSync.scan();
    b.logins.set("claude-cli", '{"claudeAiOauth":{"refreshToken":"b1","accountUuid":"u1"}}');
    b.service.settingsSync.scan();

    // A's agent refreshed its own: offered, and passed over by B, whose own works.
    a.logins.set("claude-cli", '{"claudeAiOauth":{"refreshToken":"a2","accountUuid":"u1"}}');
    a.service.settingsSync.kick(0);
    const passed = (): unknown => (JSON.parse(at(b, "system/settings-sync.json") ?? "{}") as { passed?: Record<string, unknown> }).passed?.["login:claude-cli"];
    await expect.poll(passed, { timeout: 8000 }).toBeDefined();
    expect(b.logins.get("claude-cli")).toBe('{"claudeAiOauth":{"refreshToken":"b1","accountUuid":"u1"}}');

    // B's stops working (its check found it signed out): it asks, and takes A's — the one it passed over.
    works.set("claude-cli", false);
    expect(await b.service.settingsSync.recoverLogin("claude-cli")).toBe("desk");
    expect(b.logins.get("claude-cli")).toBe('{"claudeAiOauth":{"refreshToken":"a2","accountUuid":"u1"}}');
    // Asked again with nothing different anywhere: nothing is taken, so a sign-in failing everywhere is not passed back and forth.
    expect(await b.service.settingsSync.recoverLogin("claude-cli")).toBeUndefined();

    // While it does not work, what A sends next is taken too.
    a.logins.set("claude-cli", '{"claudeAiOauth":{"refreshToken":"a3","accountUuid":"u1"}}');
    a.service.settingsSync.kick(0);
    await expect.poll(() => b.logins.get("claude-cli"), { timeout: 8000 }).toBe('{"claudeAiOauth":{"refreshToken":"a3","accountUuid":"u1"}}');
  });

  it("never sends or takes a sign-in that is signed out, expired or not working", async () => {
    const works = new Map<string, boolean>();
    const a = await machine("desk", { works });
    const b = await machine("mini");
    await pairMachines(a.service.fleet, b.service.fleet);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 8000 }).toBe("online");
    // What Claude Code leaves after a refused refresh: both tokens emptied, the account kept.
    const wiped = '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"refreshTokenExpiresAt":1797485146918,"accountUuid":"u1"}}';
    a.logins.set("claude-cli", wiped);
    // …and Codex with a token its check found refused.
    a.logins.set("codex-cli", '{"tokens":{"access_token":"c1","account_id":"acct"}}');
    works.set("codex-cli", false);
    a.service.settingsSync.kick(0);
    // A key set alongside is the proof A's offer went out.
    a.service.setSecret({ name: "MARKER", value: "m", target: "keychain" });
    await expect.poll(() => b.keychain.get("MARKER"), { timeout: 8000 }).toBe("m");
    expect(b.logins.has("claude-cli")).toBe(false);
    expect(b.logins.has("codex-cli")).toBe(false);

    // An older JaiRA still sends them: refused, and said.
    const codexOut = '{"OPENAI_API_KEY":null,"tokens":{"access_token":"","refresh_token":"","account_id":"acct"}}';
    expect(b.service.settingsSync.take([{ key: "login:claude-cli", at: Date.now() + 1000, by: "old-machine", value: wiped }, { key: "login:codex-cli", at: Date.now() + 1000, by: "old-machine", value: codexOut }], "old")).toBe(0);
    expect(b.logins.size).toBe(0);
    expect(b.service.fleet.view().self.settings?.refused?.map((r) => r.why)).toContain("it is signed out or expired");
  });

  it("carries your settings for one project to every clone of it, and keeps a clone with no remote's", async () => {
    const [a, b] = await paired();
    const atlasA = clone(a, "atlas-a", "git@github.com:me/atlas.git");
    const atlasB = clone(b, "atlas-b", "https://github.com/me/atlas");
    const scratch = clone(a, "scratch");
    await a.service.open(atlasA);
    await a.service.open(scratch);
    await b.service.open(atlasB);
    // B's own for atlas: where its agents run, kept.
    b.service.writeConfig({ layer: "projectYou", project: atlasB, config: { execEnvironment: "windows" } });

    a.service.writeConfig({ layer: "projectYou", project: atlasA, config: { appearance: { mode: "dark" }, execEnvironment: { wsl: "Ubuntu" }, autopilot: { askBelow: 0.3 } } });
    a.service.writeConfig({ layer: "projectYou", project: scratch, config: { appearance: { palette: "ink" } } });
    await expect.poll(() => (mine(b, atlasB)["appearance"] as { mode?: string } | undefined)?.mode, { timeout: 8000 }).toBe("dark");
    expect(mine(b, atlasB)).toEqual({ execEnvironment: "windows", appearance: { mode: "dark" }, autopilot: { askBelow: 0.3 } });
    // A run of atlas on B reads it.
    expect(b.service.readConfig(atlasB).effective).toMatchObject({ autopilot: { askBelow: 0.3 } });
    // The clone with no remote is keyed by where it is on A, which names nothing on B: it stayed.
    expect(readdirSync(join(b.base, "projects"))).toEqual(["github.com_me_atlas"]);

    // Changed and taken out on B, the other way.
    b.service.writeConfig({ layer: "projectYou", project: atlasB, config: { execEnvironment: "windows", appearance: { mode: "light" } } });
    await expect.poll(() => mine(a, atlasA), { timeout: 8000 }).toEqual({ appearance: { mode: "light" }, execEnvironment: { wsl: "Ubuntu" } });
  });

  it("keeps your settings for a project not cloned here, for when it is", async () => {
    const [a, b] = await paired();
    const atlasA = clone(a, "atlas-a", "https://github.com/me/atlas.git");
    await a.service.open(atlasA);
    a.service.writeConfig({ layer: "projectYou", project: atlasA, config: { archive: { keepLatest: 4 } } });
    const file = join(b.base, "projects", "github.com_me_atlas", "personal-settings.json");
    await expect.poll(() => existsSync(file), { timeout: 8000 }).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ archive: { keepLatest: 4 } });
    // Cloned on B later: it is there.
    const atlasB = clone(b, "atlas-b", "git@github.com:me/atlas.git");
    await b.service.open(atlasB);
    expect(mine(b, atlasB)).toEqual({ archive: { keepLatest: 4 } });
    // And a hand edit there, on a machine that only ever received the file, still travels back.
    writeFileSync(file, JSON.stringify({ archive: { keepLatest: 7 } }));
    b.service.settingsSync.kick(0);
    await expect.poll(() => (mine(a, atlasA)["archive"] as { keepLatest?: number } | undefined)?.keepLatest, { timeout: 8000 }).toBe(7);
  });

  it("takes the fleet's newer settings for a project opened here after its first look, rather than offering an old file as new", async () => {
    const [a, b] = await paired();
    const atlasA = clone(a, "atlas-a", "https://github.com/me/atlas");
    await a.service.open(atlasA);
    // B is not in step while A changes atlas; B's own file for atlas is from long ago.
    b.service.setSyncSettings(false);
    a.service.writeConfig({ layer: "projectYou", project: atlasA, config: { archive: { keepLatest: 5 } } });
    const atlasB = clone(b, "atlas-b", "git@github.com:me/atlas.git");
    await b.service.open(atlasB);
    b.service.writeConfig({ layer: "projectYou", project: atlasB, config: { archive: { keepLatest: 1 } } });
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(b.service.readConfig(atlasB).projectYouFile!, old, old);
    b.service.setSyncSettings(true);
    await expect.poll(() => (mine(b, atlasB)["archive"] as { keepLatest?: number } | undefined)?.keepLatest, { timeout: 8000 }).toBe(5);
    expect(mine(a, atlasA)).toEqual({ archive: { keepLatest: 5 } });
  });

  it("passes over a piece of a kind it does not know, as an older machine passes over a project's", async () => {
    const [, b] = await paired();
    // A newer machine's kind, and a project key that would reach out of `projects/`.
    expect(b.service.settingsSync.take([{ key: 'later:["appearance","mode"]', at: Date.now() + 60_000, by: "zz-newer", value: "dark" }], "a newer machine")).toBe(0);
    expect(b.service.settingsSync.take([{ key: 'projectYou:["..","appearance","mode"]', at: Date.now() + 60_000, by: "zz-newer", value: "dark" }], "a newer machine")).toBe(0);
    expect(existsSync(join(b.base, "appearance"))).toBe(false);
    expect(existsSync(join(b.base, "projects"))).toBe(false);
    expect(layer(b, "you")["appearance"]).toBeUndefined();
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

describe("permission sets and workflows that follow the person (amended 2026-11-18)", { timeout: 60_000 }, () => {
  it("carries Shared, Just you and your project's files each way: made, edited by hand, and deleted", async () => {
    const [a, b] = await paired();
    const atlasA = clone(a, "atlas-a", "git@github.com:me/atlas.git");
    const atlasB = clone(b, "atlas-b", "https://github.com/me/atlas");
    await a.service.open(atlasA);
    await b.service.open(atlasB);

    // Shared: made through JaiRA on A.
    const careful = { read_file: "allow", shell: "ask" } as const;
    a.service.savePermissionSet({ bucket: "work", name: "careful", layer: "base", permissionSet: careful });
    await expect.poll(() => at(b, "permission-sets/work/careful.json"), { timeout: 8000 }).toBe(`${JSON.stringify(careful, null, 2)}\n`);
    expect(setLayers(b, "work/careful", atlasB)).toEqual(["base"]);

    // Just you: made by hand on B, a set, an automation and its prompt.
    put(b, "personal/permission-sets/mine/quiet.json", '{"shell":"deny"}\n');
    put(b, "personal/workflows/nightly/start.json", STATE);
    put(b, "personal/prompts/tidy.md", "Tidy up.\n");
    b.service.settingsSync.kick(0);
    await expect.poll(() => at(a, "personal/permission-sets/mine/quiet.json"), { timeout: 8000 }).toBe('{"shell":"deny"}\n');
    expect(at(a, "personal/workflows/nightly/start.json")).toBe(STATE);
    expect(at(a, "personal/prompts/tidy.md")).toBe("Tidy up.\n");
    expect(setLayers(a, "mine/quiet", atlasA)).toEqual(["you"]);

    // You in atlas: made by hand on A, in the project's folder under its key.
    put(a, "projects/github.com_me_atlas/permission-sets/atlas/strict.json", '{"shell":"deny"}\n');
    put(a, "projects/github.com_me_atlas/workflows/release/start.json", STATE);
    a.service.settingsSync.kick(0);
    await expect.poll(() => at(b, "projects/github.com_me_atlas/permission-sets/atlas/strict.json"), { timeout: 8000 }).toBe('{"shell":"deny"}\n');
    expect(at(b, "projects/github.com_me_atlas/workflows/release/start.json")).toBe(STATE);
    expect(setLayers(b, "atlas/strict", atlasB)).toEqual(["projectYou"]);

    // Edited by hand on the machine that only received them, each layer: back the other way.
    put(b, "permission-sets/work/careful.json", '{"shell":"allow"}\n');
    put(a, "personal/permission-sets/mine/quiet.json", '{"shell":"ask"}\n');
    put(b, "projects/github.com_me_atlas/permission-sets/atlas/strict.json", '{"shell":"ask"}\n');
    a.service.settingsSync.kick(0);
    b.service.settingsSync.kick(0);
    await expect.poll(() => at(a, "permission-sets/work/careful.json"), { timeout: 8000 }).toBe('{"shell":"allow"}\n');
    await expect.poll(() => at(b, "personal/permission-sets/mine/quiet.json"), { timeout: 8000 }).toBe('{"shell":"ask"}\n');
    await expect.poll(() => at(a, "projects/github.com_me_atlas/permission-sets/atlas/strict.json"), { timeout: 8000 }).toBe('{"shell":"ask"}\n');

    // Deleted on one machine, deleted on the other — by hand, and through JaiRA's Files view.
    rmSync(join(a.base, "permission-sets", "work", "careful.json"));
    rmSync(join(b.base, "personal", "workflows", "nightly", "start.json"));
    a.service.deleteFile({ layer: "base", path: "projects/github.com_me_atlas/workflows/release/start.json" });
    a.service.settingsSync.kick(0);
    b.service.settingsSync.kick(0);
    await expect.poll(() => existsSync(join(b.base, "permission-sets", "work", "careful.json")), { timeout: 8000 }).toBe(false);
    await expect.poll(() => existsSync(join(a.base, "personal", "workflows", "nightly", "start.json")), { timeout: 8000 }).toBe(false);
    await expect.poll(() => existsSync(join(b.base, "projects", "github.com_me_atlas", "workflows", "release", "start.json")), { timeout: 8000 }).toBe(false);
    // What stayed is unchanged on both, and neither sees its own writes as news: nothing goes back and forth.
    expect(at(b, "personal/prompts/tidy.md")).toBe("Tidy up.\n");
    expect(a.service.settingsSync.scan()).toEqual([]);
    expect(b.service.settingsSync.scan()).toEqual([]);
    // Kept in step on A: the Just you set and prompt, and the set for atlas.
    expect(a.service.fleet.view().self.settings?.counts.files).toBe(3);
  });

  it("writes a project's files on a machine where it is not cloned, for when it is", async () => {
    const [a, b] = await paired();
    const atlasA = clone(a, "atlas-a", "https://github.com/me/atlas.git");
    await a.service.open(atlasA);
    put(a, "projects/github.com_me_atlas/permission-sets/atlas/strict.json", '{"shell":"deny"}\n');
    put(a, "projects/github.com_me_atlas/workflows/release/start.json", STATE);
    a.service.settingsSync.kick(0);
    await expect.poll(() => at(b, "projects/github.com_me_atlas/permission-sets/atlas/strict.json"), { timeout: 8000 }).toBe('{"shell":"deny"}\n');
    expect(at(b, "projects/github.com_me_atlas/workflows/release/start.json")).toBe(STATE);
    // Cloned on B later: its set is there for it.
    const atlasB = clone(b, "atlas-b", "git@github.com:me/atlas.git");
    await b.service.open(atlasB);
    expect(setLayers(b, "atlas/strict", atlasB)).toEqual(["projectYou"]);
    // And a hand edit on B, before or after the clone, travels back.
    put(b, "projects/github.com_me_atlas/workflows/release/start.json", STATE.replace("Tidy up.", "Ship it."));
    b.service.settingsSync.kick(0);
    await expect.poll(() => at(a, "projects/github.com_me_atlas/workflows/release/start.json"), { timeout: 8000 }).toContain("Ship it.");
  });

  it("on the first look at files, keeps the newer of two machines' copies, not the one looked at last", async () => {
    const [a, b] = await paired();
    for (const m of [a, b]) await expect.poll(() => m.service.settingsSync.view().at, { timeout: 8000 }).toBeDefined();
    // Both had the set before their JaiRA kept files in step: A's changed an hour ago, B's a day ago.
    put(a, "permission-sets/shared.json", '{"shell":"ask"}\n');
    put(b, "permission-sets/shared.json", '{"shell":"deny"}\n');
    const hour = new Date(Date.now() - 3_600_000);
    const day = new Date(Date.now() - 86_400_000);
    utimesSync(join(a.base, "permission-sets", "shared.json"), hour, hour);
    utimesSync(join(b.base, "permission-sets", "shared.json"), day, day);
    // As an engine from before 2026-11-18 left its sync file: settings looked at, files never.
    for (const m of [a, b]) {
      const file = join(m.base, "system", "settings-sync.json");
      const sync = JSON.parse(readFileSync(file, "utf8")) as { lookedFiles?: boolean; pieces: Record<string, unknown>; passed?: Record<string, unknown> };
      delete sync.lookedFiles;
      for (const key of Object.keys(sync.pieces)) if (key.startsWith("file:")) delete sync.pieces[key];
      for (const key of Object.keys(sync.passed ?? {})) if (key.startsWith("file:")) delete sync.passed![key];
      writeFileSync(file, JSON.stringify(sync));
    }
    // B looks first and asks A, then A asks B: A's copy was changed later, so both keep it.
    await b.service.settingsSync.pullFrom(a.service.fleet.identity().id);
    await a.service.settingsSync.pullFrom(b.service.fleet.identity().id);
    expect(at(a, "permission-sets/shared.json")).toBe('{"shell":"ask"}\n');
    expect(at(b, "permission-sets/shared.json")).toBe('{"shell":"ask"}\n');
  });

  it("never sends what is outside the folders that follow, a link, or a file over 1 MB", async () => {
    const [a, b] = await paired();
    const outside = mkdtempSync(join(tmpdir(), "jaira-sync-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.json"), '{"token":"elsewhere"}');
    const kept = [
      "system/notes.json",
      "machine/permission-sets/here.json",
      "machine/workflows/here/start.json",
      "functions/op.json",
      "skills/tidy/SKILL.md",
      "personal/notes.json",
      "projects/github.com_me_atlas/notes.json",
      "permission-sets/.env",
      "permission-sets/big.json",
    ];
    for (const rel of kept) put(a, rel, rel.endsWith("big.json") ? `"${"x".repeat(SYNCED_FILE_MAX_BYTES)}"` : '{"shell":"ask"}');
    const links = process.platform === "win32" ? [] : ["permission-sets/linked.json", "prompts/secret.json"];
    if (links.length > 0) {
      symlinkSync(join(outside, "secret.json"), join(a.base, "permission-sets", "linked.json"));
      // A whole synced folder that is a link elsewhere is not followed either.
      symlinkSync(outside, join(a.base, "prompts"));
    }
    // A small set, sent, then grown past the cap: it stays as it was elsewhere, neither sent nor removed.
    put(a, "permission-sets/grows.json", '{"shell":"ask"}');
    put(a, "permission-sets/marker.json", '{"shell":"ask"}');
    a.service.settingsSync.kick(0);
    await expect.poll(() => at(b, "permission-sets/marker.json"), { timeout: 8000 }).toBe('{"shell":"ask"}');
    expect(at(b, "permission-sets/grows.json")).toBe('{"shell":"ask"}');
    for (const rel of [...kept, ...links]) expect(existsSync(join(b.base, rel)), rel).toBe(false);
    put(a, "permission-sets/grows.json", `"${"x".repeat(SYNCED_FILE_MAX_BYTES)}"`);
    expect(a.service.settingsSync.scan()).toEqual([]);
    expect(at(b, "permission-sets/grows.json")).toBe('{"shell":"ask"}');
    // Said in the log, once each.
    const said = a.service.readLogs({ source: "machines" }).entries.map((e) => e.message);
    expect(said.filter((m) => /Shared permission-sets\/big\.json is over 1 MB, so it stays on this machine/.test(m))).toHaveLength(1);
    expect(said.some((m) => /Shared permission-sets\/grows\.json is over 1 MB/.test(m))).toBe(true);
    if (links.length > 0) expect(said.some((m) => /Shared permission-sets\/linked\.json is a link/.test(m))).toBe(true);
    // The sync file names none of them.
    const sync = readFileSync(join(a.base, "system", "settings-sync.json"), "utf8");
    for (const word of ["notes.json", "here.json", "op.json", "SKILL.md", ".env", "big.json", "linked.json", "secret.json"]) expect(sync).not.toContain(word);
  });

  it("refuses a path that leaves its folder, a project key that is not one, and a link out", async () => {
    const [, b] = await paired();
    const value = { base64: Buffer.from('{"shell":"allow"}').toString("base64") };
    const later = Date.now() + 60_000;
    const sent = (key: string, v: unknown = value): { key: string; at: number; by: string; value: never } => ({ key, at: later, by: "zz-other", value: v as never });
    expect(
      b.service.settingsSync.take(
        [
          sent('file:["base","permission-sets","..","..","escape.json"]'),
          sent('file:["base","system","jaira.json"]'),
          sent('file:["you","permission-sets","/tmp/escape.json"]'),
          sent('file:["projectYou","..","permission-sets","escape.json"]'),
          sent('file:["projectYou","github.com_me_atlas","..","..","escape.json"]'),
          sent('file:["machine","permission-sets","here.json"]'),
          sent('file:["base","permission-sets","odd.json"]', "not a file's bytes"),
        ],
        "a strange machine",
      ),
    ).toBe(0);
    expect(existsSync(join(b.base, "..", "escape.json"))).toBe(false);
    expect(existsSync(join(b.base, "system", "jaira.json"))).toBe(false);
    expect(existsSync(join(b.base, "machine", "permission-sets"))).toBe(false);
    expect(existsSync(join(b.base, "projects"))).toBe(false);
    expect(existsSync(join(b.base, "permission-sets", "odd.json"))).toBe(false);
    expect(b.service.fleet.view().self.settings?.refused?.length).toBeGreaterThan(0);

    if (process.platform !== "win32") {
      // B's own bucket is a link to a folder elsewhere: what comes for it is not written through it.
      const outside = mkdtempSync(join(tmpdir(), "jaira-sync-outside-"));
      dirs.push(outside);
      mkdirSync(join(b.base, "permission-sets"), { recursive: true });
      symlinkSync(outside, join(b.base, "permission-sets", "out"));
      expect(b.service.settingsSync.take([sent('file:["base","permission-sets","out","x.json"]')], "a strange machine")).toBe(0);
      expect(readdirSync(outside)).toEqual([]);
      expect(b.service.fleet.view().self.settings?.refused?.at(-1)).toMatchObject({ what: "Shared permission-sets/out/x.json", why: "permission-sets/out is a link here, which settings sync does not follow" });
    }
  });

  it("keeps working with an older machine, which knows no files", async () => {
    const [a, b] = await paired();
    // A kind a machine does not know, in a batch with a setting: passed over, and the setting taken.
    expect(
      b.service.settingsSync.take(
        [
          { key: 'later:["permission-sets","x.json"]', at: Date.now() + 60_000, by: "zz-newer", value: { base64: "" } },
          { key: 'base:["archive","keepLatest"]', at: Date.now() + 60_000, by: "zz-newer", value: 2 },
        ],
        "a newer machine",
      ),
    ).toBe(1);
    expect(layer(b, "base")["archive"]).toEqual({ keepLatest: 2 });

    // B stands in for a JaiRA from before files followed: it passes over every `file` piece, as `kindOf`
    // makes an older one do, and so never holds one to send or to remove.
    const sync = b.service.settingsSync;
    const take = sync.take.bind(sync);
    sync.take = (pieces, from) => take(pieces.filter((p) => !p.key.startsWith("file:")), from);
    put(a, "permission-sets/work/careful.json", '{"shell":"ask"}\n');
    a.service.writeConfig({ layer: "base", config: { autopilot: { askBelow: 0.4 } } });
    await expect.poll(() => (layer(b, "base")["autopilot"] as { askBelow?: number } | undefined)?.askBelow, { timeout: 8000 }).toBe(0.4);
    expect(existsSync(join(b.base, "permission-sets", "work", "careful.json"))).toBe(false);
    // The other way, a setting reaches A, and A's set is still there.
    b.service.writeConfig({ layer: "you", config: { appearance: { mode: "dark" } } });
    await expect.poll(() => (layer(a, "you")["appearance"] as { mode?: string } | undefined)?.mode, { timeout: 8000 }).toBe("dark");
    await a.service.settingsSync.pullFrom(b.service.fleet.identity().id);
    await b.service.settingsSync.pullFrom(a.service.fleet.identity().id);
    expect(at(a, "permission-sets/work/careful.json")).toBe('{"shell":"ask"}\n');
  });
});
