/**
 * Event notices in the inbox strip (decision 0010 §4; the approved mockup's option A): the newest
 * unread notice sits quietly at the strip's right end with "+N" for the older unread ones, × reads it
 * and the next takes its place, and none of it is counted in "Awaiting you". The model is pure, and
 * that is what is held here; the strip that draws it is the universal tree's.
 */
import { describe, expect, it } from "vitest";
import { defaultUiState, eventRef, type EventsNotice, type InstanceNode, type PendingInteraction } from "@jaira/shared/browser";
import { awaitingCount, noticeAge, noticeMeta, noticeTitle, noticeToShow, unreadNotices, withNoticeRead } from "../src/renderer/noticesModel";
import { surfaceKindOf } from "../src/renderer/stateSurfaceModel";
import { toldOf } from "../src/renderer/runConversationModel";
import { dropEchoedTransitions, type BandNote } from "../src/renderer/sessionBands";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DIR = "C:\\work\\app";

const notice = (id: string, minutesAgo: number, patch: Partial<EventsNotice> = {}): EventsNotice => ({
  id,
  project: DIR,
  taskId: "ev1",
  text: `notice ${id}`,
  at: NOW - minutesAgo * MIN,
  ...patch,
});

const checks = notice("ev1/i3/0", 2, { text: "Checks failed on main", event: "pipeline.failed", ref: "a1b2c3d", summary: "pipeline.failed a1b2c3d on main", key: "checks_red", stateId: "system/events/checks_red", instanceId: "i3", call: 0 });
const review = notice("ev1/i2/1", 60, { text: "Review started for Add GitLab device sign-in", event: "merge_request.opened", ref: "!42" });
const release = notice("ev1/i1/0", 180, { text: "Release branch pushed", event: "git.pushed", ref: "77e0c1a" });
/** Oldest first, as main keeps them. */
const backlog = [release, review, checks];

describe("which notice the strip shows", () => {
  it("the newest unread, with the older unread ones counted behind it", () => {
    expect(noticeToShow(backlog, {})).toEqual({ notice: checks, more: 2 });
    expect(unreadNotices(backlog, {}).map((n) => n.id)).toEqual([checks.id, review.id, release.id]);
  });

  it("none with nothing unread, or nothing at all", () => {
    expect(noticeToShow([], {})).toBeUndefined();
    const read = Object.fromEntries(backlog.map((n) => [n.id, n.at]));
    expect(noticeToShow(backlog, read)).toBeUndefined();
  });

  it("× reads the one shown, and the next unread takes its place — until none is left", () => {
    let ui = defaultUiState();
    ui = withNoticeRead(ui, checks, backlog);
    expect(noticeToShow(backlog, ui.noticesRead)).toEqual({ notice: review, more: 1 });
    ui = withNoticeRead(ui, review, backlog);
    expect(noticeToShow(backlog, ui.noticesRead)).toEqual({ notice: release, more: 0 });
    ui = withNoticeRead(ui, release, backlog);
    expect(noticeToShow(backlog, ui.noticesRead)).toBeUndefined();
  });

  it("a new notice arriving after a dismissal is shown on top, the dismissed one staying read", () => {
    const ui = withNoticeRead(defaultUiState(), checks, backlog);
    const later = notice("ev1/i4/0", 0, { text: "Another push" });
    expect(noticeToShow([...backlog, later], ui.noticesRead)).toEqual({ notice: later, more: 2 });
  });

  it("leaves out a notice from a project the window no longer has open", () => {
    const elsewhere = notice("ev9/i1/0", 0, { project: "C:\\work\\closed" });
    expect(noticeToShow([...backlog, elsewhere], {}, (p) => p === DIR)?.notice).toBe(checks);
  });

  it("reading keeps the marks to what main still holds, and reading twice changes nothing", () => {
    const ui = { ...defaultUiState(), noticesRead: { "gone/x/0": 1, [release.id]: release.at } };
    const next = withNoticeRead(ui, checks, backlog);
    expect(next.noticesRead).toEqual({ [release.id]: release.at, [checks.id]: checks.at });
    expect(withNoticeRead(next, checks, backlog)).toBe(next);
  });
});

