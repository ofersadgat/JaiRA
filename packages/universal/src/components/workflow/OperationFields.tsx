import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { NO_ISSUES, fieldClass, type FormIssues } from "@jaira/ui/issues";
import { reasoningSchemaOf } from "@jaira/ui/llmConfigModel";
import { levelsFooter, useModelParameters } from "@jaira/ui/modelParameters";
import {
  CONVERSATION_MODES,
  JSON_FIELDS,
  SIMPLE_FIELDS,
  type ConversationForm,
  type JsonField,
  type OperationFieldsForm,
  type SessionForm,
  type SimpleField,
} from "@jaira/ui/operationForm";
import {
  CONVERSATION_TITLE,
  FORK_TITLE,
  LINKED_NOTE,
  REF_HINT,
  SESSION_CHOICES,
  SESSION_NAME_TITLE,
  SESSION_TITLE,
  STRUCTURED_SESSION,
  modelKnobsSet,
  reasoningFormOf,
  reasoningValueOf,
  simpleFieldShown,
  visibleField,
  withField,
  withJson,
  withRef,
} from "@jaira/ui/operationFieldsModel";
import { useRunReading } from "@jaira/ui/reading";
import { useToolsFieldData } from "@jaira/ui/toolsFieldModel";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { SchemaForm } from "../form/SchemaForm";
import { Area, Box, FieldName, Pick, SlotOpt, Sub, markOf, useLists, useReadOnly } from "./controls";
import { LinkInput, LinkPreview, LinkToggle, ReadValue } from "./Links";
import { RowControls, SlotTable } from "./SlotTable";
import { ToolsFieldControl } from "./ToolsField";

/**
 * One `operation` or `environment` block of the workflow editor — its simple fields from the shared
 * table (`SIMPLE_FIELDS`), the Tools field, the operation's inputs and output, the session, the
 * conversation and, folded, the model's knobs. Which fields show and what an edit writes are
 * `operationFieldsModel.ts`'s. How it looks:
 *
 *   the block            column, gap 8
 *   a field              a column, gap 4: its name (app 11/12.5 --dim 0.04em upper) over the control
 *   the fork switch      app 11/12.5
 *   the model's knobs    a fold: its summary app 11/12.5 --dim, padding 4 0, a ▸ (▾ open) before the
 *                        words; open, a 2px --line on its left, 8 in, 2 out
 *   the reasoning's foot app 11/12.5 --dim
 */

/** A field: its name over its control, and what hangs under it. */
export function Field({ name, children, gap = 4 }: { name: ReactNode; children: ReactNode; gap?: number }): JSX.Element {
  return (
    <View flexDirection="column" gap={gap} minWidth={0}>
      {typeof name === "string" ? <FieldName>{name}</FieldName> : name}
      {children}
    </View>
  );
}

function SimpleFieldControl({
  spec,
  form,
  targets,
  path,
  issues,
  onChange,
  onLink,
}: {
  spec: SimpleField;
  form: OperationFieldsForm;
  targets: readonly string[];
  path?: string | undefined;
  issues: FormIssues;
  onChange: (name: string, value: string) => void;
  onLink: (name: string, ref: string | null) => void;
}): JSX.Element | null {
  const readOnly = useReadOnly();
  const lists = useLists();
  const structured = form.structured[spec.name] === true;
  const ref = form.refs[spec.name];
  const linked = ref !== undefined;
  const value = form.fields[spec.name] ?? "";
  if (!simpleFieldShown(readOnly, form, spec)) return null;
  const mark = markOf(path === undefined ? "" : fieldClass(issues, `${path}.${spec.key}`));
  const title = structured ? REF_HINT : spec.hint;
  return (
    <Field
      name={
        <View flexDirection="row" alignItems="center">
          <FieldName>{spec.label}</FieldName>
          {spec.linkable === true ? <LinkToggle linked={linked} disabled={structured} onToggle={(next) => onLink(spec.name, next ? (ref ?? "") : null)} /> : null}
        </View>
      }
    >
      {linked ? (
        <LinkInput value={ref} targets={targets} mark={mark} onChange={(next) => onLink(spec.name, next)} />
      ) : spec.multiline ? (
        <Area value={value} onChange={(v) => onChange(spec.name, v)} rows={spec.name === "prompt" ? 6 : 3} placeholder={structured ? "" : spec.placeholder} disabled={structured} mark={mark} title={title} />
      ) : (
        <Box value={value} onChange={(v) => onChange(spec.name, v)} placeholder={structured ? "" : spec.placeholder} disabled={structured} mark={mark} title={title} listed={spec.name === "functionRef" && lists.functions} {...(spec.type === "number" ? { inputMode: "decimal" as const } : {})} />
      )}
      {structured ? <Sub>{REF_HINT}</Sub> : null}
      {linked ? <Sub>{LINKED_NOTE}</Sub> : null}
      {linked && ref !== undefined && ref.length > 0 ? <LinkPreview reference={ref} /> : null}
    </Field>
  );
}

