/**
 * A project's remotes (decision 0010 §2, "Which remotes") against a real repository in a temp
 * directory: read from its own `.git/config`, each mapped to its host, repository and connection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultIntegrations, parseIntegrations } from "@jaira/shared";
import { NodeExec } from "../src/exec";
import { Git } from "../src/git";
import { projectRemoteOf, projectRemotes } from "../src/gitRemotes";

const exec = new NodeExec();
let dir: string;
let git: Git;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-remotes-"));
  git = new Git({ exec, repoDir: dir });
  await git.run(["init", "--initial-branch=main"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("projectRemotes", () => {
  it("lists each remote on a forge in .git/config order, with its host, repository, provider and connection", async () => {
    await git.run(["remote", "add", "origin", "git@github.com:ofersadgat/JaiRA.git"]);
    await git.run(["remote", "add", "upstream", "https://gitlab.com/mistlabs/tools/jaira.git"]);
    await git.run(["remote", "add", "Work", "ssh://git@gitlab.com:2222/group/sub/project.git"]);
    await git.run(["remote", "add", "hub", "https://someone@github.com/other/repo"]);
    expect(await projectRemotes(git, defaultIntegrations())).toEqual([
      { name: "origin", url: "git@github.com:ofersadgat/JaiRA.git", host: "github.com", repository: "ofersadgat/JaiRA", provider: "github", connection: "github" },
      { name: "upstream", url: "https://gitlab.com/mistlabs/tools/jaira.git", host: "gitlab.com", repository: "mistlabs/tools/jaira", provider: "gitlab", connection: "gitlab" },
      // git prints a remote's name as it was written; an ssh port says nothing about the forge's API.
      { name: "Work", url: "ssh://git@gitlab.com:2222/group/sub/project.git", host: "gitlab.com", repository: "group/sub/project", provider: "gitlab", connection: "gitlab" },
      { name: "hub", url: "https://someone@github.com/other/repo", host: "github.com", repository: "other/repo", provider: "github", connection: "github" },
    ]);
  });

  it("leaves the connection out where the host picks none, and names the provider only where it is known", async () => {
    await git.run(["remote", "add", "origin", "git@github.com:ofersadgat/JaiRA.git"]);
    await git.run(["remote", "add", "work", "https://git.example.org:8443/team/app.git"]);
    const integrations = parseIntegrations({ forges: { github: { enabled: false } } });
    expect(await projectRemotes(git, integrations)).toEqual([
      // Its connection is switched off: still github, with nothing to watch it through.
      { name: "origin", url: "git@github.com:ofersadgat/JaiRA.git", host: "github.com", repository: "ofersadgat/JaiRA", provider: "github" },
      { name: "work", url: "https://git.example.org:8443/team/app.git", host: "git.example.org:8443", repository: "team/app" },
    ]);
    const withWork = parseIntegrations({ forges: { office: { provider: "gitlab", host: "git.example.org:8443", credential: "OFFICE_TOKEN" } } });
    expect((await projectRemotes(git, withWork))[1]).toEqual({
      name: "work",
      url: "https://git.example.org:8443/team/app.git",
      host: "git.example.org:8443",
      repository: "team/app",
      provider: "gitlab",
      connection: "office",
    });
  });

  it("reads the configured url, not the insteadOf rewrite, and leaves out a remote that is no forge", async () => {
    await git.run(["remote", "add", "origin", "https://github.com/ofersadgat/JaiRA.git"]);
    await git.run(["config", "url.git@mirror.example.org:.insteadOf", "https://github.com/"]);
    await git.run(["remote", "add", "local", join(dir, "..", "bare.git")]);
    await git.run(["remote", "add", "file", "file:///srv/git/bare.git"]);
    const remotes = await projectRemotes(git, defaultIntegrations());
    expect(remotes.map((r) => [r.name, r.host, r.repository])).toEqual([["origin", "github.com", "ofersadgat/JaiRA"]]);
  });

  it("is empty for a repository with no remotes, and outside a repository", async () => {
    expect(await projectRemotes(git, defaultIntegrations())).toEqual([]);
    const outside = mkdtempSync(join(tmpdir(), "jaira-remotes-none-"));
    try {
      expect(await projectRemotes(new Git({ exec, repoDir: outside }), defaultIntegrations())).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("maps one url without git", () => {
    expect(projectRemoteOf("origin", "C:\\repos\\bare.git", defaultIntegrations())).toBeUndefined();
    expect(projectRemoteOf("origin", "git@GitLab.com:a/b.git", defaultIntegrations())).toEqual({
      name: "origin",
      url: "git@GitLab.com:a/b.git",
      host: "gitlab.com",
      repository: "a/b",
      provider: "gitlab",
      connection: "gitlab",
    });
  });
});
