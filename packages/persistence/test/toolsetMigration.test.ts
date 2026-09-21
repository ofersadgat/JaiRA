/**
 * Migrating authored workflows from the list-and-block form to toolsets (decision 0007 step 7).
 *
 * The rewrite is not mechanical, so the tests are not either. What is worth proving:
 *
 *  - each of the three forms a block can take, chosen by MEASUREMENT and not by what the file says;
 *  - that a state which keeps claude's own `Glob` and `Grep` today still has them afterwards, which
 *    is the whole difficulty (`agentHanded.test.ts` proves the comparison catches the naive map;
 *    here the migration is proven not to write one);
 *  - that the two things no map can say about the SHELL are refused rather than assumed;
 *  - inheritance: a child that inherited its tools resolves to the same thing after the rewrite;
 *  - idempotence, YAML, JSONC, an encoding that is not UTF-8, and the shared root's refusal.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { baseAsProjectPaths, jairaPaths, lowerToolset, parseToolset, setBuiltInDir, type JairaPaths } from "@jaira/shared";
import { handedToClaude } from "@jaira/runtime";
import { initProject } from "../src/project";
import { applyToolsetMigration, isUnderSharedRoot, planToolsetMigration, renderToolsetMigration, unprovenOf } from "../src/toolsetMigration";

vi.setConfig({ testTimeout: 120_000 });

let scratch: string;
let paths: JairaPaths;
let home: string;

/** The shipped toolsets, as the built-in layer, so `$/toolsets/chat/…` resolves as it really does. */
const SHIPPED: Record<string, Record<string, string>> = {
  "chat/read-only": {
    read_file: "allow",
    glob: "allow",
    grep: "allow",
    edit: "deny",
    write_file: "deny",
    show_artifact: "allow",
    bash: "deny",
    web_fetch: "allow",
    web_search: "allow",
    other: "deny",
  },
  "chat/ask-first": {
    read_file: "ask",
    glob: "ask",
    grep: "ask",
    edit: "ask",
    write_file: "ask",
    show_artifact: "ask",
    bash: "ask",
    web_fetch: "ask",
    web_search: "ask",
    other: "ask",
  },
};

/** Every tool a conversation can be handed — what a list has to name to be `chat/ask-first`. */
const ALL_TOOLS = ["read_file", "glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search"];

function write(root: string, relPath: string, body: unknown, encoding: BufferEncoding = "utf8"): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n", encoding);
  return file;
}

/** A prompt state, written the old way. */
function legacyState(environment: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    label: "Draft",
    outputs: { draft: { kind: "text", schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "go", model: "claude-cli/default" },
    environment,
    ...extra,
  };
}

const plan = () => planToolsetMigration({ paths });
const stateFile = (relPath: string): string => readFileSync(join(paths.workflowsDir, relPath), "utf8");
const environmentOf = (relPath: string): { tools?: unknown; permissions?: unknown } =>
  (JSON.parse(stateFile(relPath)) as Record<string, { tools?: unknown; permissions?: unknown }>)["environment"]!;
/** A written map, measured the way a run would see it — the map LOWERED, as the engine takes it. */
const handedUnder = (tools: unknown) => handedToClaude(lowerToolset(parseToolset(tools).toolset));

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-migrate-"));
  const builtIn = join(scratch, "builtin");
  for (const [id, decl] of Object.entries(SHIPPED)) write(builtIn, `toolsets/${id}.json`, decl);
  setBuiltInDir(builtIn);
  home = join(scratch, "home");
  const projectDir = join(scratch, "project");
  mkdirSync(projectDir, { recursive: true });
  initProject(projectDir, home);
  paths = jairaPaths(projectDir, home, builtIn);
});

