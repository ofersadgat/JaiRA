/**
 * The changeset value (CHANGESETS.md §1) — the model both producers lower into and the gate's
 * decisions are checked against. The properties under test are the design's load-bearing claims:
 * the source grammar refuses rather than guesses (§2), every content change lowers to a text edit
 * (§1.3), the application step is pure and determined (§4.2), and a review must decide every change
 * it was given (§4.1).
 */
import { describe, expect, it } from "vitest";
import {
  applyDecisions,
  applyHunks,
  changesetOf,
  checkDecisions,
  formatChangesetSource,
  parseChangesetSource,
  reviewSettled,
  type Changeset,
} from "../src/changeset";

describe("the source grammar (§2)", () => {
  it("round-trips the three schemes", () => {
    for (const uri of [
      "git:8f2a1cdeadbeef",
      "git:8f2a1cdeadbeef:workflows/feature/plan.json",
      "db://operation_records/t1/3/s_review@4.result.changeset",
      "file:C:/repo/workflows#sha256=" + "a".repeat(64),
    ]) {
      expect(formatChangesetSource(parseChangesetSource(uri))).toBe(uri);
    }
  });

  it("splits a db:// source on the LAST @, because a derived session id may carry one", () => {
    const source = parseChangesetSource("db://operation_records/plan~compact1@7@8.result.changeset");
    expect(source).toMatchObject({ scheme: "db", session: "plan~compact1@7", seq: 8, pointer: ["result", "changeset"] });
  });

  it("reads a db:// address WITHOUT a position as a record's content id (§10.6, settled)", () => {
    // The id settled operation.* events carry — addressable whether or not the call ever claimed a
    // conversation seat, which is what closed the record-id seam.
    const source = parseChangesetSource("db://operation_records/abc123def456.request.changeset");
    expect(source).toMatchObject({ scheme: "db", recordId: "abc123def456", pointer: ["request", "changeset"] });
    expect(formatChangesetSource(source)).toBe("db://operation_records/abc123def456.request.changeset");
  });

  it("refuses anything unrecognised rather than guessing (REFERENCES.md §1's rule)", () => {
    expect(() => parseChangesetSource("https://example.com/x")).toThrow(/refused/);
    expect(() => parseChangesetSource("git:not-a-sha")).toThrow(/hex object id/);
    expect(() => parseChangesetSource("db://operation_records/")).toThrow(/record/);
    expect(() => parseChangesetSource("file:x#md5=abc")).toThrow(/sha256/);
  });
});

describe("hunk application (§1.3)", () => {
  it("applies range replacements without earlier splices shifting later offsets", () => {
    const before = "aaa bbb ccc";
    const out = applyHunks(before, [
      { id: "h1", start: 0, end: 3, text: "AAA" },
      { id: "h2", start: 8, end: 11, text: "CCC" },
    ]);
    expect(out).toBe("AAA bbb CCC");
  });

  it("treats start === end as an insertion", () => {
    expect(applyHunks("ab", [{ id: "h1", start: 1, end: 1, text: "X" }])).toBe("aXb");
  });
});

const CHANGESET: Changeset = {
  source: "git:aaaa1111",
  changes: [
    { id: "c1", path: "src/a.ts", action: "update", before: "old a", after: "new a" },
    { id: "c2", path: "src/b.ts", action: "create", after: "new b" },
    { id: "c3", path: "src/c.ts", action: "delete", before: "old c" },
    { id: "c4", path: "src/d2.ts", action: "rename", fromPath: "src/d.ts", before: "d", after: "d" },
  ],
};

