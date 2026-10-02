/**
 * The work between two messages, summarised (the tool-summary mockups, 2026-09-25): phases cut at
 * each thought and named by what they did, chips per kind, the phase in progress keeping its latest
 * rows, and the thinking line where the provider kept the reasoning.
 */
import { describe, expect, it } from "vitest";
import { iconOf, takenApartOf, type ToolEntry, type WorkEntry } from "../src/renderer/transcript";
import { ACTIVE_NAME, approvalWordsOf, chipsOf, countOf, currentPhaseOf, inFlight, isIdle, isQuiet, liveIndexOf, phasesOf, runsOf, secondsOf, sentenceOf, spanOf, thoughtLineOf, windowOf, WITHHELD } from "../src/renderer/workSummary";
import { approvalCallIndex } from "../src/renderer/approvalCall";
import { toolLineOf } from "../src/renderer/transcriptRows";
import { durationOf } from "../src/renderer/runActivityModel";
import { thoughtTime } from "../src/renderer/liveStatusModel";

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
  // What the summary is drawn FROM. Which phase is the one in progress, how many rows it keeps and what
  // a setting hides are the summary's own choices (the universal tree's `WorkSummary.tsx`), made over
  // these values: the options below are the ones it passes for the settings each case names.
  const note = (text: string): WorkEntry => ({ kind: "event", at: t0, tone: "plain", text });

  it("keeps the latest rows of the phase in progress while the agent works", () => {
    const working = [...stretch.slice(0, 12), { kind: "tool", name: "Bash", summary: "npx vitest run", args: { command: "npx vitest run" }, at: t0 + 55_000 } as WorkEntry];
    // The call with no answer is the one still happening, and the phase holding it the one in progress.
    const live = 12;
    expect(working.map(inFlight).lastIndexOf(true)).toBe(live);
    expect(liveIndexOf(working, true)).toBe(live);
    const phases = phasesOf(working, { merge: "withheld", dropIdle: true });
    const current = phases.at(-1)!;
    expect(current.indices).toContain(live);
    expect(currentPhaseOf(phases, live, true)).toBe(phases.length - 1);
    // The phase in progress says what it is doing, not what it did — and the tests it is running again
    // have not passed yet, so it is changing until they do, and fixed after.
    expect(current.name).toBe("Changed");
    expect(ACTIVE_NAME[current.name]).toBe("Changing");
    expect(phasesOf(stretch, { merge: "withheld", dropIdle: true }).at(-1)!.name).toBe("Fixed");
    // Until they pass it is a Changed after a Changed whose reasoning was withheld: one phase, whose
    // last three rows show — the failed run, the second edit and the run going now — and the first
    // edit, with the thought before it, rolled into its chips.
    expect(current.indices).toEqual([7, 8, 9, 10, 11, 12]);
    const three = windowOf(working, current.indices, 3);
    expect(three.shown.map((run) => run.rows)).toEqual([[9], [11], [12]]);
    expect(three.rolled).toEqual([7, 8]);
    expect(sentenceOf(working, three.shown[2]!, live)).toEqual({ said: [], now: [{ text: "Running " }, { code: "npx vitest run", shell: true }] });
    // With no rows kept, everything is in the chips.
    const none = windowOf(working, current.indices, 0);
    expect(none.shown).toEqual([]);
    // The run chip holds the failed run too, and the one running.
    expect(chipsOf(working, none.rolled, live).find((chip) => chip.kind === "run")).toMatchObject({ label: "2 commands", failed: 1, live: true });
  });

  it("does not call a finished conversation that ended on an unanswered call working", () => {
    // A chat on 2026-09-25: its record ended on a `bash` call whose result was never written, the task
    // was completed — and the summary pulsed "Running git fetch…" with a clock that never stopped.
    const endedOnACall = [...stretch.slice(0, 12), { kind: "tool", name: "mcp__dai__bash", summary: "git fetch origin", args: { command: "git fetch origin" }, at: t0 + 55_000 } as WorkEntry];
    const phases = phasesOf(endedOnACall, { merge: "withheld", dropIdle: true });
    // Not being worked on: no step is in flight and no phase is in progress, whatever the entries lack.
    expect(inFlight(endedOnACall[12]!)).toBe(true);
    expect(liveIndexOf(endedOnACall, false)).toBeUndefined();
    expect(currentPhaseOf(phases, liveIndexOf(endedOnACall, false), false)).toBe(-1);
    // So nothing pulses, no row is kept, and its sentence says what it did, not what it "is doing".
    const run = runsOf(endedOnACall, [12])[0]!;
    expect(sentenceOf(endedOnACall, run, liveIndexOf(endedOnACall, false))).toEqual({ said: [{ text: "Ran " }, { code: "git fetch origin", shell: true }] });
    expect(chipsOf(endedOnACall, phases.at(-1)!.indices, liveIndexOf(endedOnACall, false)).some((chip) => chip.live)).toBe(false);
    // Said to be working, the same record is drawn in progress.
    expect(liveIndexOf(endedOnACall, true)).toBe(12);
    expect(currentPhaseOf(phases, 12, true)).toBe(phases.length - 1);
    expect(sentenceOf(endedOnACall, run, 12).now).toEqual([{ text: "Running " }, { code: "git fetch origin", shell: true }]);
  });

  it("calls the last phase the one in progress while the agent is between steps", () => {
    // Working, and every call so far has answered: it is thinking of the next one.
    const phases = phasesOf(stretch, { merge: "withheld", dropIdle: true });
    expect(liveIndexOf(stretch, true)).toBeUndefined();
    expect(currentPhaseOf(phases, undefined, true)).toBe(phases.length - 1);
    expect(currentPhaseOf(phases, undefined, false)).toBe(-1);
  });

  it("shows, counts or hides the rate limits and notes as it is asked to", () => {
    const withNotes: WorkEntry[] = [note("Hook ran: SessionStart"), note("Context injected: CLAUDE.md"), ...stretch];
    const chips = (indices: readonly number[]): string[] => chipsOf(withNotes, indices).map((chip) => chip.label);
    // Show: the opening notes are kept, with a notes chip — in the first Explored, whose reasoning was
    // withheld, so nothing tells the two apart.
    const shown = phasesOf(withNotes, { merge: "withheld", dropIdle: false });
    expect(shown.map((phase) => phase.name)).toEqual(["Explored", "Explored", "Changed", "Fixed"]);
    expect(shown[0]!.indices).toEqual([0, 1, 2, 3, 4]);
    expect(chips(shown[0]!.indices)).toEqual(["2 notes", "4 s", "1 search", "1 file"]);
    // Hide phases of only these: the notes' part goes; the rate limit inside a working phase is still a chip.
    const groups = phasesOf(withNotes, { merge: "withheld", dropIdle: true });
    expect(groups).toHaveLength(4);
    expect(groups[0]!.indices).toEqual([2, 3, 4]);
    expect(chips(groups[0]!.indices)).toEqual(["4 s", "1 search", "1 file"]);
    expect(chips(groups[1]!.indices)).toContain("12 s wait");
    // Hide: the lines a summary leaves out of its chips are the two notes and the rate limit, and no others.
    expect(withNotes.flatMap((entry, i) => (isQuiet(entry) ? [i] : []))).toEqual([0, 1, 8]);
  });

  it("leaves only the foot when every line was a rate limit or a note — or nothing, when stretches go too", () => {
    const idle: WorkEntry[] = [note("Hook ran"), note("Context injected")];
    // No phase is left to draw: the foot stands alone.
    expect(phasesOf(idle, { merge: "withheld", dropIdle: true })).toEqual([]);
    // A stretch of nothing but notes counts its notes, not "0 steps".
    expect(countOf(idle)).toBe("2 notes");
    // What hiding such stretches goes by. A lone note is a stretch of only notes too; one that did work is not.
    expect(isIdle(idle, [0, 1])).toBe(true);
    expect(isIdle([note("Hook ran")], [0])).toBe(true);
    expect(isIdle(stretch, stretch.map((_, i) => i))).toBe(false);
  });

  it("does not measure a turn from the note of the turn before it", () => {
    // A chat on 2026-09-26: the turn before had been left open by a quit, so all that stood between the
    // two turns' "went to" notes was the message the person had typed — and with that gone from the
    // screen, the notes, a withheld thought and a running `bash` were one stretch "872 min 51 s" long.
    const went = (s: number): WorkEntry => ({ kind: "event", at: t0 + s * 1000, tone: "plain", text: "went to chat/session" });
    const stretchOf = [went(0), went(52_363), think(52_370), { kind: "tool", name: "mcp__dai__bash", summary: "git fetch origin --quiet", args: { command: "git fetch origin --quiet" }, at: t0 + 52_371_000 } as WorkEntry];
    const whole = spanOf(stretchOf, [0, 1, 2, 3]);
    // Done, the foot says "2 steps · 1 s": the two notes are neither counted nor timed.
    expect(countOf(stretchOf)).toBe("2 steps");
    expect(secondsOf(whole.end! - whole.start!)).toBe("1 s");
    // Working, with the clock nine seconds past the call, the foot counts up from the thought, not the note.
    expect(secondsOf(t0 + 52_380_000 - whole.start!)).toBe("10 s");
    // …and the phase in progress keeps its row, which says what is running.
    const [phase] = phasesOf(stretchOf, { merge: "withheld", dropIdle: true });
    expect(phase!.indices).toEqual([2, 3]);
    const shown = windowOf(stretchOf, phase!.indices, 5).shown;
    expect(shown.map((run) => run.rows)).toEqual([[3]]);
    expect(sentenceOf(stretchOf, shown[0]!, 3).now).toEqual([{ text: "Running " }, { code: "git fetch origin --quiet", shell: true }]);
  });

  describe("an approval — a tool the tool called", () => {
    // The person, 2026-09-26: the approval is `approve_tool_call`, called by the call that needs
    // permission — a row and a chip of its own, its prompt in the latest row the summary shows, or under
    // the summary when it shows no rows, and folded in once answered.
    const LINE = 'git fetch origin --quiet && echo "master=$(git rev-parse origin/master)"';
    const bashCall = { kind: "tool", name: "mcp__dai__bash", summary: LINE, args: { command: LINE }, at: t0 + 8_000, callId: "t1" } as WorkEntry;
    const approve = (answered?: object): WorkEntry =>
      ({ kind: "tool", name: "approve_tool_call", summary: "", args: { tool: "bash", command: LINE }, at: t0 + 9_000, callId: "approve_abc_approval-1", calledBy: "t1", ...(answered !== undefined ? { ok: true, result: "allowed", detail: answered } : {}) }) as WorkEntry;
    // The stretch while the prompt is open: the request the host can answer is `approval-1`.
    const asking = [think(7), bashCall, approve()];
    const phaseOf = (entries: WorkEntry[]) => phasesOf(entries, { merge: "withheld", dropIdle: true })[0]!;

    it("draws its prompt in the latest row the summary shows — the row that says what the turn waits on", () => {
      // The prompt goes where its call is: the unanswered `approve_tool_call` whose id names the request.
      const at = approvalCallIndex(asking, "approval-1");
      expect(at).toBe(2);
      expect(approvalCallIndex(asking, "approval-2")).toBe(-1);
      // That call is the latest row the summary shows, on its own, and the row says what the turn waits on.
      const latest = windowOf(asking, phaseOf(asking).indices, 3).shown.at(-1)!;
      expect(latest.rows).toEqual([at]);
      expect(sentenceOf(asking, latest, at).now).toEqual([{ text: "Waiting for you to approve " }, { code: LINE, shell: true }]);
    });

    it("with rows set to None, draws it under the summary with its own row", () => {
      // No row is shown to hold the prompt — the summary puts it, and the call's row, under itself.
      const none = windowOf(asking, phaseOf(asking).indices, 0);
      expect(none.shown).toEqual([]);
      // A chip of its own, live while it waits — the step is counted like any other.
      expect(chipsOf(asking, none.rolled, 2).find((chip) => chip.kind === "approval")).toMatchObject({ label: "1 approval", live: true });
    });

    it("folds in once answered: no prompt, and the row says who answered, how far and after how long", () => {
      const allowed = { decision: "allow", scope: "once", by: "person", waitedMs: 62_000 };
      const answered = [think(7), bashCall, approve(allowed)];
      // Nothing waits on it any more: there is no call to put a prompt at, and its chip is a step like any other.
      expect(approvalCallIndex(answered, "approval-1")).toBe(-1);
      expect(chipsOf(answered, [0, 1, 2]).find((chip) => chip.kind === "approval")).toMatchObject({ label: "1 approval", live: false });
      expect(toolLineOf(approve(allowed) as ToolEntry, false, false)).toMatchObject({ name: "Approved", preview: "by you · once · after 1 min 2 s", prose: true, mark: "ok" });
      expect(approvalWordsOf(approve(allowed) as never)).toMatchObject({ name: "Approved", preview: "by you · once · after 1 min 2 s", mark: "ok" });
      expect(approvalWordsOf(approve({ decision: "deny", scope: "run", by: "person", waitedMs: 3_000 }) as never)).toMatchObject({ name: "Denied", preview: "by you · for this run · after 3 s", tone: "bad" });
      expect(approvalWordsOf(approve({ decision: "deny", scope: "once", by: "closed", waitedMs: 5_460_000 }) as never)).toMatchObject({ name: "Not answered", preview: "the app closed while it waited · after 1 h 31 min", tone: "warn" });
    });

    it("reads Not answered, not Approve, once nobody is being asked any more", () => {
      // No answer was recorded and the stretch is over (the run stopped, the app closed before it could
      // write one): "Approve" would say somebody is still being asked.
      expect(approvalWordsOf(approve() as never, true)).toMatchObject({ name: "Approve", preview: LINE, mark: "waiting" });
      expect(approvalWordsOf(approve() as never, false)).toMatchObject({ name: "Not answered", preview: LINE, tone: "warn", mark: "cut" });
      expect(toolLineOf(approve() as ToolEntry, true, false)).toMatchObject({ name: "Approve", mark: "waiting", running: true });
      expect(toolLineOf(approve() as ToolEntry, false, false)).toMatchObject({ name: "Not answered", mark: "cut", running: false, tone: "warn" });
      // Its sentence in a summary row follows: waiting only in a stretch still being worked on.
      const run = runsOf(asking, [2])[0]!;
      expect(sentenceOf(asking, run, undefined).said[0]).toEqual({ text: "Not answered " });
      expect(sentenceOf(asking, run, 2).now![0]).toEqual({ text: "Waiting for you to approve " });
    });

    it("is never what names a phase — the person being asked changes nothing and checks nothing", () => {
      expect(phasesOf([bashCall, approve({ decision: "allow", scope: "once", by: "person", waitedMs: 1 })], { merge: "all", dropIdle: true }).map((p) => p.name)).toEqual(["Explored"]);
    });
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
    const line = "cd app && git status";
    // The row hands the line over as a command to colour, not only as a preview to print…
    expect(toolLineOf(bash(line, 1) as ToolEntry, false, false)).toMatchObject({ preview: line, command: line });
    // …and the parts it is coloured by are the two commands on it.
    expect(takenApartOf(line).requests.map((request) => line.slice(request.span.start, request.span.end))).toEqual(["cd app", "git status"]);
  });
});
