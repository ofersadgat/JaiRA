/**
 * The phone's layout (decision 0015, amended 2026-10-04): when a window is a phone's, its text, the
 * context panel's sheet — its heights and where a drag lets it go — the board's column strip, and the
 * Inbox room's items.
 */
import { describe, expect, it } from "vitest";
import type { PendingApproval, PendingInteraction, PendingQuestion } from "@jaira/shared/browser";
import { inboxItemsOf } from "../src/renderer/inboxModel";
import { ancestorsOf, dragHeight, drawerSettles, isPhoneWidth, phoneTypography, railAt, railPull, scrubRow, settleSheet, sheetHeights, shownOf, stackedParts, swipeColumn, type StripColumn } from "../src/renderer/phoneModel";

describe("a phone's window", () => {
  it("is one narrower than 700", () => {
    expect(isPhoneWidth(390)).toBe(true);
    expect(isPhoneWidth(699)).toBe(true);
    expect(isPhoneWidth(700)).toBe(false);
    expect(isPhoneWidth(0)).toBe(false);
  });
  it("scales the two text bases, from the person's own sizes where set", () => {
    expect(phoneTypography({})).toEqual({ "size-app": "14.5px", "size-data": "13.92px" });
    expect(phoneTypography({ "size-app": "14px", "font-app": "X" })).toEqual({ "size-app": "16.24px", "size-data": "13.92px", "font-app": "X" });
    expect(phoneTypography({ "size-editor": "10px" })["size-editor"]).toBe("11.6px");
  });
});

describe("the sheet", () => {
  const h = sheetHeights(700, 90);
  it("has its header, half the room, and all but a strip", () => {
    expect(h).toEqual({ peek: 90, half: 364, full: 690 });
    expect(sheetHeights(100, 300)).toEqual({ peek: 90, half: 90, full: 90 });
  });
  it("settles at the nearest height when let go slowly", () => {
    expect(settleSheet(120, 0, h, true)).toBe("peek");
    expect(settleSheet(300, 0, h, true)).toBe("half");
    expect(settleSheet(600, 0, h, true)).toBe("full");
  });
  it("goes one height on when flicked", () => {
    expect(settleSheet(120, -1, h, true)).toBe("half");
    expect(settleSheet(370, -1, h, true)).toBe("full");
    expect(settleSheet(600, 1, h, true)).toBe("half");
    expect(settleSheet(360, 1, h, true)).toBe("peek");
  });
  it("moves into the main view dragged past the top, where there is one", () => {
    expect(settleSheet(690 + 60, 0, h, true)).toBe("main");
    expect(settleSheet(690 + 60, 0, h, false)).toBe("full");
    expect(settleSheet(695, -1, h, true)).toBe("main");
    expect(settleSheet(695, -1, h, false)).toBe("full");
  });
  it("closes dragged down past its header", () => {
    expect(settleSheet(20, 0, h, true)).toBe("close");
    expect(settleSheet(80, 1, h, true)).toBe("close");
  });
  it("follows the finger, with give past the top only where it means something", () => {
    expect(dragHeight(364, -100, h, true)).toBe(464);
    expect(dragHeight(690, -400, h, true)).toBeCloseTo(690 + 40 * 1.6);
    expect(dragHeight(690, -400, h, false)).toBe(702);
    expect(dragHeight(90, 400, h, true)).toBe(0);
  });
});

