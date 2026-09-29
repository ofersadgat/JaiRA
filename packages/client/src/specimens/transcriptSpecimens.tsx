import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { InstanceNode, SessionRef } from "@jaira/shared/browser";
import { bandsOf, piecesOf, type BandNote } from "@jaira/ui/sessionBands";
import { SessionBandsView } from "@jaira/ui/sessionPanels";
import type { TranscriptEntry } from "@jaira/ui/transcript";
import { Transcript as DomTranscript } from "@jaira/ui/transcriptView";
import { ValuePanelContext, type ValuePanel } from "@jaira/ui/valuePanel";
import { SessionBands, Transcript, useTokens } from "@jaira/universal";

/**
 * The transcript's pieces as specimens (decision 0015): `transcriptView.tsx`'s `Transcript` against its
 * universal copy (`components/panel/SessionTranscript.tsx`), from the same entries, on the sheet a
 * conversation is printed on (`.ts-paper`'s --panel).
 *
 *  - `transcript-rows` — a stretch of work of one line each kind draws: a call that worked, one that
 *    failed, a shell line in its parts' colours, another server's tool, a thought and how long it took,
 *    a journal fact, a call the record left unanswered — with the pauses between them (minutes, hours,
 *    a day) and a compaction, reported and worked out.
 *  - `transcript-summary` — a stretch of many steps, finished: `workSummaryView.tsx`'s phases, chips,
 *    thinking lines and the foot, over `workPreview.tsx`'s story.
 */
export interface TranscriptSpecimen {
  width: number;
  dom: () => JSX.Element;
  rn: () => JSX.Element;
}

/** A fixed morning, in the reader's own zone, so both pages print the same clocks. */
const T0 = new Date(2026, 8, 21, 10, 0, 0).getTime();
const s = (n: number): number => T0 + n * 1000;
const MIN = 60;
const HOUR = 60 * MIN;
const S = "packages/app/src/renderer";

const say = (role: string, text: string, at: number, turn?: number): TranscriptEntry => ({ kind: "message", role, text, at, ...(turn !== undefined ? { turn } : {}) });
const call = (name: string, args: Record<string, unknown>, summary: string, at: number, ok: boolean | undefined = true, result: unknown = "ok"): TranscriptEntry => ({
  kind: "tool",
  name,
  summary,
  args: args as never,
  at,
  ...(ok === undefined ? {} : { ok, result: result as never }),
});

const ROWS: TranscriptEntry[] = [
  say("user", "Tidy up the scrollbars, please.", s(0), 0),
  { kind: "thought", at: s(1), text: "Several columns scroll on their own. Check how each draws its scrollbar before touching the stylesheet.", durationMs: 6_200 },
  say("assistant", "Looking at how each column scrolls first.", s(8), 1),
  call("Read", { file_path: `${S}/styles.css` }, `${S}/styles.css`, s(9), true, "/* the stylesheet */"),
  say("assistant", "One rule covers every scroller.", s(12), 1),
  say("user", "Run the checks.", s(26 * MIN + 12), 2),
  call("Bash", { command: "git status --short && npx tsc --noEmit -p packages/app" }, "git status --short && npx tsc --noEmit -p packages/app", s(26 * MIN + 14), false, { is_error: true, error: "exit 2" }),
  say("assistant", "The type check failed on one file.", s(26 * MIN + 30), 3),
  say("user", "What does Linear say about it?", s(3 * HOUR + 26 * MIN + 30), 4),
  call("mcp__linear__list_issues", { query: "scrollbar" }, "scrollbar", s(3 * HOUR + 26 * MIN + 32)),
  say("assistant", "Two open issues mention the scrollbars.", s(3 * HOUR + 26 * MIN + 40), 5),
  say("user", "Carry on tomorrow.", s(26 * HOUR), 6),
  { kind: "event", at: s(26 * HOUR + 2), tone: "warn", text: "Rate limited — waited 12 s before the next call" },
  say("assistant", "Picking it up again.", s(26 * HOUR + 20), 7),
  { kind: "compaction", at: s(26 * HOUR + 21), trigger: "auto", before: 152_000, after: 31_000, durationMs: 12_400 },
  { kind: "message", role: "assistant", text: "The context was folded; carrying on.", at: s(26 * HOUR + 40), turn: 7, context: { used: 120_000, window: 200_000, model: "claude-sonnet-4-5", at: new Date(s(26 * HOUR + 40)).toISOString() } },
  { kind: "event", at: s(26 * HOUR + 41), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)", detail: { file: "CLAUDE.md", bytes: 4100 } },
  { kind: "message", role: "assistant", text: "And the reading dropped with nothing said about it.", at: s(26 * HOUR + 50), turn: 8, context: { used: 40_000, window: 200_000, model: "claude-sonnet-4-5", at: new Date(s(26 * HOUR + 50)).toISOString() } },
  { kind: "tool", name: "Write", summary: `${S}/scrollbars.css`, args: { file_path: `${S}/scrollbars.css`, content: "…" }, at: s(26 * HOUR + 52) },
];

