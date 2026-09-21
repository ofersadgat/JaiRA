/**
 * Settings → Toolsets against a real three-layer tree (decision 0007 §6): every layer's file read
 * apart, a save that is an edit, an override, or a file that stops following, a reset that deletes
 * only an override, and which states name a toolset.
 *
 * What is worth proving here rather than on text: that an override written by a save is resolved by
 * the same loader a run uses, that nothing is ever written into what ships, and that a line taken out
 * of a followed toolset really is gone from what a state gets.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseAsProjectPaths, jairaPaths, setBuiltInDir, type JairaPaths } from "@jaira/shared";
import { initProject } from "../src/project";
import { readToolsetLayers, readToolsets, resetToolset, toolsetUsers, writeToolset } from "../src/toolsets";

let scratch: string;
let paths: JairaPaths;
let builtIn: string;
let home: string;

const SHIPPED = { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" } as const;

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return file;
}

const winner = (id: string): unknown => readToolsets(paths).find((choice) => choice.id === id)?.decl;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-toolset-settings-"));
  builtIn = join(scratch, "builtin");
  home = join(scratch, "home");
  const projectDir = join(scratch, "project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(builtIn, { recursive: true });
  setBuiltInDir(builtIn);
  initProject(projectDir, home);
  paths = jairaPaths(projectDir, home, builtIn);
  write(builtIn, "toolsets/chat/read-only.json", SHIPPED);
});

afterEach(() => {
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

describe("readToolsetLayers", () => {
  it("keeps every layer's file apart, nearest first, with what each follows and resolves to", () => {
    write(paths.base.baseDir, "toolsets/chat/read-only.json", { $ref: "$SYSTEM/toolsets/chat/read-only", bash: "ask" });
    write(paths.jairaDir, "toolsets/feature/writes.json", { edit: "ask", other: "ask" });
    const records = readToolsetLayers(paths);
    expect(records.map((r) => [r.id, r.files.map((f) => [f.layer, f.file, f.follows])])).toEqual([
      [
        "chat/read-only",
        [
          ["base", "~/.jaira/toolsets/chat/read-only.json", "$SYSTEM/toolsets/chat/read-only"],
          ["system", "built in/toolsets/chat/read-only.json", undefined],
        ],
      ],
      ["feature/writes", [["project", ".jaira/toolsets/feature/writes.json", undefined]]],
    ]);
    expect(records[0]!.files[0]!.decl).toEqual({ ...SHIPPED, bash: "ask" });
    expect(records[0]!.files[1]!.decl).toEqual(SHIPPED);
  });

  it("lists a file it cannot read, with why, instead of leaving it out", () => {
    write(paths.jairaDir, "toolsets/chat/broken.json", { $ref: "$/toolsets/chat/nowhere" });
    write(paths.jairaDir, "toolsets/chat/list.json", '["read_file"]');
    const files = readToolsetLayers(paths).filter((r) => r.id !== "chat/read-only").map((r) => r.files[0]!);
    expect(files.map((f) => [f.decl, typeof f.problem])).toEqual([
      [undefined, "string"],
      [undefined, "string"],
    ]);
  });

  it("has no project layer where the project IS the shared root", () => {
    write(home, "toolsets/team/review.json", { read_file: "allow" });
    const shared = baseAsProjectPaths(home, builtIn);
    expect(readToolsetLayers(shared).map((r) => [r.id, r.files.map((f) => f.layer)])).toEqual([
      ["chat/read-only", ["system"]],
      ["team/review", ["base"]],
    ]);
  });
});

describe("writeToolset", () => {
  it("creates an override that follows what ships and holds only what differs — and a run reads the merge", () => {
    const result = writeToolset(paths, "chat/read-only", "project", { ...SHIPPED, bash: "ask", "git log": "allow" });
    expect(result.kind).toBe("override");
    expect(readFileSync(result.file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/toolsets/chat/read-only",\n  "bash": "ask",\n  "git log": "allow"\n}\n`);
    expect(winner("chat/read-only")).toEqual({ ...SHIPPED, bash: "ask", "git log": "allow" });
    // What ships moved on: the override inherits it, which is the point of following.
    write(builtIn, "toolsets/chat/read-only.json", { ...SHIPPED, grep: "allow" });
    expect(winner("chat/read-only")).toMatchObject({ grep: "allow", bash: "ask" });
  });

  it("an override with nothing to say is still an override — what 'Override here' writes", () => {
    const result = writeToolset(paths, "chat/read-only", "base", { ...SHIPPED });
    expect(result.kind).toBe("override");
    expect(readFileSync(result.file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/toolsets/chat/read-only"\n}\n`);
    expect(result.file.startsWith(home)).toBe(true);
  });

  it("edits an override in place, still following, and keeps the person's layout", () => {
    const file = write(paths.jairaDir, "toolsets/chat/read-only.json", `{\n  "$ref": "$SYSTEM/toolsets/chat/read-only",\n\n  "bash":   "ask"\n}\n`);
    expect(writeToolset(paths, "chat/read-only", "project", { ...SHIPPED, bash: "allow", edit: "ask" }).kind).toBe("edit");
    expect(readFileSync(file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/toolsets/chat/read-only",\n\n  "bash":   "allow",\n  "edit": "ask"\n}\n`);
    // A line put back to what ships says goes out of the override again.
    writeToolset(paths, "chat/read-only", "project", { ...SHIPPED, edit: "ask" });
    expect(readFileSync(file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/toolsets/chat/read-only",\n\n  "edit": "ask"\n}\n`);
  });

  it("stops following when a line the lower layer holds is taken out, because an override cannot say that", () => {
    const { glob: _gone, ...rest } = SHIPPED;
    const created = writeToolset(paths, "chat/read-only", "project", rest);
    expect(created.kind).toBe("detach");
    expect(JSON.parse(readFileSync(created.file, "utf8"))).toEqual(rest);
    expect(winner("chat/read-only")).toEqual(rest);

    const file = write(paths.base.baseDir, "toolsets/chat/read-only.json", { $ref: "$SYSTEM/toolsets/chat/read-only", bash: "ask" });
    expect(writeToolset(paths, "chat/read-only", "base", { ...rest, bash: "ask" }).kind).toBe("detach");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...rest, bash: "ask" });
  });

  it("edits a plain file in place, and creates one where no layer holds the id", () => {
    const file = write(paths.jairaDir, "toolsets/feature/writes.json", { edit: "ask", other: "ask" });
    expect(writeToolset(paths, "feature/writes", "project", { edit: "allow", write_file: "ask", other: "ask" }).kind).toBe("edit");
    expect(readFileSync(file, "utf8")).toBe(`{\n  "edit": "allow",\n  "write_file": "ask",\n  "other": "ask"\n}`);
    const made = writeToolset(paths, "feature/plans/reads", "base", { read_file: "allow", other: "deny" });
    expect(made.kind).toBe("create");
    expect(existsSync(join(home, "toolsets/feature/plans/reads.json"))).toBe(true);
  });

  it("writes nothing into what ships, for an id that climbs, a YAML file, or a map that is not a toolset", () => {
    const before = readFileSync(join(builtIn, "toolsets/chat/read-only.json"), "utf8");
    expect(() => writeToolset(paths, "chat/read-only", "system", SHIPPED)).toThrow(/read-only/);
    expect(() => writeToolset(paths, "../escape", "project", SHIPPED)).toThrow();
    expect(() => writeToolset(paths, "chat/x", "project", { read_file: "sometimes" } as never)).toThrow(/not a toolset/);
    write(paths.jairaDir, "toolsets/chat/yam.yaml", "read_file: allow\n");
    expect(() => writeToolset(paths, "chat/yam", "project", { read_file: "ask" })).toThrow(/YAML/);
    expect(readFileSync(join(builtIn, "toolsets/chat/read-only.json"), "utf8")).toBe(before);
    expect(existsSync(join(scratch, "escape.json"))).toBe(false);
  });
});

describe("resetToolset", () => {
  it("deletes the override, so the layer below answers again", () => {
    const made = writeToolset(paths, "chat/read-only", "project", { ...SHIPPED, bash: "ask" });
    expect(resetToolset(paths, "chat/read-only", "project").file).toBe(made.file);
    expect(existsSync(made.file)).toBe(false);
    expect(winner("chat/read-only")).toEqual(SHIPPED);
  });

  it("refuses what is not an override: nothing below it, not held here, or what ships", () => {
    const file = write(paths.jairaDir, "toolsets/feature/writes.json", { edit: "ask" });
    expect(() => resetToolset(paths, "feature/writes", "project")).toThrow(/overrides nothing/);
    expect(existsSync(file)).toBe(true);
    expect(() => resetToolset(paths, "chat/read-only", "base")).toThrow(/not overridden/);
    expect(() => resetToolset(paths, "chat/read-only", "system")).toThrow(/read-only/);
  });
});

describe("toolsetUsers", () => {
  it("finds a bare reference, a $ref with overrides, an explicit root and a per-mount environment — first layer's copy of a state only", () => {
    write(paths.workflowsDir, "sync/review.json", { environment: { tools: "$/toolsets/chat/read-only" } });
    write(paths.workflowsDir, "feature/plan.json", { operation: { kind: "prompt", tools: { $ref: "$/toolsets/chat/read-only", edit: "ask" } } });
    write(paths.workflowsDir, "feature.json", { children: { build: { state: "feature/build", environment: { tools: "$SYSTEM/toolsets/chat/full.json" } } } });
    write(paths.workflowsDir, "legacy.json", { environment: { tools: ["read_file"] } });
    write(paths.workflowsDir, "broken.json", "{ nope");
    // Shadowed by the project's own copy of the same state, so it is not what runs.
    write(join(home, "workflows"), "sync/review.json", { environment: { tools: "$/toolsets/chat/full" } });
    write(join(home, "workflows"), "shared/only.json", { environment: { tools: "$/toolsets/chat/full" } });
    expect(toolsetUsers(paths)).toEqual({
      "chat/read-only": ["feature/plan", "sync/review"],
      "chat/full": ["feature", "shared/only"],
    });
  });
});
