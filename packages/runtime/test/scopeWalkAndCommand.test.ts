/**
 * The three pieces of scope enforcement that a per-call refusal does not cover.
 *
 * A listing whose ANSWER is the thing withheld; a shell command whose places live inside a string;
 * and the table handed to the agent so it bounds its own built-ins rather than asking us once per
 * call. Each fails in a different direction, and each is here for that reason.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, FunctionInputs } from "@declarative-ai/exec";
import { createGlobTool, createGrepTool } from "../src/searchTools";
import { commandSubjects, compileClaudeScopeRules, scopeNarrowingFor } from "../src/tools";
import type { ExecEnv } from "../src/paths";

/** A posix dialect for the parser — the WSL form is how `ExecEnv` spells "not PowerShell". */
const POSIX: ExecEnv = { wsl: "test" };

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-scope-"));
  root = dir.replace(/\\/g, "/");
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "infra"), { recursive: true });
  writeFileSync(join(dir, "app", "a.ts"), "const secret = 1;\n", "utf8");
  writeFileSync(join(dir, "infra", "b.ts"), "const secret = 2;\n", "utf8");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `ctx.policy.scopeOf` is where a tool reads the narrowing — the same one the gate consults. */
const scopedCtx = (): ExecServices =>
  ({
    workspace: { root: dir },
    policy: {
      scopeOf: scopeNarrowingFor(
        [
          { path: `${root}/**`, default: "allow" },
          { path: `${root}/infra/**`, default: "deny" },
        ],
        root,
      ),
    },
  }) as unknown as ExecServices;

/**
 * The walk filter — the leak a refusal at the call does not close.
 *
 * `grep` at the root under a table denying `infra/**` is ALLOWED: the root is allowed, and the call
 * is about the root. It would then return the matching lines from `infra/`, which is precisely the
 * content the scope exists to withhold. A later `read_file` being refused is no comfort once the
 * matches are in the transcript.
 */
describe("a listing withholds what an open would refuse", () => {
  it("drops denied paths from a glob, and says nothing about having done so", async () => {
    const result = await createGlobTool().run({ pattern: "**/*.ts" } as FunctionInputs, scopedCtx());
    const paths = (result as { paths: string[] }).paths;
    expect(paths).toContain("app/a.ts");
    expect(paths).not.toContain("infra/b.ts");
    // Silently. "1 result withheld" tells the model exactly where to aim, which is the one thing a
    // withheld listing must not do — the count belongs in the journal.
    expect(JSON.stringify(result)).not.toMatch(/withheld/i);
  });

  it("drops denied files from a grep, so no content leaks", async () => {
    const result = await createGrepTool().run({ pattern: "secret" } as FunctionInputs, scopedCtx());
    const hits = (result as { matches: Array<{ path: string }> }).matches;
    expect(hits.map((h) => h.path)).toEqual(["app/a.ts"]);
  });

  it("changes nothing when no table is in force", async () => {
    const result = await createGlobTool().run({ pattern: "**/*.ts" } as FunctionInputs, {
      workspace: { root: dir },
    } as ExecServices);
    expect((result as { paths: string[] }).paths.sort()).toEqual(["app/a.ts", "infra/b.ts"]);
  });
});

/**
 * `bash` — the sandbox is where the command RUNS, plus every path it names.
 *
 * The last piece to ship and the least certain, which is why its failure direction matters most: a
 * missed path costs a prompt, never a silent pass.
 */