describe("the pure application step (§4.2)", () => {
  it("against a tree at the BASE (a sync's proposal), merged writes and everything else leaves it", () => {
    const writes = applyDecisions(
      CHANGESET,
      [
        { id: "c1", decision: "merged" },
        { id: "c2", decision: "merged", content: "user-edited b" },
        { id: "c3", decision: "denied" },
        { id: "c4", decision: "approved" },
      ],
      "base",
    );
    expect(writes).toEqual([
      { path: "src/a.ts", content: "new a" },
      // The user's own edit wins — the one non-derivable part of the outcome (§4.1).
      { path: "src/b.ts", content: "user-edited b" },
    ]);
  });

  it("against a tree already holding the PROPOSAL (a worktree), reverted rolls back and merged applies", () => {
    const writes = applyDecisions(
      CHANGESET,
      [
        { id: "c1", decision: "reverted" },
        { id: "c2", decision: "reverted" },
        { id: "c3", decision: "merged" },
        { id: "c4", decision: "reverted" },
      ],
      "proposal",
    );
    expect(writes).toEqual([
      { path: "src/a.ts", content: "old a" },
      // Reverting a create removes the file the proposal added.
      { path: "src/b.ts", content: undefined },
      // A merged delete removes — idempotent when the worktree already deleted it.
      { path: "src/c.ts", content: undefined },
      // Reverting a rename puts the content back where it came from.
      { path: "src/d2.ts", content: undefined },
      { path: "src/d.ts", content: "d" },
    ]);
  });

  it("carries a chmod through to the write — §1.1's fifth action, applicable at last", () => {
    const flip: Changeset = {
      source: "git:aaaa1111",
      changes: [
        { id: "x1", path: "run.sh", action: "chmod", before: "#!/bin/sh\n", after: "#!/bin/sh\n", modes: { before: "100644", after: "100755" } },
        // An update that ALSO flips the bit — one change, both halves applied together.
        { id: "x2", path: "tool.sh", action: "update", before: "old\n", after: "new\n", modes: { before: "100755", after: "100644" } },
      ],
    };
    expect(applyDecisions(flip, [{ id: "x1", decision: "merged" }, { id: "x2", decision: "merged" }], "base")).toEqual([
      { path: "run.sh", content: "#!/bin/sh\n", mode: "executable" },
      { path: "tool.sh", content: "new\n", mode: "normal" },
    ]);
    // Reverting restores the BEFORE mode along with the before content.
    expect(applyDecisions(flip, [{ id: "x1", decision: "reverted" }, { id: "x2", decision: "reverted" }], "proposal")).toEqual([
      { path: "run.sh", content: "#!/bin/sh\n", mode: "normal" },
      { path: "tool.sh", content: "old\n", mode: "executable" },
    ]);
  });

  it("merged applies UNCONDITIONALLY (§4.1's files column) — a revised proposal reaches a stale worktree", () => {
    // After a revision round the worktree still holds round one's proposal; the merged write is
    // what brings it to the revised `after`, and against an unmoved tree the same write is a no-op
    // in effect.
    const writes = applyDecisions(CHANGESET, [{ id: "c1", decision: "merged" }], "proposal");
    expect(writes).toEqual([{ path: "src/a.ts", content: "new a" }]);
  });

  it("applies a merged delete and a merged rename as file operations, taken whole (§1.3)", () => {
    const writes = applyDecisions(
      CHANGESET,
      [
        { id: "c3", decision: "merged" },
        { id: "c4", decision: "merged" },
      ],
      "base",
    );
    expect(writes).toEqual([
      { path: "src/c.ts", content: undefined },
      { path: "src/d.ts", content: undefined },
      { path: "src/d2.ts", content: "d" },
    ]);
  });
});

describe("decision validation (§4.1) — the main-process re-check", () => {
  const decideAll = (kind: "merged" | "comment") => CHANGESET.changes.map((c) => ({ id: c.id, decision: kind }));

  it("accepts a complete, well-formed answer", () => {
    const checked = checkDecisions(CHANGESET, { decisions: decideAll("merged") });
    expect(checked.ok).toBe(true);
  });

  it("requires EVERY change decided — the gate returns every change it was given", () => {
    const partial = { decisions: [{ id: "c1", decision: "merged" }] };
    const checked = checkDecisions(CHANGESET, partial);
    expect(checked).toMatchObject({ ok: false });
    expect((checked as { errors: string }).errors).toContain("undecided");
  });

  it("refuses a decision about a change that was never proposed", () => {
    const checked = checkDecisions(CHANGESET, { decisions: [...decideAll("merged"), { id: "ghost", decision: "merged" }] });
    expect((checked as { errors: string }).errors).toContain("ghost");
  });

  it("allows content only on merged — it is the user's own edit, nothing else", () => {
    const decisions = decideAll("merged").map((d) => (d.id === "c1" ? { ...d, decision: "denied", content: "x" } : d));
    const checked = checkDecisions(CHANGESET, { decisions });
    expect((checked as { errors: string }).errors).toContain("merged");
  });

  it("a round with comments left is not settled; one without is (§3.3 flow 1)", () => {
    expect(reviewSettled(decideAll("comment"))).toBe(false);
    expect(reviewSettled(decideAll("merged"))).toBe(true);
  });
});

describe("the wire parse", () => {
  it("reads a changeset back and refuses a duplicate change id — decisions anchor to it", () => {
    expect(changesetOf(JSON.parse(JSON.stringify(CHANGESET)))).toEqual(CHANGESET);
    const dup = { ...CHANGESET, changes: [CHANGESET.changes[0], CHANGESET.changes[0]] };
    expect(() => changesetOf(dup)).toThrow(/not unique/);
  });

  it("refuses a source nothing could resolve", () => {
    expect(() => changesetOf({ source: "somewhere/on/disk", changes: [] })).toThrow(/refused/);
  });
});
