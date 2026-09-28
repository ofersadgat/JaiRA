/**
 * Event notices in the inbox strip (decision 0010 §4; the approved mockup's option A): the newest
 * unread notice sits quietly at the strip's right end with "+N" for the older unread ones, × reads it
 * and the next takes its place, and none of it is counted in "Awaiting you". The model is pure; the
 * strip is rendered to static markup, where the claims are structural.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultUiState, eventRef, type EventsNotice, type InstanceNode, type PendingInteraction, type ProjectSummary } from "@jaira/shared/browser";
import { awaitingCount, noticeAge, noticeMeta, noticeToShow, unreadNotices, withNoticeRead, type ShownNotice } from "../src/renderer/noticesModel";
import { InboxStrip } from "../src/renderer/inboxStrip";
import { surfaceKindOf } from "../src/renderer/stateSurface";
import { toldOf } from "../src/renderer/runViews";
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

const checks = notice("ev1/i3/0", 2, { text: "Checks failed on main", event: "git.checks.failed", ref: "a1b2c3d", summary: "git.checks.failed a1b2c3d on main", key: "checks_red", stateId: "system/events/checks_red", instanceId: "i3", call: 0 });
const review = notice("ev1/i2/1", 60, { text: "Review started for Add GitLab device sign-in", event: "git.merge_request.opened", ref: "!42" });
const release = notice("ev1/i1/0", 180, { text: "Release branch pushed", event: "git.push", ref: "77e0c1a" });
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
    expect(noticeMeta(checks, NOW)).toBe("git.checks.failed a1b2c3d · 2 m");
    expect(noticeMeta(review, NOW)).toBe("git.merge_request.opened !42 · 1 h");
    expect(noticeMeta(notice("x", 0), NOW)).toBe("now");
    expect([noticeAge(NOW - 30_000, NOW), noticeAge(NOW - 59 * MIN, NOW), noticeAge(NOW - 3 * 24 * 60 * MIN, NOW)]).toEqual(["now", "59 m", "3 d"]);
  });

  it("which one: a commit's short sha, a request's number as its forge writes it, nothing for a task's end", () => {
    expect(eventRef({ name: "git.push", payload: { after: "a1b2c3d4e5f6", branch: "main" } })).toBe("a1b2c3d");
    expect(eventRef({ name: "git.checks.failed", payload: { sha: "77e0c1a99", ref: "main" } })).toBe("77e0c1a");
    expect(eventRef({ name: "git.merge_request.opened", payload: { host: "gitlab.com", merge_request: { number: 42 } } })).toBe("!42");
    expect(eventRef({ name: "git.merge_request.opened", payload: { host: "github.com", merge_request: { number: 7 } } })).toBe("#7");
    expect(eventRef({ name: "task.finished", payload: { title: "x" } })).toBeUndefined();
  });
});

describe("the strip", () => {
  const projects: ProjectSummary[] = [{ project: DIR, label: "app", kind: "user", tasks: 0, running: 0, statuses: {}, waiting: 0, ended: [] }];
  const hues = { [DIR]: "var(--p1)" };
  const gate = { requestId: "r1", taskId: "t1", project: DIR, component: "confirm_action", config: { prompt: "Accept this review of !42?" } } as unknown as PendingInteraction;
  /** `null`: no notice to show. */
  const draw = (pending: PendingInteraction[], shown: ShownNotice | null = noticeToShow(backlog, {}) ?? null): string =>
    renderToStaticMarkup(createElement(InboxStrip, { pending, approvals: [], questions: [], projects, hues, onSelect: () => undefined, notice: shown ?? undefined, now: NOW }));

  it("is not drawn with nothing awaiting and no notice", () => {
    expect(draw([], null)).toBe("");
  });

  it("without a notice: only what is awaiting you, as before", () => {
    const html = draw([gate], null);
    expect(html).toContain("Awaiting you");
    expect(html).toContain("Accept this review of !42?");
    expect(html).not.toContain("strip-notice");
    expect(html).not.toContain('class="spacer"');
  });

  it("with a notice: one quiet item after a spacer — bell, chip, text, meta, +N, × — and the count is still only what awaits you", () => {
    const html = draw([gate]);
    expect(html).toMatch(/<span class="pill-n">1<\/span>/);
    expect(awaitingCount({ pending: [gate], approvals: [], questions: [] })).toBe(1);
    // After everything awaiting, behind a spacer.
    expect(html.indexOf('class="spacer"')).toBeGreaterThan(html.indexOf("Accept this review"));
    expect(html.indexOf('class="strip-notice"')).toBeGreaterThan(html.indexOf('class="spacer"'));
    const item = html.slice(html.indexOf('class="strip-notice"'));
    expect(item).toContain("🔔");
    expect(item).toMatch(/class="chip strip-project"[^>]*>app</);
    expect(item).toContain('<span class="strip-notice-text">Checks failed on main</span>');
    expect(item).toContain('<span class="strip-notice-meta data-faint">git.checks.failed a1b2c3d · 2 m</span>');
    expect(item).toMatch(/class="strip-notice-more app-secondary"[^>]*>\+2</);
  });

  it("the item is a button with a label, and × is a button of its own with its own", () => {
    const item = draw([gate]).slice(0);
    expect(item).toMatch(/<button type="button" class="strip-notice-open"[^>]*aria-label="Notice from app: Checks failed on main — told by the events task \(checks_red\)/);
    expect(item).toMatch(/<button type="button" class="quiet strip-dismiss"[^>]*aria-label="Dismiss this notice"[^>]*>×<\/button>/);
    // Side by side, not one inside the other.
    expect(item).toMatch(/<\/button><button type="button" class="quiet strip-dismiss"/);
  });

  it("with a notice alone: drawn, without an 'Awaiting you' that would say 0", () => {
    const html = draw([], { notice: release, more: 0 });
    expect(html).toContain("Release branch pushed");
    expect(html).not.toContain("Awaiting you");
    expect(html).not.toContain("pill-n");
    expect(html).not.toContain("strip-notice-more");
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
