/**
 * `changeset:reviewSync` — the "one mechanism" half of CHANGESETS.md's opening claim: a sync's
 * proposals walked through the SAME gate a worktree review uses, applied into the layer root, with
 * the sync baseline moving exactly when the whole proposal was merged.
 *
 * The LOOPING review, since the sync workflow redo: a `comment` decision sends the changeset back
 * to a model that revises it (under the sync's own authoring rules — see `syncRespondPrompt`), and
 * the revision returns to the gate for another round. Rounds without comments behave exactly as the
 * single-round gate did.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { REVIEW_ARTIFACTS } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { Changeset, PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-reviewsync-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
  service.createFile({ layer: "project", path: ".jaira/workflows/workflow.md", kind: "file", text: "# The flow\n" });
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A sync-shaped proposal: whole files against the layer root, source pinned by content hash. */
const PROPOSAL: Changeset = {
  source: `file:unverified#sha256=${"0".repeat(64)}`,
  changes: [
    { id: "c1", path: "prompts/from-review.md", action: "create", after: "born of a review\n" },
    { id: "c2", path: "workflows/workflow.md", action: "update", before: "# The flow\n", after: "# The flow, revised\n" },
  ],
};

const finished = (taskId: string): boolean => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

describe("changeset:reviewSync", () => {
  it("applies merged proposals into the layer root and moves the baseline when all merged", async () => {
    const result = await service.reviewSyncChangeset({
      layer: "project",
      path: "workflows/workflow.md",
      changeset: PROPOSAL,
      interactions: {
        [REVIEW_ARTIFACTS]: [
          { decisions: [
            { id: "c1", decision: "merged" },
            { id: "c2", decision: "merged" },
          ] } as JsonValue,
        ],
      },
    });
    expect(result.changes).toBe(2);
    await until(() => finished(result.reviewTaskId), "the review run to finish");

    expect(readFileSync(join(dir, ".jaira", "prompts", "from-review.md"), "utf8")).toBe("born of a review\n");
    expect(readFileSync(join(dir, ".jaira", "workflows", "workflow.md"), "utf8")).toBe("# The flow, revised\n");
    // Fully merged ⇒ the description and the files were agreed — the baseline moved (§ the sync's
    // own rule: nothing left to accept means the sync succeeded).
    await until(
      () => service.syncStatus({ layer: "project", path: "workflows/workflow.md" }).synced,
      "the baseline to move",
    );
  });

  it("sends a comment back to the model and reviews the revision in a second round", async () => {
    const result = await service.reviewSyncChangeset({
      layer: "project",
      path: "workflows/workflow.md",
      changeset: PROPOSAL,
      interactions: {
        [REVIEW_ARTIFACTS]: [
          // Round one: a comment on the prompt file, the document merged — comments keep the round
          // open, so nothing is applied yet.
          { decisions: [
            { id: "c1", decision: "comment", comment: "say what the critique is FOR" },
            { id: "c2", decision: "merged" },
          ] } as JsonValue,
          // Round two: the revision satisfies, everything merges.
          { decisions: [
            { id: "c1", decision: "merged" },
            { id: "c2", decision: "merged" },
          ] } as JsonValue,
        ],
      },
      // The respond state is the sync's own prompt (syncRespondPrompt); the fake answers it with a
      // whole revised file, which `changeset-revise` folds in under the same change id.
      fake: [
        {
          promptIncludes: "answered some of the changes with comments",
          output: { edits: [{ path: "prompts/from-review.md", text: "born of a review, and it says why\n", reason: "the comment asked" }] },
        },
      ] as never,
    });
    await until(() => finished(result.reviewTaskId), "the looping review to finish");

    // The REVISED text landed — the round-two gate was shown the revision, not the original.
    expect(readFileSync(join(dir, ".jaira", "prompts", "from-review.md"), "utf8")).toBe("born of a review, and it says why\n");
    expect(readFileSync(join(dir, ".jaira", "workflows", "workflow.md"), "utf8")).toBe("# The flow, revised\n");
    // Final round fully merged ⇒ the baseline moves, same rule as a one-round review.
    await until(
      () => service.syncStatus({ layer: "project", path: "workflows/workflow.md" }).synced,
      "the baseline to move",
    );
  });

  it("a partially-accepted proposal applies what was merged and leaves the drift standing", async () => {
    const result = await service.reviewSyncChangeset({
      layer: "project",
      path: "workflows/workflow.md",
      changeset: PROPOSAL,
      interactions: {
        [REVIEW_ARTIFACTS]: [
          { decisions: [
            { id: "c1", decision: "merged" },
            // `reverted`, not `denied`: decision 0002 narrowed the judgement-only pair to mean "on a
            // round that is NOT being applied", and this round is. On a `base` tree the outcome is
            // identical — nothing is written either way — but only the applied form settles, which
            // is what lets a review-level comment hold a set back with no per-change comment on it.
            { id: "c2", decision: "reverted" },
          ] } as JsonValue,
        ],
      },
    });
    await until(() => finished(result.reviewTaskId), "the review run to finish");

    expect(existsSync(join(dir, ".jaira", "prompts", "from-review.md"))).toBe(true);
    // The denied update never landed, and the baseline did not move: the workflows still do not
    // run what the description asks for, and saying otherwise would hide real drift.
    expect(readFileSync(join(dir, ".jaira", "workflows", "workflow.md"), "utf8")).toBe("# The flow\n");
    expect(service.syncStatus({ layer: "project", path: "workflows/workflow.md" }).synced).toBe(false);
  });
});

