/**
 * A revise round answers the threads it addressed (decision 0004, "The same request on every round").
 *
 * The rule is pure — which threads, what is said, whether it resolves — so it is pinned here as a
 * table. What it must never do is say the same thing twice: a resumed run re-reaches the gate.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import { CHANGESET_REVIEW_LOOP_ID, changesetReviewLoopFiles } from "../src/changesetGate";
import { saysFixed, threadReplies } from "../src/remoteReview";
import { hostCalleeSignatures } from "../src/userEvents";

const HEAD = "9f3c1a2b7e55aa00";
const theirs = { own: false };
const ours = { own: true };
const thread = (id: string, path: string | undefined, comments: Array<{ own: boolean }>, resolved = false) => ({ id, resolved, ...(path !== undefined ? { anchor: { path } } : {}), comments });

describe("which threads a revision answers", () => {
  it("replies with the responder's reason on every open thread about a file it revised", () => {
    const replies = threadReplies([thread("t1", "src/cache.ts", [theirs]), thread("t2", "src/cache.ts", [theirs, theirs]), thread("t3", "src/other.ts", [theirs])], [{ path: "src/cache.ts", reason: "Keyed the cache on the architecture too." }], HEAD);
    expect(replies).toEqual([
      { thread: "t1", body: "Keyed the cache on the architecture too. (9f3c1a2b)", resolve: false },
      { thread: "t2", body: "Keyed the cache on the architecture too. (9f3c1a2b)", resolve: false },
    ]);
  });

  it("resolves a thread only when the responder said `fixed` — as the FIRST word", () => {
    expect(saysFixed("fixed: keyed on arch")).toBe(true);
    expect(saysFixed("  Fixed — and added a test")).toBe(true);
    expect(saysFixed("Partly fixed; the Windows path is still open")).toBe(false);
    expect(saysFixed("prefixed the key")).toBe(false);
    expect(saysFixed(undefined)).toBe(false);
    expect(threadReplies([thread("t1", "a.ts", [theirs])], [{ path: "a.ts", reason: "fixed: renamed it" }], HEAD)[0]).toMatchObject({ resolve: true });
  });

  it("says something even when the responder gave no reason, and never resolves on silence", () => {
    expect(threadReplies([thread("t1", "a.ts", [theirs])], [{ path: "a.ts" }], HEAD)).toEqual([{ thread: "t1", body: "Revised. (9f3c1a2b)", resolve: false }]);
  });

  it("never says it twice: a thread whose last word is already JaiRA's is left alone", () => {
    // The previous park replied; this is the same round re-reached after a restart.
    expect(threadReplies([thread("t1", "a.ts", [theirs, ours])], [{ path: "a.ts", reason: "fixed" }], HEAD)).toEqual([]);
    // The reviewer wrote AGAIN after the reply: that is a new thing to answer.
    expect(threadReplies([thread("t1", "a.ts", [theirs, ours, theirs])], [{ path: "a.ts", reason: "fixed" }], HEAD)).toHaveLength(1);
  });

  it("leaves alone what is resolved, what nobody else wrote on, and what is about no file", () => {
    const edits = [{ path: "a.ts", reason: "fixed" }];
    expect(threadReplies([thread("t1", "a.ts", [theirs], true)], edits, HEAD)).toEqual([]);
    expect(threadReplies([thread("t2", "a.ts", [ours])], edits, HEAD)).toEqual([]);
    expect(threadReplies([thread("t3", undefined, [theirs])], edits, HEAD)).toEqual([]);
  });
});

describe("the review loop hands the gate what the responder did", () => {
  it("binds `addressed` to the respond state's edits, with a default for round one", () => {
    const files = changesetReviewLoopFiles({ remote: { to: "origin" } }) as Record<string, { children?: Record<string, { inputs?: Record<string, string> }>; inputs?: Record<string, { default?: unknown }>; operation?: { prompt?: string } }>;
    expect(files[CHANGESET_REVIEW_LOOP_ID]!.children!["gate"]!.inputs!["addressed"]).toBe(".children.respond.output.edits");
    expect(files[`${CHANGESET_REVIEW_LOOP_ID}/gate`]!.inputs!["addressed"]!.default).toEqual([]);
    // And the responder is TOLD its reason is a public reply, and what `fixed` does.
    expect(files[`${CHANGESET_REVIEW_LOOP_ID}/respond`]!.operation!.prompt).toMatch(/Begin it with the word `fixed` ONLY when/);
    expect(() => loadBundle(Object.fromEntries(Object.entries(files).map(([id, doc]) => [`${id}.json`, doc])) as never, CHANGESET_REVIEW_LOOP_ID, { functions: hostCalleeSignatures() })).not.toThrow();
  });

  it("says none of that without a remote", () => {
    const files = changesetReviewLoopFiles() as Record<string, { children?: Record<string, { inputs?: Record<string, string> }>; operation?: { prompt?: string } }>;
    expect(files[CHANGESET_REVIEW_LOOP_ID]!.children!["gate"]!.inputs).toEqual({ changeset: expect.any(String) });
    expect(files[`${CHANGESET_REVIEW_LOOP_ID}/respond`]!.operation!.prompt).not.toMatch(/merge request/);
  });
});
