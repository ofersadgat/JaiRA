/**
 * The one-shot rewrite of `files.hidden` into what a layer ADDS (`hiddenMigration.ts`).
 *
 * The key kept its name and changed its meaning — a layer's list used to replace the one under it,
 * and now the layers concatenate — so what is worth holding down is that a rewritten list means what
 * the old one meant (the same paths hidden, checked by the matcher the tree uses), that it runs once
 * however many times a project is opened, and that a list already written as additions is left
 * alone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileHidden, DEFAULT_HIDDEN_PATHS, isHiddenPath, jairaPaths, type JairaPaths } from "@jaira/shared";
import { initProject, loadLayeredConfig } from "../src/project";
import { hiddenAdditionsOf, isReplacingHiddenList, migrateHiddenLists } from "../src/hiddenMigration";

/** The defaults as they stood when a list replaced them (with `**\/build`, without the personal file). */
const OLD = DEFAULT_HIDDEN_PATHS.filter((p) => p !== "personal-settings.json").concat("**/build");

/** Paths a tree could hold, to compare two rule lists by what they hide. */
const PROBES = [
  "system",
  "system/jaira.db",
  ".jaira/system",
  ".jaira/settings.json",
  "settings.json",
  "user-settings.json",
  "sync.json",
  ".env",
  "a/.env.local",
  ".git",
  "node_modules",
  "a/node_modules",
  "a/dist",
  "a/build",
  "a/out",
  "a/target",
  "a/vendor",
  "a/coverage",
  "a/__pycache__",
  "drafts",
  "drafts/keep",
  "drafts/keep/x",
  "src/index.ts",
];
const hiddenSet = (rules: readonly string[]): string[] => {
  const compiled = compileHidden(rules);
  return PROBES.filter((p) => isHiddenPath(p, compiled));
};

describe("which lists are in the old form", () => {
  it("takes a list that restates the defaults at its head", () => {
    expect(isReplacingHiddenList([...OLD, "drafts"])).toBe(true);
    // With some left out — the old way of switching one off.
    expect(isReplacingHiddenList(OLD.filter((p) => p !== "**/dist" && p !== "system"))).toBe(true);
  });

  it("takes an empty list, which used to mean show everything", () => {
    expect(isReplacingHiddenList([])).toBe(true);
  });

  it("leaves a list of additions alone — what a rewrite produces, and what the section writes", () => {
    expect(isReplacingHiddenList(["drafts"])).toBe(false);
    expect(isReplacingHiddenList(["!**/dist", "drafts"])).toBe(false);
    // Re-hiding one default is an addition, not a restatement of the list.
    expect(isReplacingHiddenList(["**/dist"])).toBe(false);
    // A `!` on a default says "written as additions", however many defaults follow.
    expect(isReplacingHiddenList(["!system", ...OLD])).toBe(false);
  });
});

