/**
 * The work between two messages, summarised (the tool-summary mockups, 2026-09-25): phases cut at
 * each thought and named by what they did, chips per kind, the phase in progress keeping its latest
 * rows, and the thinking line where the provider kept the reasoning.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry, WorkEntry } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";
import { WorkLookContext, type WorkLook } from "../src/renderer/workSummaryView";
import { chipsOf, inFlight, phasesOf, runsOf, sentenceOf, thoughtLineOf, windowOf, WITHHELD } from "../src/renderer/workSummary";

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
    expect(phasesOf(stretch, { merge: false, dropIdle: true }).map((p) => p.name)).toEqual(["Explored", "Explored", "Changed", "Fixed"]);
  });

  it("merges neighbours of one name when asked — what the thinking line would have told apart", () => {
    const merged = phasesOf(stretch, { merge: true, dropIdle: true });
    expect(merged.map((p) => p.name)).toEqual(["Explored", "Changed", "Fixed"]);
    expect(merged[0]!.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("leaves out a part that is only rate limits and notes — even when it is the only part", () => {
    const note = (s: number, text: string): WorkEntry => ({ kind: "event", at: t0 + s * 1000, tone: "plain", text });
    const opening: WorkEntry[] = [note(0, "Context injected: CLAUDE.md"), note(0, "Hook ran"), think(1), read("a.ts", 2), read("b.ts", 3)];
    // The notes before the first thought were a part of their own, and did no work: gone.
    expect(phasesOf(opening, { merge: false, dropIdle: true }).map((p) => p.indices)).toEqual([[2, 3, 4]]);
    // Shown when asked.
    expect(phasesOf(opening, { merge: false, dropIdle: false })).toHaveLength(2);
    // Alone, it goes too: nothing is left but the foot.
    expect(phasesOf([note(0, "Hook ran"), note(1, "Context injected")], { merge: false, dropIdle: true })).toHaveLength(0);
    // A thought and a rate limit is still only a rate limit.
    const waiting: WorkEntry[] = [think(0), read("a.ts", 1), think(2), { kind: "event", at: t0 + 3000, tone: "warn", text: "Rate limited — waited 12 s" }];
    expect(phasesOf(waiting, { merge: false, dropIdle: true })).toHaveLength(1);
  });

  it("calls a part that ran more than it read Checked", () => {
    expect(phasesOf([think(0), bash("npm test", 1), bash("npm run lint", 2), read("a.ts", 3)], { merge: false, dropIdle: true })[0]!.name).toBe("Checked");
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
    // The phase in progress says what it is doing, not what it did.
    expect(three).toContain("Fixing");
    expect(three).not.toContain(">Fixed<");
    expect(draw([...stretch, answer])).toContain(">Fixed<");
    expect(three).toContain("Running ");
    expect(three.match(/class="ws-run[ "]/g)).toHaveLength(2);
    const none = draw(working, { phases: true, rows: 0, thinking: true, notes: "hide-groups" }, true);
    expect(none).not.toMatch(/class="ws-run[ "]/);
    expect(none).toContain("ws-chip ws-k-run live");
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
    // Show: the opening notes are a phase of their own, with a notes chip.
    expect(draw(withNotes, look("show")).match(/class="ws-phase/g)).toHaveLength(5);
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

  it("leaves a single line as the row it always was", () => {
    const html = draw([read("a.ts", 1), answer]);
    expect(html).not.toContain("work-summary");
    expect(html).toContain("ts-row");
  });
});
