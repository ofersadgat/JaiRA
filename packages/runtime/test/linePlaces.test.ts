/**
 * PLACES on a permission set's lines, judged by the runtime (decision 0023 §3.4–§3.10).
 *
 * `places.test.ts` pins the ranking of one map; this pins what the runtime does with it: a shell
 * line's parts answer to the most specific line and then the most specific of its places, a place
 * that matches nothing falls to a less specific line and never to a guess; a direct call is brought
 * down from the gate's loosest mode to its own answer; a place that names a function is put to it;
 * "for this run" keeps an answer at a place; and the feature workflow's old state tables, moved onto
 * lines (§3.7), answer every representative call exactly as they did.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import {
  lowerPermissionSet,
  lowerStatePermissionSets,
  parsePermissionSet,
  placeWidthsOf,
  scopeModeOf,
  TOOL_SPEC_BY_NAME,
  type PermissionSetReader,
  type PermissionsDecl,
  type Scope,
} from "@jaira/shared";
import { CommandGrants, commandDecisionOf, compilePolicy, decideCommand, functionCallOf, pushedBranchesOf, setCommandDecision } from "../src/policy";
import { ApprovalHub } from "../src/approval";
import { shellPermissionSetOf } from "../src/commandParts";
import { compileClaudePlaceRules, namedPlacesOf } from "../src/linePlaces";
import { placeNarrowingFor, scopeNarrowingFor } from "../src/tools";
import { CLAUDE_TOOLS, CODEX_TOOLS, planAgentTools } from "../src/agentTools";
import type { PackageInfo, PackageReader } from "../src/packageScripts";

const ROOT = "/work";
const shellOf = (decl: Record<string, unknown>) => shellPermissionSetOf(parsePermissionSet(decl).permissionSet)!;
const decide = (decl: Record<string, unknown>, line: string, extra: Parameters<typeof decideCommand>[3] = {}) =>
  decideCommand({}, line, "posix", { permissionSet: shellOf(decl), root: ROOT, places: { root: ROOT, named: { $PROJECT: ROOT } }, ...extra });

describe("a shell line's parts: the line, then the place, then less specific lines (§3.4)", () => {
  const build = { "npm run build": { "packages/app": "allow" }, script: "ask", shell: "deny", other: "deny" };

  it("allows `npm run build` in packages/app, and elsewhere falls to `script`", () => {
    const here = decide(build, "cd packages/app && npm run build");
    expect(here.action).toBe("allow");
    const part = here.parts.parts.find((p) => p.text === "npm run build")!;
    expect(part.decidedBy).toMatchObject({ source: "permissionSet", entry: "npm run build", place: "packages/app" });
    expect(part.decidedBy.reason).toBe("the permission set's 'npm run build' in packages/app is allow");
    // At the root no place of the line matches: the part is `script`'s.
    const root = decide(build, "npm run build");
    expect(root.action).toBe("require_approval");
    expect(root.parts.parts[0]!.decidedBy).toMatchObject({ source: "permissionSet", entry: "script" });
    expect(root.parts.parts[0]!.decidedBy.place).toBeUndefined();
    // Under the folder is in it: a bare folder is that folder and everything under it.
    expect(decide(build, "npm run build", { cwd: "packages/app/src" }).action).toBe("allow");
  });

  it("falls past `script` to `shell` where no `script` line is written, then to `other`", () => {
    expect(decide({ "npm run build": { "packages/app": "allow" }, shell: "ask", other: "deny" }, "npm run build").parts.parts[0]!.decidedBy.entry).toBe("shell");
    expect(decide({ "npm run build": { "packages/app": "allow" }, other: "deny" }, "npm run build")).toMatchObject({ action: "deny" });
  });

  it("lets a line's `**` answer elsewhere, and never guesses for a place nothing names", () => {
    const own = decide({ "npm run build": { "**": "ask", "packages/app": "allow" }, script: "allow" }, "npm run build");
    expect(own.parts.parts[0]!.decidedBy).toMatchObject({ entry: "npm run build" });
    expect(own.action).toBe("require_approval");
    // No line at all below it, and no `other`: the shell's own last resort, `ask` — never an allow.
    expect(decide({ "npm run build": { "packages/app": "allow" } }, "npm run build").action).toBe("require_approval");
  });

  it("judges a package script where it RUNS — `npm run build -w packages/app` from the root is in packages/app (§3.6)", () => {
    const packages: PackageReader = {
      at: (dir): PackageInfo | undefined =>
        dir === "/work" ? { dir, name: "root", scripts: {}, workspaces: ["packages/*"] } : dir === "/work/packages/app" ? { dir, name: "@x/app", scripts: { build: "tsc -b" } } : undefined,
      workspacesOf: () => [{ dir: "/work/packages/app", name: "@x/app", scripts: { build: "tsc -b" } }],
    };
    expect(decide(build, "npm run build -w packages/app", { packages }).action).toBe("allow");
    // Picked by its scoped NAME, which is no path the line names: still in packages/app, before the runner's own line.
    for (const line of ["npm --workspace @x/app run build", "npm run build -w @x/app", "npm --workspace=@x/app run build"]) {
      const named = decide({ ...build, "runner:*": "ask" }, line, { packages });
      expect(named.action, line).toBe("allow");
      expect(named.parts.parts[0]!.decidedBy, line).toMatchObject({ entry: "npm run build", place: "packages/app" });
      // And as Windows' PowerShell reads it, where `@x` alone would be a splat.
      const ps = decideCommand({}, line, "powershell", { permissionSet: shellOf({ ...build, "runner:*": "ask" }), root: ROOT, places: { root: ROOT, named: { $PROJECT: ROOT } }, packages });
      expect(ps.action, `${line} (powershell)`).toBe("allow");
    }
    // Elsewhere the line says nothing, so the script is read and judged by what it runs.
    const elsewhere = decide({ "npm run build": { "packages/web": "allow" }, tsc: "allow", other: "deny" }, "npm run build -w packages/app", { packages });
    expect(elsewhere.action).toBe("allow");
    expect(elsewhere.parts.parts.map((p) => p.decidedBy.entry)).toEqual(["tsc"]);
  });

  it("takes the strictest answer for a part about several places (§3.5)", () => {
    // A command line is about where it runs AND every path it names: all in `src`, it is allowed…
    const decl = { cp: { "**": "ask", src: "allow", infra: "deny" } };
    expect(decide(decl, "cd src && cp a b").action).toBe("allow");
    // …run from the root, the root is one of its places, and the root is `**`'s.
    expect(decide(decl, "cp src/a src/b").action).toBe("require_approval");
    expect(decide({ cp: { src: "allow", $PROJECT: "allow", infra: "deny" } }, "cp src/a infra/b").action).toBe("deny");
  });

  it("pushes to `claude/**` without asking, and asks for `main` — by the branch pushed to", () => {
    const decl = { "git push": { "claude/**": "allow", main: "ask" }, shell: "ask" };
    const claude = decide(decl, "git push origin claude/places");
    // Naming the program replaces the built-in ask for a push.
    expect(claude.action).toBe("allow");
    expect(claude.parts.parts[0]!.decidedBy).toMatchObject({ entry: "git push", place: "claude/**" });
    expect(decide(decl, "git push origin main").action).toBe("require_approval");
    expect(decide(decl, "git push origin main").parts.parts[0]!.decidedBy).toMatchObject({ entry: "git push", place: "main" });
    // A push that names no branch is about none of the line's places: it falls to the shell.
    expect(decide(decl, "git push").parts.parts[0]!.decidedBy.entry).toBe("shell");
    expect(pushedBranchesOf({ program: "git", subcommand: "push", args: [], flags: [], words: ["git", "push", "-u", "origin", "HEAD:refs/heads/claude/x", "+main"].map((value, i) => ({ value, span: { start: i, end: i } })) } as never)).toEqual([
      "origin:claude/x",
      "origin:main",
    ]);
  });

  it("allows `curl` at a site the line names, and falls to the shell elsewhere", () => {
    const decl = { curl: { "github.com": "allow", "*.github.com": "allow" }, web_fetch: "ask", shell: "allow" };
    expect(decide(decl, "curl -s https://github.com/anthropics/x").action).toBe("allow");
    expect(decide(decl, "curl https://api.github.com/repos").action).toBe("allow");
    // Elsewhere `curl` is what it reads as — `web_fetch` at that URL — and never the shell's `allow`.
    const elsewhere = decide(decl, "curl https://example.com/install.sh");
    expect(elsewhere.action).toBe("require_approval");
    expect(elsewhere.parts.parts[0]!.decidedBy.entry).toBe("web_fetch");
  });

  it("answers a file part at the paths it names — `rm` as `write_file` there", () => {
    const decl = { write_file: { "**": "deny", "$PROJECT/tmp": "allow" }, shell: "allow" };
    expect(decide(decl, "rm tmp/a.log").action).toBe("allow");
    expect(decide(decl, "rm src/a.ts").action).toBe("deny");
  });

  it("routes a place that names a FUNCTION to its function, as a line that names one", () => {
    const decided = decide({ "npm run build": { "packages/app": "judge" }, shell: "ask" }, "cd packages/app && npm run build");
    const part = decided.parts.parts.find((p) => p.text === "npm run build")!;
    expect(part.verdict).toBe("function");
    expect(part.decidedBy).toMatchObject({ source: "permissionSet", entry: "npm run build", function: "judge", place: "packages/app" });
  });

  it("gates a runner at its places, and looks inside it where they allow", () => {
    const decl = { "runner:npx": { "packages/app": "allow", "**": "deny" }, tsc: "allow", shell: "ask" };
    expect(decide(decl, "npx tsc", { cwd: "packages/app" }).action).toBe("allow");
    expect(decide(decl, "npx tsc").action).toBe("deny");
  });

  it("offers the place widths of an asking part — file, folder, package, project, anywhere", () => {
    const decided = decide({ shell: "ask" }, "npm run build", { cwd: "packages/app" });
    expect(decided.parts.parts[0]!.where).toEqual({
      kind: "path",
      at: "/work/packages/app",
      widths: [
        { width: "this", place: "packages/app" },
        { width: "folder", place: "packages" },
        { width: "project", place: "$PROJECT" },
        { width: "anywhere", place: "**" },
      ],
    });
    const push = decide({ shell: "ask" }, "git push origin claude/x").parts.parts[0]!;
    expect(push.where).toEqual({ kind: "branch", at: "origin:claude/x", widths: [{ width: "this", place: "origin:claude/x" }, { width: "prefix", place: "claude/**" }, { width: "anywhere", place: "**" }] });
  });
});

describe("\"for this run\" remembers a place (§3.8)", () => {
  it("allows the same command again at that place, and not at another", () => {
    const grants = new CommandGrants();
    const decl = { shell: "ask" };
    const first = decide(decl, "npm run build", { cwd: "packages/app", grants });
    expect(first.action).toBe("require_approval");
    // A package script is `script`, and is remembered at that width — here, at a place.
    expect(grants.rememberParts(first.parts, "allow", ["script"], "packages")).toEqual(["script"]);
    const again = decide(decl, "npm run build", { cwd: "packages/app", grants });
    expect(again.action).toBe("allow");
    expect(again.parts.parts[0]!.decidedBy).toMatchObject({ source: "remembered", entry: "script", place: "packages" });
    expect(again.parts.parts[0]!.decidedBy.reason).toBe("'script' in packages was allowed for this run");
    // Elsewhere it asks again: the answer was given about `packages`.
    expect(decide(decl, "npm run build", { grants }).action).toBe("require_approval");
    expect(decide(decl, "npm run build", { cwd: "scripts", grants }).action).toBe("require_approval");
    // An answer kept at no place covers the width everywhere, as before places.
    grants.remember("script", "allow");
    expect(decide(decl, "npm run build", { cwd: "scripts", grants }).action).toBe("allow");
    expect(grants.list()).toEqual({ "script @ packages": "allow", script: "allow" });
  });

  it("is what the approval hub keeps when an answer names a place, and says so in the reach", async () => {
    const resolved: Array<{ place?: string | undefined }> = [];
    let asked: string | undefined;
    const hub = new ApprovalHub({ onRequest: (request) => void (asked = request.requestId), onResolved: (_id, _decision, _by, reach) => void resolved.push(reach) });
    const input = { command: "npm run build" };
    setCommandDecision(input, decide({ shell: "ask" }, "npm run build", { cwd: "packages/app" }));
    const answer = hub.approver({ taskId: "t1" })({ tool: "shell", input, sessionId: "s" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.decide(asked!, "allow", "workflow-run", ["script"], undefined, "person", "packages")).toBe(true);
    expect(await answer).toEqual({ decision: "allow", scope: "once" });
    expect(resolved[0]).toEqual({ scope: "workflow-run", remember: ["script"], place: "packages" });
    expect(hub.grants("t1").list()).toEqual({ "script @ packages": "allow" });
  });

  it("refuses a part one of whose places a remembered refusal covers", () => {
    const grants = new CommandGrants();
    grants.remember("rm", "deny", "infra");
    expect(decide({ shell: "ask" }, "rm src/a infra/b", { grants }).action).toBe("deny");
    expect(decide({ shell: "ask" }, "rm src/a", { grants }).action).toBe("require_approval");
  });
});

describe("a direct call is brought down from the gate's loosest mode to its own (§3.10)", () => {
  const block = (decl: Record<string, unknown>): PermissionsDecl => lowerPermissionSet(parsePermissionSet(decl).permissionSet, "$/permission-sets/x/y").permissions!;
  const narrow = placeNarrowingFor({ root: ROOT, named: namedPlacesOf(ROOT) });
  const call = (decl: Record<string, unknown>, tool: string, input: Record<string, unknown>) => narrow({ name: tool }, input as FunctionInputs, block(decl) as never);

  it("lets a file-pinning place beat a folder that allows: a credential still asks under `$PROJECT` (ruling 3)", () => {
    const decl = { read_file: { $PROJECT: "allow", "**/.env": "ask", "**": "deny" } };
    // The gate is told the loosest answer; the narrowing tightens each call to its own.
    expect(block(decl).tools!["read_file"]).toBe("allow");
    expect(call(decl, "read_file", { path: "src/a.ts" })).toBe("allow");
    expect(call(decl, "read_file", { path: "/work/.env" })).toBe("ask");
    expect(call(decl, "read_file", { path: "/work/packages/app/.env" })).toBe("ask");
    expect(call(decl, "read_file", { path: "/etc/passwd" })).toBe("deny");
    // `..` is walked before it is compared, so it cannot climb out of an allowed folder.
    expect(call(decl, "read_file", { path: "src/../../etc/passwd" })).toBe("deny");
    // An agent's own `Read`, asked about by its standard name with its `file_path` copied to `path`.
    expect(call(decl, "Read", { path: "/work/.env", file_path: "/work/.env" })).toBe("ask");
  });

  it("falls to `other` where no place matches and the line has no `**`, and leaves a line with no places alone", () => {
    expect(call({ write_file: { src: "allow" }, other: "deny" }, "write_file", { path: "infra/x" })).toBe("deny");
    expect(call({ write_file: { src: "allow" } }, "write_file", { path: "infra/x" })).toBe("ask");
    expect(call({ write_file: "allow" }, "write_file", { path: "infra/x" })).toBeUndefined();
    expect(call({ web_search: "ask" }, "web_search", { query: "x" })).toBeUndefined();
  });

  it("reads a site, a branch and a workflow off the call", () => {
    expect(call({ web_fetch: { "docs.example.com": "allow", "**": "ask" } }, "web_fetch", { url: "https://docs.example.com/a" })).toBe("allow");
    expect(call({ web_fetch: { "docs.example.com": "allow", "**": "ask" } }, "web_fetch", { url: "https://evil.example.com/a" })).toBe("ask");
    expect(call({ git_push: { "**": "allow", main: "ask" } }, "git_push", { branch: "main" })).toBe("ask");
    expect(call({ git_push: { "**": "allow", "origin:main": "deny" } }, "git_push", { branch: "main", remote: "origin" })).toBe("deny");
    // No branch named: the current one, which only the forge knows — the line's own mode answers.
    expect(call({ git_push: { "**": "allow", main: "ask" } }, "git_push", {})).toBe("allow");
    expect(call({ start_task: { "feature/**": "allow", "**": "deny" } }, "start_task", { state: "feature/product" })).toBe("allow");
  });

  it("puts a place that names a FUNCTION to that function, noted against the call", () => {
    const input = { path: "src/a.ts" };
    expect(call({ read_file: { src: "judge", "**": "allow" } }, "read_file", input)).toBe("ask");
    expect(functionCallOf(input)).toEqual({ tool: "read_file", subject: "read_file", function: "judge", place: "src" });
    const elsewhere = { path: "docs/a.md" };
    expect(call({ read_file: { src: "judge", "**": "allow" } }, "read_file", elsewhere)).toBe("allow");
    expect(functionCallOf(elsewhere)).toBeUndefined();
  });

  it("does the same in a compiled policy's narrowing, under the executor's floor", () => {
    const floor: Scope[] = [{ path: "/work/**", default: "allow" }];
    const policy = compilePolicy({}, { workspaceRoot: ROOT, scopes: floor });
    const decl = { read_file: { "**": "deny", "docs/product": "allow" } };
    expect(policy.scopeOf!({ name: "read_file" }, { path: "docs/product/a.md" } as FunctionInputs, block(decl) as never)).toBe("allow");
    expect(policy.scopeOf!({ name: "read_file" }, { path: "src/a.ts" } as FunctionInputs, block(decl) as never)).toBe("deny");
    // Nothing reaches past the floor: a place the floor never named is refused, whatever the line allows.
    expect(policy.scopeOf!({ name: "read_file" }, { path: "/etc/x" } as FunctionInputs, block({ read_file: "allow" }) as never)).toBe("deny");
    // …nor past `.jaira/`, which a shell line is refused outright.
    const jaira = { command: "cat .jaira/settings.json" };
    expect(policy.scopeOf!({ name: "shell" }, jaira as FunctionInputs, block({ shell: { "**": "allow" }, read_file: "allow" }) as never)).toBe("deny");
    expect(commandDecisionOf(jaira)!.parts.parts[0]!.decidedBy.source).toBe("path");
  });
});

