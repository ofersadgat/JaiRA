/**
 * What the state editor's Tools field (`toolsField.tsx`, decision 0007 §6) holds and decides — the data
 * it is handed from outside the document, the picker's schema and what a pick writes — moved here
 * unchanged so the universal copy (`components/workflow/ToolsField.tsx`) runs the same field (decision 0015).
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { SHARED_SESSION, permissionSetChoicesAt, permissionSetsAt, type FileTree, type PermissionSetChoice, type PermissionSetsView, type ToolChoice } from "@jaira/shared/browser";
import { invoke } from "./store";
import type { Schema } from "./schemaForm/types";
import { pickOfReference, referenceOfLabel, permissionSetPicks, type ToolsFieldForm } from "./toolsFieldForm";

/**
 * What the field needs from outside the document: the permission sets this project can name, and the
 * tools a line can be written for.
 *
 * A context rather than a prop, because the field sits five components down from anything that can
 * ask main for them — and EMPTY by default, so a form rendered outside the shell still draws: the
 * picker then offers what the state already names, and "none".
 */
export interface ToolsFieldData {
  permissionSets: readonly PermissionSetChoice[];
  tools: readonly ToolChoice[];
}
const ToolsFieldContext = createContext<ToolsFieldData>({ permissionSets: [], tools: [] });
export const ToolsFieldProvider = ToolsFieldContext.Provider;
export const useToolsFieldData = (): ToolsFieldData => useContext(ToolsFieldContext);

/** The field's picker, its value and what a pick writes — or `null` where a reading has nothing to say. */
export function useToolsField(
  value: ToolsFieldForm,
  permissionSets: readonly PermissionSetChoice[],
  readOnly: boolean,
  onChange: (next: ToolsFieldForm) => void,
): { schema: Schema; picked: { tools: string }; onPick: (next: unknown) => void; unread: string[]; note: string } | null {
  // What is in the box while it is NOT yet one of the rows: a datalist box is typed into a letter at
  // a time, and a reference is only written once the text is a permission set somebody can name.
  const [typing, setTyping] = useState<string | null>(null);
  const held = value.reference.trim().length > 0 || Object.keys(value.lines).length > 0 || Object.keys(value.unread).length > 0;
  // A reading shows what the state says, and a state that says nothing about tools says nothing here.
  if (readOnly && !held) return null;
  const picks = permissionSetPicks(permissionSets, value.reference);
  const schema: Schema = {
    type: "object",
    required: ["tools"],
    properties: {
      tools: {
        type: "string",
        title: "Tools",
        description: "A permission set, and any lines this state writes over it.",
        enum: picks.map((pick) => pick.label),
      },
    },
  };
  return {
    schema,
    picked: { tools: typing ?? pickOfReference(picks, value.reference).label },
    onPick: (next) => {
      const label = (next as { tools?: unknown } | undefined)?.tools;
      const reference = typeof label === "string" ? referenceOfLabel(picks, label) : undefined;
      // A label nobody offered is somebody mid-word in the box: nothing is written until it is one.
      setTyping(reference === undefined && typeof label === "string" ? label : null);
      if (reference !== undefined) onChange({ ...value, reference });
    },
    unread: Object.keys(value.unread),
    note: value.reference.trim().length > 0 ? "over the permission set, for this state" : "this state's own line",
  };
}

/** What the field says about lines it could not read. */
export const unreadNoteOf = (unread: readonly string[]): string =>
  `${unread.map((key) => `'${key}'`).join(", ")} ${unread.length === 1 ? "is" : "are"} written here and could not be read as a line — kept as written; see the JSON tab.`;

/**
 * The field's data, read (`App.tsx`'s, moved here so the universal shell reads it the same way): the
 * permission sets the project the window stands on can name, and the tools a line can be written for.
 *
 * Read once per project, and again when the TREE is refetched, which is what a `workflows` invalidate
 * does — the scope every permission set write publishes, so the picker never lists a permission set
 * that is not there. `usedBy: false` because only the Settings pane asks who uses one. A read that fails
 * leaves the picker offering what the state already names and "none", which is what it can prove.
 */
export function useToolsFieldRead(project: string | null | undefined, tree: FileTree | null): ToolsFieldData {
  const [read, setRead] = useState<PermissionSetsView | null>(null);
  useEffect(() => {
    let live = true;
    void invoke("permissionSets:read", { project: project ?? SHARED_SESSION, usedBy: false }).then(
      (found) => live && setRead(found),
      () => live && setRead(null),
    );
    return () => void (live = false);
  }, [project, tree]);
  return useMemo<ToolsFieldData>(
    () =>
      read === null
        ? { permissionSets: [], tools: [] }
        : { permissionSets: permissionSetChoicesAt(permissionSetsAt(read.records, read.layers[0] ?? "project")), tools: read.tools },
    [read],
  );
}
