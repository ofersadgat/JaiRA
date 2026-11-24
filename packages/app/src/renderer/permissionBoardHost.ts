/**
 * The permission board's host (decision 0034): the board built from the conversation's stack as the
 * engine composed it (`permissionSets:stack`, through the composer's stack host) and the settings'
 * tool mapping (`permissions.resources`, through `config:read`), and a move's edits written where they
 * belong — the conversation's own lines through the conversation's settings, a set's through
 * `permissionSets:write` into the settings layer its file is in. Nothing here draws; the arithmetic is
 * `permissionBoard.ts`'s.
 */
import { useMemo, useState } from "react";
import { placeSetsOf, type PermissionSetDecl } from "@jaira/shared/browser";
import { boardOf, editsIn, withLinesEdited, type Board, type BoardRowRef, type LineEdit } from "./permissionBoard";
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
      stack.refresh();
    },
  };
}
