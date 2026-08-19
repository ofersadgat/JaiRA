/**
 * One state's configuration, in the window's side panel.
 *
 * What clicking a box in the graph opens. A box draws a MOUNT — this key, this wiring, this
 * environment — and the thing an author wants when they point at one is the state that mount runs:
 * its slots, its operation, its own children. That lives in another file, and until this existed the
 * only way to read it was to go there, which meant losing the graph you were reading it FROM.
 *
 * The same form and the same JSON tab as the middle column, over the same channel and the same
 * writer, because it is the same document: a state edited in a side panel is not a lesser state. The
 * graph tab is left out — a drawing in a 300px column is a drawing nobody can read — and the form is
 * what it opens on, since the panel is where you go to check a value rather than to hand-edit one.
 *
 * ## Why it holds its own copy
 *
 * The panel is handed to the shell as a rendered element (see `valuePanel.ts`), so its props are
 * whatever they were when the click happened; a draft threaded through the store would not reach it
 * afterwards. So it loads the document itself and keeps its own unsaved text — `WorkflowEditor`
 * supports exactly that, uncontrolled, and the drafts it holds are its own for as long as it is on
 * screen. That is also the honest model for a panel: it is a second window onto a file, opened
 * deliberately, and closing it is how you put it away.
 */
import { useEffect, useState, type JSX } from "react";
import type {
  ExecutorInfo,
  FileTree,
  StateSlots,
  ValidateSchemaResult,
  WorkflowLayer,
  WorkflowSource,
} from "@jaira/shared/browser";
import type { UiSurface } from "./fileTypes";
import { WorkflowEditor } from "./stateEditor";

export function StatePanel({
  stateId,
  read,
  save,
  tree,
  executors,
  busy,
  validateSchema,
  loadStateSlots,
  wrapJson,
  onWrapJson,
  ui,
  readFile,
  onOpenState,
}: {
  /** The state to show. Fetched here rather than passed, so the panel outlives whatever opened it. */
  stateId: string;
  read: (stateId: string) => Promise<WorkflowSource | null>;
  save: (source: WorkflowSource, text: string) => void;
  tree: FileTree | null;
  executors: ExecutorInfo[];
  busy: boolean;
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  loadStateSlots?: ((stateIds: string[]) => Promise<Record<string, StateSlots> | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
  /** Any file's text, so a linked property in this form shows what it says too. */
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  /** Go to it properly — the panel is a reading, and this is the way out of one. */
  onOpenState?: ((stateId: string) => void) | undefined;
}): JSX.Element {
  const [source, setSource] = useState<WorkflowSource | null | "missing">(null);

  useEffect(() => {
    let live = true;
    setSource(null);
    void read(stateId).then((found) => {
      if (live) setSource(found ?? "missing");
    });
    return () => {
      live = false;
    };
  }, [stateId, read]);

  if (source === null) return <p className="empty">Reading {stateId}…</p>;
  if (source === "missing") {
    // A mount may name a state nothing defines — the linter says so, and so does this rather than
    // showing an empty form that reads as "this state has no configuration".
    return <p className="empty">Nothing under either root defines {stateId}.</p>;
  }
  return (
    <div className="state-panel">
      {/* The way OUT of a reading. The editor below carries the path and the tabs, so this row is one
          button and nothing else: repeating the file name above it said the same thing twice. */}
      {onOpenState !== undefined ? (
        <div className="state-panel-go">
          <button type="button" className="ghost" onClick={() => onOpenState(stateId)} title={`open ${source.file}`}>
            Open in the editor
          </button>
        </div>
      ) : null}
      <WorkflowEditor
        source={source}
        tree={tree}
        executors={executors}
        busy={busy}
        // Form and JSON only: the third reading is a picture, and the column this sits in is a
        // quarter of the window wide.
        tabs={["form", "json"]}
        {...(validateSchema !== undefined ? { validateSchema } : {})}
        {...(loadStateSlots !== undefined ? { loadStateSlots } : {})}
        {...(wrapJson !== undefined ? { wrapJson } : {})}
        onWrapJson={onWrapJson}
        ui={ui}
        {...(readFile !== undefined ? { readFile } : {})}
        onSave={(_stateId, _layer, text) => save(source, text)}
      />
    </div>
  );
}
