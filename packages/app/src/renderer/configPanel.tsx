/**
 * One state's configuration as this run had it — the state editor, rendered as a READING.
 *
 * What the link on a run's panel opens, and on the workflow panel a conversation's gutter leads to.
 * Those panels project a handful of fields out of a state — an executor, a model, whether that
 * executor is reachable — and the question they raise is the one they cannot answer: what is this
 * state, and what did it actually get?
 *
 * ## The same editor, not a second rendering of it
 *
 * The form, the JSON and the graph are the ones the Files view uses, over the same document, through
 * the same component. A read-only viewer written beside it would be a second answer to "what does a
 * state look like", and the two would drift within a month — the form has thirty controls and each
 * one of them is a decision about how a state reads.
 *
 * Two things differ, and both are `reading.ts`:
 *
 *  - **Nothing changes anything**, and the controls that would are not rendered at all. Not disabled
 *    — absent: a greyed-out Save under a run that finished last week is an offer about a document
 *    nobody is editing, and it still costs a row of a narrow column. The `fieldset` around the whole
 *    thing is the backstop for the boxes that remain, which show values and must not take them.
 *  - **The bindings have their values under them.** A binding says where a value comes from; the run
 *    is the one time it was applied. That pairing is the whole reason to look at a state through a
 *    run rather than at the file.
 *
 * ## Which copy — and it says so
 *
 * A run PINS its workflow (DESIGN §5.3), and the pinned copy is a LOWERED bundle — compiled
 * expressions, no authored spelling — which no form can draw (see `effectiveState`). So what is on
 * screen is the file, and the panel says whether that file is still the one that ran: it either
 * matches the run's pin, or the workflow has moved since and the line above says so. Reached from a
 * state file rather than a run, the question does not arise.
 *
 * ## Why it reads its own copy
 *
 * The panel is handed to the shell as a rendered element (see `valuePanel.ts`), so its props are
 * frozen at the moment it was pinned. It fetches on mount instead, the same way `statePanel.tsx`
 * does and for the same reason.
 */
import { useEffect, useState, type JSX } from "react";
import type { EffectiveState, ExecutorInfo, FileTree } from "@jaira/shared/browser";
import { ReadOnlyContext, RunReadingContext } from "./reading";
import { WorkflowEditor } from "./stateEditor";

/**
 * What the form needs to show a state WHOLE, beyond the document itself.
 *
 * All optional, and the panel is legible without any of them — but not complete. The one that
 * matters most is `readFile`: a prompt held in another file (`{"$ref": "$/prompts/goals.md"}`) is
 * the substance of the state, and without a reader the row shows a path where the prompt should be.
 * A reading that cannot read the thing being read is the wrong kind of empty.
 */
export type ConfigPanelServices = Pick<
  Parameters<typeof WorkflowEditor>[0],
  "readFile" | "readState" | "loadStateSlots" | "validateSchema" | "ui" | "wrapJson" | "onWrapJson"
>;

export function ConfigPanel({
  read,
  tree,
  executors,
  onOpenState,
  services,
}: {
  /** The state, its copy, and what the run put through it. Fetched here — see the module note. */
  read: () => Promise<EffectiveState | null>;
  /** Both layer roots, for the completions the form builds. Null is a form with none. */
  tree?: FileTree | null;
  /** For naming an operation's function — and for saying which of them are actually on. */
  executors?: ExecutorInfo[];
  /** Open the FILE. The panel is a reading of one run; the file is where it is changed. */
  onOpenState?: ((stateId: string) => void) | undefined;
  /** What the form needs to show a linked prompt, a child's slots, a graph — see the type. */
  services?: ConfigPanelServices | undefined;
}): JSX.Element {
  const [found, setFound] = useState<EffectiveState | null | "missing">(null);

  useEffect(() => {
    let live = true;
    setFound(null);
    void read().then(
      (next) => live && setFound(next ?? "missing"),
      () => live && setFound("missing"),
    );
    return () => {
      live = false;
    };
  }, [read]);

  if (found === null) return <p className="empty">Reading the state…</p>;
  if (found === "missing") return <p className="empty">That state&apos;s configuration could not be read.</p>;
  return (
    <ConfigReading
      state={found}
      tree={tree ?? null}
      executors={executors ?? []}
      {...(onOpenState !== undefined ? { onOpenState } : {})}
      {...(services !== undefined ? { services } : {})}
    />
  );
}

/**
 * The panel once it has something to show — split out so it can be rendered without a fetch.
 *
 * The same division every surface in here makes: the component that GOES AND LOOKS wraps one that is
 * handed what it found. Which also makes this the half a test can render, since a static render runs
 * no effects and would otherwise only ever see "Reading the state…".
 */
export function ConfigReading({
  state,
  tree = null,
  executors = [],
  onOpenState,
  services,
}: {
  state: EffectiveState;
  tree?: FileTree | null;
  executors?: ExecutorInfo[];
  onOpenState?: ((stateId: string) => void) | undefined;
  services?: ConfigPanelServices | undefined;
}): JSX.Element {
  return (
    <div className="pane config-panel">
      <div className="sb-gutter">
        <span className="sb-session mono ellip" title={state.rootId !== undefined ? `in ${state.rootId}` : undefined}>
          {state.stateId}
        </span>
        {/* WHICH document this is. Nothing else on screen distinguishes the copy a run pinned from
            the copy on disk, and after any edit they are two different states under one name. */}
        <span className={`sub ellip${state.from === "moved" ? " warn" : ""}`} title={state.snapshotHash}>
          {state.from === "pinned"
            ? "the file this run pinned"
            : state.from === "moved"
              ? "the workflow has changed since this run — this is the file as it stands now"
              : "as it stands on disk now"}
        </span>
        {onOpenState !== undefined ? (
          <button type="button" className="link" onClick={() => onOpenState(state.stateId)} title="open its file">
            open ↗
          </button>
        ) : null}
      </div>

      {state.source === undefined ? (
        // Not an error and not an empty form: an id the bundle does not contain is an answer — the
        // state was renamed, or it belongs to a root this workflow does not reach.
        <p className="empty">
          The workflow that ran has no state called <code>{state.stateId}</code>.
        </p>
      ) : (
        <ReadOnlyContext.Provider value={true}>
          <RunReadingContext.Provider value={state.values ?? null}>
            {/* The editor makes its own body inert — see `Body` in `stateEditor.tsx`. Its tab bar
                stays live, because switching between the form, the document and the drawing is a
                change of what you are LOOKING at rather than a change to the state. */}
            <WorkflowEditor
              source={state.source}
              tree={tree}
              executors={executors}
              busy={false}
              // Unreachable: the bar that would call it is not rendered in a reading. Passed because
              // the editor takes it, and a throwing stub would be a trap for whoever changes that.
              onSave={() => undefined}
              {...(services ?? {})}
            />
          </RunReadingContext.Provider>
        </ReadOnlyContext.Provider>
      )}
    </div>
  );
}
