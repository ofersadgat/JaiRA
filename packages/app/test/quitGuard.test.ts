/**
 * Quitting with work going (the person, 2026-11-12): with nothing working the quit goes as before;
 * otherwise the person is asked — wait, then quit; quit now; cancel — in the window, or in the OS's box
 * when the window cannot draw or did not. Work parked on the person or the world never holds a wait.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuitChoice, QuitState, RunningWork } from "@jaira/shared";
import { QuitGuard, blockingOf, quitStep, type QuitGuardOptions } from "../src/main/quitGuard";
import { nativeQuitWords, quitWaitingWords, quitWordsOf } from "../src/renderer/quitModel";

const run = (taskId: string, waiting?: RunningWork["waiting"]): RunningWork => ({
  taskId,
  project: "C:/work/demo",
  title: `Task ${taskId}`,
  kind: "run",
  ...(waiting !== undefined ? { waiting } : {}),
});
const turn = (taskId: string, waiting?: RunningWork["waiting"]): RunningWork => ({ ...run(taskId, waiting), kind: "turn" });

describe("quitStep", () => {
  it("quits at once with nothing working, parked work included", () => {
    expect(quitStep([])).toBe("quit");
    expect(quitStep([run("a", "person"), turn("b", "person"), run("c", "event")])).toBe("quit");
  });

  it("asks with anything working", () => {
    expect(quitStep([run("a")])).toBe("ask");
    expect(quitStep([turn("a"), run("b", "person")])).toBe("ask");
  });

  it("answers the three choices", () => {
    const busy = [run("a"), run("b", "person")];
    expect(quitStep(busy, "now")).toBe("quit");
    expect(quitStep(busy, "cancel")).toBe("stay");
    expect(quitStep(busy, "wait")).toBe("wait");
    expect(quitStep([run("b", "person")], "wait")).toBe("quit");
  });

  it("holds a quit only for what is working", () => {
    expect(blockingOf([run("a"), turn("b", "person"), run("c", "event"), turn("d")]).map((w) => w.taskId)).toEqual(["a", "d"]);
  });
});

describe("the dialog's words", () => {
  it("lists what is working first, five rows, then how many more", () => {
    const work = [run("p", "person"), ...["1", "2", "3", "4", "5", "6"].map((id) => run(id))];
    const words = quitWordsOf(work);
    expect(words.rows.map((r) => r.title)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
    expect(words.more).toBe(2);
    expect(words.note).toContain("6 still running");
    expect(words.note).toContain("1 waiting on you or an event is not waited for");
    expect(words.buttons.map((b) => b.label)).toEqual(["Wait for them to finish, then quit", "Quit now", "Cancel"]);
  });

  it("names what each is and where, and a parked one's wait", () => {
    const words = quitWordsOf([turn("a"), run("b", "person")]);
    expect(words.rows[0]).toMatchObject({ detail: "Chat \u00b7 demo", status: "running" });
    expect(words.rows[1]).toMatchObject({ detail: "Workflow run \u00b7 demo", status: "waiting on you" });
    expect(words.buttons[0]!.label).toBe("Wait for it to finish, then quit");
  });

  it("says the same in the OS's box, cancel by its own button", () => {
    const words = nativeQuitWords([run("a"), run("b", "event")]);
    expect(words.choices).toEqual(["wait", "now", "cancel"]);
    expect(words.detail).toContain("Task a (Workflow run \u00b7 demo)");
    expect(words.detail).toContain("Task b (Workflow run \u00b7 demo, waiting on an event)");
  });

  it("counts only what is working in the strip", () => {
    expect(quitWaitingWords([run("a"), run("b"), run("c", "person")])).toBe("Quitting when 2 running finish\u2026");
    expect(quitWaitingWords([turn("a")])).toBe("Quitting when 1 running finishes\u2026");
  });
});

/** A guard over scripted work; `published` is every state the window was told. */
function guard(work: RunningWork[], extra: Partial<QuitGuardOptions> = {}) {
  const now = { work };
  const published: QuitState[] = [];
  const quits: number[] = [];
  const native: RunningWork[][] = [];
  let nativeAnswer: ((choice: QuitChoice) => void) | undefined;
  const g = new QuitGuard({
    work: async () => now.work,
    quit: () => quits.push(1),
    publish: (state) => published.push(state),
    canDraw: () => true,
    askNatively: (w) => {
      native.push(w);
      return new Promise<QuitChoice>((resolve) => {
        nativeAnswer = resolve;
      });
    },
    pollMs: 100,
    shownWithinMs: 1000,
    ...extra,
  });
  return { g, now, published, quits, native, answerNatively: (choice: QuitChoice) => nativeAnswer?.(choice) };
}