const WITHHELD = "(withheld by the provider)";
/** `workPreview.tsx`'s story, on the fixed clock. */
const STORY: TranscriptEntry[] = [
  say("user", "Make every scrollbar the same thin rounded one.", s(0), 0),
  { kind: "event", at: s(0), tone: "plain", text: "Hook ran: SessionStart (0.4 s)" },
  { kind: "event", at: s(0), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
  { kind: "thought", at: s(1), text: WITHHELD, durationMs: 6_200 },
  call("Grep", { pattern: "scrollbar" }, "scrollbar", s(8)),
  call("Read", { file_path: `${S}/styles.css` }, `${S}/styles.css`, s(9)),
  call("Read", { file_path: `${S}/index.html` }, `${S}/index.html`, s(11)),
  call("Grep", { pattern: "overflow: auto" }, "overflow: auto", s(13)),
  {
    kind: "thought",
    at: s(14),
    text: "Several columns scroll on their own — the transcript, the chat list, the side panel and the diff editor. Check how each draws its scrollbar before touching the stylesheet.",
    durationMs: 4_100,
  },
  call("Read", { file_path: `${S}/transcriptView.tsx` }, `${S}/transcriptView.tsx`, s(19)),
  call("Read", { file_path: `${S}/chatPane.tsx` }, `${S}/chatPane.tsx`, s(20)),
  call("Read", { file_path: `${S}/sidePanel.tsx` }, `${S}/sidePanel.tsx`, s(21)),
  call("WebFetch", { url: "https://developer.chrome.com/docs/css-ui/scrollbar-styling" }, "https://developer.chrome.com/docs/css-ui/scrollbar-styling", s(26)),
  { kind: "event", at: s(29), tone: "warn", text: "Rate limited — waited 12 s before the next call" },
  call("Bash", { command: "git log --oneline -3" }, "git log --oneline -3", s(43)),
  { kind: "thought", at: s(44), text: "One global ::-webkit-scrollbar rule is enough, and Chromium skips it wherever scrollbar-width is set.", durationMs: 9_800 },
  call("Edit", { file_path: `${S}/styles.css` }, `${S}/styles.css`, s(55)),
  call("Edit", { file_path: `${S}/schemaEditor.tsx` }, `${S}/schemaEditor.tsx`, s(62)),
  call("Bash", { command: "npx tsc --noEmit" }, "npx tsc --noEmit", s(64)),
  call("Bash", { command: "npx vitest run floatLayers.test.ts" }, "npx vitest run floatLayers.test.ts", s(91), false, { is_error: true, error: "1 failed" }),
  { kind: "thought", at: s(99), text: WITHHELD, durationMs: 5_500 },
  call("Read", { file_path: "packages/app/test/floatLayers.test.ts" }, "packages/app/test/floatLayers.test.ts", s(105)),
  call("Edit", { file_path: "packages/app/test/floatLayers.test.ts" }, "packages/app/test/floatLayers.test.ts", s(109)),
  call("Bash", { command: "npx vitest run floatLayers.test.ts" }, "npx vitest run floatLayers.test.ts", s(112)),
  { kind: "event", at: s(160), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
  call("Edit", { file_path: `${S}/styles.css` }, `${S}/styles.css`, s(162)),
  call("Bash", { command: "npx vitest run packages/app" }, "npx vitest run packages/app", s(166)),
  say("assistant", "Every scrollbar now uses one rule in `styles.css`: a thin rounded thumb, no track. `floatLayers.test.ts` needed one exemption; the app suite passes.", s(170), 1),
];

/** A value panel that opens nothing: the Chat room has one, so its rails offer "…" (as the copy's always do). */
const PANEL = { open: () => undefined } as unknown as ValuePanel;

/** `.ts-paper`'s ground, which the transcript is drawn on in the Chat room. */
function DomSheet({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ValuePanelContext.Provider value={PANEL}>
      <div style={{ background: "var(--panel)" }}>{children}</div>
    </ValuePanelContext.Provider>
  );
}
function RnSheet({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return <View backgroundColor={t.v("panel") as never}>{children}</View>;
}

const pair = (entries: TranscriptEntry[], working = false, width = 640): TranscriptSpecimen => ({
  width,
  dom: () => (
    <DomSheet>
      <DomTranscript entries={entries} working={working} />
    </DomSheet>
  ),
  rn: () => (
    <RnSheet>
      <Transcript session={null} entries={entries} working={working} rails />
    </RnSheet>
  ),
});

/**
 * The story still being written, timed back from the page's own clock so its "so far" reads a few
 * seconds: its last call has no answer yet, and the phase in progress keeps its latest rows.
 */
function working(): TranscriptEntry[] {
  const all = STORY.slice(0, -1);
  const shift = Date.now() - 4_000 - s(166);
  const moved = all.map((entry) => ("at" in entry && entry.at !== undefined ? { ...entry, at: entry.at + shift } : entry)) as TranscriptEntry[];
  const tail = moved[moved.length - 1]!;
  if (tail.kind !== "tool") return moved;
  const { ok: _ok, result: _result, ...rest } = tail;
  return [...moved.slice(0, -1), rest];
}

export const TRANSCRIPT_SPECIMENS: Record<string, TranscriptSpecimen> = {
  "transcript-rows": pair(ROWS),
  "transcript-summary": pair(STORY),
  "transcript-working": { ...pair([], true), dom: () => <DomSheet><DomTranscript entries={working()} working /></DomSheet>, rn: () => <RnSheet><Transcript session={null} entries={working()} working rails /></RnSheet> },
};

// --- a run's conversation as panels (`sessionPanels.tsx`) --------------------------------------------

const node = (id: string, key: string, at: number, end: number): InstanceNode => ({
  instanceId: id,
  stateId: `feature/plan/${key}`,
  childKey: key,
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: at,
  endedAt: end,
  operation: { kind: "prompt", status: "completed" },
  children: [],
});
/**
 * A run through five conversations: `draft` in `default`, then `critique` and `lint` at the same time
 * (a band of two columns), then `default` again (torn: paused under draft, resumed over revise), and a
 * retry of `revise` that branched off it (a fork, `1 of 2` and `2 of 2`) — with the notes on the grey:
 * states entered, a child that could not be, what a fan-out made.
 */
const ROOT: InstanceNode = {
  instanceId: "r",
  stateId: "feature/plan",
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: s(0),
  endedAt: s(90),
  children: [node("i1", "draft", s(1), s(10)), node("i2", "critique", s(12), s(30)), node("i3", "lint", s(14), s(25)), node("i4", "revise", s(40), s(50)), node("i5", "revise", s(52), s(60))],
};
const REFS: SessionRef[] = [
  { instanceId: "i1", stateId: "feature/plan/draft", sessionId: "default", seq: 1, startedAt: s(1), at: s(10), status: "success" },
  { instanceId: "i2", stateId: "feature/plan/critique", sessionId: "review", seq: 1, startedAt: s(12), at: s(30), status: "success" },
  { instanceId: "i3", stateId: "feature/plan/lint", sessionId: "lint", seq: 1, startedAt: s(14), at: s(25), status: "success" },
  { instanceId: "i4", stateId: "feature/plan/revise", sessionId: "default", seq: 2, startedAt: s(40), at: s(50), status: "error" },
  { instanceId: "i5", stateId: "feature/plan/revise", sessionId: "default-b", seq: 1, startedAt: s(52), at: s(60), status: "success", branch: { parent: "default", at: 2 } },
];
const SAID: Record<string, TranscriptEntry[]> = {
  i1: [say("user", "Draft the plan.", s(1), 0), call("Read", { file_path: `${S}/board.tsx` }, `${S}/board.tsx`, s(3)), say("assistant", "A first draft, in three steps.", s(10), 1)],
  i2: [say("user", "Critique the draft.", s(12), 0), say("assistant", "Two weaknesses.", s(30), 1)],
  i3: [say("user", "Lint the workflow.", s(14), 0), say("assistant", "Clean.", s(25), 1)],
  i4: [say("user", "Revise it.", s(40), 2), say("assistant", "The call failed.", s(50), 3)],
  i5: [say("user", "Revise it.", s(52), 0), say("assistant", "Revised.", s(60), 1)],
};
const NOTES: BandNote[] = [
  { seq: 1, at: s(0.5), kind: "entered", path: "draft", stateId: "feature/plan/draft", instanceId: "i1", text: "" },
  { seq: 2, at: s(11), kind: "entered", path: "critique", stateId: "feature/plan/critique", instanceId: "i2", text: "" },
  { seq: 3, at: s(11.5), kind: "entered", path: "lint", stateId: "feature/plan/lint", instanceId: "i3", text: "" },
  { seq: 4, at: s(35), kind: "blocked", path: "publish", stateId: "feature/plan/publish", text: "input 'framing': producer output has no 'winner'" },
  {
    seq: 5,
    at: s(36),
    kind: "made",
    path: "build[0]",
    stateId: "feature/plan/build",
    text: "",
    made: {
      kind: "split",
      runs: [
        { taskId: "t-a", element: 0, title: "Alpha", status: "running", holding: 0, self: true, waitsFor: false },
        { taskId: "t-b", element: 1, title: "Beta", status: "queued", holding: 1, self: false, waitsFor: true },
        { taskId: "t-c", element: 2, title: "Gamma", status: "completed", holding: 0, held: true, self: false, waitsFor: false },
      ],
    },
  },
  { seq: 6, at: s(39), kind: "entered", path: "revise", stateId: "feature/plan/revise", instanceId: "i4", text: "" },
];
const BANDS = bandsOf(piecesOf(ROOT, REFS));

function DomBands(): JSX.Element {
  return (
    <ValuePanelContext.Provider value={PANEL}>
      <SessionBandsView bands={BANDS} notes={NOTES} scope="t" render={(piece) => <DomTranscript entries={SAID[piece.node.instanceId] ?? []} working={false} />} />
    </ValuePanelContext.Provider>
  );
}
function RnBands(): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("bg") as never} paddingTop={14} paddingHorizontal={16} paddingBottom={22}>
      <SessionBands bands={BANDS} notes={NOTES} root="" scope="t" shut={new Set()} onToggle={() => undefined} onSetShut={() => undefined} render={(piece) => <Transcript session={null} entries={SAID[piece.node.instanceId] ?? []} working={false} rails />} />
    </View>
  );
}
TRANSCRIPT_SPECIMENS["session-bands"] = { width: 760, dom: DomBands, rn: RnBands };

