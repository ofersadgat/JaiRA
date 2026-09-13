/**
 * The two changeset producers and drift (CHANGESETS.md §1–§3), against a real repository — a
 * worktree diff is exactly the kind of thing a mock gets wrong, and the property under test is the
 * design's central one: both producers lower into ONE value, whose source is a pin and whose
 * content changes carry strategy-derived hunks.
 */
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChangesetSource } from "@jaira/shared";
import { NodeExec } from "../src/exec";
import { Git } from "../src/git";
import { changesetDrift, editsChangeset, worktreeChangeset } from "../src/changesets";

const exec = new NodeExec();
let dir: string;
let repo: string;
let git: Git;

const read = (path: string): string | undefined => {
  const file = join(repo, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-changesets-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git = new Git({ exec, repoDir: repo });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "JaiRA Test"]);
  mkdirSync(join(repo, "workflows"), { recursive: true });
  writeFileSync(join(repo, "workflows", "plan.json"), `{\n  "label": "Plan",\n  "operation": { "prompt": "old" }\n}\n`, "utf8");
  writeFileSync(join(repo, "notes.md"), "line one\nline two\n", "utf8");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "base"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("worktreeChangeset (§2's git: producer)", () => {
  it("pins the source to the base commit and reads before from it, after from the tree", async () => {
    const base = (await git.head())!;
    writeFileSync(join(repo, "workflows", "plan.json"), `{\n  "label": "Plan",\n  "operation": { "prompt": "new" }\n}\n`, "utf8");
    writeFileSync(join(repo, "brand-new.md"), "hello\n", "utf8");

    const changeset = await worktreeChangeset(git, base, read);
    expect(parseChangesetSource(changeset.source)).toEqual({ scheme: "git", rev: base });

    const plan = changeset.changes.find((c) => c.path === "workflows/plan.json")!;
    expect(plan.action).toBe("update");
    expect(plan.before).toContain(`"old"`);
    expect(plan.after).toContain(`"new"`);
    // A workflow state file goes through the STRUCTURAL strategy — pointer-labelled hunks (§7.2).
    expect(plan.hunks?.map((h) => h.label)).toEqual(["/operation/prompt"]);

    const created = changeset.changes.find((c) => c.path === "brand-new.md")!;
    expect(created.action).toBe("create");
    expect(created.after).toBe("hello\n");
    expect(created.before).toBeUndefined();
  });

  it("carries a binary file as an unshowable change — approvable, not readable (§1.1)", async () => {
    const base = (await git.head())!;
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 255]));
    const changeset = await worktreeChangeset(git, base, read);
    const blob = changeset.changes.find((c) => c.path === "blob.bin")!;
    expect(blob.unshowable).toBeDefined();
    expect(blob.after).toBeUndefined();
    expect(blob.hunks).toBeUndefined();
  });

  it("carries a mode flip as a change with modes — the applicable chmod (§1.1)", async () => {
    // `update-index --chmod` is how a mode flip is made on Windows, where the filesystem has no
    // executable bit to flip and git takes the mode from the index. On POSIX git reads the bit off
    // the file itself, so the file gets it too; `chmod` does nothing to it on Windows.
    await git.run(["update-index", "--chmod=+x", "notes.md"]);
    chmodSync(join(repo, "notes.md"), 0o755);
    const changeset = await worktreeChangeset(git, (await git.head())!, read);
    const flip = changeset.changes.find((c) => c.path === "notes.md")!;
    expect(flip.modes).toEqual({ before: "100644", after: "100755" });
    // Content unchanged: same bytes both sides, no hunks — the mode IS the change.
    expect(flip.before).toBe(flip.after);
    expect(flip.hunks).toEqual([]);
  });

  it("refuses a base that does not resolve — the source must be a pin, not a guess", async () => {
    await expect(worktreeChangeset(git, "deadbeef", read)).rejects.toThrow(/does not resolve/);
  });
});

