/**
 * `allowsCall` — would a permission set let a call run with nobody asked — held against the SHIPPED
 * `chat/read-only`, which is what the work summary judges a change by (`workSummary.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePermissionSet } from "@jaira/shared";
import { allowsCall } from "../src/policy";
import type { PackageInfo, PackageReader } from "../src/packageScripts";

const READ_ONLY = parsePermissionSet(JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/builtin/permission-sets/chat/read-only.json", import.meta.url)), "utf8")) as unknown).permissionSet;
/**
 * A workspace project at `/repo`: the root's own scripts, and two workspaces — `@app/cli`, whose
 * scripts only read (and whose build writes), and `@app/web`, whose lint fixes.
 */
const PACKAGES: PackageInfo[] = [
  {
    dir: "/repo",
    name: "repo",
    workspaces: ["packages/*"],
    scripts: {
      test: "vitest run",
      pretest: "tsc --noEmit",
      lint: "eslint .",
      "lint:fix": "eslint --fix .",
      typecheck: "tsc --noEmit -p .",
      build: "tsc -b",
      check: "npm run lint && npm run typecheck",
      "check:cli": "npm -w @app/cli run lint",
    },
  },
  { dir: "/repo/packages/cli", name: "@app/cli", scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc -b" } },
  { dir: "/repo/packages/web", name: "@app/web", scripts: { test: "vitest run", lint: "eslint --fix ." } },
];
/** The table as a reader: a package by its directory; a root's workspaces, every package under it. */
const TABLE: PackageReader = {
  at: (dir) => PACKAGES.find((pkg) => pkg.dir === dir.replace(/\\/g, "/")),
  workspacesOf: (root) => PACKAGES.filter((pkg) => pkg.dir.startsWith(`${root.dir}/`)),
};
const allows = (name: string, args: unknown): boolean | undefined => allowsCall({}, READ_ONLY, name, args, "posix", { root: "/repo", packages: TABLE });
const bash = (command: string): boolean | undefined => allows("Bash", { command });

describe("what the shipped chat/read-only lets through", () => {
  it("judges an agent's built-ins as the standard tools they are, and JaiRA's own over the bridge", () => {
    expect(allows("Read", { file_path: "a.ts" })).toBe(true);
    expect(allows("Grep", { pattern: "x" })).toBe(true);
    expect(allows("Edit", { file_path: "a.ts" })).toBe(false);
    expect(allows("Write", { file_path: "a.ts" })).toBe(false);
    expect(allows("mcp__dai__read_file", { path: "a.ts" })).toBe(true);
    expect(allows("mcp__dai__git_push", {})).toBe(false);
    // A sub-agent can do anything: it is `other`, which read-only refuses.
    expect(allows("Agent", { prompt: "look" })).toBe(false);
    // Another server's tool falls to its lines, and then to `other`.
    expect(allows("mcp__linear__list_issues", {})).toBe(false);
    // Nothing holds an agent's bookkeeping.
    expect(allows("TodoWrite", { todos: [] })).toBeUndefined();
  });

  it("lets the commands that only read through, and nothing that writes", () => {
    for (const line of ["git status", "git diff HEAD~1", "git log --oneline -n 5", "git show HEAD:a.ts", "cat a.ts | wc -l", "npx vitest run a.test.ts", "tsc --noEmit -p .", "git grep -c TODO", "git log -c"]) {
      expect(bash(line), line).toBe(true);
    }
    for (const line of ["git push", "git commit -m x", "rm a.ts", "npm install", "vitest run -u", "eslint --fix .", "prettier --check --write .", "tsc -p ."]) {
      expect(bash(line), line).toBe(false);
    }
  });

  it("refuses the ways a reading command can be made to run or write something", () => {
    for (const line of ["git diff --output=a.patch", "git diff --ext-diff", "git -c diff.external=./x diff", "git --config-env=diff.external=X diff", "git --exec-path=/tmp status", "git grep -Ovim x", "GIT_EXTERNAL_DIFF=./x git diff", "export PATH=/tmp/x; git status", "sort -o out.txt in.txt"]) {
      expect(bash(line), line).toBe(false);
    }
  });

  it("judges a package script by the lines it runs — its pre and post scripts, and what is passed on to it", () => {
    for (const line of ["npm test", "npm t", "npm run lint", "npm run check", "pnpm typecheck", "yarn lint", "npm run lint -- --max-warnings 0", "CI=1 npm test"]) {
      expect(bash(line), line).toBe(true);
    }
    // A script that writes; a word passed on that makes it write; a flag of npm's own; a script there is none of.
    for (const line of ["npm run lint:fix", "npm run build", "npm test -- -u", "pnpm test -u", "npm run --script-shell=./x test", "npm run nothing"]) {
      expect(bash(line), line).toBe(false);
    }
    // With no package to read, a named script is `script`, which read-only does not name.
    expect(allowsCall({}, READ_ONLY, "Bash", { command: "npm test" }, "posix")).toBe(false);
  });

  it("follows npm's workspaces — by name, by path, a folder of them, all of them, and from inside one", () => {
    const at = (command: string, cwd = "/repo"): boolean | undefined => allows("Bash", { command, cwd });
    for (const line of ["npm -w @app/cli test", "npm run test -w packages/cli", "npm run lint --workspace=@app/cli", "npm -w packages test", "npm -ws run test", "npm test --workspaces --include-workspace-root", "npm -ws --if-present run typecheck", "npm --prefix packages/cli run lint", "npm run check:cli"]) {
      expect(at(line), line).toBe(true);
    }
    // A workspace whose script writes; one of several that does; a name no workspace has; a workspace
    // without the script and no --if-present, where npm fails.
    for (const line of ["npm -w @app/cli run build", "npm -ws run lint", "npm -w packages run lint", "npm -w @app/nope test", "npm -ws run typecheck", "npm run lint --workspace @app/web"]) {
      expect(at(line), line).toBe(false);
    }
    // From inside a workspace, `npm run` is that workspace's script, and `-w` still picks from the root.
    expect(at("npm run lint", "/repo/packages/web")).toBe(false);
    expect(at("npm run lint", "/repo/packages/cli")).toBe(true);
    expect(at("npm -w @app/cli run lint", "/repo/packages/web")).toBe(true);
  });

  it("follows pnpm's workspaces — --filter by name, name glob, path and exclusion, -r, -w, -C", () => {
    const at = (command: string, cwd = "/repo"): boolean | undefined => allows("Bash", { command, cwd });
    for (const line of [
      "pnpm --filter @app/cli lint",
      "pnpm -F @app/cli run typecheck",
      // pnpm options come before the script's name; after it they are the script's.
      "pnpm --filter ./packages/cli --if-present run build:none",
      "pnpm --filter {packages/cli} lint",
      "pnpm --filter '@app/*' test",
      "pnpm -r test",
      "pnpm -r --filter '!@app/web' lint",
      "pnpm --filter '!@app/web' lint",
      "pnpm -w lint",
      "pnpm -C packages/cli lint",
      "pnpm -r --workspace-concurrency 2 test",
    ]) {
      expect(at(line), line).toBe(true);
    }
    // A workspace whose script writes, among those picked; one picked by what it depends on, which is not read.
    for (const line of ["pnpm -r lint", "pnpm --filter '@app/*' lint", "pnpm --filter @app/web lint", "pnpm --filter ./packages lint", "pnpm --filter @app/cli... test", "pnpm --filter ...^@app/cli test", "pnpm --filter '[origin/main]' test", "pnpm --filter @app/cli build", "pnpm -w build", "pnpm --filter @app/nope test", "pnpm --filter ./packages/cli build:none --if-present"]) {
      expect(at(line), line).toBe(false);
    }
    // pnpm passes over the workspaces without the script when several are picked — none of them runs anything.
    expect(at("pnpm -r typecheck")).toBe(true);
  });

  it("follows yarn's workspaces — workspace <name>, workspaces run, workspaces foreach", () => {
    const at = (command: string, cwd = "/repo"): boolean | undefined => allows("Bash", { command, cwd });
    for (const line of [
      "yarn workspace @app/cli lint",
      "yarn workspace @app/cli run test --reporter dot",
      "yarn workspaces run test",
      "yarn workspaces foreach -A run test",
      "yarn workspaces foreach --all --parallel --topological run test",
      "yarn workspaces foreach -A --include '@app/cli' run lint",
      "yarn workspaces foreach -A --exclude '@app/web' run lint",
      "yarn workspaces foreach -A run typecheck",
      "yarn --cwd packages/cli lint",
    ]) {
      expect(at(line), line).toBe(true);
    }
    for (const line of [
      "yarn workspace @app/web lint",
      "yarn workspace @app/cli build",
      "yarn workspace @app/cli test -u",
      "yarn workspaces foreach -A run lint",
      "yarn workspaces run lint",
      // Classic fails on a workspace without the script, so what it ran first is not guessed.
      "yarn workspaces run typecheck",
      "yarn workspaces foreach --since run test",
      "yarn workspace @app/nope test",
      "yarn workspaces foreach -A exec rm -rf dist",
    ]) {
      expect(at(line), line).toBe(false);
    }
  });

  it("passes the command runners through and judges what they run; refuses sudo and its kind without looking", () => {
    for (const line of [`bash -c "git status"`, "env CI=1 git log", "timeout 60 npx vitest run", `sh -c "npm run lint -w @app/cli"`]) {
      expect(bash(line), line).toBe(true);
    }
    for (const line of ["sudo git status", "ssh host ls", "docker exec web cat /etc/hosts", `bash -c "rm -rf dist"`, "npm install", "cargo run", "just build"]) {
      expect(bash(line), line).toBe(false);
    }
  });

  it("reads codex's argv as the line a shell would run", () => {
    expect(allows("shell", { command: ["bash", "-lc", "git status"] })).toBe(true);
    expect(allows("shell", { command: ["bash", "-lc", "git push"] })).toBe(false);
  });
});
