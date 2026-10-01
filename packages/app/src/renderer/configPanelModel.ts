/**
 * What `configPanel.tsx` and `statePanel.tsx` compute — the reads each panel makes for itself, and what
 * the reading says about which copy it is showing — moved here unchanged so the universal copies
 * (`components/workflow/ConfigPanel.tsx`) read and say the same (decision 0015).
 */
import { useCallback, useEffect, useState } from "react";
import type { EffectiveState, StateSlots, ValidateSchemaResult, WorkflowLayer, WorkflowSource } from "@jaira/shared/browser";
import type { UiSurface } from "./fileTypes";
import { invoke } from "./store";

/**
 * What the form needs to show a state WHOLE, beyond the document itself.
 *
 * All optional, and the panel is legible without any of them — but not complete. The one that
 * matters most is `readFile`: a prompt held in another file (`{"$ref": "$/prompts/goals.md"}`) is
 * the substance of the state, and without a reader the row shows a path where the prompt should be.
 * A reading that cannot read the thing being read is the wrong kind of empty.
 */
export interface ConfigPanelServices {
  /** Read any file in either layer, for showing what a LINKED property says. */
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  /** Read a state that is NOT this file — what the graph's side panel needs. */
  readState?: ((stateId: string) => Promise<WorkflowSource | null>) | undefined;
  /** Read what a set of states declare as inputs, for the children table's wiring rows. */
  loadStateSlots?: (stateIds: string[]) => Promise<Record<string, StateSlots> | null>;
  /** Check the JSON tab's draft against a schema. Absent ⇒ the tab stays a plain text box. */
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  /** The window's remembered layout, for the JSON tab's field reference — see `uiState.ts`. */
  ui?: UiSurface | undefined;
  /** Word wrap on the JSON tab. Passed through so the preference is one setting, not one per editor. */
  wrapJson?: boolean;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
}

/**
 * The effective state, fetched on mount (the panel is handed to the shell as a rendered element, so its
 * props are frozen at the moment it was pinned). `null` while reading, `"missing"` when it could not be.
 */
export function useEffectiveState(read: () => Promise<EffectiveState | null>): EffectiveState | null | "missing" {
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
  return found;
}

/**
 * WHICH document a reading is. Nothing else on screen distinguishes the copy a run pinned from the copy
 * on disk, and after any edit they are two different states under one name.
 */
export function copyWordsOf(state: Pick<EffectiveState, "from">): string {
  return state.from === "pinned"
    ? "the file this run pinned"
    : state.from === "moved"
      ? "the workflow has changed since this run — this is the file as it stands now"
      : "as it stands on disk now";
}

/** The reading's id tooltip: the root it was read in. */
export const readingTitleOf = (state: Pick<EffectiveState, "rootId">): string | undefined => (state.rootId !== undefined ? `in ${state.rootId}` : undefined);

/**
 * One state's file, fetched for a side panel that outlives whatever opened it (`statePanel.tsx`).
 * `null` while reading, `"missing"` when nothing under either root defines it.
 */
export function useStateSource(stateId: string, read: (stateId: string) => Promise<WorkflowSource | null>): WorkflowSource | null | "missing" {
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
  return source;
}

/** A stable `read` for `ConfigPanel`, whose effect re-reads whenever the function changes (`panelViews.tsx`). */
export function useEffectiveRead(stateId: string, taskId?: string, instanceId?: string, project?: string | null): () => ReturnType<typeof invokeEffective> {
  return useCallback(() => invokeEffective(stateId, taskId, instanceId, project), [stateId, taskId, instanceId, project]);
}

function invokeEffective(stateId: string, taskId?: string, instanceId?: string, project?: string | null) {
  return invoke("state:effective", {
    stateId,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(project !== undefined && project !== null ? { project } : {}),
  });
}
