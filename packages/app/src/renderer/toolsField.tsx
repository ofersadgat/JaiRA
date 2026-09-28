/**
 * The state editor's ONE Tools field (decision 0007 §6): a picker of the permission set the state starts
 * from, and beneath it the same rows Settings → Permission sets uses, for the lines the state writes over it.
 *
 * Whether a block shows it is `showsToolsField`'s call, not this component's.
 *
 * A render function: what it shows arrives as `value`, and every change leaves as the whole form.
 * The picker is asked through the schema form like every other typed input — an `enum`, so a box
 * that completes against the permission sets this project can name.
 */
import type { JSX } from "react";
import type { ToolChoice, PermissionSetChoice } from "@jaira/shared/browser";
import { SchemaForm } from "./schemaForm/SchemaForm";
import { PermissionSetLines } from "./permissionSetCard";
import { linesOfPermissionSet, permissionSetOfLines, type ToolsFieldForm } from "./toolsFieldForm";
import { unreadNoteOf, useToolsField } from "./toolsFieldModel";

export { ToolsFieldProvider, useToolsFieldData, type ToolsFieldData } from "./toolsFieldModel";

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
  const field = useToolsField(value, permissionSets, readOnly === true, onChange);
  if (field === null) return null;
  const { schema, picked, onPick, unread, note } = field;
  return (
    <div className="cfg-span cfg-block set-tools-field">
      <SchemaForm
        schema={schema}
        value={picked}
        onChange={onPick}
        ctx={{ path: block ?? "environment", disabled: readOnly === true }}
      />
      <PermissionSetLines
        permissionSet={permissionSetOfLines(value.lines)}
        tools={tools}
        readOnly={readOnly}
        note={note}
        addLabel="add a tool, a command or script"
        startAdding={startAdding}
        onChange={(next) => onChange({ ...value, lines: linesOfPermissionSet(next) })}
      />
      {unread.length > 0 ? (
        <p className="sub warn-text">{unreadNoteOf(unread)}</p>
      ) : null}
    </div>
  );
}
