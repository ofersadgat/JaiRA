/**
 * What settles a gate from the forge (decision 0004 §3). Every row of the decision's table is a test
 * here, and so is each rule beneath it: the quiet window, the decision word, and who counts.
 *
 * The function is pure — `now` is an argument — so a window is tested by saying what time it is.
 */
import { describe, expect, it } from "vitest";
import type { Changeset } from "../src/changeset";
import type { ForgeComment, ForgeReview, ForgeThread, RemoteState } from "../src/forge";
import { decisionWordOf, resultOfSettlement, settleRemote, type SettleContext, type SettleStep } from "../src/remoteSettlement";

const T0 = Date.parse("2026-09-19T10:00:00Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const MIN = 60_000;

const changeset: Changeset = {
  source: "worktree",
  changes: [
    { id: "c1", path: "src/cache.ts", action: "update", before: "a\nb\nc\n", after: "a\nB\nc\n" },
    { id: "c2", path: "src/flags.ts", action: "update", before: "x\n", after: "x\ny\n" },
    { id: "c3", path: "docs/notes.md", action: "create", after: "# notes\n" },
  ],
};

let ids = 0;
const comment = (who: string, body: string, minute: number, extra: Partial<ForgeComment> = {}): ForgeComment => ({
  id: `n${++ids}`,
  who,
  body,
  at: at(minute),
  canWrite: true,
  own: false,
  ...extra,
});
const review = (who: string, verdict: ForgeReview["verdict"], minute: number, extra: Partial<ForgeReview> = {}): ForgeReview => ({
  id: `r${++ids}`,
  who,
  at: at(minute),
  verdict,
  canWrite: true,
  own: false,
  ...extra,
});
const thread = (path: string, line: number, comments: ForgeComment[], resolved = false): ForgeThread => ({
  id: `t${++ids}`,
  anchor: { path, line, side: "after" },
  resolved,
  comments,
});
const open = (extra: Partial<RemoteState> = {}): RemoteState => ({
  state: "open",
  draft: false,
  head: "abc",
  updatedAt: at(0),
  reviews: [],
  threads: [],
  comments: [],
  ...extra,
});

const OPTIONS = ["approve", "revise", "cut"];
const ctx = (extra: Partial<SettleContext> = {}): SettleContext => ({ changeset, options: OPTIONS, seen: [], settleAfterMs: 10 * MIN, now: T0, ...extra });

const settledOf = (step: SettleStep) => {
  if (step.kind !== "settled") throw new Error(`expected a settlement, got ${JSON.stringify(step)}`);
  return step.settlement;
};
const kinds = (step: SettleStep): string[] => (step.kind === "settled" ? step.settlement.decisions : step.decisions).map((d) => `${d.id}:${d.decision}`);

describe("the settlement table", () => {
  it("merged → approve, every change merged, and the forge's history is to be adopted", () => {
    const step = settleRemote(open({ state: "merged", mergeCommit: "f00", closedBy: "mara" }), ctx());
    expect(settledOf(step)).toMatchObject({ decision: "approve", settledBy: { via: "remote", who: "mara", act: "merged" }, effect: "adopt" });
    expect(kinds(step)).toEqual(["c1:merged", "c2:merged", "c3:merged"]);
  });

  it("merged decides EVERY change merged, whatever a thread said about one of them", () => {
    const step = settleRemote(open({ state: "merged", threads: [thread("src/cache.ts", 2, [comment("mara", "deny", 1)])] }), ctx());
    expect(kinds(step)).toEqual(["c1:merged", "c2:merged", "c3:merged"]);
  });

  it("approved (the forge's own approve) → approve, every change approved, and nothing is applied", () => {
    const step = settleRemote(open({ reviews: [review("sam", "approved", 5)] }), ctx());
    const settlement = settledOf(step);
    expect(settlement).toMatchObject({ decision: "approve", settledBy: { who: "sam", act: "approved" } });
    expect(settlement.effect).toBeUndefined(); // approving is not merging
    expect(kinds(step)).toEqual(["c1:approved", "c2:approved", "c3:approved"]);
  });

  it("a comment whose whole body is a decision word → that word, at once", () => {
    const step = settleRemote(open({ comments: [comment("sam", "  Revise ", 3)] }), ctx());
    expect(settledOf(step)).toMatchObject({ decision: "revise", settledBy: { who: "sam", act: "decision_word", word: "revise" } });
  });

  it("\"request changes\" submitted → revise: comment where a thread touches a change, else approved", () => {
    const step = settleRemote(
      open({
        reviews: [review("mara", "changes_requested", 8)],
        threads: [thread("src/cache.ts", 2, [comment("mara", "This ignores the architecture.", 7)])],
      }),
      ctx(),
    );
    expect(settledOf(step)).toMatchObject({ decision: "revise", settledBy: { who: "mara", act: "changes_requested" } });
    expect(kinds(step)).toEqual(["c1:comment", "c2:approved", "c3:approved"]);
  });

  it("comments, then quiet for settle_after → revise, with everything said", () => {
    const state = open({
      comments: [comment("sam", "Should this wait for the release branch?", 1)],
      threads: [thread("src/flags.ts", 2, [comment("mara", "This flag is never read.", 2)])],
    });
    const early = settleRemote(state, ctx({ now: T0 + 5 * MIN }));
    expect(early).toMatchObject({ kind: "waiting", settleAt: T0 + 12 * MIN });
    const late = settleRemote(state, ctx({ now: T0 + 12 * MIN, seen: early.seen, settleAt: (early as { settleAt: number }).settleAt }));
    expect(settledOf(late)).toMatchObject({ decision: "revise", settledBy: { who: "mara", act: "quiet" } });
    expect(kinds(late)).toEqual(["c1:approved", "c2:comment", "c3:approved"]);
    expect(settledOf(late).notes.map((n) => n.body)).toEqual(["Should this wait for the release branch?"]);
  });

  it("closed without merging → cut, every change denied", () => {
    const step = settleRemote(open({ state: "closed", closedBy: "lee" }), ctx());
    expect(settledOf(step)).toMatchObject({ decision: "cut", settledBy: { who: "lee", act: "closed" } });
    expect(kinds(step)).toEqual(["c1:denied", "c2:denied", "c3:denied"]);
    expect(settledOf(step).effect).toBeUndefined();
  });

  it("nothing said → still waiting, and no window is running", () => {
    const step = settleRemote(open(), ctx());
    expect(step).toMatchObject({ kind: "waiting" });
    expect((step as { settleAt?: number }).settleAt).toBeUndefined();
  });
});

describe("when one read finds several", () => {
  it("the request's own state outranks anything said on it", () => {
    const step = settleRemote(open({ state: "merged", reviews: [review("mara", "changes_requested", 1)] }), ctx());
    expect(settledOf(step).settledBy.act).toBe("merged");
  });

  it("a standing request for changes outranks an approval — sending it back is the cheaper mistake", () => {
    const step = settleRemote(open({ reviews: [review("mara", "changes_requested", 1), review("sam", "approved", 9)] }), ctx());
    expect(settledOf(step)).toMatchObject({ decision: "revise", settledBy: { who: "mara" } });
  });

  it("an act already acted on does not settle a later round again", () => {
    const old = review("mara", "changes_requested", 1);
    const step = settleRemote(open({ reviews: [old] }), ctx({ seen: [old.id] }));
    expect(step.kind).toBe("waiting");
  });
});

describe("the quiet window", () => {
  const first = comment("mara", "What about Windows?", 0);

  it("starts at the comment, not at the moment JaiRA read it", () => {
    // Read 9 minutes late: one minute of window is left, not ten.
    expect(settleRemote(open({ comments: [first] }), ctx({ now: T0 + 9 * MIN }))).toMatchObject({ kind: "waiting", settleAt: T0 + 10 * MIN });
  });

  it("is restarted by each further comment", () => {
    const step = settleRemote(open({ comments: [first, comment("sam", "And macOS.", 8)] }), ctx({ now: T0 + 9 * MIN, seen: [first.id], settleAt: T0 + 10 * MIN }));
    expect(step).toMatchObject({ kind: "waiting", settleAt: T0 + 18 * MIN });
  });

  it("is a TIMESTAMP: a deadline that passed while the app was closed settles on the first read, with the late comments in it", () => {
    const late = comment("sam", "One more thing before you go.", 9);
    const step = settleRemote(open({ comments: [first, late] }), ctx({ now: T0 + 3 * 24 * 60 * MIN, seen: [first.id], settleAt: T0 + 10 * MIN }));
    expect(settledOf(step).settledBy).toMatchObject({ act: "quiet", who: "sam" });
    expect(settledOf(step).notes.map((n) => n.body)).toEqual(["What about Windows?", "One more thing before you go."]);
  });

  it("does not run out early: a restart never pulls a deadline in", () => {
    const step = settleRemote(open({ comments: [first] }), ctx({ now: T0 + MIN, settleAt: T0 + 30 * MIN }));
    expect(step).toMatchObject({ kind: "waiting", settleAt: T0 + 30 * MIN });
  });

  it("settles on the first comment when settle_after is 0", () => {
    expect(settleRemote(open({ comments: [first] }), ctx({ settleAfterMs: 0, now: T0 })).kind).toBe("settled");
  });

  it("explicit acts settle at once, window or not", () => {
    const step = settleRemote(open({ comments: [first, comment("sam", "approve", 2)] }), ctx({ now: T0 + 2 * MIN, seen: [first.id], settleAt: T0 + 10 * MIN }));
    expect(settledOf(step).settledBy).toMatchObject({ act: "decision_word", word: "approve" });
  });
});

describe("the decision word", () => {
  it("is the WHOLE body, trimmed and case-folded — never a word inside a sentence", () => {
    expect(decisionWordOf(" Approve\n", OPTIONS)).toMatchObject({ word: "approve", kind: "approved", level: "approve" });
    expect(decisionWordOf("approve once the tests pass", OPTIONS)).toBeUndefined();
    expect(decisionWordOf("approve.", OPTIONS)).toBeUndefined();
    expect(decisionWordOf("", OPTIONS)).toBeUndefined();
  });

  it("is a value of the state's options, a DecisionKind, or the obvious verb form of one", () => {
    expect(decisionWordOf("cut", OPTIONS)).toMatchObject({ kind: "denied", level: "cut" });
    expect(decisionWordOf("denied", OPTIONS)).toMatchObject({ kind: "denied", level: "cut" });
    expect(decisionWordOf("deny", OPTIONS)).toMatchObject({ kind: "denied", level: "cut" });
    expect(decisionWordOf("reverted", OPTIONS)).toMatchObject({ kind: "reverted" });
    expect(decisionWordOf("comment", OPTIONS)).toMatchObject({ kind: "threads", level: "revise" });
    expect(decisionWordOf("lgtm", OPTIONS)).toBeUndefined();
    // A word the state invented is a decision there, and only there.
    expect(decisionWordOf("escalate", ["approve", "escalate"])).toMatchObject({ level: "escalate", kind: "threads" });
    expect(decisionWordOf("escalate", OPTIONS)).toBeUndefined();
  });

  it("answers with no review-level decision when the state names no option for it", () => {
    const step = settleRemote(open({ comments: [comment("sam", "approved", 1)] }), ctx({ options: [] }));
    expect(settledOf(step).decision).toBeUndefined();
    expect(kinds(step)).toEqual(["c1:approved", "c2:approved", "c3:approved"]);
  });

  it("`merged` as a word means apply it HERE, and leaves the request open", () => {
    const step = settleRemote(open({ comments: [comment("sam", "merged", 1)] }), ctx());
    expect(settledOf(step)).toMatchObject({ decision: "approve", effect: "apply", settledBy: { act: "decision_word", word: "merged" } });
    expect(kinds(step)).toEqual(["c1:merged", "c2:merged", "c3:merged"]);
  });

  it("as a reply on a file's thread decides that change alone — and settles nothing", () => {
    const state = open({ threads: [thread("src/cache.ts", 2, [comment("mara", "Is this right?", 1), comment("sam", "deny", 2)])] });
    const waiting = settleRemote(state, ctx({ now: T0 + 3 * MIN }));
    expect(waiting.kind).toBe("waiting");
    expect(kinds(waiting)).toEqual(["c1:denied", "c2:approved", "c3:approved"]);
    // It rides whatever settles the gate later.
    const step = settleRemote({ ...state, reviews: [review("mara", "approved", 5)] }, ctx({ now: T0 + 5 * MIN }));
    expect(kinds(step)).toEqual(["c1:denied", "c2:approved", "c3:approved"]);
  });
});

describe("who counts", () => {
  it("shows anyone's comment, and lets only an account with write access start the window", () => {
    const step = settleRemote(open({ comments: [comment("drive-by", "nice", 1, { canWrite: false })] }), ctx({ now: T0 + 60 * MIN }));
    expect(step).toMatchObject({ kind: "waiting" });
    expect((step as { settleAt?: number }).settleAt).toBeUndefined();
    expect((step as { notes: Array<{ body: string }> }).notes.map((n) => n.body)).toEqual(["nice"]);
  });

  it("does not let an account without write access settle a gate — by word or by approval", () => {
    const state = open({ comments: [comment("drive-by", "approve", 1, { canWrite: false })], reviews: [review("drive-by", "approved", 2, { canWrite: false })] });
    expect(settleRemote(state, ctx()).kind).toBe("waiting");
  });

  it("ignores the token's own account entirely: JaiRA's own comments are never events", () => {
    const state = open({
      comments: [comment("jaira-bot", "Opened by JaiRA for review.", 1, { own: true }), comment("jaira-bot", "approve", 2, { own: true })],
      threads: [thread("src/cache.ts", 2, [comment("jaira-bot", "Fixed in the next push.", 3, { own: true })])],
    });
    const step = settleRemote(state, ctx({ now: T0 + 60 * MIN }));
    expect(step.kind).toBe("waiting");
    expect((step as { settleAt?: number }).settleAt).toBeUndefined();
    // A thread only JaiRA wrote on does not "touch" its change.
    expect(kinds(step)).toEqual(["c1:approved", "c2:approved", "c3:approved"]);
  });
});

describe("threads as notes", () => {
  it("maps an inline thread onto a ReviewNote on that change's decision: quote, side, author, replies", () => {
    const step = settleRemote(
      open({
        reviews: [review("mara", "changes_requested", 5)],
        threads: [thread("src/cache.ts", 2, [comment("mara", "This ignores the architecture.", 1), comment("jaira-bot", "Fixed in the next push.", 2, { own: true })])],
      }),
      ctx(),
    );
    expect(settledOf(step).decisions[0]).toEqual({
      id: "c1",
      decision: "comment",
      notes: [
        {
          artifact: "c1",
          quote: "B",
          side: "after",
          body: "This ignores the architecture.",
          author: "mara",
          at: at(1),
          replies: [{ body: "Fixed in the next push.", author: "jaira-bot", at: at(2) }],
          // The forge's own id for the thread, so a later state can reply on it.
          thread: expect.stringMatching(/^t\d+$/),
        },
      ],
    });
    // And where it came from, when the caller says which forge this is.
    const marked = settleRemote(open({ reviews: [review("mara", "changes_requested", 5)], threads: [thread("src/cache.ts", 2, [comment("mara", "x", 1)])] }), ctx({ source: "gitlab" }));
    expect(settledOf(marked).decisions[0]!.notes![0]!.source).toBe("gitlab");
  });

  it("leaves a RESOLVED thread as a note and not as an objection", () => {
    const step = settleRemote(open({ reviews: [review("mara", "changes_requested", 5)], threads: [thread("src/cache.ts", 2, [comment("mara", "Typo.", 1)], true)] }), ctx());
    expect(kinds(step)).toEqual(["c1:approved", "c2:approved", "c3:approved"]);
    expect(settledOf(step).decisions[0]!.notes).toHaveLength(1);
  });

  it("files a thread on a path outside the set with the review as a whole", () => {
    const step = settleRemote(open({ reviews: [review("mara", "changes_requested", 5)], threads: [thread("README.md", 1, [comment("mara", "Mention this in the readme.", 1)])] }), ctx());
    expect(settledOf(step).notes.map((n) => [n.artifact, n.body])).toEqual([["$review", "Mention this in the readme."]]);
  });
});

describe("the result", () => {
  it("is today's, plus who settled it and where the request lives", () => {
    const remote = { id: "gitlab.com/mistlabs/jaira!41", provider: "gitlab" as const, host: "gitlab.com", project: "mistlabs/jaira", branch: "jaira/t-1/review", target: "main", number: 41, url: "https://gitlab.com/mistlabs/jaira/-/merge_requests/41", head: "9f3c" };
    const result = resultOfSettlement(settledOf(settleRemote(open({ reviews: [review("mara", "changes_requested", 1)] }), ctx())), remote);
    expect(result).toMatchObject({ decision: "revise", settled_by: { via: "remote", who: "mara", act: "changes_requested" }, remote });
    expect((result["decisions"] as unknown[]).length).toBe(3);
  });

  it("decides nothing per change when there is no changeset — a bare on_remote_event", () => {
    const step = settleRemote(open({ state: "merged" }), ctx({ changeset: undefined }));
    expect(settledOf(step).decisions).toEqual([]);
  });

  it("uses the table's own words when no state restricts the vocabulary, so a guard can read .decision", () => {
    const bare = { seen: [], settleAfterMs: 0, now: T0 };
    expect(settledOf(settleRemote(open({ state: "merged" }), bare)).decision).toBe("approve");
    expect(settledOf(settleRemote(open({ state: "closed" }), bare)).decision).toBe("cut");
    expect(settledOf(settleRemote(open({ reviews: [review("mara", "changes_requested", 1)] }), bare)).decision).toBe("revise");
  });
});