/**
 * Which project the parked gate is ABOUT.
 *
 * The reported failure: a base-layer review with no project open parked its gate, the reviewer read
 * `$WORKTREE/…`, `$JAIRA/…`, `$PROJECT/…` to show what each file holds right now, and every one of
 * them failed in the main process with `no project is open` — because an unscoped `uri:read` resolves
 * the FOCUSED project, and a review runs in JaiRA's own. The stamp says which project the request's
 * addresses belong to; for a base-layer review that is the shared root, open or not.
 */
describe("the project a parked review reads against", () => {
  let home: string;
  let base: string;
  let bare: AppService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jaira-syncgate-"));
    base = join(home, "shared");
    mkdirSync(join(base, "workflows"), { recursive: true });
    writeFileSync(join(base, "workflows", "workflow.md"), "# The flow\n", "utf8");
    bare = new AppService({ watchWorkflows: false, baseDir: base });
  });

  afterEach(async () => {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("stamps a base-layer review with the shared root, with no project open at all", async () => {
    expect(bare.current()).toBeNull();
    const result = await bare.reviewSyncChangeset({ layer: "base", path: "workflows/workflow.md", changeset: PROPOSAL });
    await until(() => bare.pendingInteractions().length === 1, "the gate to park");

    const pending = bare.pendingInteractions()[0]!;
    expect(pending.component).toBe(REVIEW_ARTIFACTS);
    expect(pending.taskId).toBe(result.reviewTaskId);
    expect(pending.subjectProject).toBe(base);
    // The other stamp, and the reason there are two: `taskId` is a rowid in the project the request
    // PARKED in — the base root, which is where a sync review runs — and the inbox strip needs that
    // one to resolve the row it draws (SHELL.md §2.4). With no project open at all, it is still an
    // answer, which is the case a focused-project guess had nothing to say about.
    expect(pending.project).toBe(bare.listProjects().find((p) => p.kind === "shared")!.project);

    // What the reviewer does with it: read what a proposed path holds right now.
    const current = await bare.readUri({ uri: "$PROJECT/workflows/workflow.md", project: pending.subjectProject });
    expect(current.text).toBe("# The flow\n");
    // And what the same read did without it — the reported error, still the honest answer to an
    // address that names no project.
    await expect(bare.readUri({ uri: "$PROJECT/workflows/workflow.md" })).rejects.toThrow(/no project is open/);
  });
});
