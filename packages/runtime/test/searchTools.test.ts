/**
 * `glob` and `grep` — the two capabilities an agent used to reach for through its own built-ins or
 * through a shell, and which nothing here could gate because nothing here had a name for them.
 *
 * What the suite is really pinning is containment and bounds. Both tools walk a tree on behalf of a
 * model, so the two ways they can go wrong are walking somewhere they should not and walking
 * forever; everything else is a convenience.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { createGlobTool, createGrepTool, globToRegExp, registerSearchTools } from "../src/searchTools";
import { newRegistry } from "../src/wiring";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-search-"));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, ".jaira"), { recursive: true });
  writeFileSync(join(dir, "top.ts"), "export const top = 1;\n", "utf8");
  writeFileSync(join(dir, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n", "utf8");
  writeFileSync(join(dir, "src", "b.txt"), "needle in a text file\n", "utf8");
  writeFileSync(join(dir, "src", "deep", "c.ts"), "// deep needle\n", "utf8");
  writeFileSync(join(dir, "node_modules", "junk", "d.ts"), "const needle = 'vendored';\n", "utf8");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): ExecServices => ({ workspace: { root: dir } }) as ExecServices;
const call = async (tool: Tool, input: unknown, c: ExecServices = ctx()) =>
  (await (tool.run as (i: unknown, x: unknown) => Promise<Record<string, unknown>>)(input, c)) ?? {};

describe("globToRegExp", () => {
  it("keeps `*` inside one segment and lets `**` cross them", () => {
    // The one distinction that makes writing a glob worth more than writing a substring.
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/c.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/deep/c.ts")).toBe(true);
  });

  it("lets `**/` match zero directories, which is what everyone means by it", () => {
    expect(globToRegExp("**/*.ts").test("top.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/deep/c.ts")).toBe(true);
  });

  it("treats a dot as a literal rather than as any character", () => {
    expect(globToRegExp("*.ts").test("axts")).toBe(false);
  });

  it("reads a brace group as alternation", () => {
    const m = globToRegExp("src/*.{ts,txt}");
    expect(m.test("src/a.ts")).toBe(true);
    expect(m.test("src/b.txt")).toBe(true);
    expect(m.test("src/c.md")).toBe(false);
  });
});

describe("glob", () => {
  const tool = () => createGlobTool();

  it("finds files by pattern, sorted, workspace-relative", () => {
    // Sorted rather than mtime-ordered: a model builds lists from this, and a list whose order moves
    // between two identical calls is one it cannot reason about.
    return call(tool(), { pattern: "**/*.ts" }).then((result) => {
      expect(result.paths).toEqual(["src/a.ts", "src/deep/c.ts", "top.ts"]);
    });
  });

  it("never walks into vendored or engine-owned directories", async () => {
    // `node_modules` holds more files than the project by two orders of magnitude, so entering one
    // spends the whole budget somewhere nobody asked about. `.jaira` is the app's own state.
    const result = await call(tool(), { pattern: "**/*" });
    expect((result.paths as string[]).some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect((result.paths as string[]).some((p) => p.startsWith(".jaira/"))).toBe(false);
  });

  it("scopes to a subdirectory when asked, and refuses one outside the workspace", async () => {
    expect(await call(tool(), { pattern: "*.ts", path: "src" })).toMatchObject({ paths: ["a.ts"] });
    expect(await call(tool(), { pattern: "*", path: "../.." })).toMatchObject({
      error: expect.stringMatching(/outside the workspace/) as unknown as string,
    });
    expect(await call(tool(), { pattern: "*", path: ".jaira" })).toMatchObject({
      error: expect.stringMatching(/\.jaira/) as unknown as string,
    });
  });

  it("says so rather than guessing when there is no workspace", async () => {
    expect(await call(tool(), { pattern: "*" }, {} as ExecServices)).toMatchObject({
      error: expect.stringMatching(/no workspace/) as unknown as string,
    });
  });

  it("is read-only, which is what a narrowing profile gates on", () => {
    expect(tool().readOnly).toBe(true);
  });
});

describe("grep", () => {
  const tool = () => createGrepTool();

  it("returns each match with its path and line number", async () => {
    const result = await call(tool(), { pattern: "needle" });
    const hits = result.matches as Array<{ path: string; line: number }>;
    expect(hits.map((h) => h.path).sort()).toEqual(["src/a.ts", "src/b.txt", "src/deep/c.ts"]);
    expect(hits.find((h) => h.path === "src/a.ts")!.line).toBe(1);
    // The vendored copy is behind the same prune the walk applies everywhere.
    expect(hits.some((h) => h.path.startsWith("node_modules/"))).toBe(false);
  });

  it("narrows by glob and by directory", async () => {
    expect(((await call(tool(), { pattern: "needle", glob: "**/*.ts" })).matches as unknown[]).length).toBe(2);
    expect(((await call(tool(), { pattern: "needle", path: "src/deep" })).matches as unknown[]).length).toBe(1);
  });

  it("matches case-sensitively unless told otherwise", async () => {
    expect(((await call(tool(), { pattern: "NEEDLE" })).matches as unknown[]).length).toBe(0);
    expect(((await call(tool(), { pattern: "NEEDLE", ignoreCase: true })).matches as unknown[]).length).toBe(3);
  });

  it("reports an unusable expression instead of throwing it", async () => {
    // A model writes these, so a bad one is an ordinary event and has to come back as data.
    expect(await call(tool(), { pattern: "([" })).toMatchObject({
      error: expect.stringMatching(/not a usable regular expression/) as unknown as string,
    });
  });
});

describe("registerSearchTools", () => {
  it("registers both under the names the vocabulary uses", () => {
    const registry = newRegistry();
    registerSearchTools(registry, { cwd: dir });
    expect(registry.tools.get("glob")?.readOnly).toBe(true);
    expect(registry.tools.get("grep")?.readOnly).toBe(true);
  });
});
