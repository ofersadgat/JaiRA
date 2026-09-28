import type { JSX } from "react";
import { View } from "@tamagui/core";
import { MODE_WHEN_UNSET, OTHER_SUBJECT, TOOL_SPEC_BY_NAME, type PermissionSet, type PermissionSetChoice, type ToolChoice } from "@jaira/shared/browser";
import { withOther, withoutSubject, withSubjectMode, withToolImplementation } from "@jaira/ui/composerPermissionSet";
import { TYPED_LINE, lineOptionsOf, withLinePicked, withLineTyped, withoutOther } from "@jaira/ui/permissionSetLinesModel";
import { linesOfPermissionSet, permissionSetOfLines, type ToolsFieldForm } from "@jaira/ui/toolsFieldForm";
import { unreadNoteOf, useToolsField } from "@jaira/ui/toolsFieldModel";
import { edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { SchemaForm } from "../form/SchemaForm";
import { AddMenu, SubjectRow, ToolRow, type AddOption } from "../settings/permissions/rows";
import { Sub } from "./controls";

/**
 * `toolsField.tsx`, universal (decision 0015): the state editor's ONE Tools field — the permission set
 * the state starts from, asked through the schema form, and beneath it the lines the state writes over it
 * (`permissionSetCard.tsx`'s `PermissionSetLines`, drawn with Settings' own rows). What it offers and
 * writes is `toolsFieldModel.ts`'s and `permissionSetLinesModel.ts`'s. The rules:
 *
 *   .cfg-span.cfg-block.set-tools-field   a column; its `.set-card` 6 above
 *   .set-card                             at most 560 wide, padding 10 12 11, 1px --line, radius 12, --panel
 *   .cx-cat-body.set-flat                 no rule, no indent: the lines one under another
 */
export function ToolsFieldControl({
  value,
  permissionSets,
  tools,
  readOnly,
  block,
  onChange,
}: {
  value: ToolsFieldForm;
  permissionSets: readonly PermissionSetChoice[];
  tools: readonly ToolChoice[];
  readOnly?: boolean | undefined;
  block?: string | undefined;
  onChange: (next: ToolsFieldForm) => void;
}): JSX.Element | null {
  const field = useToolsField(value, permissionSets, readOnly === true, onChange);
  if (field === null) return null;
  const { schema, picked, onPick, unread, note } = field;
  return (
    <View flexDirection="column" minWidth={0}>
      <SchemaForm schema={schema} value={picked} onChange={onPick} ctx={{ path: block ?? "environment", disabled: readOnly === true }} />
      <View marginTop={6}>
        <PermissionSetLines
          permissionSet={permissionSetOfLines(value.lines)}
          tools={tools}
          readOnly={readOnly}
          note={note}
          addLabel="add a tool, a command or script"
          onChange={(next) => onChange({ ...value, lines: linesOfPermissionSet(next) })}
        />
      </View>
      {unread.length > 0 ? <Sub color="warn">{unreadNoteOf(unread)}</Sub> : null}
    </View>
  );
}

/** The lines a state writes over its permission set, flat, each with its minus, and one line that adds. */
function PermissionSetLines({
  permissionSet,
  tools,
  onChange,
  readOnly,
  note,
  addLabel,
}: {
  permissionSet: PermissionSet;
  tools: readonly ToolChoice[];
  onChange?: ((next: PermissionSet) => void) | undefined;
  readOnly?: boolean | undefined;
  note: string;
  addLabel: string;
}): JSX.Element {
  const t = useTokens();
  const locked = readOnly === true || onChange === undefined;
  const write = (next: PermissionSet): void => onChange?.(next);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (
    <View maxWidth={560} paddingTop={10} paddingHorizontal={12} paddingBottom={11} borderRadius={12} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      <View flexDirection="column">
        {Object.entries(permissionSet.entries).map(([subject, entry]) =>
          entry.kind === "tool" ? (
            <ToolRow
              key={subject}
              note={note}
              tool={byName.get(subject) ?? { name: subject }}
              spec={TOOL_SPEC_BY_NAME.get(subject)}
              mode={entry.mode ?? MODE_WHEN_UNSET}
              impl={entry.implementation ?? "app"}
              readOnly={locked}
              {...(locked ? {} : { onRemove: () => write(withoutSubject(permissionSet, subject)) })}
              onMode={(next) => write(withSubjectMode(permissionSet, subject, next))}
              onImpl={(next) => write(withToolImplementation(permissionSet, subject, next))}
            />
          ) : (
            <SubjectRow
              key={subject}
              subject={subject}
              hint={note}
              mode={entry.mode ?? MODE_WHEN_UNSET}
              readOnly={locked}
              {...(locked ? {} : { onRemove: () => write(withoutSubject(permissionSet, subject)) })}
              onMode={(next) => write(withSubjectMode(permissionSet, subject, next))}
            />
          ),
        )}
        {permissionSet.other !== undefined ? (
          <SubjectRow
            subject={OTHER_SUBJECT}
            hint="anything no line names"
            mode={permissionSet.other}
            readOnly={locked}
            {...(locked ? {} : { onRemove: () => write(withoutOther(permissionSet)) })}
            onMode={(next) => write(withOther(permissionSet, next))}
          />
        ) : null}
        {locked ? null : (
          <AddMenu
            label={addLabel}
            options={lineOptionsOf(permissionSet, tools) as AddOption[]}
            onPick={(subject) => write(withLinePicked(permissionSet, subject))}
            typed={{
              ...TYPED_LINE,
              onAdd: (typed) => {
                const line = withLineTyped(permissionSet, typed);
                if ("problem" in line) return line.problem;
                write(line.next);
                return undefined;
              },
            }}
          />
        )}
      </View>
    </View>
  );
}
