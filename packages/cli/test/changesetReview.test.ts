/**
 * `jaira changeset review` (CHANGESETS.md §8.4's command): the worktree's edits against a base, one
 * changeset, the same five decisions — scripted here, because the terminal dialogue itself is
 * covered by changesetReviewer.test.ts and what this proves is the command's plumbing: produce,
 * review, APPLY into the same worktree.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git, NodeExec } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(async () => {
  dir = makePlanningProject();
  const git = new Git({ exec: new NodeExec(), repoDir: dir });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "t@example.com"]);
  await git.run(["config", "user.name", "T"]);
  writeFileSync(join(dir, "notes.md"), "committed\n", "utf8");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "base"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(): CliIo & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t), out: () => out, err: () => err };
}

describe("jaira changeset review", () => {
  it("reviews the checkout's uncommitted edits and applies the decisions", async () => {
    writeFileSync(join(dir, "notes.md"), "the agent's version\n", "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "new.md"), "brand new\n", "utf8");

    const cli = io();
    const code = await runCli(["--home", testHome(),
        "changeset",
        "review",
        "--interactions",
        JSON.stringify({
          "review_artifacts": [
            { decisions: [
              { id: "c1", decision: "merged" },
              { id: "c2", decision: "reverted" },
            ] },
          ],
        }),
      ],
      cli,
    );
    expect(cli.err()).toBe("");
    expect(code).toBe(0);
    // c1 (notes.md) merged — stays the agent's; c2 (src/new.md, a create) reverted — removed.
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("the agent's version\n");
    expect(existsSync(join(dir, "src", "new.md"))).toBe(false);
    expect(cli.out()).toContain("reviewing 2 change(s)");
    expect(cli.out()).toContain('"status": "completed"');
  });

  it("says plainly when there is nothing to review", async () => {
    const cli = io();
    expect(await runCli(["--home", testHome(), "changeset", "review"], cli)).toBe(0);
    expect(cli.out()).toContain("nothing to review");
  });

  it("refuses headless with nothing to answer the gate, before any work", async () => {
    writeFileSync(join(dir, "notes.md"), "changed\n", "utf8");
    const cli = io();
    // vitest runs with no TTY, so the terminal reviewer is not registered and nothing was scripted.
    expect(await runCli(["--home", testHome(), "changeset", "review"], cli)).toBe(1);
    expect(cli.err()).toContain("nothing can answer the gate");
    // Refused before touching anything: the edit survives.
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("changed\n");
  });
});
