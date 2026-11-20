/**
 * Every Connections section closed to a line, as the person picked them on 2026-11-17 ("MCP A, Forges
 * B"): a row's line, the one button that would make it work or the chip of who it connects as; the MCP
 * servers other tools run as a tile each; and a forge with no token at all on the "Not connected" shelf
 * (`connectionsModel.ts`).
 */
import { describe, expect, it } from "vitest";
import { parseConfig, type ConfigView, type ForgeCheck, type LocalServerProbe, type McpDetectedSource, type McpServerConfig, type McpServerStatus, type ProbeResult } from "@jaira/shared";
import { forgeActionOf, forgeChipOf, forgeLineOf, forgePlaceOf, forgeRowOf, forgeSshOf, forgesOf, foundServersOf, lookedInOf, mcpActionOf, mcpChipOf, routeActionOf, routeChipOf, routeLineOf, schemaGistOf, NEW_SERVER_SCHEMA } from "../src/renderer/connectionsModel";
import { MODEL_PROVIDERS } from "../src/renderer/providerSpecs";

const spec = (id: string) => MODEL_PROVIDERS.find((one) => one.id === id)!;
const probe = (name: string, over: Partial<ProbeResult>): ProbeResult => ({ name, status: "ok", detail: "", ...over });

describe("a model route, closed", () => {
  it("says a ready API serves its prefix, with its key as the chip — its check never asks the provider", () => {
    const ready = probe("anthropic", { detail: "ANTHROPIC_API_KEY is set (keychain)", credential: { source: "keychain" } });
    expect(routeLineOf(spec("anthropic"), ready, "available")).toEqual({ word: "ready", rest: "serves anthropic/…" });
    expect(routeChipOf(spec("anthropic"), ready, "available", {})).toMatchObject({ kind: "key", name: "ANTHROPIC_API_KEY", missing: false });
    expect(routeActionOf(spec("anthropic"), ready, "available", {}, undefined)).toBeUndefined();
  });

  it("offers the key a route cannot run without, by the name it would be filed under", () => {
    const keyless = probe("openrouter", { status: "failed", detail: "no key — OPENROUTER_API_KEY is not set and this route names no credential" });
    expect(routeLineOf(spec("openrouter"), keyless, "unavailable")).toEqual({ word: "not working", rest: "no key — OPENROUTER_API_KEY is not set and this route names no credential" });
    expect(routeActionOf(spec("openrouter"), keyless, "unavailable", {}, undefined)).toEqual({ kind: "key", label: "Add a key", title: "store OPENROUTER_API_KEY" });
    expect(routeChipOf(spec("openrouter"), keyless, "unavailable", {})).toBeUndefined();
  });

  it("points the local route at a server that answers, when it points nowhere that does", () => {
    const down = probe("local", { status: "failed", detail: "nothing answered http://localhost:1234/v1: connection refused" });
    const found: LocalServerProbe[] = [
      { name: "LM Studio", baseURL: "http://localhost:1234/v1", up: false, models: [], inUse: true },
      { name: "Ollama", baseURL: "http://localhost:11434/v1", up: true, models: ["qwen2.5-coder"], inUse: false },
    ];
    expect(routeActionOf(spec("local"), down, "unavailable", {}, found)).toEqual({ kind: "use", label: "Use Ollama", title: "send local models to http://localhost:11434/v1", baseURL: "http://localhost:11434/v1" });
    expect(routeActionOf(spec("local"), down, "unavailable", {}, [])).toBeUndefined();
    // Ready, a local route says what answered — and has no key to show.
    const up = probe("local", { detail: "http://localhost:11434/v1 answered" });
    expect(routeLineOf(spec("local"), up, "available").rest).toBe("http://localhost:11434/v1 answered");
    expect(routeChipOf(spec("local"), up, "available", {})).toBeUndefined();
  });

  it("offers weights to the embedded route that has none", () => {
    const none = probe("embedded", { status: "failed", detail: "no weights are configured, so nothing is served on this route" });
    expect(routeActionOf(spec("embedded"), none, "unconfigured", {}, undefined)).toEqual({ kind: "open", label: "Add weights", title: "name a model id and the .gguf it loads" });
  });
});

