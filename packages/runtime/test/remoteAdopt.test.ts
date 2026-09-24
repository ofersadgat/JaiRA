/**
 * After a remote merge, the forge's history is the history (decision 0004).
 *
 * Real git, local only: the "forge" is a bare repository in a temp directory, and the reviewer who
 * merges there is a second clone of it. What is pinned is the ORDER the decision lists and its two
 * refusals — "drop" never destroys the only copy of anything, and a branch the person owns is
 * fast-forwarded or left alone, never merged or rebased.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIntegrations } from "@jaira/shared";
import { NodeExec } from "../src/exec";
import { RemotePrimitives } from "../src/remote";
import { SecretResolver } from "../src/secrets";
import { replayForge } from "./forgeReplay";
import { buildRig, MemoryHandles, type Rig } from "./remoteRig";

vi.setConfig({ testTimeout: 60_000 });

let rig: Rig;
let handles: MemoryHandles;
let primitives: RemotePrimitives;
const REVIEW = "jaira/t-1/review";

beforeEach(async () => {
  rig = buildRig();
  handles = new MemoryHandles();
  primitives = new RemotePrimitives({
    taskId: "t-1",
    taskTitle: "Review the implementation",
    baseBranch: "main",
    workspaceRoot: rig.work,
    scratchDir: join(rig.root, "scratch"),
    handles,
    integrations: parseIntegrations(undefined),
    publish: "allow",
    secrets: new SecretResolver({ env: { GITLAB_TOKEN: "good" } }),
    exec: new NodeExec(),
    http: replayForge().http,
  });
  await primitives.push({}, { workspace: { root: rig.work } });
});
afterEach(() => rig.dispose());

/** The reviewer merges the request on the forge — SQUASHED, so what lands is not what was pushed. */
function squashMerge(extra?: () => void): string {
  const theirs = rig.reviewer();
  rig.git(theirs, "checkout", "main");
  rig.git(theirs, "merge", "--squash", `origin/${REVIEW}`);
  extra?.();
  rig.git(theirs, "commit", "-m", "Review the implementation (!41)");
  rig.git(theirs, "push", "origin", "main");
  return rig.git(theirs, "rev-parse", "HEAD");
}

const row = () => handles.get("t-1", "review")!;

describe("adopting the forge's history", () => {
  it("fetches, moves the task's worktree onto what landed, and fast-forwards a target nobody has checked out", async () => {
    const pushed = rig.git(rig.work, "rev-parse", "HEAD");
    const landed = squashMerge();
    const report = await primitives.adopt(row(), rig.work, true);

    expect(report).toMatchObject({ head: landed, reset: true, target: "fast-forwarded", dropped: "refs/jaira/dropped/t-1/1" });
    // The task branch now IS the forge's history — a squash the task never made.
    expect(rig.git(rig.work, "rev-parse", "HEAD")).toBe(landed);
    expect(rig.git(rig.work, "rev-parse", "main")).toBe(landed);
    // And what it held is still reachable, under a ref of its own.
    expect(rig.git(rig.work, "rev-parse", "refs/jaira/dropped/t-1/1")).toBe(pushed);
  });

  it("keeps uncommitted drift too: a worktree edited while the gate was parked loses nothing", async () => {
    writeFileSync(join(rig.work, "scratch-notes.txt"), "thought of this while waiting\n");
    squashMerge();
    const report = await primitives.adopt(row(), rig.work, true);
    expect(existsSync(join(rig.work, "scratch-notes.txt"))).toBe(false); // the worktree is the merged tree
    expect(rig.git(rig.work, "show", `${report.dropped}:scratch-notes.txt`)).toBe("thought of this while waiting");
  });

  it("adopts a fixup the reviewer pushed themselves — what landed is not necessarily what was pushed", async () => {
    const landed = squashMerge(() => {
      const theirs = join(rig.root, "reviewer-1");
      writeFileSync(join(theirs, "app.txt"), "one\ntwo, as the reviewer prefers\nthree\n");
      rig.git(theirs, "add", "-A");
    });
    await primitives.adopt(row(), rig.work, true);
    expect(rig.git(rig.work, "rev-parse", "HEAD")).toBe(landed);
    expect(readFileSync(join(rig.work, "app.txt"), "utf8")).toContain("as the reviewer prefers");
  });

  it("numbers what it drops, so a second merge in one task does not overwrite the first", async () => {
    squashMerge();
    await primitives.adopt(row(), rig.work, true);
    writeFileSync(join(rig.work, "later.txt"), "a later round\n");
    const again = await primitives.adopt(row(), rig.work, true);
    expect(again.dropped).toBe("refs/jaira/dropped/t-1/2");
  });

  it("leaves a diverged target alone and says why — it never merges a branch the person owns", async () => {
    rig.git(rig.work, "branch", "-f", "main", "main");
    // A local commit on main that the forge does not have.
    rig.git(rig.work, "stash", "-u");
    rig.git(rig.work, "checkout", "main");
    writeFileSync(join(rig.work, "local-only.txt"), "mine\n");
    rig.git(rig.work, "add", "-A");
    rig.git(rig.work, "commit", "-m", "a local commit the forge has never seen");
    const mine = rig.git(rig.work, "rev-parse", "main");
    rig.git(rig.work, "checkout", "task/t-1");
    squashMerge();

    const report = await primitives.adopt(row(), rig.work, true);
    expect(report.target).toBe("left-alone");
    expect(report.why).toMatch(/your main has commits origin\/main does not/);
    expect(rig.git(rig.work, "rev-parse", "main")).toBe(mine);
  });

  it("leaves a target that is checked out with a dirty tree alone, and fast-forwards a clean one where it is", async () => {
    const elsewhere = join(rig.root, "main-checkout");
    rig.git(rig.work, "worktree", "add", elsewhere, "main");
    writeFileSync(join(elsewhere, "README.md"), "# project, mid-edit\n");
    const landed = squashMerge();

    const dirty = await primitives.adopt(row(), rig.work, true);
    expect(dirty).toMatchObject({ target: "left-alone" });
    expect(dirty.why).toMatch(/checked out with uncommitted changes/);
    expect(readFileSync(join(elsewhere, "README.md"), "utf8")).toBe("# project, mid-edit\n");

    rig.git(elsewhere, "checkout", "--", "README.md");
    const clean = await primitives.adopt(row(), rig.work, true);
    expect(clean.target).toBe("fast-forwarded");
    expect(rig.git(elsewhere, "rev-parse", "HEAD")).toBe(landed);
  });

  it("does not reset a task that has no worktree of its own — that checkout is the person's", async () => {
    const before = rig.git(rig.work, "rev-parse", "HEAD");
    squashMerge();
    const report = await primitives.adopt(row(), rig.work, false);
    expect(report).toMatchObject({ reset: false });
    expect(report.why).toMatch(/no worktree of its own/);
    expect(rig.git(rig.work, "rev-parse", "HEAD")).toBe(before);
  });
});