describe("the rewrite", () => {
  it("drops the defaults a list restated and keeps what it added, in order", () => {
    expect(hiddenAdditionsOf([...OLD, "drafts", "!drafts/keep"], DEFAULT_HIDDEN_PATHS)).toEqual(["**/build", "drafts", "!drafts/keep"]);
  });

  it("switches off with a `!` every default the list left out", () => {
    const old = OLD.filter((p) => p !== "**/dist" && p !== ".git");
    const next = hiddenAdditionsOf(old, DEFAULT_HIDDEN_PATHS);
    // In the order the defaults are applied; `**/build` is no longer a default, so it is the list's own.
    expect(next).toEqual(["!.git", "!**/dist", "**/build"]);
    expect(hiddenSet([...DEFAULT_HIDDEN_PATHS, ...next])).toEqual(hiddenSet(old));
  });

  it("does not switch off a default the old list could not have known about", () => {
    const next = hiddenAdditionsOf(OLD, DEFAULT_HIDDEN_PATHS);
    expect(next).not.toContain("!personal-settings.json");
  });

  it("means what the old list meant, path for path", () => {
    for (const old of [
      [...OLD, "drafts", "!drafts/keep"],
      OLD.filter((p) => !p.startsWith("**/")),
      [],
      ["system", "!system/x", "drafts"],
    ]) {
      const next = hiddenAdditionsOf(old, DEFAULT_HIDDEN_PATHS);
      expect(hiddenSet([...DEFAULT_HIDDEN_PATHS, ...next])).toEqual(hiddenSet(old));
    }
  });

  it("rewrites a project's list against the shared root's, which is what it used to replace", () => {
    const base = ["drafts"];
    const old = [...OLD, "**/*.log"]; // the project did NOT hide drafts
    const next = hiddenAdditionsOf(old, [...DEFAULT_HIDDEN_PATHS, ...base]);
    expect(next).toEqual(["!drafts", "**/build", "**/*.log"]);
    expect(hiddenSet([...DEFAULT_HIDDEN_PATHS, ...base, ...next])).toEqual(hiddenSet(old));
  });
});

describe("at open", () => {
  let scratch: string;
  let home: string;
  let projectDir: string;
  let paths: JairaPaths;

  const write = (file: string, body: unknown): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  };
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "jaira-hidden-migration-"));
    home = join(scratch, "home");
    projectDir = join(scratch, "project");
    mkdirSync(projectDir, { recursive: true });
    initProject(projectDir, home);
    paths = jairaPaths(projectDir, home);
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("rewrites both layers, keeps the originals, and runs once", () => {
    write(paths.base.settingsFile, { files: { hidden: [...OLD.filter((p) => p !== "**/dist"), "drafts"] }, memo: { enabled: true } });
    write(paths.settingsFile, { files: { hidden: [...OLD, "**/*.log"] } });

    const reports = migrateHiddenLists(paths);
    expect(reports.map((r) => r.settingsFile)).toEqual([paths.base.settingsFile, paths.settingsFile]);
    expect(read(paths.base.settingsFile)).toEqual({ files: { hidden: ["!**/dist", "**/build", "drafts"] }, memo: { enabled: true } });
    // The project hid `**/dist` (which the base now switches off) and did not hide `drafts`: both are
    // said against the base; `**/build`, which the base now adds, it no longer needs to.
    expect(read(paths.settingsFile)).toEqual({ files: { hidden: ["!drafts", "**/dist", "**/*.log"] } });
    expect(existsSync(join(reports[0]!.keptAt, "settings.json"))).toBe(true);

    // The effective list is what the two old lists meant, one replacing the other.
    const hidden = loadLayeredConfig(paths).files.hidden ?? [];
    expect(hiddenSet([...DEFAULT_HIDDEN_PATHS, ...hidden])).toEqual(hiddenSet([...OLD, "**/*.log"]));

    // Idempotent: a second open finds nothing in the old form, and writes nothing.
    const before = [readFileSync(paths.base.settingsFile, "utf8"), readFileSync(paths.settingsFile, "utf8")];
    expect(migrateHiddenLists(paths)).toEqual([]);
    expect([readFileSync(paths.base.settingsFile, "utf8"), readFileSync(paths.settingsFile, "utf8")]).toEqual(before);
  });

  it("removes a list that turns out to add nothing, and the block with it", () => {
    write(paths.settingsFile, { files: { hidden: [...OLD.filter((p) => p !== "**/build")] } });
    migrateHiddenLists(paths);
    expect(read(paths.settingsFile)).toEqual({});
  });

  it("touches nothing when no layer has a list", () => {
    write(paths.settingsFile, { memo: { enabled: true } });
    expect(migrateHiddenLists(paths)).toEqual([]);
    const logs = join(paths.systemDir, "logs");
    expect(existsSync(logs) && readdirSync(logs).some((name) => name.startsWith("hidden-migration-"))).toBe(false);
  });
});
