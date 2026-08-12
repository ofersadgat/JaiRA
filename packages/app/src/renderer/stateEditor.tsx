/**
 * Edit one state file: a form over the state format, with a raw JSON tab beside it.
 *
 * The two views share one source of truth — the parsed document — so switching tabs never loses an
 * edit made in the other. The form now covers the whole of WORKFLOWS.md §2–§7: slots and their
 * types, children and their wiring, the operation, the `environment` defaults layer, transitions and
 * limits. What it still refuses to pretend it understands is anything spelled as a REFERENCE, which
 * it shows read-only rather than as an empty box.
 *
 * Rendering only. Every write goes through `applyForm`, which MERGES rather than rebuilds — see
 * `stateForm` for why that distinction is the whole safety property.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  type ExecutorInfo,
  type FileTree,
  type LintIssue,
  type StateSlotInfo,
  type StateSlots,
  type ValidateSchemaResult,
  type WorkflowLayer,
  type WorkflowSource,
} from "@jaira/shared/browser";
import {
  applyForm,
  EMPTY_FORM,
  emptyBindingRow,
  emptyChildRow,
  formOf,
  type BindingRow,
  type ChildRow,
  type FormModel,
  type TransitionRow,
} from "./stateForm";
import { EditorActions } from "./editorChrome";
import { anchorFor, fieldClass, FLASH_MS, formIssues, markFor, NO_ISSUES, type FormIssues } from "./issues";
import type { UiSurface } from "./fileTypes";
import { SchemaJsonEditor, schemaReferenceProps } from "./schemaEditor";
import { SlotTable } from "./slotTable";
import { EMPTY_OPERATION_FIELDS, type OperationFieldsForm } from "./operationForm";
import { operationFieldPaths, OperationDataLists, OperationFieldsEditor, REF_HINT } from "./operationFields";
import { LinkInput, LinkTargets, LinkToggle } from "./links";
import {
  bindingTargets,
  childKeyOptions,
  childStateIdOf,
  childStateOptions,
  functionOptions,
  guardTargets,
  linkTargets,
  operationOutputNames,
} from "./completions";

/**
 * The datalist every binding box completes against.
 *
 * One list for the whole form: a state has a binding box per slot, per operation input and per child
 * wire, and they all name paths in the SAME evaluation scope — this state's inputs and its children's
 * outputs. A list per table would be the same content under N ids.
 */
const BINDING_TARGETS_ID = "binding-targets";

/**
 * The datalist a `when` guard completes against.
 *
 * Separate from the binding list and that is the whole point: hw refuses a BINDING whose path starts
 * with `operation` — "not a runtime namespace — expected inputs, outputs, children or artifacts" —
 * while the same path in a guard loads cleanly. One shared list would suggest paths that fail the
 * workflow to load in half the places it was offered.
 */
const GUARD_TARGETS_ID = "guard-targets";

/** What the operation block's own controls mark, so the kind picker can take what is left over. */
const OPERATION_FIELD_PATHS = operationFieldPaths("operation");

// --- shared row furniture ------------------------------------------------------

/** Move a row within a list. Order is semantics for children and transitions alike. */
function moved<T>(rows: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row!);
  return next;
}

/** The ↑/↓ pair, shown wherever the order of a table means something. */
function Reorder({ index, count, onMove }: { index: number; count: number; onMove: (to: number) => void }): JSX.Element {
  return (
    <span className="reorder">
      <button type="button" className="ghost sm" title="move up" disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button
        type="button"
        className="ghost sm"
        title="move down"
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
    </span>
  );
}

// --- children ------------------------------------------------------------------

/**
 * One child's input wiring — the substance of a child declaration.
 *
 * A binding is one text field whatever form it takes: a runtime path
 * (`.children.goals.outputs.goals`), an expression, a literal. §8 makes them one grammar, so the
 * form does not ask which one you meant. A binding the document holds as a STRUCTURED form —
 * `{ json }`, `{ $ref }`, an embedded operation — is shown read-only.
 */
