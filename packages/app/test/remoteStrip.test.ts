/**
 * What the gate's second door SAYS (decision 0004, "What draws").
 *
 * The renderer has no DOM test infrastructure, so every sentence the strip, the settled-by line and
 * the board card draw is computed by a pure function and pinned here.
 */
import { describe, expect, it } from "vitest";
import type { RemoteStatusView, ReviewNote, ReviewRemote } from "@jaira/shared";
import { waitingKindOf } from "../src/renderer/board";
import { agoLabel, cardRemoteWord, commentersLine, mergeForgeNotes, requestLabel, settledByLines, stripWords } from "../src/renderer/remoteStrip";

const NOW = Date.parse("2026-09-19T11:14:00");
const remote: ReviewRemote = { provider: "gitlab", host: "gitlab.com", project: "mistlabs/jaira", number: 41, url: "https://gitlab.com/mistlabs/jaira/-/merge_requests/41", branch: "jaira/t-qfr49rm80m/review", target: "main", key: "review" };
const status = (extra: Partial<RemoteStatusView> = {}): RemoteStatusView => ({ key: "review", provider: "gitlab", host: "gitlab.com", project: "mistlabs/jaira", branch: remote.branch!, target: "main", number: 41, url: remote.url!, awaiting: true, commenters: [], ...extra });

describe("the remote strip", () => {
  it("names the request the way its forge writes it, and says which branch goes where", () => {
    expect(stripWords(remote, undefined, NOW)).toEqual({ forge: "GitLab", label: "mistlabs/jaira !41", href: remote.url, branch: "jaira/t-qfr49rm80m/review → main" });
    expect(requestLabel({ provider: "github", project: "ofersadgat/JaiRA", number: 7 })).toBe("ofersadgat/JaiRA #7");
  });

  it("says who has spoken there, and nothing when nobody has", () => {
    expect(commentersLine([])).toBeUndefined();
    expect(commentersLine(["mara"])).toBe("mara commented");
    expect(commentersLine(["mara", "dov"])).toBe("mara and dov commented");
    expect(commentersLine(["mara", "dov", "sam", "lee"])).toBe("mara, dov and 2 more commented");
  });

  it("shows the window's DEADLINE only while one is running", () => {
    expect(stripWords(remote, status(), NOW).window).toBeUndefined();
    const running = stripWords(remote, status({ settleAt: NOW + 10 * 60_000, commenters: ["mara", "dov"] }), NOW);
    expect(running.window!.text).toMatch(/^goes back at \d{1,2}:24.* unless someone writes$/);
    expect(running.window!.title).toContain("each new comment restarts it");
    expect(running.who).toBe("mara and dov commented");
    // Past the deadline and not yet read: say what is about to happen, not a time in the past.
    expect(stripWords(remote, status({ settleAt: NOW - 1 }), NOW).window!.text).toBe("going back with what was said");
  });

  it("says when it last looked, coarsely — it is reassurance, not a clock", () => {
    expect(agoLabel(NOW - 40_000, NOW)).toBe("40 s ago");
    expect(agoLabel(NOW - 3 * 60_000, NOW)).toBe("3 min ago");
    expect(agoLabel(NOW - 2 * 3_600_000, NOW)).toBe("2 h ago");
    expect(stripWords(remote, status({ checkedAt: NOW - 40_000 }), NOW).checked).toBe("checked 40 s ago");
  });

  it("when the forge cannot be reached, says so — and that the gate is still answerable here", () => {
    const words = stripWords(remote, status({ error: "reading: the forge answered 502", settleAt: NOW + 60_000 }), NOW);
    expect(words.error).toBe("cannot reach gitlab.com — still answerable here");
    // A deadline nobody can currently hear about is not shown as if it were being kept.
    expect(words.window).toBeUndefined();
  });
});

