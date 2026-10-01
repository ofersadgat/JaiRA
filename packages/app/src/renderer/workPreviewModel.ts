/**
 * Appearance → Conversation's work preview, as data: one request's work, timed back from `now` — a few
 * calls in, many calls in, and finished with its answer.
 */
import type { TranscriptEntry } from "./transcript";

const S = "packages/app/src/renderer";
const WITHHELD = "(withheld by the provider)";

/** The request, as entries timed back from `now`: the last call is `live` seconds old. */
export function story(now: number): TranscriptEntry[] {
  const at = (s: number): number => now - (372 - s) * 1000;
  const call = (name: string, key: string, arg: string, s: number, ok: boolean | undefined = true): TranscriptEntry => ({
    kind: "tool",
    name,
    summary: arg,
    args: { [key]: arg },
    at: at(s),
    ...(ok === undefined ? {} : { ok, result: ok ? "ok" : { is_error: true, error: "1 failed" } }),
  });
  return [
    // What a session logs before it does anything: notes about the run, not work.
    { kind: "event", at: at(0), tone: "plain", text: "Hook ran: SessionStart (0.4 s)" },
    { kind: "event", at: at(0), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
    { kind: "thought", at: at(1), text: WITHHELD, durationMs: 6_200 },
    call("Grep", "pattern", "scrollbar", 8),
    call("Read", "file_path", `${S}/styles.css`, 9),
    call("Read", "file_path", `${S}/index.html`, 11),
    call("Grep", "pattern", "overflow: auto", 13),
    {
      kind: "thought",
      at: at(14),
      text: "Several columns scroll on their own — the transcript, the chat list, the side panel and the diff editor. Check how each draws its scrollbar before touching the stylesheet.",
      durationMs: 4_100,
    },
    call("Read", "file_path", `${S}/transcriptView.tsx`, 19),
    call("Read", "file_path", `${S}/chatPane.tsx`, 20),
    call("Read", "file_path", `${S}/sidePanel.tsx`, 21),
    call("WebFetch", "url", "https://developer.chrome.com/docs/css-ui/scrollbar-styling", 26),
    { kind: "event", at: at(29), tone: "warn", text: "Rate limited — waited 12 s before the next call" },
    call("Bash", "command", "git log --oneline -3", 43),
    { kind: "thought", at: at(44), text: "One global ::-webkit-scrollbar rule is enough, and Chromium skips it wherever scrollbar-width is set.", durationMs: 9_800 },
    call("Edit", "file_path", `${S}/styles.css`, 55),
    call("Edit", "file_path", `${S}/schemaEditor.tsx`, 62),
    call("Bash", "command", "npx tsc --noEmit", 64),
    call("Bash", "command", "npx vitest run floatLayers.test.ts", 91, false),
    { kind: "thought", at: at(99), text: WITHHELD, durationMs: 5_500 },
    call("Read", "file_path", "packages/app/test/floatLayers.test.ts", 105),
    call("Edit", "file_path", "packages/app/test/floatLayers.test.ts", 109),
    call("Bash", "command", "npx vitest run floatLayers.test.ts", 112),
    { kind: "event", at: at(160), tone: "plain", text: "Context injected: CLAUDE.md (4.1 kB)" },
    call("Edit", "file_path", `${S}/styles.css`, 162),
    call("Bash", "command", "npx vitest run packages/app", 166),
  ];
}

export const ANSWER = "Every scrollbar now uses one rule in `styles.css`: a thin rounded thumb, no track. `floatLayers.test.ts` needed one exemption; the app suite passes.";

/** The preview's three moments, each its label, its note, its entries and whether the agent is still at it. */
export function workPreviewStates(now: number): Array<{ label: string; note: string; entries: TranscriptEntry[]; working: boolean }> {
  const all = story(now);
  // A state still working is timed so its running call started a few seconds ago — each state is
  // its own moment, not a slice of the finished one read against the same clock.
  const running = (entries: TranscriptEntry[], ago: number): TranscriptEntry[] => {
    const last = entries[entries.length - 1]!;
    const lastAt = "at" in last && last.at !== undefined ? last.at : now;
    const shift = now - ago - lastAt;
    const moved = entries.map((entry) => ("at" in entry && entry.at !== undefined ? { ...entry, at: entry.at + shift } : entry)) as TranscriptEntry[];
    const tail = moved[moved.length - 1]!;
    if (tail.kind !== "tool") return moved;
    const { ok: _ok, result: _result, ...rest } = tail;
    return [...moved.slice(0, -1), rest];
  };
  return [
    { label: "Working", note: "a few calls in", entries: running(all.slice(0, 6), 2_000), working: true },
    { label: "Working", note: "many calls in", entries: running(all, 5_000), working: true },
    { label: "Finished", note: "with its answer", entries: [...all, { kind: "message", role: "assistant", at: now, text: ANSWER } as TranscriptEntry], working: false },
  ];
}
