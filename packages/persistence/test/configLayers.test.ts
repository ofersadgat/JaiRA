/**
 * The configuration's layers on disk (2026-11-17): what ships, Shared, the project, this machine's own
 * (`machine-settings.json`), the project on this machine (`.jaira/settings.local.json`, which git
 * ignores), Just you, and you in the project (`projects/<key>/personal-settings.json`, keyed by the
 * repository) — merged in that order when a project opens, and the shared root standing as a project
 * reading each of its own files once.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths, personalProjectSettingsFile, projectSettingsKey } from "@jaira/shared";
import { ensureLocalSettingsIgnored, initProject, layerFilesOf, loadLayeredConfig, personalProjectSettingsFileOf, readRepositoryIdentity } from "../src/project";
import { ensureLocalLayerIgnored, fileLayerRoots, referenceRootPath } from "../src/fileLayers";

let dir: string;
let base: string;
const write = (file: string, doc: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc), "utf8");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-layers-project-"));
  base = mkdtempSync(join(tmpdir(), "jaira-layers-base-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("the layers a project is read with", () => {
  it("are merged least to most specific: person, then machine, then project", () => {
    const paths = initProject(dir, base);
    write(paths.base.settingsFile, { artifacts: { dir: "shared", inlineMaxBytes: 1 }, memo: { enabled: true } });
    write(paths.settingsFile, { artifacts: { dir: "project" } });
    write(paths.base.machineSettingsFile, { artifacts: { dir: "machine", inlineMaxBytes: 2 } });
    write(paths.localSettingsFile, { artifacts: { dir: "here" } });
    expect(loadLayeredConfig(paths).artifacts).toMatchObject({ dir: "here", inlineMaxBytes: 2 });
    write(paths.base.personalSettingsFile, { artifacts: { inlineMaxBytes: 3 } });
    write(personalProjectSettingsFileOf(paths), { artifacts: { dir: "mine here" } });
    const config = loadLayeredConfig(paths);
    expect(config.artifacts).toMatchObject({ dir: "mine here", inlineMaxBytes: 3 });
    expect(config.memo.enabled).toBe(true);
  });

  it("keys the person's settings for a project by its repository, the same for every clone", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:me/atlas.git"], { cwd: dir });
    const paths = initProject(dir, base);
    expect(readRepositoryIdentity(dir)).toBe("github.com/me/atlas");
    expect(personalProjectSettingsFileOf(paths)).toBe(personalProjectSettingsFile(paths.base, "github.com_me_atlas"));
    expect(personalProjectSettingsFileOf(paths)).toBe(join(base, "projects", "github.com_me_atlas", "personal-settings.json"));
    // A clone with no remote is a project of its own: its folder's name and where it is.
    expect(projectSettingsKey(undefined, "/work/notes")).toMatch(/^notes-[0-9a-f]{10}$/);
    expect(projectSettingsKey(undefined, "/work/notes")).not.toBe(projectSettingsKey(undefined, "/elsewhere/notes"));
  });

  it("reads the shared root's own files once when it stands as a project, and no project's for it", () => {
    const root = jairaPaths(dir, base);
    expect(layerFilesOf(root)).toContain(root.localSettingsFile);
    const files = layerFilesOf({ ...root, projectDir: base, settingsFile: root.base.settingsFile, localSettingsFile: root.base.machineSettingsFile });
    expect(new Set(files)).toEqual(new Set([root.builtIn.settingsFile, root.base.settingsFile, root.base.machineSettingsFile, root.base.personalSettingsFile]));
  });
});

describe("the project's settings on this machine", () => {
  it("are kept out of the repository by a new project's .gitignore, its permission sets under local/ with them", () => {
    const paths = initProject(dir, base);
    const lines = readFileSync(join(paths.jairaDir, ".gitignore"), "utf8").split("\n");
    expect(lines).toContain("settings.local.json");
    expect(lines).toContain("local/");
  });

  it("are added to an older .gitignore once, and nothing else in it moves", () => {
    const paths = initProject(dir, base);
    writeFileSync(join(paths.jairaDir, ".gitignore"), "system/jaira.db\n", "utf8");
    ensureLocalSettingsIgnored(paths.jairaDir);
    ensureLocalSettingsIgnored(paths.jairaDir);
    const lines = readFileSync(join(paths.jairaDir, ".gitignore"), "utf8").split("\n");
    expect(lines[0]).toBe("system/jaira.db");
    expect(lines.filter((line) => line === "settings.local.json")).toHaveLength(1);
    expect(lines.filter((line) => line === "local/")).toHaveLength(1);
    // One that ignores the folder its own way already is left as it is.
    writeFileSync(join(paths.jairaDir, ".gitignore"), "settings.local.json\n/local/**\n", "utf8");
    ensureLocalLayerIgnored(paths.jairaDir);
    expect(readFileSync(join(paths.jairaDir, ".gitignore"), "utf8")).toBe("settings.local.json\n/local/**\n");
  });
});

describe("the layers a permission set is found in (decision 0023, amended 2026-11-18)", () => {
  it("are the settings' six beside their settings, nearest first, and what ships", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/me/atlas"], { cwd: dir });
    const paths = initProject(dir, base);
    const roots = fileLayerRoots(paths);
    expect(roots.map((r) => [r.layer, r.token, r.label])).toEqual([
      ["projectYou", "$PROJECTYOU", "~/.jaira/projects/github.com_me_atlas"],
      ["you", "$YOU", "~/.jaira/personal"],
      ["projectMachine", "$PROJECTMACHINE", ".jaira/local"],
      ["machine", "$MACHINE", "~/.jaira/machine"],
      ["project", "$JAIRA", ".jaira"],
      ["base", "$BASE", "~/.jaira"],
      ["system", "$SYSTEM", "built in"],
    ]);
    // You in the project beside your settings for it; the project on this machine beside its settings.local.json.
    expect(roots[0]!.root).toBe(dirname(personalProjectSettingsFileOf(paths)));
    expect(roots[2]!.root).toBe(join(dirname(paths.localSettingsFile), "local"));
    // A `$` reference searches the four ahead of the project's own roots.
    expect(referenceRootPath(paths)).toEqual([...roots.slice(0, 4).map((r) => r.root), ...paths.roots]);
  });

  it("has none of a project's three for the shared root standing as a project", () => {
    const root = jairaPaths(dir, base);
    const asRoot = { ...root, projectDir: base, jairaDir: base, roots: [base, root.builtIn.dir] };
    expect(fileLayerRoots(asRoot).map((r) => r.layer)).toEqual(["you", "machine", "base", "system"]);
  });
});
