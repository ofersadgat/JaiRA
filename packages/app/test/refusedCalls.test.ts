/**
 * A call that did not do its work, told apart from one that broke (decision 0007, amended 2026-10-24 —
 * the person's D+E): it FAILED whatever stopped it, so it is red; its glyph says why (✕ broke, a lock
 * denied, "–" nobody answered) and grey words say who; the step that denied it stays in the plain ink.
 * Who refused is read off the steps under the call, never off its result's words.
 */
import { describe, expect, it } from "vitest";
import { markRefusals, type ToolEntry, type TranscriptEntry, type WorkEntry } from "../src/renderer/transcript";
import { checkWordsOf, chipsOf, phasesOf, refusalWordsOf, runToneOf, runsOf, sentenceOf } from "../src/renderer/workSummary";
import { toolLineOf } from "../src/renderer/transcriptRows";

const t0 = Date.parse("2026-10-24T19:38:00Z");
const at = (s: number): number => t0 + s * 1000;
const tool = (callId: string, name: string, args: object, s: number, ok?: boolean, result?: unknown): ToolEntry =>
  ({ kind: "tool", name, summary: "", args, at: at(s), callId, ...(ok !== undefined ? { ok } : {}), ...(result !== undefined ? { result } : {}) }) as ToolEntry;
const check = (callId: string, calledBy: string, s: number, args: object, detail?: object): ToolEntry =>
  ({ kind: "tool", name: "check_permission", summary: "", args, at: at(s), callId, calledBy, ...(detail !== undefined ? { ok: true, result: "", detail } : {}) }) as ToolEntry;
const approve = (callId: string, calledBy: string, s: number, detail?: object): ToolEntry =>
  ({ kind: "tool", name: "approve_tool_call", summary: "", args: { tool: "web_fetch" }, at: at(s), callId, calledBy, ...(detail !== undefined ? { ok: true, result: "", detail } : {}) }) as ToolEntry;

const NOT_RUN = "Not run: the person denied this call. Nothing was fetched.";

/** One turn, every way a call can end: worked, refused by a rule, by auto, by you, broke, unanswered. */
function turn(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    tool("r1", "mcp__dai__read_file", { path: "docs/settings.md" }, 3, true, "# Settings"),
    tool("e1", "mcp__dai__edit", { path: ".jaira/system/settings.json" }, 9, false, "Not run: this conversation's permission set denies edit."),
    check("k1", "e1", 9, { function: "the permission set", rule: true, tool: "edit", subject: "edit" }, { verdict: "deny", reason: "the permission set's 'edit' is deny", tookMs: 0 }),
    tool("f1", "mcp__dai__web_fetch", { url: "https://example.com/spec" }, 14, false, NOT_RUN),
    check("k2", "f1", 14, { function: "smart", tool: "web_fetch", subject: "web_fetch" }, { verdict: "unsure", tookMs: 9_000 }),
    approve("a2", "f1", 23, { decision: "deny", scope: "once", by: "person", waitedMs: 41_000 }),
    tool("g1", "Agent", { description: "Survey every settings reader" }, 66, false, "Not run: auto denied it."),
    check("k3", "g1", 66, { function: "smart", tool: "Agent", subject: "Agent" }, { verdict: "deny", reason: "a subagent the task did not ask for", tookMs: 11_000 }),
    tool("r2", "mcp__dai__read_file", { path: "src/settingsDefaults.ts" }, 80, false, "tool 'read_file' failed: ENOENT"),
    tool("f2", "mcp__dai__web_fetch", { url: "https://code.claude.com/docs/llms.txt" }, 84, false, "MCP server \"dai\" tool \"web_fetch\" sent no response or progress for 300s; aborting."),
    check("k4", "f2", 84, { function: "smart", tool: "web_fetch", subject: "web_fetch" }, { verdict: "unsure", tookMs: 12_000 }),
    approve("a4", "f2", 96, { decision: "deny", scope: "once", by: "abandoned", waitedMs: 288_000 }),
    tool("x1", "mcp__dai__shell", { command: "npm test -- settings" }, 390, true, { exitCode: 0 }),
  ];
  markRefusals(entries);
  return entries;
}
const byId = (entries: TranscriptEntry[], id: string): ToolEntry => entries.find((e) => e.kind === "tool" && e.callId === id) as ToolEntry;

