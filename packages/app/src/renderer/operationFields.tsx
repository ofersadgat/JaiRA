/**
 * The editor for one `operation` or `environment` block.
 *
 * Rendered twice per state and identical both times, because the two blocks are one shape (see
 * `operationForm`). What differs is the framing sentence above it, which the caller supplies.
 *
 * Every control here obeys the same rule: a value the document holds as a REFERENCE is shown
 * disabled, never as an empty box. An empty box invites typing and typing replaces the reference
 * with a literal — silently, and with nothing in the form to say what was lost.
 */
import type { JSX } from "react";
import {
  CONVERSATION_MODES,
  JSON_FIELDS,
  SIMPLE_FIELDS,
  type ConversationForm,
  type OperationFieldsForm,
  type SessionForm,
  type JsonField,
  type SimpleField,
} from "./operationForm";
import { NO_ISSUES, fieldClass, markFor, type FormIssues } from "./issues";
import { LinkInput, LinkToggle } from "./links";
import { useReadOnly, useRunReading } from "./reading";
import { ReadValue } from "./readValue";
import { LinkPreview } from "./linkPreview";
import { emptySlotRow } from "./slotForm";
import { SlotTable, SlotTypePicker } from "./slotTable";
import { ToolsFieldControl, useToolsFieldData } from "./toolsField";

export const REF_HINT = "a referenced value — edit it on the JSON tab";

/**
 * Every lint path a control inside an `operation` block marks for itself.
 *
 * Exported because the KIND picker sits outside the block and takes what is left: a diagnostic
 * against `operation` that none of these claims — the block failing to resolve at all, or a lowered
 * spelling this form does not render, like `operation.config.model` — is about what kind of
 * operation this is, and the picker is the box that says so.
 */
export function operationFieldPaths(path: string): string[] {
  return [...SIMPLE_FIELDS.map((spec) => `${path}.${spec.key}`), `${path}.session`, `${path}.input`, `${path}.output`];
}

/**
 * The completion lists this editor's controls reference, rendered ONCE per form.
 *
 * `OperationFieldsEditor` appears twice on a state — the operation and the environment — and a
 * datalist id has to be unique, so the lists cannot live inside the controls that use them.
 */
export function OperationDataLists({ functions }: { functions: Array<{ name: string; note: string }> }): JSX.Element {
  return (
    <>
      <datalist id="operation-functions">
        {functions.map((fn) => (
          <option key={fn.name} value={fn.name} label={fn.note} />
        ))}
      </datalist>
    </>
  );
}

/** One simple field, chosen by the table in `operationForm` rather than spelled out here. */
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
  /** Link completions, for a {@link SimpleField.linkable} field. */
  targets: readonly string[];
  /** This block's lint path (`operation`), or absent when nothing lints it. */
  path?: string | undefined;
  issues: FormIssues;
  onChange: (name: string, value: string) => void;
  /** Set or clear this field's reference. `null` unlinks. */
  onLink: (name: string, ref: string | null) => void;
}): JSX.Element | null {
  const readOnly = useReadOnly();
  const structured = form.structured[spec.name] === true;
  const ref = form.refs[spec.name];
  const linked = ref !== undefined;
  const value = form.fields[spec.name] ?? "";
  // A form shows every field it COULD hold, because that is how you find the one to fill in. A
  // reading shows what the state says — and a column of empty boxes labelled Tools, Search path and
  // Seed buries the two lines that are actually declared.
  if (readOnly && !linked && !structured && value.trim().length === 0) return null;
  // The linter names a field by its AUTHORED key — `operation.function`, not `operation.functionRef`
  // — which is the whole reason `SimpleField` carries both spellings.
  const mark = path === undefined ? "" : fieldClass(issues, `${path}.${spec.key}`);
  const shared = {
    value,
    className: mark.trim(),
    disabled: structured,
    spellCheck: false,
    title: structured ? REF_HINT : spec.hint,
    onChange: (e: { target: { value: string } }) => onChange(spec.name, e.target.value),
  };
  return (
    <label {...(path === undefined ? { className: "field" } : markFor(issues, `${path}.${spec.key}`, "field"))}>
      <span>
        {spec.label}
        {spec.linkable === true ? (
          <LinkToggle
            linked={linked}
            disabled={structured}
            // Linking starts EMPTY rather than seeded from the box: the two spellings are kept side
            // by side, so the literal is not lost and guessing a path from prose would only produce
            // a reference to nothing.
            onToggle={(next) => onLink(spec.name, next ? (ref ?? "") : null)}
          />
        ) : null}
      </span>
      {linked ? (
        <LinkInput value={ref} targets={targets} mark={mark} onChange={(next) => onLink(spec.name, next)} />
      ) : spec.multiline ? (
        <textarea rows={spec.name === "prompt" ? 6 : 3} placeholder={structured ? "" : spec.placeholder} {...shared} />
      ) : (
        // The datalists themselves are rendered ONCE by the editor: this component appears twice per
        // state (the operation and the environment) and a datalist id has to be unique.
        <input
          inputMode={spec.type === "number" ? "decimal" : undefined}
          placeholder={structured ? "" : spec.placeholder}
          {...(spec.name === "functionRef" ? { list: "operation-functions" } : {})}
          {...shared}
        />
      )}
      {structured ? <span className="sub">{REF_HINT}</span> : null}
      {linked ? <span className="sub">spliced in where it is referenced — a copy, not a live link</span> : null}
      {/* And what it says, since the whole cost of a link is that the substance moved elsewhere. */}
      {linked && ref !== undefined && ref.length > 0 ? <LinkPreview reference={ref} /> : null}
    </label>
  );
}

