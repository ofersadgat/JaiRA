/**
 * What the composer's stack reads from the engine and writes back (decision 0023 §4.1): the stack
 * composed (`permissionSets:stack`, twice — whole, for the segments and Everything; and without the
 * tools layer, for what the Tools card's lines are written against), and the writes a segment makes —
 * the conversation's settings, a pin in the project's settings, the run's answers let go of, a stack
 * saved as a set. The arithmetic is `composerStack.ts`'s.
 *
 * With no `host` nothing is asked: the stack is drawn from the settings alone, as it is until the
 * engine answers.
 */
import { useMemo, useRef } from "react";
import type { ChatSettings, PermissionSet, PermissionSetTreeRequest, PermissionStackView, WritableLayer } from "@jaira/shared/browser";
import {
  belowRequestOf,
  belowSetOf,
  declOfView,
  effectiveMapOf,
  layerSegmentsOf,
  ownedFormOf,
  pinnedConfigOf,
  saveStackRequestOf,
  stackBucketOf,
  stackFormOf,
  stackSettingsOf,
  standingOf,
  toolsWriteOf,
  withLayerRemoved,
  type LayerSegment,
  type StackForm,
} from "./composerStack";
import { invoke, syncCache } from "./store";
import { useView } from "./useView";

/** Where the stack is read: the project, and the conversation's task (for its run's answers). */
export interface StackHost {
  project?: string | undefined;
  taskId?: string | undefined;
}

export interface ComposerStack {
  form: StackForm;
  /** The stack composed, whole — the last one read while a newer one loads. */
  view: PermissionStackView | null;
  /** The map the layers under the tools layer come to. */
  below: PermissionSet;
  /** What the whole stack comes to: what the Tools card draws. */
  map: PermissionSet;
  layers: LayerSegment[];
  runtime: Readonly<Record<string, "allow" | "deny">>;
  /** What a tree read about this stack is asked with — `null` with no host. */
  treeRequest: PermissionSetTreeRequest | null;
  /** Keep a new form as the conversation's. */
  write: (next: StackForm) => void;
  /** The Tools card's map, written as the tools layer. */
  writeTools: (next: PermissionSet) => void;
  /** Let go of the run's answers these keys name, or every one. */
  forget: (keys?: readonly string[]) => Promise<void>;
  /** Pin a layer to this project's standing layers of the stack's bucket, or take it off. */
  pin: (segment: LayerSegment, pin: boolean) => Promise<void>;
  /** Save the stack as a set file. */
  saveStack: (name: string, layer: WritableLayer) => Promise<void>;
}

/** The value a view last had, kept while a newer request loads — so an edit does not blank what is drawn. */
function useLast<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}

export function useComposerStack({
  host,
  settings,
  inherited,
  overrides,
  onOverrides,
}: {
  host: StackHost | undefined;
  settings: ChatSettings;
  /** The map the settings come to with no stack chosen here — the state's. */
  inherited: PermissionSet;
  overrides: ChatSettings;
  onOverrides: (next: ChatSettings) => void;
}): ComposerStack {
  const form = useMemo(() => stackFormOf(settings), [settings]);
  const where = host === undefined ? null : { ...(host.project !== undefined ? { project: host.project } : {}), ...(host.taskId !== undefined ? { taskId: host.taskId } : {}) };
  const fullRequest = where === null ? null : { ...where, permissionSet: stackSettingsOf(form) };
  const belowRequest = where === null ? null : { ...where, permissionSet: belowRequestOf(form) };
  const view = useLast(useView("permissionSets:stack", fullRequest).value) ?? null;
  const belowView = useLast(useView("permissionSets:stack", belowRequest).value);
  const belowDecl = useMemo(() => (belowView !== undefined ? declOfView(belowView) : undefined), [belowView]);
  const below = useMemo(() => belowSetOf(belowDecl), [belowDecl]);
  const map = useMemo(() => effectiveMapOf(form, belowDecl, inherited), [form, belowDecl, inherited]);
  const layers = useMemo(() => layerSegmentsOf(view, form), [view, form]);
  const refresh = (): void => {
    if (fullRequest !== null) void syncCache().refresh("permissionSets:stack", fullRequest);
    if (belowRequest !== null) void syncCache().refresh("permissionSets:stack", belowRequest);
  };
  const write = (next: StackForm): void => onOverrides({ ...overrides, permissionSet: stackSettingsOf(next) as ChatSettings["permissionSet"] });
  return {
    form,
    view,
    below,
    map,
    layers,
    runtime: view?.runtime ?? {},
    treeRequest: fullRequest,
    write: (next) => write(ownedFormOf(next, below, inherited)),
    writeTools: (next) => write(toolsWriteOf(ownedFormOf(form, below, inherited), below, next)),
    forget: async (keys) => {
      if (host?.taskId === undefined) return;
      await invoke("permissionSets:forgetRuntime", { taskId: host.taskId, ...(host.project !== undefined ? { project: host.project } : {}), ...(keys !== undefined ? { keys: [...keys] } : {}) });
      refresh();
    },
    pin: async (segment, pin) => {
      if (segment.reference === undefined) return;
      const project = host?.project;
      const read = await invoke("config:read", project !== undefined ? { project } : undefined);
      const bucket = stackBucketOf(form);
      await invoke("config:write", {
        layer: "project",
        ...(project !== undefined ? { project } : {}),
        config: pinnedConfigOf(read.project, standingOf(read.effective, bucket), bucket, segment.reference, pin) as never,
      });
      // Pinned, it stands under the conversation's layers by settings: the conversation's own copy goes.
      // Either way the settings are sent again, so what runs now — and what waits on the person — is
      // decided under the stack with the pin (`chat:settings`).
      if (pin && segment.index !== undefined) write(withLayerRemoved(ownedFormOf(form, below, inherited), segment.index));
      else onOverrides({ ...overrides });
      refresh();
    },
    saveStack: async (name, layer) => {
      const project = host?.project;
      await invoke("permissionSets:saveStack", { ...saveStackRequestOf(ownedFormOf(form, below, inherited), name, layer), ...(project !== undefined ? { project } : {}) });
    },
  };
}
