/**
 * The pieces of a chat turn as the app draws them today — server-rendered from the real `Transcript`,
 * for the tool-summary mockup (the person's note 6, 2026-09-25). Nothing is hand-written HTML: each
 * message and each line of work is the component's own markup, so the mockup's "today" is the app's.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/tool-summary-static.mts <out.json>`
 *
 * Writes `{ today, pieces }`: `today` is the whole turn as one paper; `pieces` is the same turn one
 * entry at a time, each rendered alone, so the mockup can place a message, or a single tool line,
 * wherever the proposal puts it.
 */
import { writeFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../src/renderer/transcript";
import { Paper, Transcript } from "../src/renderer/transcriptView";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: tool-summary-static.mts <out.json>");

const t0 = Date.parse("2026-09-25T17:42:08Z");
const at = (s: number): number => t0 + s * 1000;
const R = "packages/app/src/renderer";

const tool = (name: string, summary: string, args: object, result: unknown, s: number, ok = true): TranscriptEntry => ({
  kind: "tool",
  name,
  summary,
  args: args as never,
  result: result as never,
  ok,
  at: at(s),
});

const entries: TranscriptEntry[] = [
  { kind: "message", role: "user", at: at(0), text: "When I open the context panel beside a chat and click the ×, it disappears instead of collapsing. Why?" },
  { kind: "thought", at: at(1), text: "The panel has a fold and a close. Closing sets closedOn, which reconcile honours until the root changes — beside a chat the root never changes.", durationMs: 8_400 },
  tool("Grep", "closedOn", { pattern: "closedOn", path: R }, "panelStack.ts:68\npanelStack.ts:92\npanelStack.ts:106", 10),
  tool("Read", `${R}/panelStack.ts`, { file_path: `${R}/panelStack.ts` }, "(285 lines)", 11),
  tool("Read", `${R}/sidePanel.tsx`, { file_path: `${R}/sidePanel.tsx` }, "(389 lines)", 12),
  tool("Read", `${R}/App.tsx`, { file_path: `${R}/App.tsx`, offset: 1580, limit: 360 }, "(360 lines)", 13),
  { kind: "thought", at: at(14), text: "App passes onFold but the chat room's rule always proposes the same root.", durationMs: 5_900 },
  tool("Grep", "PANEL_FOLD", { pattern: "PANEL_FOLD", path: R }, "App.tsx:1890\nuiState.ts:131", 21),
  { kind: "event", at: at(22), tone: "warn", text: "Rate limited — waited 18 s before the next call" },
  tool("Bash", "git log --oneline -5 -- packages/app/src/renderer/sidePanel.tsx", { command: "git log --oneline -5 -- packages/app/src/renderer/sidePanel.tsx" }, "3240ca0 app: side panels…", 41),
  tool("mcp__dai__list_merge_requests", "state: opened", { state: "opened" }, { merge_requests: [] }, 42),
  { kind: "event", at: at(43), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
  { kind: "event", at: at(43), tone: "plain", text: "Hook ran: PostToolUse (0.2 s)" },
  {
    kind: "message",
    role: "assistant",
    at: at(45),
    text: "Beside a conversation, **×** closes the panel and `reconcile` keeps it closed until the room stands on something else — and a chat never does. So it is gone for good.\n\nI'll make **×** fold it to the rail there.",
  },
  { kind: "message", role: "user", at: at(80), text: "yes, do it" },
  { kind: "thought", at: at(81), text: "Add closeFolds to SidePanel and set it for chat and convo roots.", durationMs: 3_100 },
  tool("Edit", `${R}/sidePanel.tsx`, { file_path: `${R}/sidePanel.tsx` }, "ok", 85),
  tool("Edit", `${R}/App.tsx`, { file_path: `${R}/App.tsx` }, "ok", 88),
  tool("Edit", "packages/app/test/sidePanel.test.ts", { file_path: "packages/app/test/sidePanel.test.ts" }, "ok", 92),
  tool("Bash", "npx vitest run packages/app/test/sidePanel.test.ts", { command: "npx vitest run packages/app/test/sidePanel.test.ts" }, { is_error: true, error: "1 failed" }, 101, false),
  tool("Edit", "packages/app/test/sidePanel.test.ts", { file_path: "packages/app/test/sidePanel.test.ts" }, "ok", 110),
  tool("Bash", "npx vitest run packages/app/test/sidePanel.test.ts", { command: "npx vitest run packages/app/test/sidePanel.test.ts" }, "17 passed", 118),
  tool("mcp__linear__update_issue", "JAI-412", { id: "JAI-412", state: "In review" }, { ok: true }, 121),
  { kind: "message", role: "assistant", at: at(124), text: "Done. Beside a chat, **×** now folds the panel to its rail; the Tasks room keeps both buttons. `sidePanel.test.ts` passes." },
];

/**
 * A LONG stretch — thirty-odd lines of work under one request — for the cases where a summary has to
 * hold a lot: a turn still going with many calls behind it, and the same turn finished.
 */
const S = "packages/app/src/renderer";
const long: TranscriptEntry[] = [
  { kind: "message", role: "user", at: at(200), text: "Make every scrollbar in the app one style, and check nothing hides them." },
  { kind: "thought", at: at(201), text: "(withheld by the provider)", durationMs: 6_200 },
  tool("Grep", "scrollbar", { pattern: "scrollbar", path: S }, "styles.css:8992, styles.css:8996", 208),
  tool("Read", `${S}/styles.css`, { file_path: `${S}/styles.css` }, "(17662 lines)", 209),
  tool("Read", `${S}/index.html`, { file_path: `${S}/index.html` }, "(40 lines)", 211),
  tool("Grep", "overflow: auto", { pattern: "overflow: auto", path: S }, "61 matches", 213),
  { kind: "thought", at: at(214), text: "Several columns scroll on their own — the transcript, the chat list, the side panel, the Files tree and the diff editor. Check how each one draws its scrollbar before touching the stylesheet.", durationMs: 4_100 },
  tool("Read", `${S}/transcriptView.tsx`, { file_path: `${S}/transcriptView.tsx` }, "(1832 lines)", 219),
  tool("Read", `${S}/chatPane.tsx`, { file_path: `${S}/chatPane.tsx` }, "(1086 lines)", 220),
  tool("Read", `${S}/sidePanel.tsx`, { file_path: `${S}/sidePanel.tsx` }, "(389 lines)", 221),
  tool("Read", `${S}/files.tsx`, { file_path: `${S}/files.tsx` }, "(1900 lines)", 222),
  tool("Read", `${S}/monacoDiff.tsx`, { file_path: `${S}/monacoDiff.tsx` }, "(1400 lines)", 223),
  tool("Grep", "scrollbar-width", { pattern: "scrollbar-width", path: S }, "styles.css:8992", 225),
  tool("WebFetch", "https://developer.chrome.com/docs/css-ui/scrollbar-styling", { url: "https://developer.chrome.com/docs/css-ui/scrollbar-styling" }, "(page)", 226),
  { kind: "event", at: at(229), tone: "warn", text: "Rate limited — waited 12 s before the next call" },
  tool("Read", `${S}/schemaEditor.tsx`, { file_path: `${S}/schemaEditor.tsx` }, "(600 lines)", 241),
  tool("Bash", "git log --oneline -3 -- packages/app/src/renderer/styles.css", { command: "git log --oneline -3 -- packages/app/src/renderer/styles.css" }, "139b252a app: …", 243),
  { kind: "thought", at: at(244), text: "One global ::-webkit-scrollbar rule is enough, and Chromium skips it wherever scrollbar-width is set, so that one rule in the gallery has to stay. schemaEditor measures the gutter rather than assuming it, so a thinner bar keeps its caret aligned.", durationMs: 9_800 },
  tool("Edit", `${S}/styles.css`, { file_path: `${S}/styles.css` }, "ok", 255),
  tool("Edit", `${S}/styles.css`, { file_path: `${S}/styles.css` }, "ok", 258),
  tool("Edit", `${S}/schemaEditor.tsx`, { file_path: `${S}/schemaEditor.tsx` }, "ok", 262),
  tool("Bash", "npx tsc --noEmit -p packages/app", { command: "npx tsc --noEmit -p packages/app" }, "", 264),
  { kind: "event", at: at(290), tone: "plain", text: "Hook ran: PostToolUse (0.3 s)" },
  tool("Bash", "npx vitest run packages/app/test/floatLayers.test.ts", { command: "npx vitest run packages/app/test/floatLayers.test.ts" }, { is_error: true, error: "1 failed" }, 291, false),
  { kind: "thought", at: at(299), text: "(withheld by the provider)", durationMs: 5_500 },
  tool("Read", "packages/app/test/floatLayers.test.ts", { file_path: "packages/app/test/floatLayers.test.ts" }, "(210 lines)", 305),
  tool("Edit", "packages/app/test/floatLayers.test.ts", { file_path: "packages/app/test/floatLayers.test.ts" }, "ok", 309),
  tool("Bash", "npx vitest run packages/app/test/floatLayers.test.ts", { command: "npx vitest run packages/app/test/floatLayers.test.ts" }, "4 passed", 312),
  tool("Bash", "npx tsx packages/app/shots/chat-chrome.mts", { command: "npx tsx packages/app/shots/chat-chrome.mts" }, "7 shots", 318),
  { kind: "event", at: at(361), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
  tool("Edit", `${S}/styles.css`, { file_path: `${S}/styles.css` }, "ok", 362),
  tool("Bash", "npx vitest run packages/app", { command: "npx vitest run packages/app" }, "212 passed", 366),
  { kind: "message", role: "assistant", at: at(420), text: "Every scrollbar now uses one rule in `styles.css`: a thin rounded thumb, no track. `floatLayers.test.ts` needed one exemption; the app suite passes." },
];
/** A call not yet answered: the row as the transcript draws it while it runs. */
const inFlight = (entry: TranscriptEntry): TranscriptEntry | null => {
  if (entry.kind !== "tool") return null;
  const { ok: _ok, result: _result, ...rest } = entry;
  return rest;
};

const paper = (list: TranscriptEntry[]): string => renderToStaticMarkup(h(Paper, null, h(Transcript, { entries: list })));
const bare = (list: TranscriptEntry[]): string => renderToStaticMarkup(h(Transcript, { entries: list }));

writeFileSync(
  out,
  JSON.stringify({
    today: paper(entries),
    pieces: entries.map((entry) => ({ kind: entry.kind, html: bare([entry]) })),
    long: long.map((entry) => ({ kind: entry.kind, html: bare([entry]), live: inFlight(entry) === null ? null : bare([inFlight(entry)!]) })),
  }),
);
console.log(`wrote ${out}`);