describe("what an agent is handed (§3.9)", () => {
  it("compiles a kept built-in's places into Claude rules — scoped only, every native", () => {
    const rules = compileClaudePlaceRules(
      { read_file: { $PROJECT: "allow", "**/.env": "ask", "**": "deny" }, edit: { src: "deny" }, web_fetch: { "github.com": "allow", "docs.x.com/a": "allow" } },
      { root: ROOT, named: { $PROJECT: ROOT }, declaration: CLAUDE_TOOLS },
    );
    expect(rules.allow).toEqual(["Read(/work)", "Read(/work/**)", "WebFetch(domain:github.com)"]);
    expect(rules.ask).toEqual(["Read(**/.env)"]);
    expect(rules.deny).toEqual(["Edit(/work/src)", "MultiEdit(/work/src)", "NotebookEdit(/work/src)", "Edit(/work/src/**)", "MultiEdit(/work/src/**)", "NotebookEdit(/work/src/**)"]);
  });

  it("removes a built-in its line makes unavailable, and keeps a native line's built-in with places under the bare ask", () => {
    const plan = planAgentTools(parsePermissionSet({ read_file: "unavailable", edit: { mode: { "**": "deny", src: "allow" }, implementation: "native" }, other: "ask" }).permissionSet, CLAUDE_TOOLS);
    expect(plan.denyNatives).toContain("Read");
    // A native whose line allows at some place is kept — not removed for its `**` deny.
    expect(plan.askNatives).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "NotebookEdit"]));
  });

  it("serves codex JaiRA's own tool where a native line has places, and keeps its sandbox shut", () => {
    const placed = planAgentTools(parsePermissionSet({ shell: { mode: { "**": "ask", "packages/app": "allow" }, implementation: "native" } }).permissionSet, CODEX_TOOLS);
    expect(placed.inject).toContain("shell");
    expect(placed.askNatives).toEqual([]);
    expect(placed.switches).toEqual({ "workspace-write": false });
    // Without places the native is kept, as before.
    const plain = planAgentTools(parsePermissionSet({ shell: { mode: "ask", implementation: "native" } }).permissionSet, CODEX_TOOLS);
    expect(plain.switches).toEqual({ "workspace-write": true });
  });
});