describe("notes from the forge, in the reviewer", () => {
  const mine: ReviewNote = { artifact: "c1", quote: "two", body: "Say what changed.", author: "Ofer", at: "2026-09-19T10:00:00Z" };
  const theirs = (body: string): ReviewNote => ({ artifact: "c1", quote: "two", body, author: "mara", at: "2026-09-19T10:05:00Z", source: "gitlab", thread: "t1" });

  it("lays the forge's notes over the person's own, which are never touched", () => {
    expect(mergeForgeNotes([mine], [theirs("This ignores the architecture.")])).toEqual([mine, theirs("This ignores the architecture.")]);
  });

  it("REPLACES what came from the forge with what the last read found — a thread changes there", () => {
    const first = mergeForgeNotes([mine], [theirs("first")]);
    expect(mergeForgeNotes(first, [theirs("first, edited, with a reply")])).toEqual([mine, theirs("first, edited, with a reply")]);
    // Resolved and gone on the forge means gone here.
    expect(mergeForgeNotes(first, [])).toEqual([mine]);
  });
});

describe("a gate answered on the forge says so", () => {
  const remoteResult = { provider: "gitlab", project: "mistlabs/jaira", number: 41, target: "main", head: "9f3c1a2b7e" };

  it("merged there: who, and what happened to the worktree and to your own branch", () => {
    expect(
      settledByLines({
        settled_by: { via: "remote", who: "mara", act: "merged" },
        remote: { ...remoteResult, adopted: { reset: true, dropped: "refs/jaira/dropped/t-1/1", target: "fast-forwarded" } },
      }),
    ).toEqual({
      head: "Merged on GitLab by mara",
      lines: [
        { text: "this task's worktree now holds main as merged (9f3c1a2b)" },
        { text: "what it held before is kept under refs/jaira/dropped/t-1/1" },
        { text: "your main was fast-forwarded" },
      ],
    });
  });

  it("says so when your own branch was left alone, and why", () => {
    const said = settledByLines({ settled_by: { via: "remote", who: "mara", act: "merged" }, remote: { ...remoteResult, adopted: { reset: true, target: "left-alone", why: "your main has commits origin/main does not, so it was left alone" } } });
    expect(said!.lines.at(-1)).toEqual({ text: "your main has commits origin/main does not, so it was left alone", warned: true });
  });

  it("has a sentence for each way the forge can settle it", () => {
    const head = (settled_by: Record<string, string>) => settledByLines({ settled_by: { via: "remote", ...settled_by }, remote: remoteResult })!.head;
    expect(head({ act: "approved", who: "sam" })).toBe("Approved on GitLab by sam");
    expect(head({ act: "changes_requested", who: "mara" })).toBe("Changes requested on GitLab by mara");
    expect(head({ act: "decision_word", who: "sam", word: "revise" })).toBe("Answered on GitLab by sam — “revise”");
    expect(head({ act: "quiet", who: "dov" })).toBe("Went back with what was said on GitLab — dov wrote last");
    expect(head({ act: "closed", who: "lee" })).toBe("Closed on GitLab by lee without merging");
  });

  it("says nothing at all for a gate answered here", () => {
    expect(settledByLines({ settled_by: { via: "local", who: "Ofer", act: "answered" } })).toBeUndefined();
    expect(settledByLines({ decisions: [] })).toBeUndefined();
  });
});

describe("the board card", () => {
  it("says where the question is open, instead of claiming it is waiting for you", () => {
    expect(cardRemoteWord({ provider: "gitlab", number: 41, url: "u" })).toBe("in review on GitLab !41");
    expect(cardRemoteWord({ provider: "github", number: 7, url: "u" })).toBe("in review on GitHub #7");
    const card = { taskId: "t", title: "x", status: "running", workflow: "w", activeStatus: "waiting_for_user", activePath: [], hasSubBoard: false, updatedAt: 0 } as never;
    expect(waitingKindOf(card)).toBe("gate");
    expect(waitingKindOf({ ...(card as object), inReview: { provider: "gitlab", number: 41, url: "u" } } as never)).toBe("in review on GitLab !41");
  });
});

describe("replying to a note", () => {
  it("posts on the forge only when the note says where it lives AND how to find it", async () => {
    const { repliesOnForge } = await import("../src/renderer/remoteStrip");
    expect(repliesOnForge({ source: "gitlab", thread: "t1" })).toBe(true);
    // Written here: a reply is a draft, and rides the review when the gate settles.
    expect(repliesOnForge({})).toBe(false);
    // Marked as the forge's but with no thread id to reply on: the reply stays local rather than lost.
    expect(repliesOnForge({ source: "gitlab" })).toBe(false);
  });
});
