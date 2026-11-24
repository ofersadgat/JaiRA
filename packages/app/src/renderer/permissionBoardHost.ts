/**
 * The permission board's host (decision 0034): the board built from the conversation's stack as the
 * engine composed it (`permissionSets:stack`, through the composer's stack host) and the settings'
 * tool mapping (`permissions.resources`, through `config:read`), and a move's edits written where they
 * belong — the conversation's own lines through the conversation's settings, a set's through
 * `permissionSets:write` into the settings layer its file is in. Nothing here draws; the arithmetic is
 * `permissionBoard.ts`'s.
 */
import { useMemo, useState } from "react";
import { isWritableSetLayer, PERMISSION_SET_LAYER_LABELS, placeSetsOf, type PermissionSetDecl, type WritableSetLayer } from "@jaira/shared/browser";
import { boardOf, editsIn, withLinesEdited, type Board, type BoardLayer, type BoardRowRef, type LineEdit } from "./permissionBoard";
import { withLayerMovedTo, withLayerRemoved, withLayerReplaced, withUnsavedAdded, withUnsavedLines, withUnsavedMerged } from "./composerStack";
import { permissionSetReference } from "./toolsFieldForm";
import type { ComposerStack, StackHost } from "./composerStackHost";
import { invoke } from "./store";
import { useView } from "./useView";

export interface PermissionBoardHost {
  /** `undefined` until the stack is read. */
  board: Board | undefined;
  onToggle: (ref: BoardRowRef) => void;
  onCommit: (edits: LineEdit[]) => Promise<void>;
  /** Rows by resource, or by tool. */
  by: "resources" | "tools";
  onBy: (by: "resources" | "tools") => void;
  /** The layer heads' acts (2026-11-23). */
  layers: LayerHost;
}

/** A set a layer can be swapped for, and where it lives. */
export interface SetChoice {
  id: string;
  reference: string;
  where: string;
}