describe("the feature workflow's state tables, moved onto lines (§3.7)", () => {
  // The sets the feature workflow names, as `~/.jaira/permission-sets/feature/` holds them.
  const SETS: Record<string, Record<string, string>> = {
    "$/permission-sets/feature/read-only": { read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" },
    "$/permission-sets/feature/write-files": { read_file: "allow", glob: "ask", grep: "ask", edit: "ask", write_file: "allow", shell: "smart", web_fetch: "ask", web_search: "ask", other: "ask" },
  };
  const read: PermissionSetReader = (reference) => {
    const value = SETS[reference];
    if (value === undefined) throw new Error(`no '${reference}'`);
    return { value, key: reference, from: reference };
  };
  /** Two states as they were (`feature/product/draft`, `feature/ui/item/render`) and as `migrate` wrote them. */
  const CASES: Array<{ name: string; set: string; scopes: Scope[]; migrated: Record<string, unknown> }> = [
    {
      name: "product/draft",
      set: "$/permission-sets/feature/read-only",
      scopes: [
        { path: "docs/product/**", tools: { read_file: "allow" } },
        { path: "docs/_templates/**", tools: { read_file: "allow" } },
      ],
      migrated: { read_file: { "**": "deny", "docs/product": "allow", "docs/_templates": "allow" }, glob: "deny", grep: "deny", show_artifact: "deny", web_fetch: "deny" },
    },
    {
      name: "ui/item/render",
      set: "$/permission-sets/feature/write-files",
      scopes: [
        { path: "docs/product/**", tools: { read_file: "allow" } },
        { path: "docs/ux/**", tools: { read_file: "allow" } },
        { path: "docs/ui/**", tools: { read_file: "allow" } },
        { path: "docs/_templates/**", tools: { read_file: "allow" } },
        { path: "docs/ui/assets/**", tools: { read_file: "allow", write_file: "allow" } },
      ],
      migrated: {
        read_file: { "**": "deny", "docs/product": "allow", "docs/ux": "allow", "docs/ui": "allow", "docs/_templates": "allow", "docs/ui/assets": "allow" },
        glob: "deny",
        grep: "deny",
        edit: "deny",
        write_file: { "**": "deny", "docs/ui/assets": "allow" },
        show_artifact: "deny",
        shell: "deny",
        web_fetch: "deny",
      },
    },
  ];
  const CALLS: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "docs/product/a.md" }],
    ["read_file", { path: "docs/_templates/unit.md" }],
    ["read_file", { path: "docs/ux/flow.md" }],
    ["read_file", { path: "docs/ui/assets/x/a.html" }],
    ["read_file", { path: "src/index.ts" }],
    ["read_file", { path: "/etc/passwd" }],
    ["write_file", { path: "docs/ui/assets/x/a.html" }],
    ["write_file", { path: "docs/ui/a.md" }],
    ["edit", { path: "docs/ui/assets/x/a.html" }],
    ["glob", { pattern: "**/*.md" }],
    ["glob", { pattern: "*.md", path: "docs/product" }],
    ["grep", { pattern: "x", path: "docs/product" }],
    ["web_fetch", { url: "https://example.com" }],
    ["web_search", { query: "x" }],
    ["show_artifact", { file_path: "out/a.html" }],
    ["shell", { command: "cat docs/product/a.md" }],
  ];
  const RANK = { allow: 0, smart: 1, ask: 2, deny: 3 } as const;
  type GateMode = keyof typeof RANK;
  const strictest = (...modes: Array<GateMode | undefined>): GateMode =>
    modes.reduce<GateMode>((worst, mode) => (mode !== undefined && RANK[mode] > RANK[worst] ? mode : worst), "allow");

  it.each(CASES)("$name answers every representative call as its table did", ({ set, scopes, migrated }) => {
    // AS IT WAS: the set lowered alone, and the state's table — a sandbox, nothing under it — narrowing each call.
    const before = lowerPermissionSet(parsePermissionSet(SETS[set]!).permissionSet).permissions!;
    const table = scopeNarrowingFor(scopes, ROOT)!;
    // AS IT IS: the migrated state lowered as every load lowers it, and the run's policy narrowing each call.
    const { def, issues } = lowerStatePermissionSets("feature/x", { operation: { kind: "prompt", prompt: "go", tools: { $ref: set, ...migrated } } }, read);
    expect(issues).toEqual([]);
    const after = (def as { operation: { tools: string[]; permissions: PermissionsDecl } }).operation;
    const policy = compilePolicy({}, { workspaceRoot: ROOT });
    for (const [tool, input] of CALLS) {
      const held = (list: readonly string[]): boolean => list.includes(tool) || TOOL_SPEC_BY_NAME.get(tool)?.alwaysGranted === true;
      const was = held(lowerPermissionSet(parsePermissionSet(SETS[set]!).permissionSet).tools)
        ? strictest(before.tools?.[tool] ?? "ask", tool === "shell" ? "ask" : undefined, table({ name: tool }, input as FunctionInputs) ?? undefined)
        : "deny";
      const is = held(after.tools) || after.permissions.tools?.[tool] !== undefined
        ? strictest(after.permissions.tools?.[tool] ?? "ask", policy.scopeOf!({ name: tool }, { ...input } as FunctionInputs, after.permissions as never))
        : "deny";
      // A `smart` that stood for a function (`shell: "smart"`) asks, as an `ask` does: what reaches a person.
      const word = (mode: GateMode): string => (mode === "smart" ? "ask" : mode);
      expect(word(is), `${tool} ${JSON.stringify(input)}`).toBe(word(was));
    }
  });

  it("the old state table key is refused by the linter, with what to write instead", () => {
    const { issues } = lowerStatePermissionSets("feature/x", { operation: { kind: "prompt", tools: "$/permission-sets/feature/read-only", permissions: { scopes: [{ path: "docs/**", tools: { read_file: "allow" } }] } } }, read);
    expect(issues.map((issue) => issue.message)).toEqual([expect.stringMatching(/permissions\.scopes is gone — where a tool may act is a map of places on its line/)]);
    // The old table's reader is the floor's now; a state's table is read by nothing.
    expect(scopeModeOf([{ path: "docs/**", tools: { read_file: "allow" } }], TOOL_SPEC_BY_NAME.get("read_file"), "read_file", { path: "src/x" }, { root: ROOT })).toBe("deny");
  });
});

