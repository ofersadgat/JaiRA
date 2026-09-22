/**
 * What a claude or codex agent is handed under one effective block, MEASURED (decision 0007).
 *
 * The measurement goes through the real chain (engine → `withAgentToolset` → the upstream executor →
 * the spawn options, with a fake query standing in for the binary), so these tests pin what a
 * toolset does to an agent without restating any rule of the chain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { lowerToolset, parseToolset, type PermissionsDecl } from "@jaira/shared";
import { handedToClaude, handedToCodex, type HandedEnvironment } from "../src/agentHanded";

vi.setConfig({ testTimeout: 60_000 });

const map = (decl: Record<string, unknown>): HandedEnvironment => lowerToolset(parseToolset(decl).toolset);

describe("handedToClaude", () => {
  it("a MAP is the whole grant: what it does not hold is not reachable, and `deny` is not a way in", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", edit: "deny", other: "deny" }));
    expect(handed.served).toEqual(["read_file", "show_artifact"]);
    expect(handed.tools["read_file"]).toEqual({ reachable: true, via: ["app"], decision: "allow" });
    for (const name of ["glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search"]) expect(handed.tools[name]!.reachable).toBe(false);
    expect(handed.natives).toEqual({ Task: "removed", Agent: "removed", SlashCommand: "removed" });
    expect(handed.other).toBe("deny");
  });

  it("a state that declares NO toolset is handed on untouched: claude keeps everything it has, under the gate", async () => {
    const handed = await handedToClaude({});
    expect(handed.served).toEqual(["show_artifact"]);
    for (const native of ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Task"]) expect(handed.removed).not.toContain(native);
    expect(handed.tools["edit"]).toEqual({ reachable: true, via: ["Edit", "MultiEdit", "NotebookEdit"], decision: "ask" });
    expect(handed.tools["bash"]).toEqual({ reachable: true, via: ["Bash"] });
    expect(handed.natives).toEqual({ Task: "ask", Agent: "ask", SlashCommand: "ask" });
  });

  it("ignores `scopes`: a table answers per place, and is its own test's business", async () => {
    const lowered = map({ read_file: "allow", other: "deny" });
    const scoped: PermissionsDecl = { ...lowered.permissions, scopes: [{ path: "docs/**", tools: { read_file: "allow" } }] };
    expect(await handedToClaude({ tools: lowered.tools, permissions: scoped })).toEqual(await handedToClaude(lowered));
  });

  it("refuses a block the engine would refuse", async () => {
    await expect(handedToClaude({ tools: ["reed_file"] })).rejects.toThrow(/never reached the agent/);
  });

  it("judges a held shell's lines BY THE MAP, part by part: a file part answers to the file tool's entry", async () => {
    const held = await handedToClaude(map({ read_file: "allow", write_file: "allow", bash: "ask", other: "ask" }));
    expect(held.shell).toEqual({ command: "ask", read: "allow", write: "allow", script: "ask" });
  });
});

describe("a shell the toolset denies, MEASURED in a run", () => {
  it("hands claude NO shell for `\"bash\": \"deny\"` — not ours, not its own", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", bash: "deny", other: "deny" }));
    expect(handed.served).not.toContain("bash");
    expect(handed.removed).toContain("Bash");
    expect(handed.tools["bash"]).toEqual({ reachable: false, via: [] });
    expect(handed.shell).toEqual({});
  });

  it("hands the SHIPPED `chat/read-only` no shell", async () => {
    const decl = JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/builtin/toolsets/chat/read-only.json", import.meta.url)), "utf8")) as unknown;
    const handed = await handedToClaude(lowerToolset(parseToolset(decl).toolset));
    expect(handed.removed).toContain("Bash");
    expect(handed.tools["bash"]).toEqual({ reachable: false, via: [] });
  });

  it("judges a \"no shell but these commands\" map's lines BY THE MAP, where the project's policy would have run them", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", bash: "deny", "git status": "allow", other: "deny" }));
    expect(handed.tools["bash"]).toEqual({ reachable: true, via: ["app"] });
    expect(handed.removed).toContain("Bash");
    // `git status` is named; `cat` is `read_file`, allowed; `rm` is `write_file`, which the map
    // does not hold; `./build.sh` is `script`, which it does not name either.
    expect(handed.shell).toEqual({ command: "allow", read: "allow", write: "deny", script: "deny" });
  });
});

/**
 * A RUN reads the state's resolved block, as a conversation turn does — upstream hands it over whole
 * (`literalPermissions` keeps a host's keys; `ExecServices.authored`, declarative-ai 3f5e5cc).
 */
describe("what a RUN reads off the state's block, MEASURED", () => {
  it("a written `other: \"ask\"` forces `Task`, `Agent` and `SlashCommand` to the callback — the gate's own default does not", async () => {
    const asking = await handedToClaude(map({ read_file: "allow", other: "ask" }));
    expect(asking.askRules).toEqual(["Agent", "SlashCommand", "Task"]);
    expect(asking.natives).toEqual({ Task: "ask", Agent: "ask", SlashCommand: "ask" });
    // A map that says nothing about `other` is not forced: the gate's `ask` is a last resort, not a choice.
    expect((await handedToClaude(map({ read_file: "allow" }))).askRules).toEqual([]);
  });

  it("`implementation: \"native\"` keeps the built-in in a run: ours is not served, the native is forced to the callback, and the ENTRY decides", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" }));
    expect(handed.served).toEqual(["read_file", "show_artifact"]);
    expect(handed.removed).not.toContain("Grep");
    expect(handed.askRules).toEqual(["Grep"]);
    expect(handed.tools["grep"]).toEqual({ reachable: true, via: ["Grep"], decision: "ask" });
    // Ours still serves what the entry did not hand to the agent.
    expect(handed.tools["read_file"]).toEqual({ reachable: true, via: ["app"], decision: "allow" });
    // A `deny` beside `native` is a removal, not a question.
    const shut = await handedToClaude(map({ read_file: "allow", grep: { mode: "deny", implementation: "native" }, other: "deny" }));
    expect(shut.removed).toContain("Grep");
    expect(shut.tools["grep"]!.reachable).toBe(false);
  });

  it("a child's OWN shell entries win over a parent's that offered a shell", async () => {
    const child = map({ read_file: "allow", bash: "ask", git: "allow", other: "deny" });
    const alone = await handedToClaude(child);
    expect(alone.shell["command"]).toBe("allow");
    // The child's map runs `git status`; the parent's `bash: "deny"` would have refused it.
    const parent = map({ bash: "deny", "npm test": "allow" });
    expect((await handedToClaude(child, { parent })).shell).toEqual(alone.shell);
    // And codex's writing sandbox follows the CHILD's shell.
    for (const via of ["route", "function"] as const) {
      expect((await handedToCodex(map({ bash: "ask" }), { parent, via })).permissionMode).toBeUndefined();
    }
  });
});

describe("handedToCodex — codex is held by its sandbox, by a model prefix and as a FUNCTION alike", () => {
  it.each(["route", "function"] as const)("%s: a toolset with no open writer runs read-only; one with one, or a state that declares none, keeps the configured sandbox", async (via) => {
    expect((await handedToCodex(map({ other: "deny" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "deny", other: "deny" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "deny", "git status": "allow" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "ask" }), { via })).permissionMode).toBeUndefined();
    expect((await handedToCodex({}, { via })).permissionMode).toBeUndefined();
  });
});