const STDIO: McpServerConfig = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: { secret: "GITHUB_TOKEN" } } } as unknown as McpServerConfig;
const status = (over: Partial<McpServerStatus>): McpServerStatus => ({ name: "github", state: "ready", transport: "stdio", where: "npx -y @modelcontextprotocol/server-github", tools: [], credentials: [], checkedAt: 0, ...over });

describe("an MCP server, closed", () => {
  it("offers the claims its tools make before anything else, then the secret it is not sent", () => {
    const claiming = status({ tools: [{ name: "read_text_file", annotations: {}, claim: { as: "read_file" } }, { name: "write_file", annotations: {}, claim: { as: "write_file" } }] } as Partial<McpServerStatus>);
    expect(mcpActionOf(true, STDIO, claiming)).toEqual({ kind: "accept", label: "Accept 2…", title: "2 tools say what they count as — open to accept" });
    const unsent = status({ credentials: [{ field: "env", key: "GITHUB_TOKEN", credential: "GITHUB_TOKEN" }] });
    expect(mcpActionOf(true, STDIO, unsent)).toEqual({ kind: "secret", label: "Store a secret", title: "store GITHUB_TOKEN" });
    expect(mcpActionOf(false, STDIO, unsent)).toBeUndefined();
  });

  it("shows the secret it is sent as the chip, and where it was found", () => {
    const sent = status({ credentials: [{ field: "env", key: "GITHUB_TOKEN", credential: "GITHUB_TOKEN", origin: { source: "keychain" } }] });
    expect(mcpChipOf(true, sent)).toMatchObject({ kind: "key", name: "GITHUB_TOKEN", missing: false });
    expect(mcpActionOf(true, STDIO, sent)).toBeUndefined();
  });

  it("says what a server's settings fold holds", () => {
    expect(schemaGistOf(NEW_SERVER_SCHEMA)).toMatch(/^name, command, arguments/);
  });
});

describe("the servers other tools run, a tile each", () => {
  const detected: McpDetectedSource[] = [
    { source: "claude-code", label: "Claude Code", where: "~/.claude.json", state: "none listed", servers: [] },
    { source: "claude-desktop", label: "Claude Desktop", where: "~/Library/…/claude_desktop_config.json", state: "found", servers: [{ name: "memory", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } as McpServerConfig }, { name: "github", config: STDIO }] },
    { source: "cursor", label: "Cursor", where: "~/.cursor/mcp.json", state: "found", servers: [{ name: "memory", config: { command: "uvx", args: ["mcp-memory"] } as McpServerConfig }, { name: "figma", config: { url: "http://127.0.0.1:3845/mcp" } as McpServerConfig }] },
  ] as McpDetectedSource[];

  it("lists each server not added yet once, the first place's, with how it is reached and where", () => {
    const tiles = foundServersOf(detected, { github: STDIO });
    expect(tiles.map((one) => [one.name, one.sub])).toEqual([
      ["memory", "stdio · in Claude Desktop"],
      ["figma", "HTTP · in Cursor"],
    ]);
  });

  it("says where it looked", () => {
    expect(lookedInOf(detected)).toBe("Looked in Claude Code · Claude Desktop · Cursor when this page opened. None is started until it is added.");
    expect(lookedInOf([{ source: "project", label: "This project's .mcp.json", where: ".mcp.json", state: "not found", servers: [] }] as McpDetectedSource[])).toBe("Looked in this project's .mcp.json when this page opened. None is started until it is added.");
    expect(lookedInOf(undefined)).toBeUndefined();
  });
});