describe("the board's strip", () => {
  const cols: StripColumn[] = [
    { key: "a", label: "Control", count: 0 },
    { key: "b", label: "Hello", count: 0 },
    { key: "c", label: "Session", count: 3 },
    { key: "d", label: "Events", count: 0 },
  ];
  it("folds consecutive empty columns into one line", () => {
    expect(stackedParts(cols).map((p) => (p.kind === "column" ? p.column.key : p.columns.map((c) => c.column.key).join("+")))).toEqual(["a+b", "c", "d"]);
  });
  it("swipes from All to the first column and back, and stops at the last", () => {
    expect(swipeColumn(cols, "all", 1)).toEqual({ column: "a" });
    expect(swipeColumn(cols, { column: "a" }, -1)).toBe("all");
    expect(swipeColumn(cols, { column: "d" }, 1)).toEqual({ column: "d" });
    expect(swipeColumn(cols, "all", -1)).toBe("all");
    expect(swipeColumn([], { column: "x" }, 1)).toBe("all");
  });
  it("shows All when the column shown is gone", () => {
    expect(shownOf({ column: "z" }, cols)).toBe("all");
    expect(shownOf({ column: "c" }, cols)).toEqual({ column: "c" });
  });
});

describe("the Inbox", () => {
  it("lists every question, approval and gate, in the strip's order", () => {
    const questions = [{ requestId: "q", questions: [{ question: "Which one?" }, { question: "And then?" }], taskId: "t1", project: "/p", at: 1 }] as unknown as PendingQuestion[];
    const approvals = [{ requestId: "a", tool: "Bash", command: "git push", reason: "pushes", taskId: "t2", project: "/p" }] as unknown as PendingApproval[];
    const pending = [{ requestId: "g", taskId: "t3", project: "/p", component: "choose_option", config: { prompt: "Review the critique result." } }] as unknown as PendingInteraction[];
    expect(inboxItemsOf({ pending, approvals, questions })).toEqual([
      { key: "q", kind: "question", heading: "The agent has 2 questions", text: "Which one?", detail: "And then?", taskId: "t1", project: "/p" },
      { key: "a", kind: "approval", heading: "Approve this command?", text: "git push", detail: "pushes", taskId: "t2", project: "/p" },
      { key: "g", kind: "gate", heading: "Choose one", text: "Review the critique result.", taskId: "t3", project: "/p" },
    ]);
  });
});

describe("the Steps rail", () => {
  it("is pulled out by a finger moving left, and held to its two ends", () => {
    expect(railPull(0, -135)).toBeCloseTo(0.5);
    expect(railPull(1, 400)).toBe(0);
    expect(railPull(0, -900)).toBe(1);
  });
  it("widens, spreads its lanes and brings its rows in as it comes out", () => {
    expect(railAt(0)).toEqual({ width: 30, squeeze: 0.22, fade: 0 });
    expect(railAt(1)).toEqual({ width: 300, squeeze: 1, fade: 1 });
    expect(railAt(0.5).width).toBe(165);
  });
  it("finds the row under the finger", () => {
    expect(scrubRow(0, 300, 10)).toBe(0);
    expect(scrubRow(299, 300, 10)).toBe(9);
    expect(scrubRow(-20, 300, 10)).toBe(0);
    expect(scrubRow(900, 300, 10)).toBe(9);
    expect(scrubRow(10, 0, 10)).toBe(0);
  });
  it("names a state's ancestors, outermost first", () => {
    const nodes = [
      { instanceId: "a", stateId: "feature/plan" },
      { instanceId: "b", stateId: "critique", parentInstanceId: "a" },
      { instanceId: "c", stateId: "human_review", parentInstanceId: "b" },
    ];
    const byId = new Map(nodes.map((n) => [n.instanceId, n]));
    expect(ancestorsOf(nodes[2]!, byId, (n) => n.stateId)).toEqual(["feature/plan", "critique"]);
    expect(ancestorsOf(nodes[0]!, byId, (n) => n.stateId)).toEqual([]);
  });
});

describe("the drawer", () => {
  it("opens past a third of the way, or on a flick to the right", () => {
    expect(drawerSettles(120, 0, 330)).toBe(true);
    expect(drawerSettles(100, 0, 330)).toBe(false);
    expect(drawerSettles(40, 0.8, 330)).toBe(true);
    expect(drawerSettles(300, -0.8, 330)).toBe(false);
  });
});
