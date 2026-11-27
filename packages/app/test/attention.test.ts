/**
 * What needs the person, told outside the window (the person, 2026-11-26: "at the OS level, so a
 * notification or perhaps an icon on the taskbar" — mockups 1, 2 and 3 chosen).
 */
import { describe, expect, it } from "vitest";
import type { PushMessage } from "@jaira/shared";
import { AttentionLedger, taskbarOf, toastOf } from "../src/main/attention";
import { BADGE_SIZE, badgeBitmap, badgeText } from "../src/main/badgeIcon";

const question = (requestId: string, options: string[], extra: Record<string, unknown> = {}): PushMessage =>
  ({
    type: "question:requested",
    pending: { requestId, taskId: "t-1", project: "/p", at: 1, questions: [{ question: "Apply the migration?", options: options.map((label) => ({ label })) }], ...extra },
  }) as never;
const input = (taskId: string): PushMessage => ({ type: "interaction:requested", pending: { requestId: `in-${taskId}`, taskId, project: "/p", component: "input", inputs: {} } }) as never;

describe("the ledger", () => {
  it("counts an ask until it is resolved, and tells of it once", () => {
    const ledger = new AttentionLedger();
    expect(ledger.take(question("q1", ["Yes", "No"]))?.kind).toBe("asking");
    expect(ledger.asking.size).toBe(1);
    expect(ledger.take({ type: "question:resolved", requestId: "q1" })).toBeUndefined();
    expect(ledger.asking.size).toBe(0);
  });

  it("counts a recovered ask, or one already open at the start, without telling of it", () => {
    const ledger = new AttentionLedger();
    expect(ledger.take(question("q1", ["Yes"], { recovered: true }))).toBeUndefined();
    ledger.seed([{ requestId: "q2", questions: [], project: "/p", at: 1 }], [], [{ requestId: "g1", taskId: "t", project: "/p", component: "input", inputs: {} } as never]);
    expect([...ledger.asking.keys()]).toEqual(["q1", "q2"]);
  });

  it("tells of a reply only from a conversation it saw working, so a start that re-parks them all is quiet", () => {
    const ledger = new AttentionLedger();
    expect(ledger.take(input("t-a"))).toBeUndefined();
    ledger.take({ type: "session:turn", taskId: "t-a", text: "hi" } as never);
    expect(ledger.take(input("t-a"))?.kind).toBe("replied");
    expect(ledger.take(input("t-a"))).toBeUndefined();
    expect(ledger.asking.size).toBe(0);
  });

  it("keeps a failure and a completion until the window is looked at; a cancel is nothing", () => {
    const ledger = new AttentionLedger();
    expect(ledger.take({ type: "run:finished", taskId: "t-f", status: "failed" })?.kind).toBe("failed");
    expect(ledger.take({ type: "run:finished", taskId: "t-d", status: "completed" })).toBeUndefined();
    expect(ledger.take({ type: "run:finished", taskId: "t-c", status: "canceled" })).toBeUndefined();
    expect([ledger.failed.size, ledger.done.size]).toEqual([1, 1]);
    ledger.looked();
    expect([ledger.failed.size, ledger.done.size]).toEqual([0, 0]);
  });
});

describe("the taskbar button", () => {
  const sets = (asking: number, failed: number, done: number) => ({
    asking: new Map(Array.from({ length: asking }, (_, i) => [`q${i}`, {} as never])),
    failed: new Set(Array.from({ length: failed }, (_, i) => `f${i}`)),
    done: new Set(Array.from({ length: done }, (_, i) => `d${i}`)),
  });

  it("badges the asks first, then a failure, then a completion", () => {
    expect(taskbarOf(sets(2, 1, 1), false)).toEqual({ badge: { kind: "asking", count: 2 }, progress: "paused", description: "JaiRA: 2 asking, 1 failed, 1 finished" });
    expect(taskbarOf(sets(0, 1, 1), true)).toMatchObject({ badge: { kind: "failed" }, progress: "error" });
    expect(taskbarOf(sets(0, 0, 3), true)).toMatchObject({ badge: { kind: "done" }, progress: "indeterminate" });
    expect(taskbarOf(sets(0, 0, 0), false)).toEqual({ badge: undefined, progress: "none", description: "" });
  });

  it("draws the badge's text, nine at most", () => {
    expect(badgeText({ kind: "asking", count: 3 })).toBe("3");
    expect(badgeText({ kind: "asking", count: 12 })).toBe("9+");
    expect(badgeText({ kind: "failed" })).toBe("!");
    const pixels = badgeBitmap({ kind: "asking", count: 12 });
    expect(pixels.length).toBe(BADGE_SIZE * BADGE_SIZE * 4);
    const centre = ((BADGE_SIZE / 2) * BADGE_SIZE + 2) * 4;
    expect(pixels[centre + 3]).toBe(255);
  });
});

describe("a toast", () => {
  it("offers a short question's answers as buttons, and Open", () => {
    const item = new AttentionLedger().take(question("q1", ["Yes, apply", "Not yet"]))!;
    const spec = toastOf(item, "Review plan");
    expect(spec.title).toBe("Review plan is asking");
    expect(spec.body).toBe("Apply the migration?");
    expect(spec.buttons.map((b) => b.text)).toEqual(["Yes, apply", "Not yet", "Open"]);
    expect(spec.buttons[0]!.answer).toEqual({ channel: "question:submit", request: { requestId: "q1", answers: { "Apply the migration?": "Yes, apply" } } });
  });

  it("offers Open alone for a question with too many answers to fit", () => {
    const item = new AttentionLedger().take(question("q1", ["a", "b", "c", "d"]))!;
    expect(toastOf(item, undefined).buttons.map((b) => b.text)).toEqual(["Open"]);
  });

  it("allows or denies an approval once", () => {
    const ledger = new AttentionLedger();
    const item = ledger.take({ type: "approval:requested", pending: { requestId: "a1", tool: "Bash", command: "git push", input: {}, project: "/p", at: 1, taskId: "t" } } as never)!;
    const spec = toastOf(item, "Release");
    expect(spec.title).toBe("Release wants to use Bash");
    expect(spec.buttons.map((b) => b.answer)).toEqual([
      { channel: "approval:submit", request: { requestId: "a1", decision: "allow", scope: "once" } },
      { channel: "approval:submit", request: { requestId: "a1", decision: "deny", scope: "once" } },
      { open: true },
    ]);
  });

  it("lets a reply go back to the conversation that answered", () => {
    const ledger = new AttentionLedger();
    ledger.take({ type: "session:turn", taskId: "t-a" } as never);
    expect(toastOf(ledger.take(input("t-a"))!, "Fix the picker")).toMatchObject({ title: "Fix the picker replied", reply: { taskId: "t-a", project: "/p" } });
  });
});