describe("the places a shell command is about", () => {
  it("always includes the working directory, not only when no path is named", () => {
    // A command naming one innocuous file while running somewhere it should not be is still running
    // somewhere it should not be.
    expect(commandSubjects("ls -al", "/work/infra", POSIX).paths).toContain("/work/infra");
  });

  it("resolves every path argument against the directory it runs in", () => {
    const { paths } = commandSubjects("cp app/x.ts infra/x.ts", "/work", POSIX);
    expect(paths).toContain("/work/app/x.ts");
    expect(paths).toContain("/work/infra/x.ts");
  });

  it("follows `cd` for the commands after it", () => {
    // `cd infra && rm -rf .` is judged at infra/, which is the whole reason to track it.
    expect(commandSubjects("cd infra && ls", "/work", POSIX).paths).toContain("/work/infra");
  });

  it("leaves bare words alone — they are subcommands far more often than paths", () => {
    // Resolving `origin` and `main` against the cwd would invent two places nobody named.
    expect(commandSubjects("git push origin main", "/work", POSIX).paths).toEqual(["/work"]);
  });

  it("reports a line it could not parse rather than guessing at it", () => {
    expect(commandSubjects('echo "unterminated', "/work", POSIX).unparsed).toBe(true);
  });

  it("takes the strictest place, through the narrowing", () => {
    const narrow = scopeNarrowingFor(
      [
        { path: "/work/**", default: "allow" },
        { path: "/work/infra/**", default: "deny" },
      ],
      "/work",
      POSIX,
    )!;
    expect(narrow({ name: "bash" }, { command: "ls app" } as FunctionInputs)).toBe("allow");
    // One denied argument decides the whole call…
    expect(narrow({ name: "bash" }, { command: "cp app/x infra/x" } as FunctionInputs)).toBe("deny");
    // …and so does a denied working directory.
    expect(narrow({ name: "bash" }, { command: "ls", cwd: "infra" } as FunctionInputs)).toBe("deny");
  });

  it("escalates a line it could not parse", () => {
    // The existing "unparsable ⇒ ask" rule, kept: an unreadable command must not become an allowed
    // one just because its cwd happened to be permitted.
    const narrow = scopeNarrowingFor([{ path: "/work/**", default: "allow" }], "/work", POSIX)!;
    expect(narrow({ name: "bash" }, { command: 'echo "unterminated' } as FunctionInputs)).toBe("ask");
  });
});

/**
 * The rule compiler — the table handed to the agent rather than enforced one callback at a time.
 *
 * Claude Code's rules are path-scoped (verified against 2.1.142), so a table can bound the agent's
 * own built-ins up front. These pin the shape, and above all that every rule is SCOPED.
 */
describe("compiling a table into the agent's own rules", () => {
  const table = [
    { path: "/work/**", tools: { read_file: "allow", glob: "allow" } },
    { path: "/work/infra/**", default: "deny" },
    { path: "/work/app/**", tools: { write_file: "ask" } },
  ] as never;

  it("emits a scoped rule per tool per place, under the agent's own names", () => {
    const rules = compileClaudeScopeRules(table);
    expect(rules.allow).toContain("Read(/work/**)");
    expect(rules.allow).toContain("Glob(/work/**)");
    expect(rules.ask).toContain("Write(/work/app/**)");
    expect(rules.deny).toContain("Read(/work/infra/**)");
  });

  it("scopes EVERY rule — a bare one would outrank a specific one", () => {
    // The trap that made a live test read as "path rules do not work": precedence is
    // deny > ask > allow, so a bare `ask: ["Read"]` beats `allow: ["Read(inside/**)"]`.
    for (const rule of Object.values(compileClaudeScopeRules(table)).flat()) {
      expect(rule, `'${rule}' is not scoped`).toMatch(/\(.+\)$/);
    }
  });

  it("leaves `smart` to our callback — a rule cannot inspect the call", () => {
    const rules = compileClaudeScopeRules([{ path: "/work/**", tools: { bash: "smart" } }] as never);
    expect(Object.values(rules).flat()).toEqual([]);
  });

  it("emits nothing for a tool that names no place", () => {
    // `web_search` takes a query — there is nothing for a path rule to scope.
    expect(compileClaudeScopeRules([{ path: "/work/**", tools: { web_search: "allow" } }] as never).allow).toEqual([]);
  });
});
