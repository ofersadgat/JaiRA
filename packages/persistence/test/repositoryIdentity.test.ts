/**
 * A folder's repository identity (decision 0013 §4), read many at once for a folder listing (the person,
 * 2026-11-21): the same reading as one folder's — `upstream` over `origin` — so a folder listed groups
 * as it will once it is open.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readRepositoryIdentities, readRepositoryIdentity } from "../src/repositoryIdentity";

const root = mkdtempSync(join(tmpdir(), "jaira-identity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, remotes: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [remote, url] of Object.entries(remotes)) execFileSync("git", ["remote", "add", remote, url], { cwd: dir });
  return dir;
}

describe("many folders' repository identities", () => {
  it("reads each as one folder's is read, upstream over origin, nothing for none", async () => {
    const fork = repo("fork", { origin: "git@github.com:someone/jaira.git", upstream: "https://gitlab.com/mistlabs/jaira.git" });
    const plain = repo("plain", { origin: "ssh://git@gitlab.com/mistlabs/mist.git" });
    const bare = repo("bare", {});
    const notGit = join(root, "not-git");
    mkdirSync(notGit);
    const read = await readRepositoryIdentities([fork, plain, bare, notGit]);
    expect(Object.fromEntries(read)).toEqual({ [fork]: "gitlab.com/mistlabs/jaira", [plain]: "gitlab.com/mistlabs/mist", [bare]: undefined, [notGit]: undefined });
    for (const dir of [fork, plain, bare, notGit]) expect(readRepositoryIdentity(dir)).toBe(read.get(dir));
  });
});