/** Whether anything under "Model settings" was actually tuned — see the fold's own note. */
function MODEL_KNOBS_SET(form: OperationFieldsForm): boolean {
  const tuned = SIMPLE_FIELDS.some(
    (spec) =>
      spec.group === "model" &&
      spec.prominent !== true &&
      ((form.fields[spec.name] ?? "").trim().length > 0 || form.refs[spec.name] !== undefined),
  );
  const json = JSON_FIELDS.some((spec) => (form.json[spec.name] ?? "").trim().length > 0);
  return tuned || json || form.reasoning.effort.length > 0 || form.reasoning.budgetTokens.trim().length > 0;
}

/** One arbitrary-JSON field. No generated form beats a JSON box for a value nothing has a schema for. */
function JsonFieldControl({
  spec,
  form,
  onChange,
}: {
  spec: JsonField;
  form: OperationFieldsForm;
  onChange: (name: string, value: string) => void;
}): JSX.Element | null {
  // See {@link SimpleFieldControl}: an empty JSON box in a reading is a heading over nothing.
  if (useReadOnly() && (form.json[spec.name] ?? "").trim().length === 0) return null;
  return (
    <label className="field">
      <span>{spec.label}</span>
      <textarea
        className="code-editor"
        rows={3}
        spellCheck={false}
        value={form.json[spec.name] ?? ""}
        placeholder={spec.placeholder}
        title={spec.hint}
        onChange={(e) => onChange(spec.name, e.target.value)}
      />
    </label>
  );
}

/**
 * The session control (DESIGN §1.6).
 *
 * Four states, and "not declared" is separated from "fresh" deliberately: absent means the operation
 * gets its own stream, `null` is an explicit override of whatever the chain supplied. One control
 * that collapsed them would silently discard the override.
 */
function SessionControl({
  value,
  path,
  issues,
  onChange,
}: {
  value: SessionForm;
  /** This block's lint path. A session complaint is reported at `<block>.session`. */
  path?: string | undefined;
  issues: FormIssues;
  onChange: (session: SessionForm) => void;
}): JSX.Element | null {
  // "not declared" is a picker's way of saying nothing was said. In a reading that is a labelled row
  // reporting the absence of a decision, which the state's silence already reports.
  if (useReadOnly() && value.mode === "absent") return null;
  return (
    <label {...(path === undefined ? { className: "field" } : markFor(issues, `${path}.session`, "field"))}>
      <span>Session</span>
      <div className="row-controls">
        <select
          className={path === undefined ? undefined : fieldClass(issues, `${path}.session`).trim()}
          value={value.mode}
          disabled={value.mode === "structured"}
          title={value.mode === "structured" ? REF_HINT : "which conversation stream this call joins"}
          onChange={(e) => onChange({ ...value, mode: e.target.value as SessionForm["mode"] })}
        >
          <option value="absent">not declared — its own stream</option>
          <option value="named">named — shared by every state using the name</option>
          <option value="fresh">fresh — override the chain and start new</option>
          {value.mode === "structured" ? <option value="structured">a computed position</option> : null}
        </select>
        {value.mode === "named" ? (
          <input
            value={value.name}
            placeholder="review"
            spellCheck={false}
            title="also the resource-bundle key — workspace and permissions"
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        ) : null}
        {value.mode === "structured" ? <input value={value.text} readOnly disabled title={REF_HINT} /> : null}
      </div>
    </label>
  );
}

