/**
 * What running a state from the Files inspector needs of its host — the surface the universal
 * `RunPanel` (`packages/universal/src/components/panel/RunPanel.tsx`) is handed and `panelHost.ts`
 * builds. Everything with a decision in it is in `runForm.ts`. A type only.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { TaskSummary } from "@jaira/shared/browser";
import type { RunField, RunTarget, RunValues } from "./runForm";
import type { SettledMark } from "./schemaForm/types";

/**
 * Everything the two sections need beyond the state itself.
 *
 * One bag rather than a dozen props, and optional at the call site: {@link StateInspector} is also
 * rendered in places with no host to start a task from, and a Run button that cannot run is worse
 * than no Run button.
 *
 * `values` lives in the store rather than in this component, for the reason every other per-document
 * thing in this view does: the inspector unmounts the moment you click another file, and a paragraph
 * of instruction typed into an input slot is exactly as losable as a draft.
 */
export interface RunSurface {
  /**
   * The state's declared inputs, read from the SAVED document. `null` when it does not parse.
   *
   * Read by the host rather than here so that both sections and the store agree on one reading —
   * and so the parse happens once per file opened, not once per keystroke in a box.
   */
  fields: RunField[] | null;
  /** What the form holds — a value per slot that is set. */
  values: RunValues;
  /**
   * How each value was settled (decision 0005 §4), when the form is showing what a run was CALLED
   * with and nothing has been typed over it. Absent for a form that is a question about the next run.
   */
  provenance?: ((path: string) => SettledMark | undefined) | undefined;
  /**
   * Which project the run goes to, decided by the file's layer — see {@link runTargetOf}.
   *
   * Named on screen rather than left implicit. A shared workflow runs in JaiRA's own project with
   * `~/.jaira` as its workspace, and that is a surprise worth one line of text before the button
   * rather than a discovery afterwards.
   */
  target: RunTarget;
  /** Where the target project lives on disk, for the tooltip. */
  targetDir?: string | undefined;
  /** The open file exists on disk. A never-saved draft has no snapshot to pin. */
  exists: boolean;
  /** The open file has unsaved edits. A run reads the SAVED file, so this is worth saying out loud. */
  dirty: boolean;
  busy: boolean;
  /**
   * Every task in the TARGET project — what "started here" filters.
   *
   * The target's, not the focused project's: a shared state's runs are recorded in JaiRA's own
   * project, and listing the open checkout's tasks beside a button that writes somewhere else would
   * make the section permanently empty and permanently wrong about why.
   */
  tasks: TaskSummary[];
  /** The task the rest of the app has selected, so the row for it reads as current. */
  selected: string | null;
  onChange: (values: RunValues) => void;
  /** Create the task and start it. The title is generated; see {@link runTitle}. */
  onRun: (title: string, inputs: Record<string, JsonValue>) => void;
  /**
   * Open a previous run.
   *
   * `project` is which one holds it, and the two history groups differ: a run STARTED here is the
   * target's, while one that merely passed through was projected from the state view, which is the
   * focused project's. Reading a task out of the wrong project finds nothing.
   */
  onSelectTask: (taskId: string, project?: string) => void;
}
