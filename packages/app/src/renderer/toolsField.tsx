/**
 * The state editor's ONE Tools field (decision 0007 §6): a picker of the permission set the state starts
 * from, and beneath it the same rows Settings → Permission sets uses, for the lines the state writes over it.
 *
 * It replaces two fields that said one thing between them — a list of names in `tools`, and their
 * modes in `permissions` — for a state written the new way. A state still written the old way keeps
 * those two fields unchanged; which a state IS is `showsToolsField`'s call, not this component's.
 *
 * A render function: what it shows arrives as `value`, and every change leaves as the whole form.
 * The picker is asked through the schema form like every other typed input — an `enum`, so a box
 * that completes against the permission sets this project can name.
 */
import { createContext, useContext, useState, type JSX } from "react";
import type { ToolChoice, PermissionSetChoice } from "@jaira/shared/browser";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { PermissionSetLines } from "./permissionSetCard";
import { linesOfPermissionSet, pickOfReference, referenceOfLabel, permissionSetOfLines, permissionSetPicks, type ToolsFieldForm } from "./toolsFieldForm";

/**
 * What the field needs from outside the document: the permission sets this project can name, and the tools a
 * line can be written for.
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

export function ToolsFieldControl({
  value,
  permissionSets,
  tools,
  onChange,
  readOnly,
  startAdding,
  block,
}: {
  value: ToolsFieldForm;
  /** Every permission set this project can name — the winners, as the composer's Permissions card lists them. */
  permissionSets: readonly PermissionSetChoice[];
  /** Every tool a line can be written for. */
  tools: readonly ToolChoice[];
  onChange: (next: ToolsFieldForm) => void;
  readOnly?: boolean | undefined;
  /** The add line drawn open from the first render — for a still picture. */
  startAdding?: boolean | undefined;
  /** The block this field is in, for the path beside its name: `operation`, or `environment` (the default). */
  block?: string | undefined;
}): JSX.Element | null {
  // What is in the box while it is NOT yet one of the rows: a datalist box is typed into a letter at
  // a time, and a reference is only written once the text is a permission set somebody can name.
  const [typing, setTyping] = useState<string | null>(null);
  const held = value.reference.trim().length > 0 || Object.keys(value.lines).length > 0 || Object.keys(value.unread).length > 0;
  // A reading shows what the state says, and a state that says nothing about tools says nothing here.
  if (readOnly === true && !held) return null;
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
  const unread = Object.keys(value.unread);
  return (
    <div className="cfg-span cfg-block set-tools-field">
      <SchemaForm
        schema={schema}
        value={{ tools: typing ?? pickOfReference(picks, value.reference).label }}
        onChange={(next) => {
          const label = (next as { tools?: unknown } | undefined)?.tools;
          const reference = typeof label === "string" ? referenceOfLabel(picks, label) : undefined;
          // A label nobody offered is somebody mid-word in the box: nothing is written until it is one.
          setTyping(reference === undefined && typeof label === "string" ? label : null);
          if (reference !== undefined) onChange({ ...value, reference });
        }}
        ctx={{ path: block ?? "environment", disabled: readOnly === true }}
      />
      <PermissionSetLines
        permissionSet={permissionSetOfLines(value.lines)}
        tools={tools}
        readOnly={readOnly}
        note={value.reference.trim().length > 0 ? "over the permission set, for this state" : "this state's own line"}
        addLabel="add a tool, a command or script"
        startAdding={startAdding}
        onChange={(next) => onChange({ ...value, lines: linesOfPermissionSet(next) })}
      />
      {unread.length > 0 ? (
        <p className="sub warn-text">
          {unread.map((key) => `'${key}'`).join(", ")} {unread.length === 1 ? "is" : "are"} written here and could not be read as a line — kept as written; see the JSON tab.
        </p>
      ) : null}
    </div>
  );
}