function ConversationControl({
  value,
  onChange,
}: {
  value: ConversationForm;
  onChange: (conversation: ConversationForm) => void;
}): JSX.Element | null {
  if (useReadOnly() && value.mode.length === 0) return null;
  return (
    <label className="field">
      <span>Conversation</span>
      <div className="row-controls">
        <select
          value={value.mode}
          title="the transcript preamble injected into THIS call (SPEC §4.7)"
          onChange={(e) => onChange({ ...value, mode: e.target.value as ConversationForm["mode"] })}
        >
          <option value="">not declared</option>
          {CONVERSATION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        {/* Only `selected_artifacts` reads the list, so it is the only mode that offers one. */}
        {value.mode === "selected_artifacts" ? (
          <input
            value={value.artifacts}
            placeholder="plan_doc, critique"
            spellCheck={false}
            onChange={(e) => onChange({ ...value, artifacts: e.target.value })}
          />
        ) : null}
      </div>
    </label>
  );
}

/**
 * One `operation` or `environment` block, in full.
 *
 * `kinds` says which of the operation-shaped fields are worth showing: a prompt operation has no
 * `function`, a function operation has no `prompt`. An `environment` block shows both, because it is
 * a defaults layer and may legitimately supply either.
 */
export function OperationFieldsEditor({
  form,
  show,
  targets,
  bindingListId,
  path,
  issues = NO_ISSUES,
  onChange,
}: {
  form: OperationFieldsForm;
  /** Which of `prompt` / `function` this block should offer. */
  show: { prompt: boolean; function: boolean };
  /** Every reference the link controls can offer, from the file tree. */
  targets: readonly string[];
  /** The datalist of runtime paths a binding may name. Absent ⇒ the boxes stay free text. */
  bindingListId?: string;
  /**
   * What this block is called in a lint path — `operation` for the state's own, absent for the
   * `environment` layer, which the linter reports against the operation it ends up merged into
   * rather than against the defaults that supplied it.
   */
  path?: string | undefined;
  /** This state's diagnostics, for the controls to mark themselves with. */
  issues?: FormIssues;
  onChange: (form: OperationFieldsForm) => void;
}): JSX.Element {
  const readOnly = useReadOnly();
  const reading = useRunReading();
  const toolsFieldData = useToolsFieldData();
  const setField = (name: string, value: string): void =>
    onChange({ ...form, fields: { ...form.fields, [name]: value } });
  const setJson = (name: string, value: string): void =>
    onChange({ ...form, json: { ...form.json, [name]: value } });
  const setRef = (name: string, ref: string | null): void => {
    const refs = { ...form.refs };
    // Deleting the key is what "not linked" IS — an empty string there means a link whose target has
    // not been typed yet, and the two must stay distinguishable or unlinking would write a literal
    // empty prompt.
    if (ref === null) delete refs[name];
    else refs[name] = ref;
    onChange({ ...form, refs });
  };

  const visible = (spec: SimpleField): boolean =>
    (spec.name !== "prompt" || show.prompt) &&
    (spec.name !== "functionRef" || show.function) &&
    // A block says its tools ONCE, in the field below — see {@link ToolsFieldControl}.
    (spec.name !== "tools" || form.toolsField === undefined);

  // The block's OWN anchor, so a diagnostic against `operation` has somewhere to scroll to and
  // something to say in a tooltip. It is not marked in colour — the boxes below are.
  return (
    <div {...(path === undefined ? { className: "op-block" } : markFor(issues, path, "op-block"))}>
      {SIMPLE_FIELDS.filter((spec) => spec.group === "operation")
        .filter(visible)
        .map((spec) => (
          <SimpleFieldControl
            key={spec.name}
            spec={spec}
            form={form}
            targets={targets}
            path={path}
            issues={issues}
            onChange={setField}
            onLink={setRef}
          />
        ))}

      {/* ONE Tools field (decision 0007): the toolset the block starts from, and the lines it writes
          over that. A `tools` value it cannot draw — a binding — shows read-only in the box above. */}
      {form.toolsField !== undefined ? (
        <ToolsFieldControl
          value={form.toolsField}
          toolsets={toolsFieldData.toolsets}
          tools={toolsFieldData.tools}
          readOnly={readOnly}
          {...(path !== undefined ? { block: path } : {})}
          onChange={(toolsField) => onChange({ ...form, toolsField })}
        />
      ) : null}

      {/* The model-group fields that are not knobs — see `SimpleField.prominent`. WHO ANSWERS is
          part of what the block says, not a setting to go looking for, and on an `environment`
          block it is the field that routes every descendant. */}
      {SIMPLE_FIELDS.filter((spec) => spec.group === "model" && spec.prominent === true)
        .filter((spec) => show.prompt)
        .map((spec) => (
          <SimpleFieldControl
            key={spec.name}
            spec={spec}
            form={form}
            targets={targets}
            path={path}
            issues={issues}
            onChange={setField}
            onLink={setRef}
          />
        ))}

      {/* Untyped by nature — only the function knows what it takes — so a JSON box rather than a
          generated form, and the one position where a reference must be written {"$ref": …}. */}
      {show.function ? <JsonFieldControl spec={JSON_FIELDS[0]!} form={form} onChange={setJson} /> : null}

      {/* §4.3, the single most common silent failure: these are PARAMETERS, so the wiring goes in
          the binding column. `"input": { "prompt": ".inputs.x" }` loads as a slot with no binding at
          all — the call runs with nothing in it and the state reports success. */}
      <SlotTable
        title="Operation inputs"
        rows={form.input}
        optional
        bindingHint=".inputs.instruction"
        targets={targets}
        bindingListId={bindingListId}
        {...(path === undefined ? {} : { path: `${path}.input`, issues })}
        onChange={(input) => onChange({ ...form, input })}
      />

      {/* §4.4: a PARAMETER map keyed by returned name, the same table `input` uses — one field, one
          shape. Empty, the loader builds one object slot from the state's produced outputs. A
          delegated agent returns ONE STRING, so a LONE entry carrying `blob` is how "the whole
          return is that value" is said; without it the string is read as a record of named outputs,
          finds nothing, and the state fails. */}
      <SlotTable
        title="Operation output"
        rows={form.output}
        bindingHint=""
        emptyBindingMeans="the call returns this name"
        targets={targets}
        bindingListId={bindingListId}
        {...(path === undefined ? {} : { path: `${path}.output`, issues })}
        onChange={(output) => onChange({ ...form, output })}
      />
      {/* What the call actually RETURNED. On the OPERATION only: the same editor draws the
          `environment` defaults layer, which declares what descendants inherit and returns nothing,
          so a result shown there would attribute this state's answer to a block that never ran. */}
      {path === "operation" ? <ReadValue value={reading?.output} /> : null}

      <SessionControl
        value={form.session}
        path={path}
        issues={issues}
        onChange={(session) => onChange({ ...form, session })}
      />
      {readOnly && !form.fork ? null : (
        <label className="slot-opt wide" title="always branch, rather than appending when the position is still the head">
          <input type="checkbox" checked={form.fork} onChange={(e) => onChange({ ...form, fork: e.target.checked })} />
          fork the session rather than appending
        </label>
      )}

      <ConversationControl value={form.conversation} onChange={(conversation) => onChange({ ...form, conversation })} />

      {/* Thirteen empty boxes when nothing is tuned, which is nearly always. A fold hides them from
          an author; a reading should not carry them at all — and when it does carry them, it opens
          them, because a reader is not going to guess that a closed fold has something in it. */}
      {readOnly && !MODEL_KNOBS_SET(form) ? null : (
      <details className="model-knobs" open={readOnly}>
        <summary>Model settings</summary>
        {SIMPLE_FIELDS.filter((spec) => spec.group === "model" && spec.prominent !== true).map((spec) => (
          <SimpleFieldControl
            key={spec.name}
            spec={spec}
            form={form}
            targets={targets}
            path={path}
            issues={issues}
            onChange={setField}
            onLink={setRef}
          />
        ))}
        {JSON_FIELDS.filter((spec) => spec.group === "model").map((spec) => (
          <JsonFieldControl key={spec.name} spec={spec} form={form} onChange={setJson} />
        ))}
        <label className="field">
          <span>Reasoning</span>
          <div className="row-controls">
            <select
              value={form.reasoning.effort}
              onChange={(e) => onChange({ ...form, reasoning: { ...form.reasoning, effort: e.target.value } })}
            >
              <option value="">effort…</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <input
              value={form.reasoning.budgetTokens}
              inputMode="decimal"
              placeholder="budget tokens"
              spellCheck={false}
              onChange={(e) => onChange({ ...form, reasoning: { ...form.reasoning, budgetTokens: e.target.value } })}
            />
          </div>
        </label>
      </details>
      )}
    </div>
  );
}
