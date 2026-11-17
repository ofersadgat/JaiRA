import { describe, expect, it } from "vitest";
import { canonicalJson, isLoopbackUrl, isMachinePiece, layPiece, settingsPieces, valueAt } from "../src/settingsSync";

const keys = (doc: unknown): string[] => settingsPieces(doc as never).map((p) => p.path.join("."));

describe("a settings layer cut into pieces", () => {
  it("cuts blocks into their keys, and the entry maps into their entries", () => {
    const doc = {
      appearance: { mode: "dark", conversation: { workRows: 5 } },
      models: { routes: { anthropic: { credential: "ANTHROPIC_API_KEY" } }, presets: { coder: { model: "claude-opus-5-5" } } },
      integrations: { forges: { github: { provider: "github", host: "github.com", credential: "GITHUB_TOKEN" } } },
      autopilot: { askBelow: 0.3 },
      events: { "git.push": { enabled: false } },
    };
    expect(keys(doc).sort()).toEqual(
      [
        "appearance.mode",
        "appearance.conversation",
        "models.routes.anthropic",
        "models.presets.coder",
        "integrations.forges.github",
        "autopilot.askBelow",
        "events.git.push",
      ].sort(),
    );
    // An event's name has a dot of its own: the path keeps it whole.
    expect(settingsPieces(doc as never).find((p) => p.path[0] === "events")?.path).toEqual(["events", "git.push"]);
  });

  it("leaves out what is the machine's own", () => {
    const doc = {
      execEnvironment: { wsl: "Ubuntu" },
      engine: { separateServer: true },
      updates: { channel: "nightly" },
      models: { routes: { local: { baseURL: "http://127.0.0.1:11434/v1" }, embedded: { weights: {} }, openrouter: { enabled: true } } },
      mcp: {
        servers: {
          files: { command: "npx", args: ["server-files"] },
          mine: { url: "http://localhost:3000/mcp" },
          linear: { url: "https://mcp.linear.app/sse" },
          off: { enabled: false },
        },
      },
      workflows: { path: ["$SHARED/workflows", "/Users/me/flows"] },
    };
    expect(keys(doc).sort()).toEqual(["mcp.servers.linear", "mcp.servers.off", "models.routes.openrouter"]);
    expect(keys({ workflows: { path: ["$SHARED/workflows"] } })).toEqual(["workflows.path"]);
  });

  it("sends an agent without the binary path this machine gave it, but a CLI the person added with its own", () => {
    const pieces = settingsPieces({
      agents: {
        claudeCli: { command: "/opt/homebrew/bin/claude", enabled: true },
        codex: { command: "codex", sandbox: "workspace-write" },
        genericCli: [
          { name: "gemini-cli", command: "/usr/local/bin/gemini", enabled: false },
          { name: "aider", command: "/Users/me/.local/bin/aider" },
        ],
      },
    } as never);
    expect(valueAt({ x: pieces.find((p) => p.path[1] === "claudeCli")!.value }, ["x"])).toEqual({ enabled: true });
    expect(pieces.find((p) => p.path[1] === "codex")!.value).toEqual({ command: "codex", sandbox: "workspace-write" });
    expect(pieces.find((p) => p.path[1] === "genericCli")!.value).toEqual([
      { name: "gemini-cli", enabled: false },
      { name: "aider", command: "/Users/me/.local/bin/aider" },
    ]);
  });

  it("knows a loopback address", () => {
    expect(["http://localhost:1/x", "http://127.0.0.1/", "http://[::1]:3/", "http://app.localhost/", "http://0.0.0.0/"].every(isLoopbackUrl)).toBe(true);
    expect(["https://mcp.linear.app/sse", "not a url", undefined].some(isLoopbackUrl)).toBe(false);
  });
});

describe("another machine's piece laid into this one's layer", () => {
  it("sets it, making the objects on its way", () => {
    expect(layPiece(null, ["integrations", "forges", "gitlab"], { provider: "gitlab", host: "gitlab.com" }).doc).toEqual({
      integrations: { forges: { gitlab: { provider: "gitlab", host: "gitlab.com" } } },
    });
  });

  it("removes it, and the objects it leaves empty, but nothing beside it", () => {
    const doc = { mcp: { servers: { linear: { url: "https://x.example/mcp" } } }, appearance: { mode: "dark" } };
    expect(layPiece(doc, ["mcp", "servers", "linear"], undefined).doc).toEqual({ appearance: { mode: "dark" } });
    // The document given is not changed.
    expect(doc.mcp.servers.linear).toBeDefined();
  });

  it("never replaces what is this machine's own", () => {
    const doc = { mcp: { servers: { files: { command: "npx" } } } };
    const laid = layPiece(doc, ["mcp", "servers", "files"], { url: "https://files.example/mcp" });
    expect(laid).toEqual({ doc, kept: true });
    expect(layPiece({}, ["engine", "separateServer"], true).kept).toBe(true);
  });

  it("puts this machine's binary path back into an agent that came without one", () => {
    const here = { agents: { claudeCli: { command: "/opt/homebrew/bin/claude" }, genericCli: [{ name: "gemini-cli", command: "/usr/local/bin/gemini" }] } };
    expect(layPiece(here, ["agents", "claudeCli"], { enabled: false }).doc.agents).toMatchObject({ claudeCli: { enabled: false, command: "/opt/homebrew/bin/claude" } });
    expect(valueAt(layPiece(here, ["agents", "genericCli"], [{ name: "gemini-cli", enabled: false }]).doc, ["agents", "genericCli"])).toEqual([
      { name: "gemini-cli", enabled: false, command: "/usr/local/bin/gemini" },
    ]);
  });

  it("reads one value one way, whatever order its keys were written in", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(isMachinePiece(["appearance", "mode"], "dark")).toBe(false);
  });
});
