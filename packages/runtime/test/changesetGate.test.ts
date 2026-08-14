/**
 * The changeset gate end to end (CHANGESETS.md §4): the review workflow loads, the loop's policy is
 * AUTHORED (a transition, not component code), a settled round applies through the pure application
 * step, and a round with comments terminates carrying them — driven through `executeWorkflow` with
 * a scripted human, because the guarantee under test is wiring, not any one function.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryPersistence, loadBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/exec";
import { openDb, SqliteSessionStore } from "@jaira/persistence";
import { changesetOf, parseChangesetSource, type Changeset } from "@jaira/shared";
import { buildPromptExecutor, executeWorkflow, newRegistry, statusOfResult } from "../src/wiring";
import { ScriptedFunctions } from "../src/scriptedFunctions";
import {
  CHANGESET_REVIEW_ID,
  CHANGESET_REVIEW_LOOP_ID,
  changesetReviewFiles,
  changesetReviewLoopFiles,
  registerChangesetFunctions,
  reviewStatusOf,
  reviseChangeset,
  USER_APPROVE_CHANGESET,
} from "../src/changesetGate";

const CHANGESET: Changeset = {
  source: "git:aaaa1111",
  changes: [
    { id: "c1", path: "src/a.txt", action: "update", before: "base a\n", after: "proposed a\n" },
    { id: "c2", path: "src/b.txt", action: "create", after: "proposed b\n" },
  ],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-gate-"));
  // The tree holds the PROPOSAL — an agent's worktree after it worked.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "proposed a\n", "utf8");
  writeFileSync(join(dir, "src", "b.txt"), "proposed b\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(decisions: JsonValue): Promise<{ outputs: Record<string, JsonValue>; status: string }> {
  const registry = newRegistry();
  registerChangesetFunctions(registry);
  // The scripted human — in the app this is the InteractionHub, and nothing inside the workflow can
  // reach either; the registry is supplied by the host, which is the §4.1 guarantee.
  new ScriptedFunctions({ [USER_APPROVE_CHANGESET]: [{ decisions } as JsonValue] }).register(registry);
  const result = await executeWorkflow({
    bundle: loadBundle(changesetReviewFiles(), CHANGESET_REVIEW_ID),
    inputs: { changeset: CHANGESET as unknown as JsonValue },
    registry,
    prompt: buildPromptExecutor({ fakeRules: [] }),
    workspace: { root: dir },
  });
  const outputs = ((result as { value?: unknown }).value ?? {}) as Record<string, JsonValue>;
  return { outputs, status: statusOfResult(result) };
}

describe("the review workflow (§4.3)", () => {
  it("loads with the loop policy authored as transitions on the root", () => {
    const bundle = loadBundle(changesetReviewFiles(), CHANGESET_REVIEW_ID);
    const root = bundle.states[CHANGESET_REVIEW_ID]!;
    expect(root.sequence).toEqual(["gate", "status", "apply"]);
    const transitions = root.transitions as Array<{ to: string }>;
    expect(transitions.map((t) => t.to)).toEqual(["terminate.success", "apply", "terminate.success"]);
  });

  it("a settled round applies: reverted rolls the worktree back, merged leaves the proposal", async () => {
    const { outputs, status } = await run([
      { id: "c1", decision: "reverted" },
      { id: "c2", decision: "merged" },
    ]);
    expect(status).toBe("completed");
    expect(outputs["settled"]).toBe(true);
    // c1 rolled back to the base, c2 (already the proposal on disk) untouched.
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("base a\n");
    expect(readFileSync(join(dir, "src", "b.txt"), "utf8")).toBe("proposed b\n");
  });

  it("a merged decision may carry the user's own edit — the one non-derivable content (§4.1)", async () => {
    const { status } = await run([
      { id: "c1", decision: "merged", content: "the user's own version of a\n" },
      { id: "c2", decision: "merged" },
    ]);
    expect(status).toBe("completed");
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("the user's own version of a\n");
  });

  it("a round with comments terminates WITHOUT applying, carrying them for the next round (§3.3)", async () => {
    const { outputs, status } = await run([
      { id: "c1", decision: "comment", comment: "why this way?" },
      { id: "c2", decision: "merged" },
    ]);
    expect(status).toBe("completed");
    expect(outputs["settled"]).toBe(false);
    expect(outputs["comments"]).toEqual([{ id: "c1", comment: "why this way?" }]);
    // Nothing applied — the tree still holds the proposal it held.
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("proposed a\n");
  });

  it("refuses to apply over a tree that moved while the review was pending (§3.2)", async () => {
    // Between the gate parking and the human answering, something else rewrites a file past the
    // proposal the reviewer was shown. Applying anyway would overwrite content nobody saw.
    writeFileSync(join(dir, "src", "a.txt"), "a third party's edit\n", "utf8");
    const { status } = await run([
      { id: "c1", decision: "merged" },
      { id: "c2", decision: "merged" },
    ]);
    expect(status).toBe("failed");
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("a third party's edit\n");
  });

  it("a drifted file the decisions LEAVE ALONE does not block the rest (§3.2's check is per touch)", async () => {
    writeFileSync(join(dir, "src", "a.txt"), "a third party's edit\n", "utf8");
    const { status } = await run([
      { id: "c1", decision: "denied" },
      { id: "c2", decision: "merged" },
    ]);
    expect(status).toBe("completed");
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("a third party's edit\n");
    expect(readFileSync(join(dir, "src", "b.txt"), "utf8")).toBe("proposed b\n");
  });

  it("refuses an incomplete answer — every change it was given, each with a decision (§4.1)", async () => {
    const { status } = await run([{ id: "c1", decision: "merged" }]);
    // apply-changeset re-validates and fails the state rather than applying a partial judgement.
    expect(status).toBe("failed");
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("proposed a\n");
  });

  it("a delete decision applied against the base tree removes the file (reverted create)", async () => {
    const { status } = await run([
      { id: "c1", decision: "reverted" },
      { id: "c2", decision: "reverted" },
    ]);
    expect(status).toBe("completed");
    expect(existsSync(join(dir, "src", "b.txt"))).toBe(false);
  });
});

describe("the LOOPING review workflow (flow 1 whole, §3.3)", () => {
  // The fake model answers the comment with a complete revised file (§11: whole file in, hunks
  // derived) — matched on a line of the respond prompt, like every scripted prompt.
  const RESPOND_RULE = {
    promptIncludes: "a reviewer answered some of them with comments",
    output: { edits: [{ path: "src/a.txt", text: "answered a\n", reason: "as asked" }], notes: [] } as JsonValue,
  };

  async function runLoop(
    gateRounds: JsonValue[],
    options: Parameters<typeof changesetReviewLoopFiles>[0] = {},
  ): Promise<{ outputs: Record<string, JsonValue>; status: string }> {
    const registry = newRegistry();
    registerChangesetFunctions(registry);
    new ScriptedFunctions({ [USER_APPROVE_CHANGESET]: gateRounds.map((decisions) => ({ decisions }) as JsonValue) }).register(
      registry,
    );
    const result = await executeWorkflow({
      bundle: loadBundle(changesetReviewLoopFiles(options), CHANGESET_REVIEW_LOOP_ID),
      inputs: { changeset: CHANGESET as unknown as JsonValue },
      registry,
      prompt: buildPromptExecutor({ fakeRules: [RESPOND_RULE] }),
      workspace: { root: dir },
    });
    return {
      outputs: ((result as { value?: unknown }).value ?? {}) as Record<string, JsonValue>,
      status: statusOfResult(result),
    };
  }

  it("carries the revised changeset into round two — the model answered, the gate re-reviews, apply writes it", async () => {
    const { outputs, status } = await runLoop([
      // Round one: a comment on c1 — flow 1's "another round" signal.
      [
        { id: "c1", decision: "comment", comment: "say answered instead" },
        { id: "c2", decision: "merged" },
      ],
      // Round two: the gate is shown the REVISED changeset (same id — comments anchor to it) and settles.
      [
        { id: "c1", decision: "merged" },
        { id: "c2", decision: "merged" },
      ],
    ]);
    expect(status).toBe("completed");
    // The worktree still held round one's proposal; the merged write brings it to the revision.
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("answered a\n");
    expect(readFileSync(join(dir, "src", "b.txt"), "utf8")).toBe("proposed b\n");
    const changeset = outputs["changeset"] as { changes: Array<{ id: string; after?: string }> };
    expect(changeset.changes.find((c) => c.id === "c1")?.after).toBe("answered a\n");
    expect(outputs["applied"]).toEqual(["src/a.txt", "src/b.txt"]);
  });

  it("a review that settles in round one never wakes the model", async () => {
    const { outputs, status } = await runLoop([
      [
        { id: "c1", decision: "merged" },
        { id: "c2", decision: "merged" },
      ],
    ]);
    expect(status).toBe("completed");
    const changeset = outputs["changeset"] as { changes: Array<{ id: string; after?: string }> };
    // No revision round happened: the carried changeset is the input, verbatim.
    expect(changeset.changes.find((c) => c.id === "c1")?.after).toBe("proposed a\n");
  });

  it("a failed respond FAILS the round — never a silent restart from the input", async () => {
    // The carry binding is coalesce over the VALUE, so this property rests on the transitions: an
    // errored respond matches nothing, and "child terminated with error and no transition handled
    // it" ends the run. An `.outcome === 'success'` ternary in the binding would instead have
    // fallen back to the input changeset and quietly reviewed round one again.
    const registry = newRegistry();
    registerChangesetFunctions(registry);
    new ScriptedFunctions({
      [USER_APPROVE_CHANGESET]: [
        [
          { id: "c1", decision: "comment", comment: "please revise" },
          { id: "c2", decision: "merged" },
        ] as JsonValue,
      ].map((decisions) => ({ decisions }) as JsonValue),
    }).register(registry);
    const result = await executeWorkflow({
      bundle: loadBundle(changesetReviewLoopFiles(), CHANGESET_REVIEW_LOOP_ID),
      inputs: { changeset: CHANGESET as unknown as JsonValue },
      registry,
      // The model answers with garbage that fails the respond state's output schema — a broken
      // revision, which must surface as a failure, not as another round over stale content.
      prompt: buildPromptExecutor({
        fakeRules: [
          {
            promptIncludes: "a reviewer answered some of them with comments",
            output: { edits: [{ path: 42 }] } as unknown as JsonValue,
          },
        ],
        repairTurns: 0,
      }),
      workspace: { root: dir },
    });
    expect(statusOfResult(result)).toBe("failed");
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("proposed a\n");
  });

  it("fails loudly when the rounds run out with comments still open, rather than applying anyway", async () => {
    const comment = [
      { id: "c1", decision: "comment", comment: "still not right" },
      { id: "c2", decision: "merged" },
    ] as JsonValue;
    const { status } = await runLoop([comment, comment], { maxRounds: 0 });
    expect(status).toBe("failed");
    // Nothing applied — the tree still holds what it held.
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("proposed a\n");
  });
});

describe("reviseChangeset", () => {
  it("keeps ids and the before side stable, re-derives hunks, and adds unknown paths as creates", () => {
    const revised = reviseChangeset(CHANGESET, [
      { path: "src/a.txt", text: "answered a\n", reason: "as asked" },
      { path: "src/new.txt", text: "brand new\n" },
    ]);
    expect(revised.source).toBe(CHANGESET.source);
    const a = revised.changes.find((c) => c.path === "src/a.txt")!;
    // The comment anchored to c1; the revision must keep the anchor.
    expect(a.id).toBe("c1");
    expect(a.before).toBe("base a\n");
    expect(a.after).toBe("answered a\n");
    expect(a.hunks?.length).toBeGreaterThan(0);
    const added = revised.changes.find((c) => c.path === "src/new.txt")!;
    expect(added.action).toBe("create");
    expect(added.id).toBe("c3");
  });
});

describe("the record-id seam (§10.6, settled)", () => {
  it("a settled event's operationId leads to the record whose request pins the changeset (§5.3)", async () => {
    // The whole chain the seam exists for: journal → record → the changeset the human judged —
    // recomputable long after the worktree moved, addressed by the id the event carries.
    const db = openDb(join(dir, "review.db"));
    try {
      const stores = new SqliteSessionStore(db, { taskId: "t-review", runId: 1 });
      const persistence = new InMemoryPersistence();
      const registry = newRegistry();
      registerChangesetFunctions(registry);
      new ScriptedFunctions({
        [USER_APPROVE_CHANGESET]: [
          { decisions: [
            { id: "c1", decision: "merged" },
            { id: "c2", decision: "merged" },
          ] } as JsonValue,
        ],
      }).register(registry);
      const result = await executeWorkflow({
        bundle: loadBundle(changesetReviewFiles(), CHANGESET_REVIEW_ID),
        inputs: { changeset: CHANGESET as unknown as JsonValue },
        registry,
        prompt: buildPromptExecutor({ fakeRules: [] }),
        workspace: { root: dir },
        persistence,
        session: { sessions: stores, records: stores },
      });
      expect(statusOfResult(result)).toBe("completed");

      // Every settled operation event names its call…
      const rows = persistence.events as Array<{ event: { type: string; stateId?: string; operationId?: string } }>;
      const gateEvent = rows.find(
        (r) => r.event.type === "operation.completed" && r.event.stateId === `${CHANGESET_REVIEW_ID}/gate`,
      )!;
      expect(gateEvent.event.operationId).toBeDefined();

      // …and the id resolves to the record, whose REQUEST holds the changeset the human was shown —
      // the §5.3 pin, now addressable as db://operation_records/<id>.request (the §2 grammar's
      // positionless form).
      const record = stores.record(gateEvent.event.operationId!)!;
      expect(record).toBeDefined();
      const request = record.request as { input?: Record<string, { binding?: { json?: unknown } }> };
      const pinned = changesetOf(request.input?.["changeset"]?.binding?.json);
      expect(pinned.changes.map((c) => c.id)).toEqual(["c1", "c2"]);
      // The address round-trips through the grammar.
      const uri = `db://operation_records/${gateEvent.event.operationId}.request`;
      expect(parseChangesetSource(uri)).toMatchObject({ scheme: "db", recordId: gateEvent.event.operationId });
    } finally {
      db.close();
    }
  });
});

describe("reviewStatusOf", () => {
  it("derives the §4.3 guard's answer until higher-order expressions exist", () => {
    expect(reviewStatusOf([{ id: "c1", decision: "merged" }])).toEqual({ settled: true, comments: [] });
    expect(reviewStatusOf([{ id: "c1", decision: "comment", comment: "hm" }])).toEqual({
      settled: false,
      comments: [{ id: "c1", comment: "hm" }],
    });
  });
});
