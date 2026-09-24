/**
 * A layer's `toolsets/` becomes `permission-sets/`, and every reference to it follows (the person's
 * ruling, 2026-09-23: "rename everywhere"). Moved whole or file by file, never over a file already at
 * the new place; the references in workflows and settings rewritten; the originals kept; and a second
 * open finds nothing to do. The open runs it before the settings migration, which reads the new place.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths, setBuiltInDir, type JairaPaths } from "@jaira/shared";
import { initProject, openProject } from "../src/project";
import { renamePermissionSetLayers } from "../src/permissionSetRename";

let scratch: string;
let home: string;
let projectDir: string;
let paths: JairaPaths;

const write = (root: string, file: string, doc: unknown): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
};
const read = (root: string, file: string): string => readFileSync(join(root, file), "utf8");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-permission-set-rename-"));
  const builtIn = join(scratch, "builtin");
  home = join(scratch, "home");
  projectDir = join(scratch, "project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(builtIn, { recursive: true });
  setBuiltInDir(builtIn);
  initProject(projectDir, home);
  paths = jairaPaths(projectDir, home, builtIn);
});

afterEach(() => {
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

describe("renaming toolsets/ to permission-sets/", () => {
  it("moves the directory whole, and rewrites every reference to it in the layer's own files", () => {
    write(home, "toolsets/feature/build.json", { read_file: "allow", bash: "ask" });
    write(home, "workflows/feature/plan.json", { tools: "$/toolsets/feature/build", prompt: "see $BASE/toolsets/feature/build" });
    write(paths.jairaDir, "workflows/local.yaml", "tools: $SYSTEM/toolsets/chat/read-only\n");

    const reports = renamePermissionSetLayers(paths);

    expect(existsSync(join(home, "toolsets"))).toBe(false);
    expect(JSON.parse(read(home, "permission-sets/feature/build.json"))).toEqual({ read_file: "allow", bash: "ask" });
    expect(JSON.parse(read(home, "workflows/feature/plan.json"))).toEqual({
      tools: "$/permission-sets/feature/build",
      prompt: "see $BASE/permission-sets/feature/build",
    });
    expect(read(paths.jairaDir, "workflows/local.yaml")).toBe("tools: $SYSTEM/permission-sets/chat/read-only\n");
    // the originals, and what was done, are kept
    const shared = reports.find((r) => r.root === home)!;
    expect(shared.lines.join("\n")).toMatch(/toolsets\/ became permission-sets\//);
    expect(readdirSync(shared.keptAt!)).toContain("report.txt");
    expect(JSON.parse(readFileSync(join(shared.keptAt!, "originals", "workflows", "feature", "plan.json"), "utf8")).tools).toBe("$/toolsets/feature/build");
  });

  it("moves file by file into a permission-sets/ that exists, and never over a file already there", () => {
    write(home, "toolsets/chat/mine.json", { bash: "deny" });
    write(home, "toolsets/chat/clash.json", { bash: "deny" });
    write(home, "permission-sets/chat/clash.json", { bash: "allow" });

    const [report] = renamePermissionSetLayers(paths);

    expect(JSON.parse(read(home, "permission-sets/chat/mine.json"))).toEqual({ bash: "deny" });
    expect(JSON.parse(read(home, "permission-sets/chat/clash.json"))).toEqual({ bash: "allow" });
    expect(JSON.parse(read(home, "toolsets/chat/clash.json"))).toEqual({ bash: "deny" });
    expect(report!.lines.join("\n")).toMatch(/clash\.json was NOT moved/);
  });

  it("does nothing where there is nothing to move, so a second open writes nothing", () => {
    write(home, "toolsets/feature/build.json", { bash: "ask" });
    expect(renamePermissionSetLayers(paths)).toHaveLength(1);
    expect(renamePermissionSetLayers(paths)).toEqual([]);
  });

  it("runs when a project opens, before its settings are read", () => {
    write(paths.jairaDir, "toolsets/feature/build.json", { read_file: "allow", bash: "ask" });
    write(paths.jairaDir, "workflows/plan.json", { tools: "$/toolsets/feature/build" });
    const project = openProject(projectDir, { baseDir: home });
    try {
      expect(existsSync(join(paths.jairaDir, "permission-sets", "feature", "build.json"))).toBe(true);
      expect(JSON.parse(read(paths.jairaDir, "workflows/plan.json")).tools).toBe("$/permission-sets/feature/build");
    } finally {
      project.close();
    }
  });
});