function JsonFieldControl({ spec, form, onChange }: { spec: JsonField; form: OperationFieldsForm; onChange: (name: string, value: string) => void }): JSX.Element | null {
  if (useReadOnly() && (form.json[spec.name] ?? "").trim().length === 0) return null;
  return (
    <Field name={spec.label}>
      <Area value={form.json[spec.name] ?? ""} onChange={(v) => onChange(spec.name, v)} rows={3} code minHeight={220} placeholder={spec.placeholder} title={spec.hint} />
    </Field>
  );
}

function SessionControl({ value, path, issues, onChange }: { value: SessionForm; path?: string | undefined; issues: FormIssues; onChange: (session: SessionForm) => void }): JSX.Element | null {
  if (useReadOnly() && value.mode === "absent") return null;
  return (
    <Field name="Session">
      <RowControls>
        <Pick
          value={value.mode}
          options={[...SESSION_CHOICES, ...(value.mode === "structured" ? [STRUCTURED_SESSION] : [])]}
          disabled={value.mode === "structured"}
          mark={markOf(path === undefined ? "" : fieldClass(issues, `${path}.session`))}
          title={value.mode === "structured" ? REF_HINT : SESSION_TITLE}
          onChange={(mode) => onChange({ ...value, mode: mode as SessionForm["mode"] })}
        />
        {value.mode === "named" ? <Box value={value.name} onChange={(name) => onChange({ ...value, name })} placeholder="review" title={SESSION_NAME_TITLE} /> : null}
        {value.mode === "structured" ? <Box value={value.text} onChange={() => undefined} disabled title={REF_HINT} /> : null}
      </RowControls>
    </Field>
  );
}

function ConversationControl({ value, onChange }: { value: ConversationForm; onChange: (conversation: ConversationForm) => void }): JSX.Element | null {
  if (useReadOnly() && value.mode.length === 0) return null;
  return (
    <Field name="Conversation">
      <RowControls>
        <Pick
          value={value.mode}
          options={[{ value: "", label: "not declared" }, ...CONVERSATION_MODES.map((mode) => ({ value: mode, label: mode }))]}
          title={CONVERSATION_TITLE}
          onChange={(mode) => onChange({ ...value, mode: mode as ConversationForm["mode"] })}
        />
        {value.mode === "selected_artifacts" ? <Box value={value.artifacts} onChange={(artifacts) => onChange({ ...value, artifacts })} placeholder="plan_doc, critique" /> : null}
      </RowControls>
    </Field>
  );
}

/**
 * "Model settings", folded — a ▸ (▾ open) before the words, and open, a --line down its left.
 * Uncontrolled: `open` is where it starts.
 */