describe("editsChangeset (§2's file:+hash producer)", () => {
  it("lowers whole-file proposals against the tree, hashing the before side", async () => {
    const changeset = await editsChangeset(
      repo,
      [
        { path: "workflows/plan.json", action: "update", text: `{\n  "label": "Plan",\n  "operation": { "prompt": "revised" }\n}\n`, reason: "closes R1" },
        { path: "workflows/next.json", action: "create", text: `{ "label": "Next" }\n` },
      ],
      read,
    );
    const source = parseChangesetSource(changeset.source);
    expect(source).toMatchObject({ scheme: "file" });
    expect((source as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/);

    const [next, plan] = changeset.changes; // sorted by path
    expect(next).toMatchObject({ path: "workflows/next.json", action: "create" });
    expect(plan).toMatchObject({ path: "workflows/plan.json", action: "update", reason: "closes R1" });
    expect(plan!.hunks?.map((h) => h.label)).toEqual(["/operation/prompt"]);
  });

  it("believes the tree over the claim: an 'update' of a missing file is a create", async () => {
    const changeset = await editsChangeset(repo, [{ path: "workflows/ghost.json", action: "update", text: "{}\n" }], read);
    expect(changeset.changes[0]?.action).toBe("create");
  });

  it("two runs over an unchanged tree hash identically; a moved tree hashes differently", async () => {
    const edits = [{ path: "notes.md", action: "update" as const, text: "line one\nCHANGED\n" }];
    const first = await editsChangeset(repo, edits, read);
    const second = await editsChangeset(repo, edits, read);
    expect(second.source).toBe(first.source);
    writeFileSync(join(repo, "notes.md"), "moved\n", "utf8");
    expect((await editsChangeset(repo, edits, read)).source).not.toBe(first.source);
  });
});

describe("changesetDrift (§3.2)", () => {
  it("answers a moved base with another changeset, chained by source — never a silent rebase", async () => {
    const base = (await git.head())!;
    writeFileSync(join(repo, "notes.md"), "line one\nline two\nproposal\n", "utf8");
    const pending = await worktreeChangeset(git, base, read);

    // Nothing moved yet.
    const readBase = async (path: string): Promise<string | undefined> => git.show(base, path);
    expect(await changesetDrift(pending, readBase)).toBeUndefined();

    // The base the pending changeset recorded no longer matches what a re-read finds.
    const drifted = await changesetDrift(pending, async () => "someone rewrote this\n");
    expect(drifted).toBeDefined();
    expect(drifted!.source).toBe(pending.source);
    expect(drifted!.changes[0]).toMatchObject({ path: "notes.md", action: "update" });
    expect(drifted!.changes[0]?.reason).toContain("moved");
  });

  it("under a PROPOSAL tree, drift means the files no longer hold what the reviewer was shown", async () => {
    const base = (await git.head())!;
    writeFileSync(join(repo, "notes.md"), "line one\nline two\nproposal\n", "utf8");
    const pending = await worktreeChangeset(git, base, read);

    // The worktree still holds the proposal: no drift for a proposal-state tree…
    expect(await changesetDrift(pending, read, "proposal")).toBeUndefined();
    // …but the same read IS drift under base semantics, because a worktree changeset's tree holds
    // the proposal, not the base — which is why the parameter exists.
    expect(await changesetDrift(pending, read, "base")).toBeDefined();

    // A third party moves the file past the proposal: drift either way, and the drift changeset
    // runs from what the REVIEWER saw to what is there now.
    writeFileSync(join(repo, "notes.md"), "someone else's edit\n", "utf8");
    const drifted = await changesetDrift(pending, read, "proposal");
    expect(drifted!.changes[0]).toMatchObject({ path: "notes.md", action: "update" });
    expect(drifted!.changes[0]?.before).toBe("line one\nline two\nproposal\n");
    expect(drifted!.changes[0]?.after).toBe("someone else's edit\n");
  });
});