afterEach(() => {
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

describe("the three forms a block takes", () => {
  it("names a SHIPPED toolset by reference where the state's effective behaviour is exactly that toolset's", async () => {
    // `chat/ask-first` is every tool at `ask` with `other: "ask"` — which is what this list does.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ALL_TOOLS, permissions: { default: "ask", other: "ask" } }));
    // Its `bash: "ask"` asks before every line, which a map cannot say — hence the consent.
    const made = await planToolsetMigration({ paths, accept: ["shell-judged"] });
    expect(unprovenOf(made)).toEqual([]);
    expect(made.blocks.map((block) => [block.at, block.outcome, block.tools])).toEqual([["environment", "reference", "$/toolsets/chat/ask-first"]]);
    applyToolsetMigration(made, { paths });
    expect(environmentOf("draft.json").tools).toBe("$/toolsets/chat/ask-first");
    expect(environmentOf("draft.json").permissions).toBeUndefined();
  });

  it("starts from one and says the few lines that differ", async () => {
    // A toolset of this project's own, with no shell in it — see the test below for why the shipped
    // `chat/read-only`, which holds `bash: "deny"`, is no base for a state that has no shell.
    write(paths.jairaDir, "toolsets/docs/reader.json", { read_file: "allow", glob: "allow", grep: "allow", show_artifact: "allow", other: "deny" });
    // The same grant but for one line: this state may not glob.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file", "grep", "show_artifact"], permissions: { default: "allow", other: "deny" } }));
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    const [block] = made.blocks;
    expect(block!.outcome).toBe("reference+lines");
    // Everything the base says is kept; only the line this state differs on is written.
    expect(block!.tools).toEqual({ $ref: "$/toolsets/docs/reader", glob: "deny" });
    applyToolsetMigration(made, { paths });
    expect(environmentOf("draft.json").tools).toEqual({ $ref: "$/toolsets/docs/reader", glob: "deny" });
  });

  it('never starts from a toolset that HOLDS a shell the state has not got — `bash: "deny"` still offers one', async () => {
    // `chat/read-only` is exactly this state's grant but for the shell it holds at `deny`, which is
    // still a door: a held entry is offered, and a map's shell lowers as `smart` whatever it says.
    write(
      paths.workflowsDir,
      "draft.json",
      legacyState({ tools: ["read_file", "glob", "grep", "show_artifact", "web_fetch", "web_search"], permissions: { default: "allow", other: "deny" } }),
    );
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    expect(made.blocks[0]!.outcome).toBe("inline");
    expect(made.blocks[0]!.tools).not.toHaveProperty("$ref");
    expect(made.blocks[0]!.tools).not.toHaveProperty("bash");
  });

  it("writes an inline map when nothing on the search path measures the same", async () => {
    // A read-only profile over a one-tool list: claude keeps Glob, Grep and the web tools, ASKED
    // about — which is no shipped toolset, and which `chat/read-only` (they are `allow` there) is not.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } }));
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    const [block] = made.blocks;
    expect(block!.outcome).toBe("inline");
    expect(block!.tools).toEqual({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" });
  });
});

describe("what the state DOES, not what it says", () => {
  /** The 19-state shape in the person's shared root: a read-only profile over a one-tool list. */
  const READ_ONLY = { tools: ["read_file"], permissions: { profile: "read-only" as const, tools: { read_file: "allow" as const } } };

  it("keeps the `Glob`, `Grep`, `WebFetch` and `WebSearch` a read-only list leaves claude — and removes the profile", async () => {
    write(paths.workflowsDir, "draft.json", legacyState(READ_ONLY));
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    const map = made.blocks[0]!.tools as Record<string, string>;
    // A NAIVE rewrite would write `{ read_file: "allow", other: "deny" }` and lose four tools.
    expect(map).toEqual({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" });
    for (const writer of ["edit", "write_file", "bash"]) expect(map[writer]).toBeUndefined();

    applyToolsetMigration(made, { paths });
    expect(stateFile("draft.json")).not.toContain("profile");
    // …and the file, read back and measured as a run would see it, hands the agent what it did.
    const was = await handedToClaude(READ_ONLY);
    const now = await handedUnder(environmentOf("draft.json").tools);
    // Reach and decision, not which implementation serves it: claude's own `Glob` under the gate and
    // JaiRA's `glob` at the same mode are the same grant.
    const grant = (handed: Awaited<ReturnType<typeof handedToClaude>>, name: string) => ({ reachable: handed.tools[name]!.reachable, decision: handed.tools[name]!.decision });
    for (const name of ["read_file", "glob", "grep", "web_fetch", "web_search"]) expect(grant(now, name)).toEqual(grant(was, name));
    for (const name of ["edit", "write_file", "bash"]) expect(now.tools[name]!.reachable).toBe(false);
  });

  it("keeps a list that already fences itself with `other: deny` exactly as small as it was", async () => {
    // `other: "deny"` answers for every tool the list did not grant, so claude keeps none of them:
    // the list is already a fence, and the honest map is the small one.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { tools: { read_file: "allow" }, other: "deny" } }));
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    expect(made.blocks[0]!.tools).toEqual({ read_file: "allow", other: "deny" });
  });

  it("keeps `scopes` exactly where they were, and never counts them as part of a toolset", async () => {
    const scopes = [{ path: "docs/**", tools: { read_file: "allow", write_file: "allow" } }];
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" }, scopes } }));
    const made = await plan();
    applyToolsetMigration(made, { paths });
    expect(environmentOf("draft.json").permissions).toEqual({ scopes });
  });
});

describe("the shell, which no map can say twice over", () => {
  it("REFUSES a state whose unlisted shell no map can hold, and names the consent that goes on", async () => {
    // No `other`, so claude keeps its own Bash: a tool the list never granted, which no map can hold.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { tools: { read_file: "allow" } } }));
    const made = await plan();
    expect(made.blocks[0]!.outcome).toBe("refused");
    expect(made.blocks[0]!.reason).toMatch(/the list never granted/);
    expect(made.blocks[0]!.reason).toMatch(/--accept unlisted-shell/);
    expect(made.files).toEqual([]);

    const accepted = await planToolsetMigration({ paths, accept: ["unlisted-shell"] });
    expect(unprovenOf(accepted)).toEqual([]);
    expect((accepted.blocks[0]!.tools as Record<string, string>)["bash"]).toBeUndefined();
    expect(accepted.blocks[0]!.tolerated.map((difference) => difference.tolerated)).toContain("unlisted-shell");
    expect(renderToolsetMigration(accepted)).toContain("ACCEPTED BY FLAG");
  });

  it("REFUSES a state that asked before every shell line, because a run never sees a map's shell entry", async () => {
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ALL_TOOLS, permissions: { default: "ask", other: "ask" } }));
    const made = await plan();
    expect(made.blocks[0]!.outcome).toBe("refused");
    expect(made.blocks[0]!.reason).toMatch(/--accept shell-judged/);
    expect(made.blocks[0]!.reason).toMatch(/permissions.subjects/);

    const accepted = await planToolsetMigration({ paths, accept: ["shell-judged"] });
    expect(unprovenOf(accepted)).toEqual([]);
    expect(accepted.blocks[0]!.tolerated.map((difference) => difference.subject)).toEqual(expect.arrayContaining(["shell:command"]));
  });

  it("needs NO consent where the shell was already judged by the project's policy", async () => {
    // A list that names `bash` and gives it no mode of its own resolves to the baseline's `smart`,
    // which is the policy deciding the line — exactly what a map's shell entry means.
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file", "bash"], permissions: { tools: { read_file: "allow" }, other: "deny" } }));
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    expect(made.blocks[0]!.outcome).not.toBe("refused");
    expect(made.blocks[0]!.tolerated).toEqual([]);
    expect(made.blocks[0]!.tools).toEqual({ read_file: "allow", bash: "smart", other: "deny" });
  });
});

describe("inheritance", () => {
  it("gives a child the map of what it INHERITED, and both resolve to what they did", async () => {
    write(paths.workflowsDir, "feature.json", {
      label: "Feature",
      environment: { tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } },
      children: { draft: { state: "./draft" } },
      sequence: ["draft"],
    });
    // The child says nothing about tools: everything it has comes down the chain.
    write(paths.workflowsDir, "feature/draft.json", {
      label: "Draft",
      outputs: { draft: { kind: "text", schema: { type: "string" } } },
      operation: { kind: "prompt", prompt: "go", model: "claude-cli/default" },
    });
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    // One block is rewritten — the parent's. The child had nothing of its own to rewrite.
    expect(made.blocks.map((block) => `${block.stateId}:${block.at}`)).toEqual(["feature:environment"]);
    // …and the proof measured the child under its chain, before and after.
    expect(made.proofs.some((proof) => proof.stateId === "feature/draft" && proof.chain === "feature → feature/draft")).toBe(true);
    applyToolsetMigration(made, { paths });

    // The child inherits the MAP now, so it is held to it — and what it can reach is unchanged.
    const parent = environmentOf("feature.json");
    expect(parent.tools).toEqual({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" });
    expect((await handedUnder(parent.tools)).tools["glob"]).toMatchObject({ reachable: true });
  });

  it("writes `other` on a child's own toolset, because upstream merges `permissions` per key", async () => {
    write(paths.workflowsDir, "feature.json", {
      label: "Feature",
      environment: { tools: ["read_file", "glob", "grep", "show_artifact"], permissions: { default: "allow", other: "deny" } },
      children: { draft: { state: "./draft" } },
      sequence: ["draft"],
    });
    write(paths.workflowsDir, "feature/draft.json", legacyState({ tools: ALL_TOOLS, permissions: { default: "ask", other: "ask" } }));
    const made = await planToolsetMigration({ paths, accept: ["shell-judged"] });
    expect(unprovenOf(made)).toEqual([]);
    applyToolsetMigration(made, { paths });
    // The child names `chat/ask-first`, whose `other` is `ask` — written down in the file it names,
    // so the parent's `deny` cannot come down the per-key merge and answer for it.
    expect(environmentOf("feature/draft.json").tools).toBe("$/toolsets/chat/ask-first");
    expect(SHIPPED["chat/ask-first"]!["other"]).toBe("ask");
    expect((await handedUnder(SHIPPED["chat/ask-first"])).other).toBe("ask");
  });

  it("REFUSES a state mounted under two chains that hand it different tools", async () => {
    for (const [root, mode] of [
      ["strict", "deny"],
      ["loose", "allow"],
    ] as const) {
      write(paths.workflowsDir, `${root}.json`, {
        label: root,
        environment: { tools: ["read_file"], permissions: { tools: { read_file: mode } } },
        children: { shared: { state: "shared" } },
        sequence: ["shared"],
      });
    }
    write(paths.workflowsDir, "shared.json", legacyState({ tools: ["read_file", "bash"], permissions: { other: "deny" } }));
    const made = await plan();
    const block = made.blocks.find((one) => one.stateId === "shared");
    expect(block!.outcome).toBe("refused");
    expect(block!.reason).toMatch(/mounted under 2 chains/);
  });
});

describe("the files themselves", () => {
  it("is IDEMPOTENT: a second run has nothing to do and nothing to say about the first", async () => {
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } }));
    applyToolsetMigration(await plan(), { paths });
    const once = stateFile("draft.json");
    const again = await plan();
    expect(again.blocks).toEqual([]);
    expect(again.files).toEqual([]);
    expect(again.already).toEqual([{ stateId: "draft", at: "environment" }]);
    expect(unprovenOf(again)).toEqual([]);
    expect(applyToolsetMigration(again, { paths }).written).toEqual([]);
    expect(stateFile("draft.json")).toBe(once);
  });

  it("migrates a YAML state, and a JSON one with comments, keeping both readable", async () => {
    write(
      paths.workflowsDir,
      "yamlish.yaml",
      [
        "label: Draft",
        "outputs:",
        "  draft:",
        "    kind: text",
        "    schema: { type: string }",
        "operation:",
        "  kind: prompt",
        "  prompt: go",
        "  model: claude-cli/default",
        "environment:",
        "  tools:",
        "    - read_file",
        "  permissions:",
        "    profile: read-only",
        "    tools:",
        "      read_file: allow",
        "",
      ].join("\n"),
    );
    write(
      paths.workflowsDir,
      "commented.json",
      [
        "{",
        "  // what this state may do",
        '  "label": "Draft",',
        '  "outputs": { "draft": { "kind": "text", "schema": { "type": "string" } } },',
        '  "operation": { "kind": "prompt", "prompt": "go", "model": "claude-cli/default" },',
        '  "environment": {',
        '    "tools": ["read_file"],',
        '    "permissions": { "profile": "read-only", "tools": { "read_file": "allow" } }',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const made = await plan();
    expect(unprovenOf(made)).toEqual([]);
    expect(made.files.map((file) => file.file).sort()).toEqual(["commented.json", "yamlish.yaml"]);
    applyToolsetMigration(made, { paths });

    const yaml = parseYaml(stateFile("yamlish.yaml")) as Record<string, Record<string, unknown>>;
    expect(yaml["environment"]!["tools"]).toEqual({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" });
    expect(yaml["environment"]!["permissions"]).toBeUndefined();
    expect(yaml["operation"]!["prompt"]).toBe("go");

    const commented = stateFile("commented.json");
    expect(commented).toContain("// what this state may do");
    expect(commented).toContain('"glob": "ask"');
    expect(commented).not.toContain("profile");
  });

  it("keeps the BYTES of a file that is not UTF-8", async () => {
    // A byte that is not valid UTF-8 on its own: read as latin1, and written back as the same byte.
    const odd = String.fromCharCode(0x97);
    const text = JSON.stringify(legacyState({ tools: ["read_file"], permissions: { profile: "read-only" } }, { description: `Draft ${odd} pass one` }), null, 2) + "\n";
    write(paths.workflowsDir, "latin.json", text, "latin1");
    expect(readFileSync(join(paths.workflowsDir, "latin.json")).includes(0x97)).toBe(true);

    const made = await plan();
    expect(made.files[0]!.encoding).toBe("latin1");
    applyToolsetMigration(made, { paths });
    const after = readFileSync(join(paths.workflowsDir, "latin.json"));
    expect(after.includes(0x97)).toBe(true);
    expect(after.toString("latin1")).toContain(`Draft ${odd} pass one`);
    expect(JSON.parse(after.toString("latin1")).environment.tools).toMatchObject({ read_file: "ask" });
  });

  it("refuses to write a file that changed since the plan was made", async () => {
    write(paths.workflowsDir, "draft.json", legacyState({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } }));
    const made = await plan();
    writeFileSync(join(paths.workflowsDir, "draft.json"), stateFile("draft.json") + "\n", "utf8");
    expect(() => applyToolsetMigration(made, { paths })).toThrow(/changed since the plan was made/);
  });
});

describe("the shared root", () => {
  it("is REFUSED without its own flag, and backs `workflows/` up before the first byte with it", async () => {
    const basePaths = baseAsProjectPaths(home);
    write(basePaths.workflowsDir, "shared.json", legacyState({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } }));
    const made = await planToolsetMigration({ paths: basePaths });
    expect(isUnderSharedRoot(made.workflowsDir, paths)).toBe(true);
    expect(made.files).toHaveLength(1);

    const before = readFileSync(join(basePaths.workflowsDir, "shared.json"), "utf8");
    expect(() => applyToolsetMigration(made, { paths })).toThrow(/--shared-root/);
    // Refused means WRITTEN NOTHING, not written-and-rolled-back.
    expect(readFileSync(join(basePaths.workflowsDir, "shared.json"), "utf8")).toBe(before);

    const written = applyToolsetMigration(made, { paths, sharedRoot: true, now: () => new Date("2026-09-21T12:34:56Z") });
    expect(written.backup).toBe(`${basePaths.workflowsDir}.backup-20260921-123456`);
    expect(readFileSync(join(written.backup!, "shared.json"), "utf8")).toBe(before);
    expect(readFileSync(join(basePaths.workflowsDir, "shared.json"), "utf8")).not.toBe(before);
  });

  it("knows the real `~/.jaira` whatever layout it is handed", () => {
    expect(isUnderSharedRoot(join(paths.base.baseDir, "workflows"), paths)).toBe(true);
    expect(isUnderSharedRoot(paths.workflowsDir, paths)).toBe(false);
  });
});
