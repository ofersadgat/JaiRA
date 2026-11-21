/**
 * A folder with no git remote taken into a project (`project:join`; the person, 2026-11-21: "if a
 * project folder doesnt have a git connection and you try to add it to a project, ask the user what to
 * do (e.g. add it without git, add git connection, cancel)"). Either answer leaves the folder grouped
 * with the project's other workspaces: `git` by its new remote, `plain` by what the engine keeps.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

const ID = "github.com/acme/atlas";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

let root: string;
let home: string;
let service: AppService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jaira-join-"));
  home = testHome();
  service = new AppService({ baseDir: home, publish: () => undefined, watchWorkflows: false });
});

afterEach(async () => {
  await service.close();
  rmSync(root, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), "hi\n");
  return dir;
}

describe("joinProject", () => {
  it("connects a plain folder to the project's remote: git init, then origin", async () => {
    const dir = folder("scratch");
    expect(service.joinProject({ dir, identity: ID, how: "git" })).toEqual({ identity: ID, remote: `https://${ID}.git` });
    expect(git(dir, "config", "--get", "remote.origin.url")).toBe(`https://${ID}.git`);
    initProject(dir);
    await service.open(dir);
    expect(service.listProjects().find((p) => p.project === dir)?.identity).toBe(ID);
  });

  it("takes the remote a workspace of the project here already has", async () => {
    const atlas = folder("atlas");
    git(atlas, "init", "-q");
    git(atlas, "remote", "add", "origin", "git@github.com:acme/atlas.git");
    initProject(atlas);
    await service.open(atlas);
    const dir = folder("scratch");
    git(dir, "init", "-q");
    expect(service.joinProject({ dir, identity: ID, how: "git" }).remote).toBe("git@github.com:acme/atlas.git");
    expect(git(dir, "config", "--get", "remote.origin.url")).toBe("git@github.com:acme/atlas.git");
  });

  it("adds a folder without git: the engine keeps it as the project's, across a restart", async () => {
    const dir = folder("plain");
    expect(service.joinProject({ dir, identity: ID, how: "plain" })).toEqual({ identity: ID });
    initProject(dir);
    await service.open(dir);
    expect(service.listProjects().find((p) => p.project === dir)?.identity).toBe(ID);
    expect((await service.browseDirectory(root)).entries.find((e) => e.path === dir)?.identity).toBe(ID);
    await service.close();
    service = new AppService({ baseDir: home, publish: () => undefined, watchWorkflows: false });
    await service.open(dir);
    expect(service.listProjects().find((p) => p.project === dir)?.identity).toBe(ID);
  });

  it("takes a folder inside another repository's checkout without git as the project's, not that repository's", async () => {
    const outer = folder("outer");
    git(outer, "init", "-q");
    git(outer, "remote", "add", "origin", "https://gitlab.com/acme/outer.git");
    const dir = folder("outer/scratch");
    expect(service.joinProject({ dir, identity: ID, how: "plain" })).toEqual({ identity: ID });
    initProject(dir);
    await service.open(dir);
    expect(service.listProjects().find((p) => p.project === dir)?.identity).toBe(ID);
  });

  it("refuses a folder that is already another repository", () => {
    const dir = folder("fork");
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/someone/atlas.git");
    expect(() => service.joinProject({ dir, identity: ID, how: "plain" })).toThrow(/already github.com\/someone\/atlas/);
  });
});

describe("the folders lately chosen", () => {
  it("are kept per machine in the layout: strings only, each once, six at most", async () => {
    const { parseUiState } = await import("@jaira/shared");
    expect(parseUiState({ recentFolders: { m: ["/a", "/a", 3, "/b", "/c", "/d", "/e", "/f", "/g"], n: "x", o: [] } }).recentFolders).toEqual({ m: ["/a", "/b", "/c", "/d", "/e", "/f"] });
    expect(parseUiState({}).recentFolders).toBeUndefined();
  });
});