function BindingTable({
  rows,
  slots,
  listId,
  bindingListId,
  path,
  issues,
  onChange,
}: {
  rows: BindingRow[];
  /** What the child actually declares. Empty when the mount names nothing readable yet. */
  slots: readonly StateSlotInfo[];
  /** Unique per child row — a datalist id has to be, and this table is rendered once per child. */
  listId: string;
  /** The shared datalist of runtime paths a binding may name — see {@link bindingTargets}. */
  bindingListId: string;
  /** This table's lint path — `children.<key>.inputs`. Absent ⇒ nothing is marked. */
  path?: string | undefined;
  issues: FormIssues;
  onChange: (rows: BindingRow[]) => void;
}): JSX.Element {
  const edit = (index: number, patch: Partial<BindingRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const byName = new Map(slots.map((slot) => [slot.name, slot]));
  const pathOf = (row: BindingRow): string | undefined =>
    path === undefined || row.name.trim().length === 0 ? undefined : `${path}.${row.name.trim()}`;
  /**
   * What is wrong with the TABLE rather than with any wire in it.
   *
   * One diagnostic, and it is the most common error a state has: "required child input 'goal' is not
   * wired", reported at `children.<key>.inputs` because the wire it is about does not exist in the
   * document. The box for it does exist — `seedRequiredBindings` puts a blank row there — so the
   * error goes to that row below. Without this the row showed the form's own `.unwired` warning
   * colour and nothing else, which is an error rendered as a caution.
   */
  const missing = path === undefined ? "" : fieldClass(issues, path, rows.map(pathOf).filter(Boolean) as string[]);
  return (
    <div {...(path === undefined ? { className: "bindings" } : markFor(issues, path, "bindings"))}>
      <datalist id={listId}>
        {slots.map((slot) => (
          <option key={slot.name} value={slot.name} label={slot.optional ? "optional" : "required"} />
        ))}
      </datalist>
      <div className="slots-head">
        <span>Inputs</span>
        <span className="sub">wired into the child&apos;s declared slots</span>
        <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptyBindingRow()])}>
          + Wire
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="sub">
          none — the child&apos;s inputs must all be optional or defaulted, or it cannot run
        </div>
      ) : (
        rows.map((row, i) => {
          const slot = byName.get(row.name.trim());
          // Seeded and still blank. Left as an ERROR rather than filled with a guess: the whole
          // point of the row appearing is that this is a decision only the author can make, and a
          // plausible default would be one the lint would then stop asking about.
          const unwired = slot !== undefined && !slot.optional && row.structured !== true && row.value.trim().length === 0;
          const rowPath = pathOf(row);
          const base = `slot-row binding-row${unwired ? " unwired" : ""}`;
          // A row that IS the missing wire wears the table's error on both boxes: nothing about it
          // is right yet. A row that exists and is wrong wears it on the value, which is the part
          // hw checked.
          const rowMark = rowPath === undefined ? "" : fieldClass(issues, rowPath);
          const absent = unwired ? missing : "";
          return (
            <div key={i} {...(rowPath === undefined ? { className: base } : markFor(issues, rowPath, base))}>
              <input
                className={absent.trim()}
                value={row.name}
                list={listId}
                placeholder="the child's input"
                spellCheck={false}
                title={slot?.description}
                onChange={(e) => edit(i, { name: e.target.value })}
              />
              <span className="arrow">←</span>
              {/* The wire, and therefore the box a diagnostic about this wire belongs to — every
                  check hw runs at `children.<key>.inputs.<slot>` is about the value, not the name. */}
              <input
                className={(rowMark.length > 0 ? rowMark : absent).trim()}
                value={row.value}
                list={bindingListId}
                placeholder={unwired ? "required — nothing runs until this is bound" : ".inputs.issue"}
                spellCheck={false}
                disabled={row.structured === true}
                title={row.structured === true ? REF_HINT : slot?.description}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="ghost sm"
                title="remove"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Give every child a row for each REQUIRED input it declares, blank.
 *
 * The row is the whole feature. `applyBindings` drops a row with no value, so nothing is written and
 * `children.<key>.inputs` stays as it was — which means the state still fails to lint with "required
 * child input 'x' is not wired", exactly as it should. What changes is where you meet that sentence:
 * in the form, next to an empty box with the slot's name on it, instead of in the lint panel after
 * saving a child you had no way of knowing declared anything.
 *
 * Derived on every load rather than seeded once at mount, so a row deleted here comes back. That is
 * the correct behaviour and not an oversight: the row is a rendering of what the child declares, and
 * a required input does not stop being required because someone closed the row for it.
 *
 * OPTIONAL slots get no row. A blank row for one would never resolve into anything — it is not an
 * error, so nothing would ever clear it — and a table of permanent non-problems is how the two
 * genuine ones stop being read. "+ Wire" and the name completion cover them.
 *
 * Returns `rows` unchanged, by identity, when there is nothing to add. The caller writes back only
 * on a real change, so this cannot cycle with the effect that calls it.
 */
export function seedRequiredBindings(
  children: readonly ChildRow[],
  declared: Record<string, StateSlots>,
  stateIdOf: (child: ChildRow) => string,
): ChildRow[] {
  let changed = false;
  const next = children.map((child) => {
    const slots = declared[stateIdOf(child)];
    if (slots === undefined) return child;
    const present = new Set(child.inputs.map((row) => row.name.trim()));
    const missing = slots.inputs.filter((slot) => !slot.optional && !present.has(slot.name));
    if (missing.length === 0) return child;
    changed = true;
    return { ...child, inputs: [...child.inputs, ...missing.map((slot) => ({ name: slot.name, value: "" }))] };
  });
  return changed ? next : (children as ChildRow[]);
}

/**
 * The default for {@link WorkflowEditor}'s `loadStateSlots` — a form with no store behind it.
 *
 * A module constant rather than an inline default, so its identity is stable: it is an effect
 * dependency, and a fresh closure per render would fire the effect on every paint.
 */
const NO_STATE_SLOTS = async (): Promise<null> => null;

/**
 * The children table — the state's structure, in the order it runs.
 *
 * Ordered rather than alphabetical, and reorderable, because this list IS the sequence: the columns
 * on the board above are these rows, left to right. Each row opens onto its wiring and its per-mount
 * `environment`, which is what makes mounting one state twice under two runtimes (§6.1) a thing you
 * can do here rather than only in the JSON.
 */
function ChildrenTable({
  rows,
  keyOptions,
  stateOptions,
  functions,
  declared,
  stateIdOf,
  issues,
  onChange,
}: {
  rows: ChildRow[];
  /** Basenames of the states one segment below this one — see {@link childKeyOptions}. */
  keyOptions: string[];
  stateOptions: string[];
  functions: Array<{ name: string; note: string }>;
  /** Declared inputs by state id, as far as they have been read. */
  declared: Record<string, StateSlots>;
  /** What a row actually mounts — see {@link childStateIdOf}. */
  stateIdOf: (row: ChildRow) => string;
  /** This state's diagnostics. `children.*` and `sequence[*]` both land here. */
  issues: FormIssues;
  onChange: (rows: ChildRow[]) => void;
}): JSX.Element {
  const edit = (index: number, patch: Partial<ChildRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const pathOf = (row: ChildRow): string | undefined =>
    row.key.trim().length === 0 ? undefined : `children.${row.key.trim()}`;
  // Keys already used are not offered again: a `children` map cannot hold the same key twice, and the
  // second one would silently replace the first rather than adding a child.
  const taken = new Set(rows.map((row) => row.key.trim()).filter((key) => key.length > 0));
  return (
    // Two anchors: `sequence[i]` is a claim about which of THESE rows are steps, and the spine
    // checkbox is where it is edited, so a diagnostic about the sequence belongs to this table.
    <div {...markFor(issues, ["children", "sequence"], "slots children")}>
      <datalist id="child-keys">
        {keyOptions
          .filter((key) => !taken.has(key))
          .map((key) => (
            <option key={key} value={key} />
          ))}
      </datalist>
      <datalist id="child-states">
        {stateOptions.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {/* A second list of the same names: an id must be unique, and the operation's own copy lives
          in `operationFields`, which this table does not render. */}
      <datalist id="child-functions">
        {functions.map((fn) => (
          <option key={fn.name} value={fn.name} label={fn.note} />
        ))}
      </datalist>
      <div className="slots-head">
        <span>Children</span>
        <span className="sub">{rows.length > 1 ? "in run order" : ""}</span>
        <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptyChildRow()])}>
          + Add
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="sub">none — this state runs its own operation and nothing below it</div>
      ) : (
        rows.map((row, i) => {
          const childPath = pathOf(row);
          const inputsPath = childPath === undefined ? undefined : `${childPath}.inputs`;
          // What the child MOUNTS. Everything reported against a child except its wiring (the rows
          // below) and its per-mount environment (the selects below) is about the state it names:
          // "references unknown state", "not a descendant path of".
          const stateMark =
            childPath === undefined
              ? ""
              : fieldClass(issues, childPath, [inputsPath!, `${childPath}.environment`]);
          return (
          <div className="slot-group" key={i}>
            <div
              {...(childPath === undefined
                ? { className: "slot-row child-row" }
                : markFor(issues, childPath, "slot-row child-row"))}
            >
              <span className="seq">{i + 1}</span>
              <input
                value={row.key}
                list="child-keys"
                placeholder="key"
                spellCheck={false}
                onChange={(e) => edit(i, { key: e.target.value })}
              />
              <input
                className={stateMark.trim()}
                value={row.state}
                list="child-states"
                placeholder={row.key ? `./${row.key}` : "state id (defaults to the key)"}
                spellCheck={false}
                onChange={(e) => edit(i, { state: e.target.value })}
              />
              <label
                className="slot-opt"
                title="in the sequence: the cursor walks into it. Off means it runs only if a transition names it."
              >
                <input
                  type="checkbox"
                  checked={row.inSpine}
                  onChange={(e) => edit(i, { inSpine: e.target.checked })}
                />
                spine
              </label>
              <label className="slot-opt" title="SPEC §10.4: starting this child does not block the sequence">
                <input type="checkbox" checked={row.async} onChange={(e) => edit(i, { async: e.target.checked })} />
                async
              </label>
              <Reorder index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />
              <button
                type="button"
                className="ghost sm"
                title="remove"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            {/* NOT behind a disclosure, and that is the point of the row existing at all: a child
                with a required input does not run until it is wired, `seedRequiredBindings` puts a
                blank box here to say so, and a box you have to open a twisty to find says it to
                nobody. Configuration a state cannot run without is not "more". */}
            <BindingTable
              rows={row.inputs}
              slots={declared[stateIdOf(row)]?.inputs ?? []}
              listId={`child-inputs-${i}`}
              bindingListId={BINDING_TARGETS_ID}
              path={inputsPath}
              issues={issues}
              onChange={(inputs) => edit(i, { inputs })}
            />
            {/* §6.1: defaults for THIS MOUNT and its subtree. It sits between the parent's
                environment and the child's own, so it is a default the child may still override.
                Folded away because it is genuinely optional — most mounts take what they inherit —
                and open the moment this one says anything of its own. */}
            <details
              className="slot-more"
              open={
                row.environment.kind !== "" ||
                row.environment.functionRef.length > 0 ||
                row.environment.model.length > 0
              }
            >
              <summary>
                environment
                <span className="sub"> · defaults for this mount only</span>
              </summary>
              <div className="row-controls">
                {/* §6.1's own diagnostics — `children.<key>.environment.session` is the one hw
                    reports — belong to this mount's defaults, and this is the first box of them. */}
                <select
                  className={
                    childPath === undefined ? undefined : fieldClass(issues, `${childPath}.environment`).trim()
                  }
                  value={row.environment.kind}
                  title="the operation kind this mount supplies to a child that leaves it to the chain"
                  onChange={(e) =>
                    edit(i, {
                      environment: { ...row.environment, kind: e.target.value as ChildRow["environment"]["kind"] },
                    })
                  }
                >
                  <option value="">kind…</option>
                  <option value="prompt">prompt</option>
                  <option value="function">function</option>
                </select>
                <input
                  value={row.environment.functionRef}
                  list="child-functions"
                  placeholder="function — e.g. claude-code on one mount, codex-cli on another"
                  spellCheck={false}
                  onChange={(e) => edit(i, { environment: { ...row.environment, functionRef: e.target.value } })}
                />
                <input
                  value={row.environment.model}
                  placeholder="model"
                  spellCheck={false}
                  onChange={(e) => edit(i, { environment: { ...row.environment, model: e.target.value } })}
                />
              </div>
              <div className="sub">
                anything else on this mount&apos;s environment is kept as written — edit it on the JSON tab
              </div>
            </details>
          </div>
          );
        })
      )}
    </div>
  );
}

/**
 * The transitions table.
 *
 * Ordered too — guards are tried in turn, so moving a row changes which one wins. `to` accepts any
 * child key or a `terminate.*` outcome; the suggestions cover the common cases without refusing a
 * reference the form has not thought of.
 */
function TransitionsTable({
  rows,
  childKeys,
  guards,
  issues,
  onChange,
}: {
  rows: TransitionRow[];
  childKeys: string[];
  /** Paths a guard may name — wider than a binding's, see {@link GUARD_TARGETS_ID}. */
  guards: readonly string[];
  /** This state's diagnostics. A transition is named by its INDEX — `transitions[2].when`. */
  issues: FormIssues;
  onChange: (rows: TransitionRow[]) => void;
}): JSX.Element {
  const edit = (index: number, patch: Partial<TransitionRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div {...markFor(issues, "transitions", "slots")}>
      <datalist id={GUARD_TARGETS_ID}>
        {guards.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      <datalist id="transition-targets">
        {childKeys.map((key) => (
          <option key={key} value={key} />
        ))}
        <option value="terminate.success" />
        <option value="terminate.error" />
      </datalist>
      <div className="slots-head">
        <span>Transitions</span>
        <span className="sub">{rows.length > 1 ? "first match wins" : ""}</span>
        <button type="button" className="ghost sm" onClick={() => onChange([...rows, { when: "", to: "" }])}>
          + Add
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="sub">none — the state terminates when its children are done</div>
      ) : (
        rows.map((row, i) => (
          <div key={i} {...markFor(issues, `transitions[${i}]`, "slot-row transition-row")}>
            {/* The guard takes what is reported against the row itself as well as against `.when`:
                the row-level one is the cycle warning, whose remedy is a guard or a limit — and of
                the two boxes here, this is the one that can carry it. */}
            <input
              className={fieldClass(issues, `transitions[${i}]`, [`transitions[${i}].to`]).trim()}
              value={row.when}
              list={GUARD_TARGETS_ID}
              placeholder="guard — empty is unconditional, and must infer to boolean"
              spellCheck={false}
              disabled={row.structured === true}
              title={row.structured === true ? "a lowered guard — edit it on the JSON tab" : undefined}
              onChange={(e) => edit(i, { when: e.target.value })}
            />
            <span className="arrow">→</span>
            <input
              className={fieldClass(issues, `transitions[${i}].to`).trim()}
              value={row.to}
              list="transition-targets"
              placeholder="child key or terminate.success"
              spellCheck={false}
              onChange={(e) => edit(i, { to: e.target.value })}
            />
            <Reorder index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />
            <button
              type="button"
              className="ghost sm"
              title="remove"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// --- the editor ----------------------------------------------------------------

export function WorkflowEditor({
  source,
  tree,
  executors,
  busy,
  onSave,
  validateSchema,
  loadStateSlots = NO_STATE_SLOTS,
  wrapJson,
  onWrapJson,
  ui,
  issues = [],
  reveal = null,
  draft,
  onDraft,
  tab: tabProp,
  onTab,
}: {
  source: WorkflowSource;
  /** Both layer roots, for completing child keys and state references. */
  tree: FileTree | null;
  /** For completing an operation's `function` — and for saying which of them are actually on. */
  executors: ExecutorInfo[];
  busy: boolean;
  onSave: (stateId: string, layer: WorkflowLayer, text: string) => void;
  /**
   * Check the JSON tab's draft against a schema. Absent ⇒ the tab stays a plain text box.
   *
   * Optional because this component is also rendered from places that have no store to reach the
   * channel through, and a JSON tab that works is better than one that refuses to render.
   */
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  /**
   * Read what a set of states declare as inputs, for the children table's wiring rows.
   *
   * Defaulted rather than optional-and-checked: a form with no way to ask simply seeds no rows,
   * which is where it was before, and every call site that has a store passes the real one.
   */
  loadStateSlots?: (stateIds: string[]) => Promise<Record<string, StateSlots> | null>;
  /** Word wrap on the JSON tab. Passed through so the preference is one setting, not one per editor. */
  wrapJson?: boolean;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  /**
   * The window's remembered layout, for the JSON tab's field reference — see `uiState.ts`.
   *
   * Passed through for the same reason the wrap preference is: the reference panel is one panel, and
   * whether it is open should not depend on which editor you happened to reach it from.
   */
  ui?: UiSurface | undefined;
  /**
   * What the linter says about this state — the same list the inspector is showing beside it.
   *
   * The form marks the control each one is about, which is the difference between "3 errors" as a
   * count and as three places to look. Empty by default: a form rendered with nothing linted marks
   * nothing, rather than claiming everything is fine.
   */
  issues?: readonly LintIssue[];
  /** The issue the inspector asked to be shown — see `FileSurfaceContext.revealIssue`. */
  reveal?: { path: string; nonce: number } | null;
  /**
   * The unsaved document, when someone else is holding it — `null` ⇒ this file is as it is on disk.
   *
   * Controlled by the store in the app, so an edit survives clicking another file; local state
   * otherwise, which keeps this component usable on its own. Both halves of the editor write through
   * it, because the form and the JSON tab are two views of ONE document (see the module comment) and
   * a draft that only covered one of them would lose whichever you were not looking at.
   */
  draft?: string | null;
  onDraft?: ((text: string | null) => void) | undefined;
  /** The tab to show, and where to remember it. Uncontrolled — starting on the form — without them. */
  tab?: "form" | "json";
  onTab?: ((tab: "form" | "json") => void) | undefined;
}): JSX.Element {
  const [localTab, setLocalTab] = useState<"form" | "json">("form");
  /**
   * Used only when nothing outside is holding the draft — see {@link draft}.
   *
   * Carries the file it belongs to. This component is not remounted when the panel opens another
   * state, so an unkeyed draft would be shown over the next file the tree selected.
   */
  const [localDraft, setLocalDraft] = useState<{ file: string; text: string } | null>(null);

  const tab = tabProp ?? localTab;
  const setTab = (next: "form" | "json"): void => (onTab ? onTab(next) : setLocalTab(next));

  /**
   * The file as this editor found it — what Revert goes back to, and what `dirty` is measured
   * against.
   *
   * `source.text` itself, not a copy taken at mount: a save comes back as a new `source.text`, and
   * the document is unmodified again the moment it does. Comparing against the mount value instead
   * would leave the editor claiming unsaved changes forever after the first save.
   */
  const onDisk = source.text || "{}";
  const held = onDraft
    ? (draft ?? null)
    : localDraft !== null && localDraft.file === source.file
      ? localDraft.text
      : null;
  const text = held ?? onDisk;
  const dirty = text !== onDisk;

  /** Write the document. A draft equal to the file is not a draft — see `drafts.ts`. */
  const setText = (next: string): void => {
    const value = next === onDisk ? null : next;
    if (onDraft) onDraft(value);
    else setLocalDraft(value === null ? null : { file: source.file, text: value });
  };
  // The state schema by default: this file IS a state, so the one thing the picker never has to ask
  // is whether it applies.
  const [schemaId, setSchemaId] = useState<string | null>("state");
  const functions = functionOptions(executors);

  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }

  /**
   * The form's own model, held in state rather than re-derived from the document each render.
   *
   * Deriving it was simpler and wrong: a row you have just added has no name yet, `applyForm`
   * refuses to serialize a nameless slot, and re-reading the document therefore erased the row
   * between the click and the next paint. "+ Add" appeared to do nothing.
   *
   * A scalar field survives that round-trip because an empty label is representable — it is just an
   * absent key. A list row is not: it has to exist while it is still too empty to write down.
   */
  const [form, setForm] = useState<FormModel>(() => formOf(parsed));

  /** Every reference the tree can offer, for the link controls. Recomputed only when the tree does. */
  const targets = useMemo(() => linkTargets(tree), [tree]);

  /** The diagnostics, indexed by the path each control answers for — see `issues`. */
  const marks = useMemo(() => (issues.length === 0 ? NO_ISSUES : formIssues(issues)), [issues]);

  /**
   * The form's root, for {@link anchorFor} to search.
   *
   * Scoped to this element rather than the document: the same anchor paths appear in every open
   * editor's form, and `outputs.report` in a state you are not looking at is not the one to scroll.
   */
  const formRef = useRef<HTMLDivElement>(null);

  /**
   * What each mounted child declares, accumulated as it is read.
   *
   * Accumulated rather than replaced, so retyping a child's `state` does not blank the table for the
   * children beside it while one request is in flight. An id that resolved to nothing is remembered
   * as an empty list — that is what stops the effect asking for it again on every keystroke.
   */
  const [declared, setDeclared] = useState<Record<string, StateSlots>>({});

  const childStateId = useMemo(
    () => (row: ChildRow) => childStateIdOf(source.stateId, row.key, row.state),
    [source.stateId],
  );

  /**
   * What the `.operation.*` namespace can offer, given what this file settles about the operation.
   *
   * `inherit` and `ref` are `unknown`: the block exists, so the node does, but which fields it
   * carries is decided by the environment chain rather than here.
   */
  const operationKind =
    form.operationKind === "" || form.operationKind === "prompt" || form.operationKind === "function"
      ? form.operationKind
      : "unknown";

  /**
   * Every runtime path a BINDING here could name — this state's inputs, the outputs its operation
   * produces, and its children's outputs and outcomes.
   *
   * A produced output is one with no binding of its own (§3.3): the operation fills it, so
   * `.outputs.<name>` is how a second output derives from what the call returned.
   */
  const producedOutputs = form.outputs
    .filter((row) => row.binding.trim().length === 0)
    .map((row) => row.name.trim());
  const bindings = bindingTargets(
    form.children.map((row) => ({ key: row.key, stateId: childStateId(row) })),
    declared,
    form.inputs.map((row) => row.name.trim()),
    producedOutputs,
    operationOutputNames(operationKind, producedOutputs),
  );

  /** Guards see everything a binding does, plus the operation and the control-flow scalars. */
  const guards = [...bindings, ...guardTargets(operationKind)];

  /** Render a document into the form. The text itself is derived, so this is the form model alone. */
  const loadForm = (next: string): void => {
    try {
      setForm(formOf(JSON.parse(next)));
    } catch {
      setForm(EMPTY_FORM);
    }
  };

  // Re-derive at the BOUNDARIES only: a different file, a save that came back, or returning from the
  // JSON tab. The form's own writes to `text` move neither dependency, so an in-progress row stands.
  //
  // `text` rather than `source.text`: a file reopened with an unsaved draft has to come back to the
  // draft, and the form is a rendering of whatever the document currently is — not of the file.
  useEffect(() => {
    loadForm(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.file, source.text]);

  useEffect(() => {
    if (tab !== "form") return;
    // Deliberately not depending on `text`: this resyncs when the JSON tab hands control back, not
    // on every keystroke the form itself makes.
    try {
      setForm(formOf(JSON.parse(text)));
    } catch {
      /* the form refuses to render over a document it could not parse; the tab body says so. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /**
   * Show the control an inspector diagnostic is about: switch to the form, scroll to it, flash it.
   *
   * Two effects, split at the tab: the anchor has to be in the DOM before it can be found, and it is
   * not while the JSON tab is up. The first asks for the form and the second runs once the form is
   * there — which is also why `tab` is a dependency of the second and not of the first.
   *
   * The flash is applied to the node rather than held in React state, deliberately. A rendered
   * "which one is flashing" would have to be threaded through every table down to every row, and it
   * describes a second of animation rather than anything about the document. The red OUTLINE, which
   * is a fact about the document, is a class the components render from `marks` in the ordinary way.
   */
  useEffect(() => {
    if (reveal !== null) setTab("form");
  }, [reveal]);

  useEffect(() => {
    if (reveal === null || tab !== "form" || formRef.current === null) return;
    const target = anchorFor(formRef.current, reveal.path);
    if (target === null) return;
    // A child's wiring and a slot's default live behind disclosures. Scrolling to a control inside a
    // closed one would scroll to the summary and leave the author looking at a row that says
    // nothing, so the way in is opened first.
    for (let node = target.parentElement; node !== null; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("issue-flash");
    const timer = window.setTimeout(() => target.classList.remove("issue-flash"), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      target.classList.remove("issue-flash");
    };
  }, [reveal, tab]);

  /**
   * Read what any newly-named child declares, then seed a blank row per required input.
   *
   * Two effects rather than one, and split at the await: fetching is asynchronous and the state it
   * lands in (`declared`) is not the state it changes (`form.children`). Folding them together would
   * mean seeding from inside a promise, against a form that may have moved on three keystrokes ago.
   *
   * Only ids nothing is known about are asked for. `declared` remembers a miss as an empty list, so
   * typing `./go`, `./goa`, `./goal` costs three requests and then stops — rather than one per
   * render, forever, for a child that does not exist.
   */
  const childIds = form.children.map(childStateId).filter((id) => id.length > 0);
  const unknownIds = childIds.filter((id) => declared[id] === undefined);
  const unknownKey = [...new Set(unknownIds)].sort().join("\n");
  useEffect(() => {
    if (unknownKey.length === 0) return;
    let live = true;
    void (async () => {
      const found = await loadStateSlots(unknownKey.split("\n"));
      if (!live) return;
      // A failed call is remembered as "nothing known" for every id asked about, not as an empty
      // declaration: guessing "declares no inputs" would suppress the very rows this exists to add.
      if (found === null) return;
      setDeclared((prev) => {
        const next = { ...prev };
        for (const id of unknownKey.split("\n")) next[id] = found[id] ?? { inputs: [], outputs: [] };
        return next;
      });
    })();
    return () => {
      live = false;
    };
  }, [unknownKey, loadStateSlots]);

  // A named executor that exists but is switched off. An unknown name is NOT flagged: a `function`
  // may name a host function or a sub-workflow, neither of which is in this list.
  const namedFunction = form.operation.fields["functionRef"] ?? "";
  const offFunction = executors.some((e) => e.name === namedFunction && !e.enabled);

  const editForm = (patch: Partial<FormModel>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    if (parseError === null) setText(JSON.stringify(applyForm(parsed, next), null, 2));
  };

  /**
   * Seeded rows go into the FORM only — never into `text`.
   *
   * `setForm` rather than `editForm`, and that is the whole point rather than an optimization.
   * `editForm` re-serializes the document, so seeding through it would rewrite the editor's text the
   * moment a state was opened: the file would read as modified before anyone touched it, the JSON
   * tab would validate a draft nobody authored, and a save would write JaiRA's formatting over the
   * author's.
   *
   * So the placeholder is exactly that — a placeholder. What is validated, what is saved, and what
   * the lint surface reports on all stay the file as it is on disk until the author types a binding.
   */
  useEffect(() => {
    setForm((current) => {
      const seeded = seedRequiredBindings(current.children, declared, childStateId);
      // Same array back when there is nothing to add, so React bails out of the update and this
      // cannot cycle with its own dependency on `form.children`.
      return seeded === current.children ? current : { ...current, children: seeded };
    });
  }, [declared, childStateId, form.children]);

  return (
    <div className="pane editor">
      {/* One line of chrome. All three of these are standing facts about the file rather than things
          you act on, and each used to own a row: a path, a padded notice, and a pair of tabs
          stretched the width of the pane. Together they cost more height than the first two fields
          of the form — so they share a line, and the warning keeps its sentence in its tooltip. */}
      <div className="edit-bar editor-top">
        <div className="sub file-path" title={source.file}>
          {source.file}
          {source.exists ? "" : " · new file"}
        </div>
        {source.layer === "base" ? (
          <span
            className="chip chip-warn"
            title="Editing the shared copy. Every project that has not overridden this state will see the change."
          >
            shared copy
          </span>
        ) : null}
        <div className="tabs seg">
          <button className={tab === "form" ? "layer-on" : "ghost"} onClick={() => setTab("form")}>
            Form
          </button>
          <button className={tab === "json" ? "layer-on" : "ghost"} onClick={() => setTab("json")}>
            JSON
          </button>
        </div>
      </div>

      {tab === "form" ? (
        parseError !== null ? (
          // The form cannot represent a document it could not parse, and guessing would destroy it.
          <div className="reason">
            This file is not valid JSON ({parseError}) — fix it on the JSON tab to use the form.
          </div>
        ) : (
          <div className="form" ref={formRef}>
            {/* Once per form: several controls below reference these by id, and two of them are
                rendered twice (the operation block and the environment block). */}
            <OperationDataLists functions={functions} />
            <LinkTargets targets={targets} />
            {/* Every path a binding in this state could name. Rendered once — see BINDING_TARGETS_ID. */}
            <datalist id={BINDING_TARGETS_ID}>
              {bindings.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            {/* The state's own prose. Labels beside the boxes rather than above them: they are two
                words each, and stacked they doubled the height of the one part of the form that is
                never the reason anyone opened it. */}
            <div className="identity">
              <label className="field inline">
                <span>Label</span>
                <input
                  value={form.label}
                  placeholder="a short name — what the board shows"
                  onChange={(e) => editForm({ label: e.target.value })}
                />
              </label>
              <label className="field inline">
                <span>Description</span>
                <textarea
                  rows={2}
                  value={form.description}
                  placeholder="an author's note — also useful prompt context"
                  onChange={(e) => editForm({ description: e.target.value })}
                />
              </label>
            </div>

            {/* Slots belong to the STATE, so they are offered whether or not it has an operation —
                a pure composite still declares what it takes in and what it hands back. */}
            <SlotTable
              title="Inputs"
              rows={form.inputs}
              optional
              bindingHint="default binding (optional)"
              targets={targets}
              bindingListId={BINDING_TARGETS_ID}
              path="inputs"
              issues={marks}
              onChange={(inputs) => editForm({ inputs })}
            />
            {/* §3.3: an output with a binding is DERIVED, one without is PRODUCED — the operation
                returns it — and there is no third case. Which makes the empty box the answer to
                "bind this to the operation's result", not an unfilled field. */}
            <SlotTable
              title="Outputs"
              rows={form.outputs}
              bindingHint=".children.critique.outputs.outcome"
              targets={targets}
              bindingListId={BINDING_TARGETS_ID}
              emptyBindingMeans={
                form.operationKind === ""
                  ? "nothing produces it — this state has no operation"
                  : "the operation returns it"
              }
              path="outputs"
              issues={marks}
              onChange={(outputs) => editForm({ outputs })}
            />

            {/* The order of the blocks below is the order a state is read in: what it takes, what
                it hands back, what it does with them, what it delegates to, where it goes next —
                and only then the two layers that are defaults rather than substance. The operation
                used to sit after the control flow, which put the one thing most states are ABOUT
                below the tables describing how it is reached. */}
            <div className="slots">
              <div className="slots-head">
                <span>Operation</span>
                <span className="sub">what this state does when the cursor is on it</span>
              </div>
              {/* A transcluded operation is a reference, not a block — there is nothing here to take
                  apart. What it IS, though, is a path, and the control now edits it: `ref` is a fifth
                  value of the same dropdown rather than a state you could only arrive at by editing
                  the JSON. The block behind it is left in place until a target is named, so moving the
                  control here and changing your mind costs nothing. */}
              {/* The kind picker answers for `operation` only when there is no block below it to do
                  so — a transcluded or absent operation still lints, and that diagnostic has to land
                  somewhere. The SELECT carries the mark either way: a complaint about the block as a
                  whole (rather than about one of its fields, which mark themselves) is a complaint
                  about what kind of operation this is. */}
              <label
                {...(form.operationKind === "" || form.operationKind === "ref"
                  ? markFor(marks, "operation", "field inline")
                  : { className: "field inline" })}
              >
                <span>Kind</span>
                <select
                  className={fieldClass(marks, "operation", OPERATION_FIELD_PATHS).trim()}
                  value={form.operationKind}
                  onChange={(e) => editForm({ operationKind: e.target.value as FormModel["operationKind"] })}
                >
                  <option value="">none — groups its children</option>
                  <option value="prompt">prompt — one model call</option>
                  <option value="function">function — host code, a gate, or an agent</option>
                  {/* WORKFLOWS.md §5/§6.1: a block with no `kind` of its own takes one from an
                      ancestor's `environment`. It is also how one state is mounted under two
                      runtimes, so it has to be selectable and not just readable. */}
                  <option value="inherit">inherited — whatever the environment chain says</option>
                  <option value="ref">linked — a block held in another file</option>
                </select>
              </label>
              {form.operationKind === "ref" ? (
                <div className="field">
                  {/* Object position: the bare string IS the reference, no `{"$ref": …}` wrapper
                      (WORKFLOWS.md §2.2). */}
                  <LinkInput
                    value={form.operationRef}
                    targets={targets}
                    placeholder="$/lib/review.operation"
                    onChange={(operationRef) => editForm({ operationRef })}
                  />
                  <div className="sub">
                    spliced in whole; sibling keys would override it, and those stay on the JSON tab
                  </div>
                </div>
              ) : form.operationKind !== "" ? (
                <>
                  <OperationFieldsEditor
                    form={form.operation}
                    show={{
                      prompt: form.operationKind !== "function",
                      function: form.operationKind !== "prompt",
                    }}
                    targets={targets}
                    bindingListId={BINDING_TARGETS_ID}
                    path="operation"
                    issues={marks}
                    onChange={(operation) => editForm({ operation })}
                  />
                  {offFunction ? (
                    <div className="sub warn-text">
                      {namedFunction} is turned off in this project, so it is not registered
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            <ChildrenTable
              rows={form.children}
              keyOptions={childKeyOptions(tree, source.stateId)}
              stateOptions={childStateOptions(tree, source.stateId)}
              functions={functions}
              declared={declared}
              stateIdOf={childStateId}
              issues={marks}
              onChange={(children) => editForm({ children })}
            />
            <TransitionsTable
              rows={form.transitions}
              childKeys={form.children.map((c) => c.key).filter((k) => k.length > 0)}
              guards={guards}
              issues={marks}
              onChange={(transitions) => editForm({ transitions })}
            />

            {/* The DEFAULTS layer. Offered on every state, including a pure composite: declaring a
                session here is the ordinary way to give a whole subtree one conversation. */}
            <div className="slots">
              <div className="slots-head">
                <span>Environment</span>
                <span className="sub">defaults for this state and every descendant</span>
                <button
                  type="button"
                  className="ghost sm"
                  onClick={() => editForm({ environment: form.environment === null ? EMPTY_OPERATION_FIELDS : null })}
                >
                  {form.environment === null ? "+ Add" : "Remove"}
                </button>
              </div>
              {form.environment === null ? (
                <div className="sub">none — this state adds no defaults to what it inherits</div>
              ) : (
                <OperationFieldsEditor
                  form={form.environment}
                  show={{ prompt: true, function: true }}
                  targets={targets}
                  bindingListId={BINDING_TARGETS_ID}
                  onChange={(environment: OperationFieldsForm) => editForm({ environment })}
                />
              )}
            </div>

            <div {...markFor(marks, "limits", "slots")}>
              <div className="slots-head">
                <span>Limits</span>
                <span className="sub">how far this state may go before it is stopped</span>
              </div>
              <div className="row-controls">
                <label className="field">
                  <span>Max iterations</span>
                  <input
                    className={fieldClass(marks, "limits.max_iterations").trim()}
                    value={form.limits.maxIterations}
                    inputMode="decimal"
                    placeholder="guard value: limits.max_iterations"
                    spellCheck={false}
                    onChange={(e) => editForm({ limits: { ...form.limits, maxIterations: e.target.value } })}
                  />
                </label>
                <label className="field">
                  <span>Timeout</span>
                  <input
                    className={fieldClass(marks, "limits.timeout").trim()}
                    value={form.limits.timeout}
                    inputMode="decimal"
                    placeholder="seconds — then terminate.timeout"
                    spellCheck={false}
                    onChange={(e) => editForm({ limits: { ...form.limits, timeout: e.target.value } })}
                  />
                </label>
              </div>
            </div>

            <div className="sub">
              A plain reference is editable here — 🔗 links a value to a file and unlinking gives back
              what was inline. Anything richer than that (a reference with sibling overrides, a
              computed binding) is kept exactly as written and shown read-only; edit those on the
              JSON tab.
            </div>
          </div>
        )
      ) : validateSchema ? (
        // Schema-aware: the picker defaults to the state schema, because that is unambiguously what
        // this file is. It stays a choice rather than being forced — a state whose operation is a
        // prompt has a tighter schema available, and picking `none` is how you silence the panel
        // while restructuring something mid-edit.
        <SchemaJsonEditor
          text={text}
          busy={busy}
          onChange={setText}
          validate={validateSchema}
          schemaId={schemaId}
          onSchema={setSchemaId}
          {...(wrapJson !== undefined ? { wrap: wrapJson } : {})}
          onWrap={onWrapJson}
          {...schemaReferenceProps(ui)}
        />
      ) : (
        <>
          <textarea
            className="code-editor tall"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {parseError ? <div className="reason">not valid JSON: {parseError}</div> : null}
        </>
      )}

      {/* The same bar the JSON editor and the file editors wear, for the same reason they wear it:
          this form is a page long, and a Save that lives at the bottom of a page is a Save that is
          only visible when there is nothing left to fill in. See `editorChrome`. */}
      <EditorActions
        // A file that is not on disk yet has a pending change whether or not anything was typed:
        // its existence. Without the second clause the panel offers "saving creates it" beside a
        // button it has disabled.
        dirty={dirty || !source.exists}
        busy={busy}
        blocked={parseError === null ? undefined : "fix the JSON before saving"}
        onSave={() => onSave(source.stateId, source.layer, text)}
        onRevert={() => {
          setText(onDisk);
          loadForm(onDisk);
        }}
      >
        {source.exists ? null : <span className="sub">new file — saving creates it</span>}
      </EditorActions>
    </div>
  );
}