describe("what the item says", () => {
  it("the event, which one, and how long ago — in the faint data line", () => {
    expect(noticeMeta(checks, NOW)).toBe("pipeline.failed a1b2c3d · 2 m");
    expect(noticeMeta(review, NOW)).toBe("merge_request.opened !42 · 1 h");
    expect(noticeMeta(notice("x", 0), NOW)).toBe("now");
    expect([noticeAge(NOW - 30_000, NOW), noticeAge(NOW - 59 * MIN, NOW), noticeAge(NOW - 3 * 24 * 60 * MIN, NOW)]).toEqual(["now", "59 m", "3 d"]);
  });

  it("which one: a commit's short sha, a request's number as its forge writes it, nothing for a task's end", () => {
    expect(eventRef({ name: "git.pushed", payload: { after: "a1b2c3d4e5f6", branch: "main" } })).toBe("a1b2c3d");
    expect(eventRef({ name: "pipeline.failed", payload: { sha: "77e0c1a99", ref: "main" } })).toBe("77e0c1a");
    expect(eventRef({ name: "merge_request.opened", payload: { host: "gitlab.com", merge_request: { number: 42 } } })).toBe("!42");
    expect(eventRef({ name: "merge_request.opened", payload: { host: "github.com", merge_request: { number: 7 } } })).toBe("#7");
    expect(eventRef({ name: "task.finished", payload: { title: "x" } })).toBeUndefined();
  });
});

describe("the strip", () => {
  const gate = { requestId: "r1", taskId: "t1", project: DIR, component: "confirm_action", config: { prompt: "Accept this review of !42?" } } as unknown as PendingInteraction;

  it("with a notice: the count is still only what awaits you", () => {
    // One gate awaiting and three notices unread: the pill says 1, and the notices are the "+2" behind
    // the one shown — never added to it.
    expect(noticeToShow(backlog, {})).toEqual({ notice: checks, more: 2 });
    expect(awaitingCount({ pending: [gate], approvals: [], questions: [] })).toBe(1);
  });

  it("the item's label says what it says, who told it and what a click does", () => {
    expect(noticeTitle(checks)).toBe("Checks failed on main — told by the events task (checks_red) · pipeline.failed a1b2c3d on main. Opens its conversation at that step.");
    // No automation recorded and no summary handed: it says what it knows.
    expect(noticeTitle(release)).toBe("Release branch pushed — told by the events task. Opens its conversation at that step.");
  });

  it("with a notice alone: nothing is counted, so there is no 'Awaiting you' to say 0", () => {
    const read = { [checks.id]: checks.at, [review.id]: review.at };
    expect(noticeToShow(backlog, read)).toEqual({ notice: release, more: 0 });
    expect(awaitingCount({ pending: [], approvals: [], questions: [] })).toBe(0);
  });
});

describe("in the events conversation", () => {
  const node = (patch: Partial<InstanceNode> = {}): InstanceNode => ({ instanceId: "i1", stateId: "system/events/deploy_done", status: "completed", index: 0, superseded: false, startedAt: 0, children: [], operation: { kind: "function", status: "completed" }, ...patch });

  it("a function the shape says asks nobody is a CALL, not a question; without a shape it still reads as asked", () => {
    expect(surfaceKindOf(node({ plainCall: true }))).toBe("called");
    expect(surfaceKindOf(node())).toBe("asked");
  });

  it("a settled notify is one told line — its answer's text and event", () => {
    const call = { name: "notify", ref: "notify", kind: "function", args: { text: "Deploy finished" }, status: "completed" };
    expect(toldOf({ ...call, result: { text: "Deploy finished", event: 'task.finished "Deploy 0.14.1"' } })).toEqual({ text: "Deploy finished", about: 'task.finished "Deploy 0.14.1"' });
    expect(toldOf({ ...call, result: { text: "Deploy finished" } })).toEqual({ text: "Deploy finished" });
    expect(toldOf({ ...call, status: "failed", error: { reason: "x" } })).toBeUndefined();
    expect(toldOf({ ...call, name: "start_task" })).toBeUndefined();
  });

  it("one row per firing: a transition into a child that the entry right after it names is not drawn twice", () => {
    const notes: BandNote[] = [
      { seq: 1, at: 0, kind: "transition", path: "plan_failed", text: "plan_failed" },
      { seq: 2, at: 0, kind: "entered", path: "plan_failed", instanceId: "i2", text: "" },
      { seq: 3, at: 0, kind: "transition", path: "terminate.success", text: "terminate.success" },
    ];
    expect(dropEchoedTransitions(notes).map((n) => n.seq)).toEqual([2, 3]);
  });
});
