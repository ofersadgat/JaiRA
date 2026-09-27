/**
 * The work between two messages, summarised (the tool-summary mockups, 2026-09-25): phases cut at
 * each thought and named by what they did, chips per kind, the phase in progress keeping its latest
 * rows, and the thinking line where the provider kept the reasoning.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { iconOf, type TranscriptEntry, type WorkEntry } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";
import { ApprovalAskContext, WorkLookContext, type WorkLook } from "../src/renderer/workSummaryView";
import { approvalWordsOf, chipsOf, inFlight, phasesOf, runsOf, secondsOf, sentenceOf, spanOf, thoughtLineOf, windowOf, WITHHELD } from "../src/renderer/workSummary";
import { durationOf, thoughtTime } from "../src/renderer/transcriptView";

const t0 = Date.parse("2026-09-25T17:42:08Z");
const call = (name: string, key: string, arg: string, s: number, ok: boolean | undefined = true): WorkEntry => ({
  kind: "tool",
  name,
  summary: arg,
  args: { [key]: arg },
  at: t0 + s * 1000,
  ...(ok === undefined ? {} : { ok, result: ok ? "ok" : { is_error: true } }),
});
const read = (path: string, s: number): WorkEntry => call("Read", "file_path", path, s);
const edit = (path: string, s: number): WorkEntry => call("Edit", "file_path", path, s);
const grep = (pattern: string, s: number): WorkEntry => call("Grep", "pattern", pattern, s);
const bash = (command: string, s: number, ok: boolean | undefined = true): WorkEntry => call("Bash", "command", command, s, ok);
const think = (s: number, text = WITHHELD, ms = 4000): WorkEntry => ({ kind: "thought", at: t0 + s * 1000, text, durationMs: ms });

/** Explore, explore again, change (a test fails), then fix. */
const stretch: WorkEntry[] = [
  think(0),
  grep("scrollbar", 7),
  read("src/renderer/styles.css", 8),
  think(9, "Several columns scroll on their own. Check each before touching the stylesheet."),
  read("src/renderer/chatPane.tsx", 12),
  read("src/renderer/sidePanel.tsx", 13),
  { kind: "event", at: t0 + 14_000, tone: "warn", text: "Rate limited — waited 12 s" },
  think(30),
  edit("src/renderer/styles.css", 34),
  bash("npx vitest run", 40, false),
  think(45),
  edit("test/floatLayers.test.ts", 50),
  bash("npx vitest run", 55),
];

