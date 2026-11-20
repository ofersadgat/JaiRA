/**
 * Making a workspace folder with real git in temporary folders: a clone, a copy of a checkout as it is
 * (its unpushed commit, staged and unstaged changes and new files — and nothing git ignores), a copy of
 * a checkout with no remote, and the ignored files Bring carries.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExec } from "../src/exec";
import type { RemoteRoute } from "../src/sshAccess";
import { checkoutState, cloneRepository, collectIgnored, packCheckout, patternTest, unpackCheckout, writeFiles } from "../src/workspaceMake";

const exec = new NodeExec();
const made: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-make-"));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

/** A bare "forge" repository with one commit on main, and a working clone of it. */
function forgeAndClone(): { bare: string; work: string } {
  const root = scratch();
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n.env*.local\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  const bare = join(root, "forge.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const work = join(root, "work");
  git(root, "clone", "-q", bare, work);
  return { bare, work };
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("making a workspace from a forge", () => {
  it("clones into a new folder and refuses one that is not empty", async () => {
    const { bare } = forgeAndClone();
    const target = join(scratch(), "nested", "atlas");
    const said: string[] = [];
    await cloneRepository({ url: bare, dir: target, branch: "main" }, { exec, onOutput: (t) => said.push(t) });
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\n");
    expect(said.join("")).toContain("git clone --branch main");
    await expect(cloneRepository({ url: bare, dir: target }, { exec })).rejects.toThrow(/not empty/);
  });
});

describe("copying a checkout as it is", () => {
  it("brings the unpushed commit, staged and unstaged changes and new files — and nothing git ignores", async () => {
    const { work } = forgeAndClone();
    git(work, "checkout", "-q", "-b", "feature/maps");
    writeFileSync(join(work, "maps.ts"), "export const x = 1;\n");
    git(work, "add", "maps.ts");
    git(work, "commit", "-q", "-m", "maps");
    writeFileSync(join(work, "README.md"), "hello\nstaged\n");
    git(work, "add", "README.md");
    writeFileSync(join(work, "README.md"), "hello\nstaged\nunstaged\n");
    writeFileSync(join(work, "notes.txt"), "new\n");
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "node_modules", "big.js"), "x");
    writeFileSync(join(work, ".env.local"), "SECRET=1\n");

    const state = await checkoutState(work, { exec });
    expect(state).toMatchObject({ branch: "feature/maps", ahead: 1, changed: 1, untracked: 1, remoteName: "origin" });

    const pack = await packCheckout(work, { exec });
    expect(pack.bundle).toBeDefined();
    expect(pack.untracked.map((f) => f.path)).toEqual(["notes.txt"]);
    const target = join(scratch(), "atlas-1");
    await unpackCheckout(JSON.parse(JSON.stringify(pack)), target, { exec });

    expect(git(target, "rev-parse", "HEAD")).toBe(state.head);
    expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe("feature/maps");
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\nstaged\nunstaged\n");
    expect(git(target, "diff", "--cached", "--name-only")).toBe("README.md");
    expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, ".env.local"))).toBe(false);
    expect(git(target, "remote", "get-url", "origin")).toBe(git(work, "remote", "get-url", "origin"));
  });

  it("copies a checkout with no remote whole, from its own commits", async () => {
    const dir = scratch();
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "a");
    const pack = await packCheckout(dir, { exec });
    expect(pack.bundleAll).toBe(true);
    const target = join(scratch(), "copy");
    await unpackCheckout(pack, target, { exec });
    expect(git(target, "remote")).toBe("");
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("a\n");
  });
});

describe("a copy whose source names its remote in a way this machine cannot use", () => {
  /** A ladder that hands out these routes in order, recording each failure it was told about. */
  function ladderOf(...routes: (RemoteRoute | undefined)[]): { told: string[]; routes: (remote: string) => { next(failure: string): Promise<RemoteRoute | undefined> } } {
    const told: string[] = [];
    return { told, routes: () => ({ next: (failure) => (told.push(failure), Promise.resolve(routes.shift())) }) };
  }

  // Opening a Mac's checkout on Windows cloned `git@gitlab.com:org/repo.git` there, and Windows had
  // never trusted gitlab.com's host key: "Cloning failed: and the repository exists."
  it("walks the routes it is given until one clones, and keeps that one's remote and config in the copy", async () => {
    const { bare, work } = forgeAndClone();
    writeFileSync(join(work, "notes.txt"), "new\n");
    const pack = await packCheckout(work, { exec });
    const unreachable = join(scratch(), "only-on-the-source.git");
    pack.state.remote = unreachable;
    const ladder = ladderOf({ url: join(scratch(), "nor-this.git"), how: "a second way" }, { url: bare, how: "a third way", config: { "core.sshCommand": "ssh -i key" } });
    const said: string[] = [];
    const target = join(scratch(), "copy");
    await unpackCheckout(pack, target, { exec, onOutput: (t) => said.push(t), routes: ladder.routes });
    expect(ladder.told).toHaveLength(2);
    expect(git(target, "remote", "get-url", "origin")).toBe(bare);
    expect(git(target, "config", "core.sshCommand")).toBe("ssh -i key");
    expect(git(target, "rev-parse", "HEAD")).toBe(pack.state.head);
    expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe("new\n");
    expect(said.join("")).toContain(`${unreachable} cannot be reached from this machine as the source names it`);
    expect(said.join("")).toContain(`Cloning ${bare} a third way instead.`);
  });

  it("says every reason when no route clones, and the first alone when there is no other route", async () => {
    const { work } = forgeAndClone();
    const pack = await packCheckout(work, { exec });
    pack.state.remote = join(scratch(), "gone.git");
    const second = join(scratch(), "also-gone.git");
    const failed = unpackCheckout(pack, join(scratch(), "copy"), { exec, routes: ladderOf({ url: second, how: "a second way" }).routes });
    await expect(failed).rejects.toThrow(/^Cloning failed: .*gone\.git.* a second way failed too: /);
    await expect(unpackCheckout(pack, join(scratch(), "copy"), { exec, routes: ladderOf().routes })).rejects.toThrow(/^Cloning failed: (?!.*failed too)/);
  });
});

describe("bringing files git ignores", () => {
  it("reads the ignored files the patterns name, and writes them under a new folder", async () => {
    const { work } = forgeAndClone();
    writeFileSync(join(work, ".env.local"), "A=1\n");
    writeFileSync(join(work, ".env.development.local"), "B=2\n");
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "node_modules", ".env.local"), "no\n");
    const files = await collectIgnored(work, [".env*.local"], { exec });
    expect(files.map((f) => f.path)).toEqual([".env.development.local", ".env.local"]);
    const target = scratch();
    await writeFiles(target, files);
    expect(readFileSync(join(target, ".env.local"), "utf8")).toBe("A=1\n");
    await expect(writeFiles(target, [{ path: "../escape", data: "", mode: 0o644 }])).rejects.toThrow(/outside/);
  });

  it("matches patterns the way .gitignore does", () => {
    expect(patternTest(".env*.local")("apps/web/.env.local")).toBe(true);
    expect(patternTest("/config/*.json")("config/a.json")).toBe(true);
    expect(patternTest("/config/*.json")("x/config/a.json")).toBe(false);
    expect(patternTest("secrets/**")("secrets/a/b.pem")).toBe(true);
  });
});