describe("place widths (§3.8)", () => {
  it("offers a path's file, folder, package, project and anywhere — the package from the filesystem's answer", () => {
    expect(placeWidthsOf("path", "packages/app/src/x.ts", { root: ROOT, named: { $PROJECT: ROOT }, packageOf: () => "/work/packages/app" })).toEqual([
      { width: "this", place: "packages/app/src/x.ts" },
      { width: "folder", place: "packages/app/src" },
      { width: "package", place: "packages/app" },
      { width: "project", place: "$PROJECT" },
      { width: "anywhere", place: "**" },
    ]);
    // Outside the project there is no project width, and a place is written absolute.
    expect(placeWidthsOf("path", "/etc/hosts", { root: ROOT })).toEqual([
      { width: "this", place: "/etc/hosts" },
      { width: "folder", place: "/etc" },
      { width: "anywhere", place: "**" },
    ]);
  });

  it("offers a URL's page, host, parent domain and anywhere; never a wildcard over an address", () => {
    expect(placeWidthsOf("site", "https://docs.github.com/en/rest?x=1")).toEqual([
      { width: "this", place: "docs.github.com/en/rest" },
      { width: "host", place: "docs.github.com" },
      { width: "parent", place: "*.github.com" },
      { width: "anywhere", place: "**" },
    ]);
    expect(placeWidthsOf("site", "https://github.com")).toEqual([{ width: "host", place: "github.com" }, { width: "anywhere", place: "**" }]);
    expect(placeWidthsOf("site", "http://127.0.0.1:8080/a")).toEqual([
      { width: "this", place: "127.0.0.1:8080/a" },
      { width: "host", place: "127.0.0.1:8080" },
      { width: "anywhere", place: "**" },
    ]);
  });

  it("offers a branch, its prefix and any branch", () => {
    expect(placeWidthsOf("branch", "claude/places")).toEqual([
      { width: "this", place: "claude/places" },
      { width: "prefix", place: "claude/**" },
      { width: "anywhere", place: "**" },
    ]);
    expect(placeWidthsOf("branch", "main")).toEqual([{ width: "this", place: "main" }, { width: "anywhere", place: "**" }]);
  });
});