describe("phases", () => {
  it("cuts the stretch at each thought and names each part by what it did", () => {
    expect(phasesOf(stretch, { merge: "none", dropIdle: true }).map((p) => p.name)).toEqual(["Explored", "Explored", "Changed", "Fixed"]);
  });

  it("merges neighbours of one name when asked — what the thinking line would have told apart", () => {
    const merged = phasesOf(stretch, { merge: "all", dropIdle: true });
    expect(merged.map((p) => p.name)).toEqual(["Explored", "Changed", "Fixed"]);
    expect(merged[0]!.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("with the thinking line on, merges a neighbour whose reasoning was withheld — it has no line to tell it apart", () => {
    const told = "Several columns scroll on their own.";
    // Withheld, withheld: one phase, as with the line off.
    expect(phasesOf([think(0), read("a.ts", 1), think(2), read("b.ts", 3)], { merge: "withheld", dropIdle: true }).map((p) => p.indices)).toEqual([[0, 1, 2, 3]]);
    // Told, then withheld: the withheld one joins the told one, whose line heads both.
    const joined = phasesOf([think(0, told), read("a.ts", 1), think(2), read("b.ts", 3)], { merge: "withheld", dropIdle: true });
    expect(joined.map((p) => p.indices)).toEqual([[0, 1, 2, 3]]);
    expect(thoughtLineOf([think(0, told), read("a.ts", 1), think(2), read("b.ts", 3)], joined[0]!.indices)?.first).toBe(told);
    // Withheld, then told: the told one keeps its own line, so it stays apart.
    expect(phasesOf([think(0), read("a.ts", 1), think(2, told), read("b.ts", 3)], { merge: "withheld", dropIdle: true })).toHaveLength(2);
    // Of the stretch, only the withheld neighbours of one name join.
    expect(phasesOf(stretch, { merge: "withheld", dropIdle: true }).map((p) => p.name)).toEqual(["Explored", "Explored", "Changed", "Fixed"]);
  });

  it("leaves out a part that is only rate limits and notes — even when it is the only part", () => {
    const note = (s: number, text: string): WorkEntry => ({ kind: "event", at: t0 + s * 1000, tone: "plain", text });
    const opening: WorkEntry[] = [note(0, "Context injected: CLAUDE.md"), note(0, "Hook ran"), think(1), read("a.ts", 2), read("b.ts", 3)];
    // The notes before the first thought were a part of their own, and did no work: gone.
    expect(phasesOf(opening, { merge: "none", dropIdle: true }).map((p) => p.indices)).toEqual([[2, 3, 4]]);
    // Shown when asked.
    expect(phasesOf(opening, { merge: "none", dropIdle: false })).toHaveLength(2);
    // Alone, it goes too: nothing is left but the foot.
    expect(phasesOf([note(0, "Hook ran"), note(1, "Context injected")], { merge: "none", dropIdle: true })).toHaveLength(0);
    // A thought and a rate limit is still only a rate limit.
    const waiting: WorkEntry[] = [think(0), read("a.ts", 1), think(2), { kind: "event", at: t0 + 3000, tone: "warn", text: "Rate limited — waited 12 s" }];
    expect(phasesOf(waiting, { merge: "none", dropIdle: true })).toHaveLength(1);
  });

  it("calls running what changes nothing Explored the first time and Checked the second", () => {
    const names = (entries: WorkEntry[]) => phasesOf(entries, { merge: "none", dropIdle: true }).map((p) => p.name);
    expect(names([think(0), bash("npm test", 1), bash("npm run lint", 2), read("a.ts", 3)])).toEqual(["Explored"]);
    // The same file read again — another part of it is still the file — and the same line run again.
    expect(names([think(0), read("a.ts", 1), bash("npm test", 2), think(3), bash("npm  test", 4), call("Read", "file_path", "a.ts", 5)])).toEqual(["Explored", "Checked"]);
    // More new than again is still exploring.
    expect(names([think(0), read("a.ts", 1), think(2), read("a.ts", 3), read("b.ts", 4), read("c.ts", 5)])).toEqual(["Explored", "Explored"]);
  });

  it("calls a part that did again what had failed, and got through, Fixed — whatever made the difference", () => {
    const names = (entries: WorkEntry[]) => phasesOf(entries, { merge: "none", dropIdle: true }).map((p) => p.name);
    // No edit between: a script, or the world, may have fixed it. Fixed outranks Changed.
    expect(names([think(0), bash("npm test", 1, false), think(2), bash("npm run setup", 3), bash("npm test", 4)])).toEqual(["Explored", "Fixed"]);
    expect(names([think(0), bash("npm test", 1, false), think(2), edit("a.ts", 3), bash("npm test", 4)])).toEqual(["Explored", "Fixed"]);
    // Still running is not yet through; failing again is not fixed.
    const running: WorkEntry = { kind: "tool", name: "Bash", summary: "npm test", args: { command: "npm test" }, at: t0 + 3000 };
    expect(names([think(0), bash("npm test", 1, false), think(2), running])).toEqual(["Explored", "Checked"]);
    expect(names([think(0), bash("npm test", 1, false), think(2), bash("npm test", 3, false)])).toEqual(["Explored", "Checked"]);
    // What failed once and passed since is not failing any more.
    expect(names([think(0), bash("npm test", 1, false), bash("npm test", 2), think(3), bash("npm test", 4)])).toEqual(["Fixed", "Checked"]);
  });

  it("calls a part Changed by what the read-only permission set says of its calls", () => {
    const verdicts = (entry: { name: string; args?: unknown }): boolean | null | undefined => {
      if (entry.name === "TodoWrite") return null;
      const command = (entry.args as { command?: string } | undefined)?.command;
      return command === undefined ? entry.name === "Read" : !/^git (commit|push)/.test(command);
    };
    const names = (entries: WorkEntry[], judged = true) => phasesOf(entries, { merge: "none", dropIdle: true, ...(judged ? { verdicts } : {}) }).map((p) => p.name);
    expect(names([think(0), bash("git commit -m x", 1)])).toEqual(["Changed"]);
    expect(names([think(0), bash("git status", 1)])).toEqual(["Explored"]);
    // Before the set has answered — or where nothing asks — a call that edits is a change and nothing else is.
    expect(names([think(0), bash("git commit -m x", 1)], false)).toEqual(["Explored"]);
    // A call no set holds is bookkeeping: it is neither new nor again.
    expect(names([think(0), read("a.ts", 1), think(2), read("a.ts", 3), call("TodoWrite", "todos", "x", 4), call("TodoWrite", "todos", "y", 5)])).toEqual(["Explored", "Checked"]);
  });
});

describe("chips", () => {
  it("counts each kind once, files by distinct path, in the order each kind first happened", () => {
    const chips = chipsOf(stretch, [0, 1, 2, 3, 4, 5, 6]);
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ["think", "8 s"],
      ["search", "1 search"],
      ["read", "3 files"],
      ["wait", "12 s wait"],
    ]);
  });

  it("says how many failed, and which chip is running", () => {
    const running = [...stretch.slice(0, 9), bash("npx vitest run", 40, undefined)];
    const chips = chipsOf(running, [8, 9], 9);
    expect(chips.find((c) => c.kind === "run")!.live).toBe(true);
    expect(chipsOf(stretch, [8, 9]).find((c) => c.kind === "run")!.failed).toBe(1);
  });

  it("gives each tool with no family its own chip, by title", () => {
    const tools: WorkEntry[] = [call("mcp__dai__list_merge_requests", "state", "opened", 1), call("mcp__linear__update_issue", "id", "JAI-4", 2)];
    expect(chipsOf(tools, [0, 1]).map((c) => c.label)).toEqual(["List merge requests", "Update issue"]);
  });
});

describe("rows", () => {
  it("merges consecutive calls of one kind, puts a thought on the row after it and a note on the row before", () => {
    const runs = runsOf(stretch, [3, 4, 5, 6]);
    expect(runs).toEqual([{ key: "read", kind: "read", rows: [4, 5], thoughts: [3], notes: [] }, { key: "wait", kind: "wait", rows: [6], thoughts: [], notes: [] }]);
  });

  it("says what a run did, and what the running one is doing now", () => {
    const [run] = runsOf(stretch, [4, 5]);
    expect(sentenceOf(stretch, run!).said).toEqual([{ text: "Read 2 files" }, { text: " in " }, { code: "src/renderer" }]);
    const live = [...stretch.slice(0, 5), { ...read("src/renderer/sidePanel.tsx", 13), ok: undefined, result: undefined } as WorkEntry];
    const said = sentenceOf(live, runsOf(live, [4, 5])[0]!, 5);
    expect(said.said).toEqual([{ text: "Read " }, { code: "chatPane.tsx" }, { text: ", then " }]);
    expect(said.now).toEqual([{ text: "Reading " }, { code: "sidePanel.tsx" }]);
  });

  it("keeps the last N rows of a phase and counts the rest in its chips", () => {
    const phase = [10, 11, 12];
    expect(windowOf(stretch, phase, 1).shown.map((r) => r.rows)).toEqual([[12]]);
    expect(windowOf(stretch, phase, 1).rolled).toEqual([10, 11]);
    expect(windowOf(stretch, phase, 5).rolled).toEqual([]);
    expect(windowOf(stretch, phase, 0).shown).toEqual([]);
  });
});

describe("thinking", () => {
  it("shows the first sentence of reasoning that was kept, and nothing for reasoning withheld", () => {
    expect(thoughtLineOf(stretch, [3, 4])).toEqual({ first: "Several columns scroll on their own.", full: "Several columns scroll on their own. Check each before touching the stylesheet." });
    expect(thoughtLineOf(stretch, [0, 1])).toBeUndefined();
  });

  it("reads a call with no answer, a call being written and a live thought as still happening", () => {
    expect(inFlight({ kind: "tool", name: "Bash", summary: "ls" })).toBe(true);
    expect(inFlight(bash("ls", 1))).toBe(false);
    expect(inFlight({ kind: "writing", name: "Write", chars: 10 })).toBe(true);
    expect(inFlight({ kind: "thought", text: "", live: true })).toBe(true);
  });
});

describe("time", () => {
  it("says hours past an hour — 872 minutes is a sum left for the reader", () => {
    expect(secondsOf(400)).toBe("<1 s");
    expect(secondsOf(59_000)).toBe("59 s");
    expect(secondsOf(12 * 60_000 + 5000)).toBe("12 min 5 s");
    expect(secondsOf(59 * 60_000 + 59_000)).toBe("59 min 59 s");
    expect(secondsOf(3_600_000)).toBe("1 h 0 min");
    expect(secondsOf(872 * 60_000 + 51_000)).toBe("14 h 32 min");
    expect(durationOf(872 * 60_000 + 51_000)).toBe("14 h 32 m");
    expect(durationOf(72_000)).toBe("1 m 12 s");
    expect(thoughtTime(2 * 3_600_000 + 5 * 60_000)).toBe("2 h 5 m");
    expect(thoughtTime(125_300)).toBe("2 m 5.3 s");
  });

  it("does not time the notes: they say when something about the run happened, not how long the work took", () => {
    const note = (s: number): WorkEntry => ({ kind: "event", at: t0 + s * 1000, tone: "plain", text: "went to chat/session" });
    const entries = [note(0), note(52_363), think(52_370), bash("git fetch origin --quiet", 52_371, undefined)];
    expect(spanOf(entries, [0, 1, 2, 3])).toEqual({ start: t0 + 52_370_000, end: t0 + 52_371_000 });
    // Nothing but notes: nothing to time.
    expect(spanOf(entries, [0, 1])).toEqual({});
    // A rate limit is still timed — that wait is time the work took.
    const limited: WorkEntry = { kind: "event", at: t0, tone: "warn", text: "Rate limited — waited 12 s" };
    expect(spanOf([limited], [0])).toEqual({ start: t0, end: t0 + 12_000 });
  });
});

describe("in the transcript", () => {
  const draw = (entries: TranscriptEntry[], look?: WorkLook, working?: boolean): string => {
    const transcript = createElement(Transcript, { entries, ...(working !== undefined ? { working } : {}) });
    return renderToStaticMarkup(look === undefined ? transcript : createElement(WorkLookContext.Provider, { value: look }, transcript));
  };
  const answer: TranscriptEntry = { kind: "message", role: "assistant", text: "Done." };

  it("draws a finished stretch as its phases and chips, with no rows, and every step behind the foot", () => {
    const html = draw([...stretch, answer]);
    expect(html).toContain('data-testid="work-summary"');
    expect(html.match(/class="ws-phase/g)).toHaveLength(4);
    expect(html).toContain("Every step");
    expect(html).not.toContain("ws-run ");
    expect(html).toContain("Several columns scroll on their own.");
  });

  it("keeps the latest rows of the phase in progress while the agent works", () => {
    const working = [...stretch.slice(0, 12), { kind: "tool", name: "Bash", summary: "npx vitest run", args: { command: "npx vitest run" }, at: t0 + 55_000 } as WorkEntry];
    const three = draw(working, { phases: true, rows: 3, thinking: true, notes: "hide-groups" }, true);
    expect(three).toContain("ws-phase current");
    // The phase in progress says what it is doing, not what it did — and the tests it is running again
    // have not passed yet, so it is changing until they do, and fixed after.
    expect(three).toContain("Changing");
    expect(three).not.toContain(">Fixed<");
    expect(draw([...stretch, answer])).toContain(">Fixed<");
    expect(three).toContain("Running ");
    // Until they pass it is a Changed after a Changed whose reasoning was withheld: one phase, whose
    // last three rows show — the first edit, the failed run rolled into its chips.
    expect(three.match(/class="ws-run[ "]/g)).toHaveLength(3);
    const none = draw(working, { phases: true, rows: 0, thinking: true, notes: "hide-groups" }, true);
    expect(none).not.toMatch(/class="ws-run[ "]/);
    // The run chip holds the failed run too, and the one running.
    expect(none).toContain("ws-chip ws-k-run failed live");
  });

  it("merges the Explored phases and drops the thinking line with thinking off, and draws one row with phases off", () => {
    const off = draw([...stretch, answer], { phases: true, rows: 3, thinking: false, notes: "hide-groups" });
    expect(off.match(/class="ws-phase/g)).toHaveLength(3);
    expect(off).not.toContain("ws-think");
    const flat = draw([...stretch, answer], { phases: false, rows: 3, thinking: true, notes: "hide-groups" });
    expect(flat.match(/class="ws-phase/g)).toHaveLength(1);
    expect(flat).not.toContain("ws-name");
  });

  it("shows, counts or hides the rate limits and notes as the setting says, and always lists them under Every step", () => {
    const note = (text: string): WorkEntry => ({ kind: "event", at: t0, tone: "plain", text });
    const withNotes: TranscriptEntry[] = [note("Hook ran: SessionStart"), note("Context injected: CLAUDE.md"), ...stretch, answer];
    const look = (notes: WorkLook["notes"]): WorkLook => ({ phases: true, rows: 3, thinking: true, notes });
    // Show: the opening notes are kept, with a notes chip — in the first Explored, whose reasoning was
    // withheld, so nothing tells the two apart.
    const shown = draw(withNotes, look("show"));
    expect(shown.match(/class="ws-phase/g)).toHaveLength(4);
    expect(shown).toContain("ws-k-note");
    // Hide phases of only these: that phase goes; the rate limit inside a working phase is still a chip.
    const groups = draw(withNotes, look("hide-groups"));
    expect(groups.match(/class="ws-phase/g)).toHaveLength(4);
    expect(groups).toContain("12 s wait");
    // Hide: no chip for them anywhere.
    const hidden = draw(withNotes, look("hide"));
    expect(hidden).not.toContain("12 s wait");
    expect(hidden).not.toContain("ws-k-note");
  });

  it("leaves only the foot when every line was a rate limit or a note — or nothing, when stretches go too", () => {
    const note = (text: string): WorkEntry => ({ kind: "event", at: t0, tone: "plain", text });
    const idle: TranscriptEntry[] = [note("Hook ran"), note("Context injected"), answer];
    const html = draw(idle);
    expect(html).toContain("ws bare");
    // A stretch of nothing but notes counts its notes, not "0 steps".
    expect(html).toContain("2 notes");
    expect(html).not.toContain("0 steps");
    expect(html).not.toContain("ws-box");
    expect(html).toContain("Every step");
    for (const notes of ["hide-blocks", "hide"] as const) {
      const gone = draw(idle, { phases: true, rows: 3, thinking: true, notes });
      expect(gone).not.toContain("work-summary");
      expect(gone).not.toContain("Every step");
      expect(gone).not.toContain("Hook ran");
      // A lone note is a stretch of only notes too.
      expect(draw([note("Hook ran"), answer], { phases: true, rows: 3, thinking: true, notes })).not.toContain("Hook ran");
    }
  });

  it("does not call a finished conversation that ended on an unanswered call working", () => {
    // A chat on 2026-09-25: its record ended on a `bash` call whose result was never written, the task
    // was completed — and the summary pulsed "Running git fetch…" with a clock that never stopped.
    const endedOnACall = [...stretch.slice(0, 12), { kind: "tool", name: "mcp__dai__bash", summary: "git fetch origin", args: { command: "git fetch origin" }, at: t0 + 55_000 } as WorkEntry];
    for (const html of [draw(endedOnACall), draw(endedOnACall, undefined, false)]) {
      expect(html).not.toContain("ws-phase current");
      expect(html).not.toContain("Running ");
      expect(html).not.toMatch(/class="ws-run[ "]/);
    }
    // Said to be working, the same record is drawn in progress.
    expect(draw(endedOnACall, undefined, true)).toContain("ws-phase current");
  });

  it("does not measure a turn from the note of the turn before it", () => {
    // A chat on 2026-09-26: the turn before had been left open by a quit, so all that stood between the
    // two turns' "went to" notes was the message the person had typed — and with that gone from the
    // screen, the notes, a withheld thought and a running `bash` were one stretch "872 min 51 s" long.
    const note = (s: number): WorkEntry => ({ kind: "event", at: t0 + s * 1000, tone: "plain", text: "went to chat/session" });
    const stretchOf = [note(0), note(52_363), think(52_370), { kind: "tool", name: "mcp__dai__bash", summary: "git fetch origin --quiet", args: { command: "git fetch origin --quiet" }, at: t0 + 52_371_000 } as WorkEntry];
    const look: WorkLook = { phases: true, rows: 5, thinking: true, notes: "hide-blocks" };
    const done = draw(stretchOf, look, false);
    expect(done).not.toContain(" h ");
    expect(done).not.toContain("min");
    expect(done).toContain("2 steps · 1 s");
    // Working, the phase in progress keeps its rows and the foot counts up from the thought, not the note.
    vi.useFakeTimers({ now: t0 + 52_380_000 });
    try {
      const working = draw(stretchOf, look, true);
      expect(working).toContain("ws-phase current");
      expect(working).toMatch(/class="ws-run live/);
      expect(working).toContain("Running ");
      expect(working).toContain("2 steps · 10 s so far");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("an approval — a tool the tool called", () => {
    // The person, 2026-09-26: the approval is `approve_tool_call`, called by the call that needs
    // permission — a row and a chip of its own, its prompt in the latest row the summary shows, or under
    // the summary when it shows no rows, and folded in once answered.
    const LINE = 'git fetch origin --quiet && echo "master=$(git rev-parse origin/master)"';
    const bashCall = { kind: "tool", name: "mcp__dai__bash", summary: LINE, args: { command: LINE }, at: t0 + 8_000, callId: "t1" } as WorkEntry;
    const approve = (answered?: object): WorkEntry =>
      ({ kind: "tool", name: "approve_tool_call", summary: "", args: { tool: "bash", command: LINE }, at: t0 + 9_000, callId: "approve_abc_approval-1", calledBy: "t1", ...(answered !== undefined ? { ok: true, result: "allowed", detail: answered } : {}) }) as WorkEntry;
    const pending = { requestId: "approval-1", tool: "bash", command: LINE, input: { command: LINE }, project: "p", at: t0 + 9_000 };
    const asked = (rows: WorkLook["rows"]): string =>
      renderToStaticMarkup(
        createElement(
          WorkLookContext.Provider,
          { value: { phases: true, rows, thinking: true, notes: "hide-groups" } },
          createElement(ApprovalAskContext.Provider, { value: { pending, onDecide: () => undefined } }, createElement(Transcript, { entries: [think(7), bashCall, approve()], working: true })),
        ),
      );

    it("draws its prompt in the latest row the summary shows — the row that says what the turn waits on", () => {
      const html = asked(3);
      expect(html).toContain("Waiting for you to approve ");
      const live = html.indexOf('class="ws-run live');
      const prompt = html.indexOf('class="inline-gate ws-ask"');
      expect(live).toBeGreaterThan(-1);
      expect(prompt).toBeGreaterThan(live);
      expect(prompt).toBeLessThan(html.indexOf('class="ws-foot"'));
    });

    it("with rows set to None, draws it under the summary with its own row", () => {
      const html = asked(0);
      expect(html).not.toContain("ws-runs");
      expect(html.indexOf('class="ws-kept ts-work ws-ask-row"')).toBeGreaterThan(html.indexOf('class="ws-foot"'));
      expect(html).toContain('class="inline-gate ws-ask"');
      // A chip of its own, live while it waits — the step is counted like any other.
      expect(html).toContain("ws-chip ws-k-approval live");
      expect(html).toContain("1 approval");
    });

    it("folds in once answered: no prompt, and the row says who answered, how far and after how long", () => {
      const html = draw([think(7), bashCall, approve({ decision: "allow", scope: "once", by: "person", waitedMs: 62_000 }), { kind: "message", role: "assistant", text: "done" } as TranscriptEntry]);
      expect(html).not.toContain("ws-ask");
      expect(html).toContain("1 approval");
      expect(approvalWordsOf(approve({ decision: "allow", scope: "once", by: "person", waitedMs: 62_000 }) as never)).toMatchObject({ name: "Approved", preview: "by you · once · after 1 min 2 s", mark: "ok" });
      expect(approvalWordsOf(approve({ decision: "deny", scope: "run", by: "person", waitedMs: 3_000 }) as never)).toMatchObject({ name: "Denied", preview: "by you · for this run · after 3 s", tone: "bad" });
      expect(approvalWordsOf(approve({ decision: "deny", scope: "once", by: "closed", waitedMs: 5_460_000 }) as never)).toMatchObject({ name: "Not answered", preview: "the app closed while it waited · after 1 h 31 min", tone: "warn" });
    });

    it("is never what names a phase — the person being asked changes nothing and checks nothing", () => {
      expect(phasesOf([bashCall, approve({ decision: "allow", scope: "once", by: "person", waitedMs: 1 })], { merge: "all", dropIdle: true }).map((p) => p.name)).toEqual(["Explored"]);
    });
  });

  it("leaves a single line as the row it always was", () => {
    const html = draw([read("a.ts", 1), answer]);
    expect(html).not.toContain("work-summary");
    expect(html).toContain("ts-row");
  });
});

describe("a shell line that runs git (the person's note, 2026-09-26)", () => {
  it("draws the git icon for git on its own and nested in a line, and the terminal otherwise", () => {
    const icons = ["git status", "cd packages/app && git diff --stat", "sh -c 'git log -1'", "env GIT_PAGER=cat git show", "npx vitest run"].map((line) => iconOf(bash(line, 1)));
    expect(icons).toEqual(["git", "git", "git", "git", "terminal"]);
  });

  it("counts git commands as a kind of their own, and says them as commands", () => {
    const entries = [bash("git status", 1), bash("git diff", 2), bash("npm test", 3)];
    expect(chipsOf(entries, [0, 1, 2]).map((chip) => chip.label)).toEqual(["2 git commands", "1 command"]);
    const [gits] = runsOf(entries, [0, 1, 2]);
    expect(sentenceOf(entries, gits!).said).toEqual([{ text: "Ran 2 git commands" }]);
    expect(sentenceOf(entries, runsOf(entries, [0])[0]!).said).toEqual([{ text: "Ran " }, { code: "git status", shell: true }]);
  });

  it("keeps a forge Git tool as the tool it is", () => {
    expect(chipsOf([call("mcp__dai__git_push", "branch", "main", 1)], [0])[0]!.kind).toBe("tool");
  });

  it("draws a command row's line in the colours of its parts", () => {
    const html = renderToStaticMarkup(createElement(Transcript, { entries: [bash("cd app && git status", 1)] }));
    expect(html).toContain('class="shell-line"');
    expect(html.match(/class="part-c"/g)?.length).toBe(2);
  });
});