describe("QuitGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a quit with nothing working go, asking nothing", async () => {
    const { g, quits, published } = guard([run("a", "person")]);
    expect(g.allows()).toBe(false);
    await g.request();
    expect(quits).toHaveLength(1);
    expect(g.allows()).toBe(true);
    expect(published.every((s) => s.phase === "idle")).toBe(true);
  });

  it("asks once with work going; a second attempt draws the same question", async () => {
    const { g, quits, published } = guard([run("a")]);
    await g.request();
    g.shown();
    await g.request();
    expect(quits).toHaveLength(0);
    expect(published.map((s) => s.phase)).toEqual(["asking", "asking"]);
    expect(g.current().work.map((w) => w.taskId)).toEqual(["a"]);
  });

  it("Quit now quits; Cancel stays, and the next attempt asks again", async () => {
    const a = guard([run("a")]);
    await a.g.request();
    await a.g.answer("now");
    expect(a.quits).toHaveLength(1);

    const b = guard([run("a")]);
    await b.g.request();
    await b.g.answer("cancel");
    expect(b.quits).toHaveLength(0);
    expect(b.g.current().phase).toBe("idle");
    expect(b.g.allows()).toBe(false);
    await b.g.request();
    expect(b.g.current().phase).toBe("asking");
  });

  it("Wait quits once nothing is working, and a run that stops to ask the person does not hold it", async () => {
    vi.useFakeTimers();
    const { g, now, quits, published } = guard([run("a"), turn("b")]);
    await g.request();
    await g.answer("wait");
    expect(g.current().phase).toBe("waiting");
    now.work = [turn("b")];
    await vi.advanceTimersByTimeAsync(100);
    expect(published.at(-1)).toMatchObject({ phase: "waiting", work: [turn("b")] });
    expect(quits).toHaveLength(0);
    // An attempt while waiting changes nothing: no second dialog.
    await g.request();
    expect(g.current().phase).toBe("waiting");
    now.work = [turn("b", "person")];
    await vi.advanceTimersByTimeAsync(100);
    expect(quits).toHaveLength(1);
    expect(g.allows()).toBe(true);
  });

  it("Don't quit while waiting stops waiting", async () => {
    vi.useFakeTimers();
    const { g, quits } = guard([run("a")]);
    await g.request();
    await g.answer("wait");
    await g.answer("cancel");
    await vi.advanceTimersByTimeAsync(1000);
    expect(quits).toHaveLength(0);
    expect(g.current().phase).toBe("idle");
  });

  it("Wait with nothing left working by then quits at once", async () => {
    const { g, now, quits } = guard([run("a")]);
    await g.request();
    now.work = [];
    await g.answer("wait");
    expect(quits).toHaveLength(1);
  });

  it("asks in the OS's box when there is no window to draw it", async () => {
    const { g, native, quits, published, answerNatively } = guard([run("a")], { canDraw: () => false });
    await g.request();
    expect(native).toHaveLength(1);
    expect(published).toHaveLength(0);
    answerNatively("now");
    await vi.waitFor(() => expect(quits).toHaveLength(1));
  });

  it("asks in the OS's box when the window did not say it drew the question", async () => {
    vi.useFakeTimers();
    const { g, native } = guard([run("a")]);
    await g.request();
    await vi.advanceTimersByTimeAsync(999);
    expect(native).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(native).toHaveLength(1);
  });

  it("does not, once the window drew it", async () => {
    vi.useFakeTimers();
    const { g, native } = guard([run("a")]);
    await g.request();
    g.shown();
    await vi.advanceTimersByTimeAsync(5000);
    await g.request();
    await vi.advanceTimersByTimeAsync(5000);
    expect(native).toHaveLength(0);
  });

  it("a quit the app asks for itself is not asked about", () => {
    const { g } = guard([run("a")]);
    g.letGo();
    expect(g.allows()).toBe(true);
  });

  it("an engine that cannot say what is going does not keep the app from quitting", async () => {
    const { g, quits } = guard([], { work: async () => Promise.reject(new Error("gone")) });
    await g.request();
    expect(quits).toHaveLength(1);
  });
});