describe("a forge, closed", () => {
  const empty: ConfigView = { base: {} as never, project: null, machine: null, projectMachine: null, system: null, you: null, projectYou: null, effective: parseConfig({}) as never, baseFile: "~/.jaira/settings.json", projectFile: "", youFile: "~/.jaira/personal-settings.json", baseDir: "~/.jaira" };
  const forges = forgesOf(empty);
  const checks: Record<string, ForgeCheck> = {
    github: { name: "github", provider: "github", host: "github.com", status: "ok", detail: "signed in as @sam", identity: { login: "samstudio", scopes: ["repo", "workflow"] }, credential: { source: "keychain" }, via: "oauth" },
    gitlab: { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "unconfigured", detail: "no token stored under GITLAB_TOKEN" },
  };
  const oauth = { signingIn: new Set<string>(), pending: new Map<string, string>(), errors: new Map<string, string>(), viaOAuth: new Set(["github"]), onSignIn: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined };

  it("puts a connection with no token at all on the shelf, and keeps one refused or turned off a row", () => {
    expect(forgePlaceOf(true, checks["gitlab"])).toBe("shelf");
    expect(forgePlaceOf(true, checks["github"])).toBe("row");
    expect(forgePlaceOf(true, { ...checks["gitlab"]!, status: "failed", detail: "gitlab.com refused the token (401)" })).toBe("row");
    expect(forgePlaceOf(false, checks["gitlab"])).toBe("row");
    expect(forgePlaceOf(true, undefined)).toBe("row");
  });

  it("says a connected forge's scopes, with its account as the chip", () => {
    const row = forgeRowOf("github", forges["github"]!, checks["github"], oauth);
    expect(forgeLineOf(row.state, checks["github"])).toEqual({ word: "ready", rest: "repo, workflow" });
    expect(forgeChipOf(row)).toEqual({ kind: "login", who: "samstudio", fact: "OAuth", more: 0 });
    expect(forgeActionOf(row, checks["github"], "github.com", true)).toBeUndefined();
  });

  it("offers to sign in again where a token was refused, and a token where there is no sign-in", () => {
    const refused: ForgeCheck = { ...checks["gitlab"]!, status: "failed", detail: "gitlab.com refused the token (401)", credential: { source: "keychain" } };
    const row = forgeRowOf("gitlab", forges["gitlab"]!, refused, oauth);
    expect(forgeActionOf(row, refused, "gitlab.com", true)).toEqual({ kind: "sign-in", label: "Sign in again", title: "opens gitlab.com with a code to enter" });
    expect(forgeActionOf(row, refused, "gitlab.com", false)).toEqual({ kind: "token", label: "Replace the token", title: "filed under GITLAB_TOKEN" });
  });
});

describe("a forge's ssh keys, opened", () => {
  const gitlab = { provider: "gitlab" as const, host: "gitlab.com" };
  const ok: ForgeCheck = { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "ok", detail: "", identity: { login: "lab" } };

  it("tags each key by whether it lets this machine in, and says how that was found out", () => {
    const view = forgeSshOf(gitlab, {
      ...ok,
      ssh: {
        by: "account",
        keys: [
          { path: "~/.ssh/id_ed25519", fingerprint: "SHA256:a", valid: "yes", detail: "on @lab's account" },
          { path: "~/.ssh/old", fingerprint: "SHA256:b", valid: "no", detail: "not on @lab's account" },
          { path: "~/.ssh/locked", fingerprint: "SHA256:c", valid: "unknown", detail: "needs its passphrase" },
        ],
      },
    });
    expect(view.keys.map((key) => [key.name, key.tag, key.tone])).toEqual([
      ["~/.ssh/id_ed25519", "lets you in", "ok"],
      ["~/.ssh/old", "not on the account", "accent"],
      ["~/.ssh/locked", "can't tell", "warn"],
    ]);
    expect(view.notes).toEqual(["Checked against the keys on @lab's gitlab.com account."]);
    expect(view.makeOn).toBe(true);
  });

  it("says what was made, what turned off means, and that nothing is checked before signing in", () => {
    const made = forgeSshOf(gitlab, { ...ok, ssh: { by: "ssh", keys: [{ path: "~/.ssh/jaira_gitlab.com_ed25519", fingerprint: "SHA256:j", valid: "yes", detail: "ssh signs in as @lab", jaira: true }], made: { ok: true, detail: "Added it." } } });
    expect(made.keys[0]).toMatchObject({ jaira: true, tag: "lets you in" });
    expect(made.notes).toEqual(["Checked by signing in to gitlab.com over ssh with each key.", "Added it."]);
    const off = forgeSshOf({ ...gitlab, makeSshKey: false }, { ...ok, ssh: { by: "account", keys: [] } });
    expect(off).toMatchObject({ makeOn: false, empty: "No ssh keys on this machine." });
    expect(off.notes).toContain("No key here lets this machine in to gitlab.com over ssh, so a project from gitlab.com is cloned over https here.");
    expect(forgeSshOf(gitlab, undefined).empty).toBe("Checked once this connection is signed in.");
  });
});