function ModelKnobs({ open: initial, children }: { open: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(initial);
  return (
    <View flexDirection="column" gap={8} {...(open ? { ...edge(t, { left: 2 }), paddingLeft: 8, marginLeft: 2 } : {})}>
      <Press onPress={() => setOpen(!open)} flexDirection="row" alignItems="center" paddingVertical={4}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{`${open ? "▾" : "▸"} Model settings`}</Txt>
      </Press>
      {open ? children : null}
    </View>
  );
}

export function OperationFieldsEditor({
  form,
  show,
  targets,
  path,
  issues = NO_ISSUES,
  onChange,
}: {
  form: OperationFieldsForm;
  show: { prompt: boolean; function: boolean };
  targets: readonly string[];
  bindingListId?: string | undefined;
  path?: string | undefined;
  issues?: FormIssues;
  onChange: (form: OperationFieldsForm) => void;
}): JSX.Element {
  const readOnly = useReadOnly();
  const reading = useRunReading();
  const toolsFieldData = useToolsFieldData();
  const namedModel = form.fields["model"]?.trim();
  const thinking = useModelParameters(namedModel === "" ? undefined : namedModel);
  const setField = (name: string, value: string): void => onChange(withField(form, name, value));
  const setJson = (name: string, value: string): void => onChange(withJson(form, name, value));
  const setRef = (name: string, ref: string | null): void => onChange(withRef(form, name, ref));
  const simple = (spec: SimpleField): JSX.Element => (
    <SimpleFieldControl key={spec.name} spec={spec} form={form} targets={targets} path={path} issues={issues} onChange={setField} onLink={setRef} />
  );
  return (
    <View flexDirection="column" gap={8} minWidth={0}>
      {SIMPLE_FIELDS.filter((spec) => spec.group === "operation")
        .filter((spec) => visibleField(spec, show, form))
        .map(simple)}
      {form.toolsField !== undefined ? (
        <ToolsFieldControl
          value={form.toolsField}
          permissionSets={toolsFieldData.permissionSets}
          tools={toolsFieldData.tools}
          readOnly={readOnly}
          {...(path !== undefined ? { block: path } : {})}
          onChange={(toolsField) => onChange({ ...form, toolsField })}
        />
      ) : null}
      {SIMPLE_FIELDS.filter((spec) => spec.group === "model" && spec.prominent === true)
        .filter(() => show.prompt)
        .map(simple)}
      {show.function ? <JsonFieldControl spec={JSON_FIELDS[0]!} form={form} onChange={setJson} /> : null}
      <SlotTable
        title="Operation inputs"
        rows={form.input}
        optional
        bindingHint=".inputs.instruction"
        targets={targets}
        {...(path === undefined ? {} : { path: `${path}.input`, issues })}
        onChange={(input) => onChange({ ...form, input })}
      />
      <SlotTable
        title="Operation output"
        rows={form.output}
        bindingHint=""
        emptyBindingMeans="the call returns this name"
        targets={targets}
        {...(path === undefined ? {} : { path: `${path}.output`, issues })}
        onChange={(output) => onChange({ ...form, output })}
      />
      {path === "operation" ? <ReadValue value={reading?.output} /> : null}
      <SessionControl value={form.session} path={path} issues={issues} onChange={(session) => onChange({ ...form, session })} />
      {readOnly && !form.fork ? null : (
        <View flexDirection="row">
          <SlotOpt wide checked={form.fork} onChange={(fork) => onChange({ ...form, fork })} title={FORK_TITLE}>
            fork the session rather than appending
          </SlotOpt>
        </View>
      )}
      <ConversationControl value={form.conversation} onChange={(conversation) => onChange({ ...form, conversation })} />
      {readOnly && !modelKnobsSet(form) ? null : (
        <ModelKnobs open={readOnly}>
          {SIMPLE_FIELDS.filter((spec) => spec.group === "model" && spec.prominent !== true).map(simple)}
          {JSON_FIELDS.filter((spec) => spec.group === "model").map((spec) => (
            <JsonFieldControl key={spec.name} spec={spec} form={form} onChange={setJson} />
          ))}
          <Field name="Reasoning">
            <SchemaForm
              schema={reasoningSchemaOf(thinking)}
              value={reasoningValueOf(form.reasoning)}
              onChange={(next) => onChange({ ...form, reasoning: reasoningFormOf(next) })}
              ctx={{ path: path === undefined ? "reasoning" : `${path}.reasoning`, disabled: readOnly, reading: readOnly }}
            />
            {readOnly ? null : <Sub>{levelsFooter(thinking)}</Sub>}
          </Field>
        </ModelKnobs>
      )}
    </View>
  );
}
