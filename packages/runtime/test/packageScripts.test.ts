/**
 * The packages on disk (`filePackages`): a root's `workspaces` patterns globbed as npm globs them, and
 * a script call resolved against a real workspace project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCallOf } from "../src/commandParts";
import { takeApart } from "../src/command";
import { expandWorkspaces, filePackages, makeDryRunLines, makefileRunsCodeWhenRead, scriptRunsOf } from "../src/packageScripts";

let root: string;
const write = (path: string, json: unknown): void => {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), JSON.stringify(json));
};
const names = (dirs: string[]): string[] => dirs.map((dir) => dir.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").length + 1));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jaira-workspaces-"));
  write(".", { name: "repo", workspaces: ["packages/*", "apps/**", "!packages/skip"], scripts: { lint: "eslint ." } });
  write("packages/a", { name: "@x/a", scripts: { lint: "eslint .", prelint: "tsc --noEmit" } });
  write("packages/b", { name: "@x/b", scripts: { test: "vitest run" } });
  write("packages/skip", { name: "@x/skip" });
  write("apps/web/site", { name: "site", scripts: { lint: "eslint --fix ." } });
  // Never a workspace: inside node_modules, or a folder with no package.json.
  write("packages/a/node_modules/dep", { name: "dep" });
  mkdirSync(join(root, "packages", "empty"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the packages on disk", () => {
  it("globs each pattern for the package.json under it, takes back what `!` names, and never enters node_modules", () => {
    expect(names(expandWorkspaces(root, ["packages/*", "apps/**", "!packages/skip"]))).toEqual(["apps/web/site", "packages/a", "packages/b"]);
    expect(filePackages.workspacesOf(filePackages.at(root)!).map((pkg) => pkg.name)).toEqual(["site", "@x/a", "@x/b"]);
  });

  it("resolves a script call to the workspaces it picks, each with its pre script, in its own directory", () => {
    const runs = scriptRunsOf(filePackages, { name: "lint", args: [], workspaces: { picked: [], all: true, root: false, excluded: [] }, ifPresent: true }, root)!;
    expect(runs.map((run) => [names([run.dir])[0], run.lines])).toEqual([
      ["apps/web/site", ["eslint --fix ."]],
      ["packages/a", ["tsc --noEmit", "eslint ."]],
    ]);
    // From inside a workspace, the nearest package; a name nobody has is not read.
    expect(scriptRunsOf(filePackages, { name: "test", args: ["-u"], ifPresent: false }, join(root, "packages", "b"))).toEqual([{ dir: join(root, "packages", "b"), lines: ["vitest run -u"] }]);
    expect(scriptRunsOf(filePackages, { name: "lint", args: [], workspaces: { picked: ["@x/none"], all: false, root: false, excluded: [] }, ifPresent: false }, root)).toBeUndefined();
  });

  it("reads a pnpm root's workspaces from pnpm-workspace.yaml, with no package.json beside it", () => {
    const pnpm = join(root, "mono");
    mkdirSync(pnpm, { recursive: true });
    writeFileSync(join(pnpm, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n  - '!libs/old'\n");
    write("mono/libs/core", { name: "@m/core", scripts: { lint: "eslint ." } });
    write("mono/libs/old", { name: "@m/old", scripts: { lint: "eslint --fix ." } });
    const found = filePackages.at(pnpm)!;
    expect(found.workspaces).toEqual(["libs/*", "!libs/old"]);
    expect(filePackages.workspacesOf(found).map((pkg) => pkg.name)).toEqual(["@m/core"]);
    // Picked by a glob of names, from inside a workspace: the root is found upward.
    const runs = scriptRunsOf(filePackages, { name: "lint", args: [], workspaces: { picked: ["@m/*"], all: false, root: false, excluded: [] }, ifPresent: true }, join(pnpm, "libs", "core"));
    expect(runs?.map((run) => run.lines)).toEqual([["eslint ."]]);
  });
});

describe("make's dry run", () => {
  it("does not dry-run a makefile whose reading runs code", () => {
    const safe = "CC := gcc\nall: build\n\t@echo building\n\tgcc -o app main.c\n# $(shell in a comment) is nothing\n";
    expect(makefileRunsCodeWhenRead(safe)).toBe(false);
    for (const bad of [
      "V := $(shell git describe)",
      "V != date",
      "all:\n\t+$(MAKE) -C sub",
      "all:\n\t$(MAKE) -C sub",
      "all:\n\t@+echo hi",
      "include deps.mk",
      "-include config.mk",
      "$(file >out.txt,hi)",
      "$(eval X := y)",
      "SHELL := /bin/zsh",
      "export SHELL = ./x",
    ]) {
      expect(makefileRunsCodeWhenRead(bad), bad).toBe(true);
    }
  });

  it("reads a dry run's output as the recipe lines it would run", () => {
    expect(makeDryRunLines("make: Entering directory\ngcc -o app \\\n  main.c\necho done\nmake: Leaving directory\n\n")).toEqual(["gcc -o app    main.c", "echo done"]);
  });

  it("reads make's own flags, and refuses the ones that change what runs", () => {
    const call = (line: string) => makeCallOf(takeApart(line).commands[0]!);
    expect(call("make -C sub -f build.mk -j 4 -s V=1 all test")).toEqual({ dir: "sub", makefile: "build.mk", args: ["V=1", "all", "test"], dryRun: false });
    expect(call("make -n check")).toEqual({ args: ["check"], dryRun: true });
    for (const line of ["make -t all", "make --eval=x all", "make SHELL=/bin/evil all", "make -f a.mk -f b.mk", "make -q all"]) {
      expect(call(line), line).toBeUndefined();
    }
  });
});