/**
 * What a call draws under its row unasked, and the rows that are not a plain call: an agent's question
 * with its answer, what a workflow tool did, an approval asked and answered, a call stopped while it was
 * being written.
 */
const SHOWN: TranscriptEntry[] = [
  say("user", "Plan the pause feature with me.", s(0), 0),
  {
    kind: "tool",
    name: "AskUserQuestion",
    summary: "Which should a pause keep?",
    at: s(2),
    callId: "q1",
    args: { questions: [{ question: "Which should a pause keep?", header: "Pause", options: [{ label: "The worktree", description: "keep the files as they are" }, { label: "Nothing" }] }] },
    ok: true,
    result: "User has answered your questions: \"Which should a pause keep?\"=\"The worktree\".",
  },
  say("assistant", "Keeping the worktree, then.", s(5), 1),
  {
    kind: "tool",
    name: "start_task",
    summary: "feature/product",
    at: s(8),
    args: { state: "feature/product" },
    ok: true,
    result: { ok: true, task: "t-1", key: "product", state: "feature/product", status: "started", mount: "plain", inputs: [{ name: "issue", via: "asked" }] },
  },
  say("assistant", "Product is running.", s(9), 2),
  { kind: "tool", name: "approve_tool_call", summary: "", at: s(10), args: { command: "git push origin main", asker: "smart" }, ok: true, result: "allow", detail: { decision: "allow", scope: "session", by: "person", waitedMs: 4200 } },
  say("assistant", "Pushed.", s(12), 3),
  { kind: "writing", name: "Write", path: `${S}/pause.md`, chars: 5400, at: s(13) },
];
TRANSCRIPT_SPECIMENS["transcript-shown"] = pair(SHOWN);
