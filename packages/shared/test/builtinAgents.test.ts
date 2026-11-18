/**
 * The agent CLIs JaiRA ships set up (`builtin/settings.json`'s `agents.genericCli`): Gemini, Muse Code
 * and OpenCode, and Antigravity. The file is the source of truth; `BUILTIN_GENERIC_AGENTS` is what the rows know of
 * them, so the two are held to each other here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_GENERIC_AGENTS, EXECUTOR_TITLES, mergeConfigLayers, parseConfig } from "../src/index";

const BUILT_IN = JSON.parse(readFileSync(fileURLToPath(new URL("../builtin/settings.json", import.meta.url)), "utf8")) as Record<string, unknown>;

describe("the built-in agent CLIs", () => {
  it("ships Gemini, Antigravity, Muse Code and OpenCode as generic CLIs the parser accepts, each with a title and a hint", () => {
    const agents = parseConfig(BUILT_IN).agents?.genericCli ?? [];
    expect(agents.map((agent) => [agent.name, agent.command])).toEqual([
      ["gemini-cli", "gemini"],
      ["antigravity-cli", "agy"],
      ["muse-code", "muse"],
      ["opencode", "opencode"],
    ]);
    expect(Object.keys(BUILTIN_GENERIC_AGENTS).sort()).toEqual(agents.map((agent) => agent.name!).sort());
    for (const agent of agents) expect(EXECUTOR_TITLES[agent.name!]).toBeDefined();
  });

  it("runs each headless — none starts a session that waits on a terminal", () => {
    const args = Object.fromEntries((parseConfig(BUILT_IN).agents?.genericCli ?? []).map((agent) => [agent.name, agent.args]));
    expect(args["gemini-cli"]).toEqual(["--approval-mode", "auto_edit", "-p", "{prompt}"]);
    expect(args["antigravity-cli"]).toEqual(["--mode", "accept-edits", "-p", "{prompt}"]);
    expect(args["muse-code"]?.[0]).toBe("exec");
    expect(args["opencode"]?.[0]).toBe("run");
  });

  it("serves Gemini and OpenCode JaiRA's tools with their own off — the other two keep theirs, unchecked", () => {
    const agents = Object.fromEntries((parseConfig(BUILT_IN).agents?.genericCli ?? []).map((agent) => [agent.name, agent.mcp]));
    expect(agents["gemini-cli"]?.builtinsOff).toBe(true);
    expect(agents["opencode"]?.builtinsOff).toBe(true);
    expect(agents["antigravity-cli"]).toBeUndefined();
    expect(agents["muse-code"]).toBeUndefined();
    // Gemini: our settings are its SYSTEM file, which it merges last; `tools.core` lists only our server's
    // tools, which turns every built-in off and lets ours past the deny-everything rule it adds; and
    // only our server is started, not the person's own or an extension's.
    const gemini = agents["gemini-cli"]!;
    expect(gemini.env).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: "{mcpConfig}" });
    expect(gemini.args).toEqual(["--allowed-mcp-server-names", "dai"]);
    expect(gemini.config).toMatchObject({ mcpServers: { dai: { httpUrl: "{mcpUrl}", trust: true } }, tools: { core: ["mcp_dai_*"] } });
    // OpenCode: the project's own config is not read (a repository could re-allow a tool there), its
    // run is an agent of ours, and the permission it applies after every file denies all but ours.
    const opencode = agents["opencode"]!;
    expect(opencode.args).toEqual(["--agent", "jaira"]);
    expect(opencode.env).toMatchObject({ OPENCODE_CONFIG: "{mcpConfig}", OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
    expect(JSON.parse(opencode.env!["OPENCODE_PERMISSION"]!)).toEqual({ "*": "deny", "dai_*": "allow" });
    expect(opencode.config).toMatchObject({ mcp: { dai: { type: "remote", url: "{mcpUrl}" } }, agent: { jaira: { permission: { "*": "deny", "dai_*": "allow" } } } });
  });

  it("is turned off by a layer above, by name, and keeps the rest", () => {
    const merged = mergeConfigLayers([BUILT_IN, { agents: { genericCli: [{ name: "muse-code", command: "muse", enabled: false }] } }]);
    const agents = parseConfig(merged).agents?.genericCli ?? [];
    expect(agents.map((agent) => [agent.name, agent.enabled ?? true])).toEqual([
      ["gemini-cli", true],
      ["antigravity-cli", true],
      ["muse-code", false],
      ["opencode", true],
    ]);
    expect(agents.find((agent) => agent.name === "muse-code")?.args).toEqual(["exec", "--approval-mode", "never"]);
  });
});