/** What the board's layer heads do to the conversation's stack — none of it changes a set's file but Save. */
export interface LayerHost {
  /** Every set, nearest layer's word for where it lives. */
  sets: SetChoice[];
  /** Where a set can be saved: the settings layers this window has, but what ships. */
  saveTo: Array<{ layer: WritableSetLayer; label: string }>;
  /** A new, empty unsaved layer just before this one. */
  addBefore: (layer: BoardLayer) => void;
  /** Dragged onto another layer's head: put just before it (or last, before the run's answers). */
  moveBefore: (layer: BoardLayer, before: BoardLayer | undefined) => void;
  moveBy: (layer: BoardLayer, by: -1 | 1) => void;
  remove: (layer: BoardLayer) => void;
  /** Whether an unsaved layer holds lines — what swapping it, or taking it off, asks about first. */
  holdsLines: (layer: BoardLayer) => boolean;
  /** Swap a layer for a set; an unsaved one is replaced, or the set merged into it. */
  swap: (layer: BoardLayer, set: SetChoice, how: "replace" | "merge") => Promise<void>;
  /** Keep an unsaved layer (or the conversation's own lines) as a set file, and name it in the stack. */
  save: (layer: BoardLayer, name: string, where: WritableSetLayer) => Promise<void>;
  clear: () => void;
  forget: () => Promise<void>;
  unpin: (layer: BoardLayer) => Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `permissions.resources` as the settings come to: tool → resource permissions. */
export function mappingOf(effective: unknown): Record<string, string[]> {
  const permissions = isObject(effective) ? effective["permissions"] : undefined;
  const resources = isObject(permissions) ? permissions["resources"] : undefined;
  if (!isObject(resources)) return {};
  return Object.fromEntries(Object.entries(resources).filter(([, list]) => Array.isArray(list)).map(([tool, list]) => [tool, (list as unknown[]).filter((each): each is string => typeof each === "string")]));
}

/** `permissions.placeSets` as the settings come to: a set's name → its places. */
export function placeSetsSettingOf(effective: unknown): Record<string, string[]> {
  const permissions = isObject(effective) ? effective["permissions"] : undefined;
  const sets = isObject(permissions) ? permissions["placeSets"] : undefined;
  if (!isObject(sets)) return {};
  return Object.fromEntries(Object.entries(sets).filter(([, list]) => Array.isArray(list)).map(([name, list]) => [name, (list as unknown[]).filter((each): each is string => typeof each === "string")]));
}

export function usePermissionBoardHost({ stack, host }: { stack: ComposerStack; host: StackHost | undefined }): PermissionBoardHost {
  const project = host?.project;
  const config = useView("config:read", project !== undefined ? { project } : {}).value;
  const mapping = useMemo(() => mappingOf(config?.effective), [config]);
  // The machine's projects folder is the `root` place set: where its workspaces and their worktrees go.
  const machines = useView("machines:view", {}).value;
  const placeSets = useMemo(() => placeSetsOf(placeSetsSettingOf(config?.effective), machines?.self.projectsFolder), [config, machines]);
  const [resources, setResources] = useState<ReadonlySet<string>>(() => new Set(["files", "cat:files"]));
  const [by, setBy] = useState<"resources" | "tools">("resources");
  const [accesses, setAccesses] = useState<ReadonlySet<string>>(() => new Set());
  const records = useView("permissionSets:read", project !== undefined ? { project } : {}).value;
  const sets = useMemo((): SetChoice[] => (records?.records ?? []).map((record) => ({ id: record.id, reference: permissionSetReference(record.id), where: record.files[0] !== undefined ? PERMISSION_SET_LAYER_LABELS[record.files[0].layer] : "" })), [records]);
  const saveTo = useMemo(() => (records?.layers ?? []).filter(isWritableSetLayer).map((layer) => ({ layer, label: PERMISSION_SET_LAYER_LABELS[layer] })), [records]);
  const board = useMemo(() => (stack.view !== null ? boardOf({ view: stack.view, mapping, placeSets, by, open: { resources, accesses } }) : undefined), [stack.view, mapping, placeSets, by, resources, accesses]);

  const flip = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return {
    board,
    by,
    onBy: setBy,
    onToggle: (ref) => {
      if (ref.level === 1) setResources((was) => flip(was, ref.resource));
      else if (ref.level === 2) setAccesses((was) => flip(was, `${ref.resource}.${ref.access}`));
    },
    onCommit: async (edits) => {
      if (board === undefined) return;
      // A set's file first: if it cannot be written, the conversation is not changed either.
      for (const layer of board.layers) {
        const mine = editsIn(edits, layer.key);
        if (mine.length === 0 || layer.writes !== "set" || layer.setLayer === undefined) continue;
        const read = await invoke("permissionSets:read", project !== undefined ? { project } : {});
        const record = read.records.find((each) => each.id === layer.id);
        const file = record?.files.find((each) => each.layer === layer.setLayer);
        if (file?.decl === undefined) throw new Error(`${layer.label} could not be read here${file?.problem !== undefined ? ` — ${file.problem}` : ""}`);
        const next = withLinesEdited(file.decl as Record<string, unknown>, mine) as PermissionSetDecl;
        await invoke("permissionSets:write", { id: layer.id, layer: layer.setLayer, ...(project !== undefined ? { project } : {}), permissionSet: next });
      }
      const own = board.layers.find((layer) => layer.writes === "conversation");
      const mine = own !== undefined ? editsIn(edits, own.key) : [];
      if (mine.length > 0) stack.writeOwn((lines) => withLinesEdited(lines, mine));
      // An unsaved layer's lines are the conversation's too.
      for (const layer of board.layers) {
        const theirs = editsIn(edits, layer.key);
        if (theirs.length > 0 && layer.unsaved !== undefined) stack.editForm((form) => withUnsavedLines(form, layer.unsaved!, (lines) => withLinesEdited(lines, theirs)));
      }
      stack.refresh();
    },
    layers: {
      sets,
      saveTo,
      addBefore: (layer) => stack.editForm((form) => withUnsavedAdded(form, layer.entry ?? form.layers.length)),
      moveBefore: (layer, before) =>
        stack.editForm((form) => {
          if (layer.entry === undefined) return form;
          const at = before?.entry ?? form.layers.length;
          return withLayerMovedTo(form, layer.entry, at > layer.entry ? at - 1 : at);
        }),
      moveBy: (layer, by) => stack.editForm((form) => (layer.entry === undefined ? form : withLayerMovedTo(form, layer.entry, layer.entry + by))),
      remove: (layer) => stack.editForm((form) => (layer.entry === undefined ? form : withLayerRemoved(form, layer.entry))),
      holdsLines: (layer) => layer.unsaved !== undefined && Object.keys(stack.form.unsaved?.[layer.unsaved] ?? {}).some((key) => !key.startsWith("$")),
      swap: async (layer, set, how) => {
        if (layer.entry === undefined) return;
        if (how === "merge" && layer.unsaved !== undefined) {
          // The set as it reads here, references followed: the nearest copy of it.
          const read = await invoke("permissionSets:read", project !== undefined ? { project } : {});
          const decl = read.records.find((each) => each.id === set.id)?.files.find((file) => file.decl !== undefined)?.decl;
          if (decl === undefined) throw new Error(`${set.id} could not be read here`);
          stack.editForm((form) => withUnsavedMerged(form, layer.unsaved!, decl as Record<string, unknown>));
          return;
        }
        stack.editForm((form) => withLayerReplaced(form, layer.entry!, set.reference));
      },
      save: async (layer, name, where) => {
        const id = name.trim();
        const form = stack.form;
        const lines = layer.unsaved !== undefined ? Object.fromEntries(Object.entries(form.unsaved?.[layer.unsaved] ?? {}).filter(([key]) => !key.startsWith("$"))) : { ...(form.tools ?? {}) };
        await invoke("permissionSets:write", { id, layer: where, ...(project !== undefined ? { project } : {}), permissionSet: lines as PermissionSetDecl });
        const reference = permissionSetReference(id);
        if (layer.unsaved !== undefined && layer.entry !== undefined) stack.editForm((owned) => withLayerReplaced(owned, layer.entry!, reference));
        // The conversation's own lines, kept: the set takes their place as the newest layer it names.
        else stack.editForm((owned) => ({ ...owned, layers: [...owned.layers, reference], tools: {} }));
      },
      clear: () => stack.editForm((form) => ({ ...form, tools: {} })),
      forget: () => stack.forget(),
      unpin: async (layer) => {
        const segment = stack.layers.find((each) => each.role === "standing" && each.id === layer.id);
        if (segment !== undefined) await stack.pin(segment, false);
      },
    },
  };
}
