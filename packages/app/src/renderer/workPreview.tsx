/**
 * Appearance → Conversation's preview of the work summary: one request's work, drawn three times by
 * the real {@link Transcript} under the settings being chosen — a few calls in, many calls in, and
 * finished with its answer.
 *
 * Unlike the other previews on the page it takes the pointer (`.ws-preview`): what the summary is
 * FOR is its hover cards and its "Every step", and a preview you cannot hover shows the half of it
 * that matters least.
 */
import { useMemo, useState, type JSX } from "react";
import type { TranscriptEntry } from "./transcript";
import { Transcript } from "./transcriptView";
import { WorkLookContext, type WorkLook } from "./workSummaryView";

const S = "packages/app/src/renderer";
const WITHHELD = "(withheld by the provider)";

/** The request, as entries timed back from `now`: the last call is `live` seconds old. */
function story(now: number): TranscriptEntry[] {
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

const ANSWER = "Every scrollbar now uses one rule in `styles.css`: a thin rounded thumb, no track. `floatLayers.test.ts` needed one exemption; the app suite passes.";

export function WorkPreview({ look }: { look: WorkLook }): JSX.Element {
  // Timed once, when the preview opens, so the "so far" clocks read as they would in a live turn.
  const [now] = useState(() => Date.now());
  const states = useMemo(() => {
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
      { label: "Working", note: "a few calls in", entries: running(all.slice(0, 4), 2_000) },
      { label: "Working", note: "many calls in", entries: running(all, 5_000) },
      { label: "Finished", note: "with its answer", entries: [...all, { kind: "message", role: "assistant", at: now, text: ANSWER } as TranscriptEntry] },
    ];
  }, [now]);
  return (
    <WorkLookContext.Provider value={look}>
      <div className="set-preview ws-preview">
        {states.map((state, i) => (
          <div key={i} className="ws-preview-card">
            <div className="ws-preview-head">
              <span className={`ws-preview-dot${state.label === "Finished" ? " done" : ""}`} />
              {state.label}
              <span className="ws-preview-note">{state.note}</span>
            </div>
            <Transcript entries={state.entries} />
          </div>
        ))}
      </div>
    </WorkLookContext.Provider>
  );
}
