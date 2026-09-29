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
import { Transcript } from "./transcriptView";
import { workPreviewStates } from "./workPreviewModel";
import { WorkLookContext, type WorkLook } from "./workSummaryView";

export function WorkPreview({ look }: { look: WorkLook }): JSX.Element {
  // Timed once, when the preview opens, so the "so far" clocks read as they would in a live turn.
  const [now] = useState(() => Date.now());
  const states = useMemo(() => workPreviewStates(now), [now]);
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
            <Transcript entries={state.entries} working={state.working} />
          </div>
        ))}
      </div>
    </WorkLookContext.Provider>
  );
}
