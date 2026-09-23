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
    // And codex follows the CHILD's shell: its lines judged by the child's map at the bridge, and its
    // writing sandbox opened by the child keeping codex's own shell.
    const keeps = map({ read_file: "allow", bash: { mode: "ask", implementation: "native" }, other: "deny" });
    for (const via of ["route", "function"] as const) {
      expect((await handedToCodex(child, { parent, via })).shell).toEqual((await handedToCodex(child, { via })).shell);
      expect((await handedToCodex(keeps, { parent, via })).sandbox).toBe("workspace-write");
    }
  });
});

/**
 * Codex is served the tools its toolset holds over its MCP bridge, and — having no permission callback
 * — every call is put to the gate AT the bridge, before the tool runs. Measured through upstream's
 * real codex transport (its refusals, argv and bridge), with a double for the binary and the listener.
 */
describe("handedToCodex — a held tool reaches codex through the MCP bridge, and is gated there", () => {
  it.each(["route", "function"] as const)("%s: serves what the map holds, points codex at the bridge, and the ENTRY decides each call", async (via) => {
    const handed = await handedToCodex(map({ read_file: "allow", write_file: "ask", edit: "deny", bash: "ask", git: "allow", other: "deny" }), { via });
    // Held and not refused ⇒ served; `edit: "deny"` is not a way in, so it is not served at all.
    // (`show_artifact` is granted to prompt states only, so a function call is not served it.)
    expect(handed.served).toEqual(via === "route" ? ["bash", "read_file", "show_artifact", "write_file"] : ["bash", "read_file", "write_file"]);
    // Codex approves our tools on its side and waits for the bridge's handshake — the gate is ours.
    expect(handed.bridge).toContain('mcp_servers.dai={url="<url>",required=true');
    expect(handed.bridge).toContain('"write_file"={approval_mode="approve"}');
    // What decides a call is the toolset's entry, through the gate at the bridge — `ask` reaches a person.
    expect(handed.tools).toMatchObject({ read_file: "allow", write_file: "ask" });
    // A shell line is taken apart and each part judged by the map, as claude's is: the program is named,
    // `cat` is `read_file`, `rm` is `write_file` (ask), and `./build.sh` is `script`, which falls to `other`.
    expect(handed.shell).toEqual({ command: "allow", read: "allow", write: "ask", script: "deny" });
    // Ours do the writing, under the gate: codex's own writers stay shut in the read-only sandbox.
    expect(handed.sandbox).toBe("read-only");
  });

  it("decides a served tool exactly as claude's callback decides it", async () => {
    const decl = { read_file: "allow", grep: "ask", write_file: "deny", bash: "ask", git: "allow", other: "deny" };
    const claude = await handedToClaude(map(decl));
    const codex = await handedToCodex(map(decl));
    for (const name of codex.served.filter((served) => served !== "bash")) expect(codex.tools[name], name).toBe(claude.tools[name]!.decision);
    expect(codex.shell).toEqual(claude.shell);
  });
});

describe("handedToCodex — codex's sandbox opens only for a writer of its own the toolset keeps", () => {
  it.each(["route", "function"] as const)("%s: read-only unless an entry keeps codex's own shell or apply_patch; a state that declares none keeps the configured sandbox", async (via) => {
    expect((await handedToCodex(map({ other: "deny" }), { via })).sandbox).toBe("read-only");
    expect((await handedToCodex(map({ bash: "deny", other: "deny" }), { via })).sandbox).toBe("read-only");
    expect((await handedToCodex(map({ bash: "deny", "git status": "allow" }), { via })).sandbox).toBe("read-only");
    // Ours holds the shell: codex writes through it, under the gate, and its own stays shut.
    expect((await handedToCodex(map({ bash: "ask" }), { via })).sandbox).toBe("read-only");
    // The entry keeps codex's own: the sandbox is how it is kept, and ours is not served beside it.
    const native = await handedToCodex(map({ bash: { mode: "ask", implementation: "native" } }), { via });
    expect(native.sandbox).toBe("workspace-write");
    expect(native.served).not.toContain("bash");
    expect((await handedToCodex(map({ edit: { mode: "allow", implementation: "native" } }), { via })).sandbox).toBe("workspace-write");
    // A `deny` beside `native` keeps nothing.
    expect((await handedToCodex(map({ bash: { mode: "deny", implementation: "native" } }), { via })).sandbox).toBe("read-only");
    expect((await handedToCodex({}, { via })).sandbox).toBe("workspace-write");
  });
});