describe("who refused a call, read off the steps under it", () => {
  it("names the rule, the function, or you — and a call nobody answered is not run", () => {
    const entries = turn();
    expect(byId(entries, "r1").refused).toBeUndefined();
    expect(byId(entries, "e1").refused).toEqual({ kind: "denied", by: "the permission set" });
    // Auto was unsure; the person's no is the answer.
    expect(byId(entries, "f1").refused).toEqual({ kind: "denied", by: "you" });
    expect(byId(entries, "g1").refused).toEqual({ kind: "denied", by: "auto" });
    // A tool that broke is no refusal, whatever its result says.
    expect(byId(entries, "r2").refused).toBeUndefined();
    expect(byId(entries, "f2").refused).toEqual({ kind: "not run" });
    expect(byId(entries, "x1").refused).toBeUndefined();
  });

  it("reads a call whose question was never answered, and that has its end, as not run — and one still waiting as neither", () => {
    const ended = [tool("f3", "mcp__dai__web_fetch", { url: "u" }, 1, false, "aborted"), approve("a3", "f3", 2)];
    markRefusals(ended);
    expect(byId(ended, "f3").refused).toEqual({ kind: "not run" });
    const waiting = [tool("f4", "mcp__dai__web_fetch", { url: "u" }, 1), approve("a5", "f4", 2)];
    markRefusals(waiting);
    expect(byId(waiting, "f4").refused).toBeUndefined();
  });
});

describe("a refused call's row: failed, the glyph says why, grey words say who", () => {
  it("draws the call red with a lock and who denied it; one nobody answered with a dash; one that broke with a cross", () => {
    const entries = turn();
    expect(toolLineOf(byId(entries, "e1"), false, false)).toMatchObject({ tone: "bad", mark: "denied", note: "denied by the permission set" });
    expect(toolLineOf(byId(entries, "f1"), false, false)).toMatchObject({ tone: "bad", mark: "denied", note: "denied by you" });
    expect(toolLineOf(byId(entries, "g1"), false, false)).toMatchObject({ tone: "bad", mark: "denied", note: "denied by auto" });
    expect(toolLineOf(byId(entries, "f2"), false, false)).toMatchObject({ tone: "bad", mark: "cut", note: "not answered" });
    const broke = toolLineOf(byId(entries, "r2"), false, false);
    expect(broke).toMatchObject({ tone: "bad", mark: "bad" });
    expect(broke.note).toBeUndefined();
  });

  it("keeps the step that denied it in the plain ink: the denial did not fail", () => {
    const entries = turn();
    expect(checkWordsOf(byId(entries, "k1"))).toEqual({ name: "Denied by the permission set", preview: "the permission set's 'edit' is deny", tone: "plain", mark: "denied" });
    expect(checkWordsOf(byId(entries, "k3"))).toMatchObject({ name: "Denied by auto", tone: "plain", mark: "denied" });
    const runs = runsOf(entries as WorkEntry[], entries.map((_, i) => i));
    const ruleRun = runs.find((run) => run.kind === "check" && run.rows.includes(2))!;
    expect(runToneOf(entries as WorkEntry[], ruleRun)).toBeUndefined();
  });

  it("says who after a pill without saying denied twice", () => {
    expect(refusalWordsOf({ kind: "denied", by: "the permission set" }, true)).toBe("by the permission set");
    expect(refusalWordsOf({ kind: "not run" }, true)).toBe("nobody answered");
  });
});

describe("the work summary counts what broke, what was refused and what nobody answered apart", () => {
  it("chips: ✕ for what broke, a lock for what was refused, a dash for what nobody answered; an edit refused is not edited", () => {
    const entries = turn() as WorkEntry[];
    const chips = chipsOf(entries, entries.map((_, i) => i));
    expect(chips.find((c) => c.kind === "read")).toMatchObject({ label: "2 files", failed: 1, denied: 0, notRun: 0 });
    expect(chips.find((c) => c.kind === "write")).toMatchObject({ label: "1 edit", failed: 0, denied: 1, notRun: 0 });
    expect(chips.find((c) => c.kind === "web")).toMatchObject({ label: "2 pages", failed: 0, denied: 1, notRun: 1 });
    expect(chips.find((c) => c.kind === "check")).toMatchObject({ label: "4 permission checks" });
  });

  it("a refused call's sentence is what it would have done, not what it did", () => {
    const entries = turn() as WorkEntry[];
    const runs = runsOf(entries, entries.map((_, i) => i));
    const edit = runs.find((run) => run.kind === "write")!;
    expect(sentenceOf(entries, edit).said).toEqual([{ text: "Edit " }, { code: "settings.json" }]);
  });

  it("a stretch whose only change was refused changed nothing", () => {
    const entries = [tool("e1", "mcp__dai__edit", { path: "a.ts" }, 1, false, "Not run"), check("k1", "e1", 1, { function: "the permission set", rule: true, tool: "edit", subject: "edit" }, { verdict: "deny", tookMs: 0 })];
    markRefusals(entries);
    expect(phasesOf(entries as WorkEntry[], { merge: "none", dropIdle: false })[0]!.name).not.toBe("Changed");
  });
});