/**
 * A claude agent reached as a FUNCTION is wrapped by the route's own wrapper (upstream `wrapExecutor`),
 * so what an entry chose reaches it exactly as it reaches the route — `implementation: "native"`
 * included, which a function call used to have nowhere to write.
 */
describe("handedToClaude — a function call is handed exactly what the route is", () => {
  // `show_artifact` is granted to every PROMPT state (`grantAlwaysGrantedTools`) and to no function state, so
  // the route serves it and the function does not; that is the engine's grant, not the wrapper's, and
  // it is left out of the comparison (tool-policy's failure rows name it). So is claude's question tool:
  // the route probe declares an output, and upstream withholds `AskUserQuestion` from a structured-output
  // call, where the function's answer is text.
  const sansArtifact = (handed: Awaited<ReturnType<typeof handedToClaude>>) => ({
    ...handed,
    served: handed.served.filter((name) => name !== "show_artifact"),
    preApproved: handed.preApproved.filter((name) => name !== "show_artifact"),
    removed: handed.removed.filter((name) => name !== "AskUserQuestion"),
    tools: Object.fromEntries(Object.entries(handed.tools).filter(([name]) => name !== "show_artifact")),
  });
  const cases: Record<string, Record<string, unknown>> = {
    native: { read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" },
    "native beside deny": { read_file: "allow", grep: { mode: "deny", implementation: "native" }, other: "deny" },
    "written other": { read_file: "allow", other: "ask" },
    "a shell by the map": { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" },
    "holds nothing": { other: "ask" },
  };
  it.each(Object.keys(cases))("%s", async (name) => {
    const environment = map(cases[name]!);
    expect(sansArtifact(await handedToClaude(environment, { via: "function" }))).toEqual(sansArtifact(await handedToClaude(environment)));
  });

  it("keeps a `native` built-in as a FUNCTION: ours not served, the native under an ask rule, the entry deciding", async () => {
    const handed = await handedToClaude(map(cases["native"]!), { via: "function" });
    expect(handed.served).toEqual(["read_file"]);
    expect(handed.askRules).toEqual(["Grep"]);
    expect(handed.tools["grep"]).toEqual({ reachable: true, via: ["Grep"], decision: "ask" });
  });

  it("hands a state that declares no toolset on untouched, as the route does", async () => {
    expect(sansArtifact(await handedToClaude({}, { via: "function" }))).toEqual(sansArtifact(await handedToClaude({})));
  });
});

/**
 * A child that writes a toolset has written the whole statement of what it holds and whose code serves
 * it (decision 0007 §1). Lowering writes `implementations` on every map, empty where it chose none, so
 * the engine's per-key merge of `permissions` replaces a parent's choice instead of carrying it down.
 */
describe("a child's map does not inherit its parent's implementation choices", () => {
  const parent = map({ read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" });
  const child = map({ read_file: "allow", grep: "ask", other: "deny" });

  it.each(["route", "function"] as const)("%s: the child's `grep` is OURS — the parent's `native` does not keep claude's Grep", async (via) => {
    const under = await handedToClaude(child, { parent, via });
    expect(under.served).toContain("grep");
    expect(under.removed).toContain("Grep");
    expect(under.askRules).toEqual([]);
    expect(under).toEqual(await handedToClaude(child, { via }));
  });

  it("codex likewise: the child's shell is ours, served, and codex's own stays shut", async () => {
    const keepsShell = map({ bash: { mode: "ask", implementation: "native" }, other: "deny" });
    const oursShell = map({ bash: "ask", other: "deny" });
    const under = await handedToCodex(oursShell, { parent: keepsShell });
    expect(under.served).toContain("bash");
    expect(under.sandbox).toBe("read-only");
  });
});
