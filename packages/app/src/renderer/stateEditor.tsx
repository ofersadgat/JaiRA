/**
 * Edit one state file: a form over the state format, a raw JSON tab, and the graph the two describe.
 *
 * The three views share one source of truth — the document as text — so switching tabs never loses
 * an edit made in another, and the graph is a drawing of what is in the boxes rather than of what
 * was last saved. The form now covers the whole of WORKFLOWS.md §2–§7: slots and their
 * types, children and their wiring, the operation, the `environment` defaults layer, transitions and
 * limits. What it still refuses to pretend it understands is anything spelled as a REFERENCE, which
 * it shows read-only rather than as an empty box.
 *
 * Rendering only. Every write goes through `applyForm`, which MERGES rather than rebuilds — see
 * `stateForm` for why that distinction is the whole safety property.
 */
import { lazy, Suspense, useEffect, useRef, type JSX, type ReactNode } from "react";
import {
  WORKFLOW_JSON,
  type ExecutorInfo,
  type FileTree,
  type LintIssue,
  type StateSlotInfo,
  type StateSlots,
  type ValidateSchemaResult,
  type WorkflowLayer,
  type WorkflowSource,
  type WritableLayer,
} from "@jaira/shared/browser";
import { emptyBindingRow, emptyChildRow, type BindingRow, type ChildRow, type FormModel, type TransitionRow } from "./stateForm";
import { EditorActions, type EditorTab } from "./editorChrome";
import { ReadOnlyContext, useReadOnly, useRunReading } from "./reading";
import { LayerBar, layerBarOf } from "./builtIn";
import { ReadValue } from "./readValue";
import { StateGraphView } from "./stateGraphView";
import { anchorFor, fieldClass, FLASH_MS, markFor, type FormIssues } from "./issues";
import type { UiSurface } from "./fileTypes";
import { SchemaJsonEditor, schemaReferenceProps } from "./schemaEditor";
import { SlotTable } from "./slotTable";
import { EMPTY_OPERATION_FIELDS, type OperationFieldsForm } from "./operationForm";
import { OperationDataLists, OperationFieldsEditor, REF_HINT } from "./operationFields";
import { LinkInput, LinkTargets } from "./links";
import { LinkPreview, LinkReaderProvider } from "./linkPreview";
import { childKeyOptions, childStateOptions } from "./completions";
import {
  BINDING_TARGETS_ID,
  ENVIRONMENT_KINDS,
  GUARD_TARGETS_ID,
  MOUNT_KINDS,
  NO_STATE_SLOTS,
  OPERATION_KINDS,
  TABS,
  TAB_TITLES,
  TAB_WORDS,
  bindingTableOf,
  childRowOf,
  editedRow,
  editorPathOf,
  freeChildKeys,
  kindMarksOf,
  moved,
  outputsEmptyMeans,
  savesOf,
  transitionMarksOf,
  transitionTargetsOf,
  useWorkflowEditor,
  type LayerActions,
} from "./stateEditorModel";

export { seedRequiredBindings } from "./stateEditorModel";

/**
 * The diff editor, for "Compare with what ships". Loaded on first use, never with the form — Monaco
 * is megabytes and touches `window` at module scope, so a static import would drag a browser global
 * into every node-side test that renders this editor.
 */
const MonacoDiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));


/**
 * What the tabs draw INTO — inert in a reading, and nothing at all otherwise.
 *
 * A wrapper rather than a class on the editor, because the thing that must stay live is the tab bar
 * above it: `disabled` on a `fieldset` reaches every control inside, which is exactly why it has to
 * enclose the body alone.
 */
function Body({ readOnly, children }: { readOnly: boolean; children: ReactNode }): JSX.Element {
  return readOnly ? (
    <fieldset className="reading" disabled>
      {children}
    </fieldset>
  ) : (
    <>{children}</>
  );
}

/** The ↑/↓ pair, shown wherever the order of a table means something. */
function Reorder({ index, count, onMove }: { index: number; count: number; onMove: (to: number) => void }): JSX.Element | null {
  // Order still MEANS something in a reading — first match wins, children run in sequence — but the
  // control that changes it has nothing to do there, and a pair of dead arrows per row is two.
  if (useReadOnly()) return null;
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
 * (`.children.goals.output.goals`), an expression, a literal. §8 makes them one grammar, so the
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
  const readOnly = useReadOnly();
  const reading = useRunReading();
  // `children.<key>.inputs` — the key is what the recorded values are filed under, and this path is
  // the only place the table is told which child it is wiring.
  const table = bindingTableOf(rows, slots, path, issues, REF_HINT);
  const childKey = table.childKey;
  const wired = childKey === undefined ? undefined : reading?.children?.[childKey];
  const edit = (index: number, patch: Partial<BindingRow>): void => onChange(editedRow(rows, index, patch));
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
        {readOnly ? null : (
          <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptyBindingRow()])}>
            + Wire
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="sub">
          none — the child&apos;s inputs must all be optional or defaulted, or it cannot run
        </div>
      ) : (
        rows.map((row, i) => {
          // A row that IS the missing wire wears the table's error on both boxes: nothing about it
          // is right yet. A row that exists and is wrong wears it on the value, which is the part
          // hw checked. See `bindingTableOf`.
          const { slot, rowPath, base, nameMark, valueMark, valuePlaceholder, valueTitle } = table.rows[i]!;
          return (
            <div key={i} className="binding-group">
            <div {...(rowPath === undefined ? { className: base } : markFor(issues, rowPath, base))}>
              <input
                className={nameMark}
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
                className={valueMark}
                value={row.value}
                list={bindingListId}
                placeholder={valuePlaceholder}
                spellCheck={false}
                disabled={row.structured === true}
                title={valueTitle}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              {readOnly ? null : (
                <button
                  type="button"
                  className="ghost sm"
                  title="remove"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
              </div>
              {/* What the child was actually called with — the other half of the wire. */}
              <ReadValue value={wired?.[row.name.trim()]} />
            </div>
          );
        })
      )}
    </div>
  );
}

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
  const readOnly = useReadOnly();
  const edit = (index: number, patch: Partial<ChildRow>): void => onChange(editedRow(rows, index, patch));
  return (
    // Two anchors: `sequence[i]` is a claim about which of THESE rows are steps, and the spine
    // checkbox is where it is edited, so a diagnostic about the sequence belongs to this table.
    <div {...markFor(issues, ["children", "sequence"], "slots children")}>
      <datalist id="child-keys">
        {/* Keys already used are not offered again: a `children` map cannot hold the same key twice,
            and the second one would silently replace the first rather than adding a child. */}
        {freeChildKeys(keyOptions, rows).map((key) => (
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
        {readOnly ? null : (
          <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptyChildRow()])}>
            + Add
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="sub">none — this state runs its own operation and nothing below it</div>
      ) : (
        rows.map((row, i) => {
          // What the child MOUNTS, what this mount actually RUNS, and whether its environment is
          // drawn — see `childRowOf`.
          const { childPath, inputsPath, stateMark, resolved, statePlaceholder, environmentShown, environmentOpen, environmentMark } = childRowOf(row, issues, stateIdOf, readOnly);
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
              <span className="child-state">
                <input
                  className={stateMark.trim()}
                  value={row.state}
                  list="child-states"
                  placeholder={statePlaceholder}
                  spellCheck={false}
                  onChange={(e) => edit(i, { state: e.target.value })}
                />
                {resolved.length > 0 ? (
                  <span className="mount-id" title={`this mount runs the state '${resolved}'`}>
                    → {resolved}
                  </span>
                ) : null}
              </span>
              {/* Said, not switched, and only when true — the same rule the `optional` box follows in
                  `slotTable.tsx`. An unticked pair on every child is a column of empty boxes
                  reporting that nothing was ticked. */}
              {readOnly ? (
                <>
                  {row.inSpine ? <span className="slot-opt sub">in the sequence</span> : null}
                  {row.async ? <span className="slot-opt sub">async</span> : null}
                </>
              ) : (
                <>
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
                </>
              )}
              <Reorder index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />
              {readOnly ? null : (
                <button
                  type="button"
                  className="ghost sm"
                  title="remove"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
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
            {!environmentShown ? null : (
            <details className="slot-more" open={environmentOpen}>
              <summary>
                environment
                <span className="sub"> · defaults for this mount only</span>
              </summary>
              <div className="row-controls">
                {/* §6.1's own diagnostics — `children.<key>.environment.session` is the one hw
                    reports — belong to this mount's defaults, and this is the first box of them. */}
                <select
                  className={childPath === undefined ? undefined : environmentMark}
                  value={row.environment.kind}
                  title="the operation kind this mount supplies to a child that leaves it to the chain"
                  onChange={(e) =>
                    edit(i, {
                      environment: { ...row.environment, kind: e.target.value as ChildRow["environment"]["kind"] },
                    })
                  }
                >
                  {MOUNT_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
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
            )}
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
  const readOnly = useReadOnly();
  const edit = (index: number, patch: Partial<TransitionRow>): void => onChange(editedRow(rows, index, patch));
  return (
    <div {...markFor(issues, "transitions", "slots")}>
      <datalist id={GUARD_TARGETS_ID}>
        {guards.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      <datalist id="transition-targets">
        {transitionTargetsOf(childKeys).map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>
      <div className="slots-head">
        <span>Transitions</span>
        <span className="sub">{rows.length > 1 ? "first match wins" : ""}</span>
        {readOnly ? null : (
          <button type="button" className="ghost sm" onClick={() => onChange([...rows, { when: "", to: "" }])}>
            + Add
          </button>
        )}
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
              className={transitionMarksOf(issues, i).when}
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
              className={transitionMarksOf(issues, i).to}
              value={row.to}
              list="transition-targets"
              placeholder="child key or terminate.success"
              spellCheck={false}
              onChange={(e) => edit(i, { to: e.target.value })}
            />
            <Reorder index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />
            {readOnly ? null : (
              <button
                type="button"
                className="ghost sm"
                title="remove"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
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
  tabs = TABS,
  onOpenState,
  readState,
  saveState,
  readFile,
  layerActions,
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
  tab?: EditorTab;
  onTab?: ((tab: EditorTab) => void) | undefined;
  /**
   * Which readings this host offers. All three by default.
   *
   * The side panel takes `["form", "json"]`: the graph is a picture and the column it would be drawn
   * in is a quarter of the window wide. A limit rather than a separate component, because everything
   * else about the two is the same document, the same merge and the same writer.
   */
  tabs?: readonly EditorTab[];
  /**
   * Open another state's file, by id — what the graph's child boxes lead to.
   *
   * Optional, and the graph degrades to a picture without it. A drawing of a state's children is
   * also the shortest route to one of them, and a box you cannot follow makes the reader go back to
   * the tree and find by name what they are already looking at.
   */
  onOpenState?: ((stateId: string) => void) | undefined;
  /**
   * Reading and writing a state that is NOT this file — what the graph's side panel needs.
   *
   * Passed through rather than reached for, because this component is also rendered where there is
   * no store: a graph without them still draws, and clicking a box then shows the box's own
   * declaration rather than the state behind it.
   */
  readState?: ((stateId: string) => Promise<WorkflowSource | null>) | undefined;
  saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
  /**
   * Read any file in either layer, for showing what a LINKED property says — see `linkPreview.tsx`.
   *
   * Absent ⇒ a linked field shows its path and nothing else, which is what a form rendered outside
   * the shell can prove about a reference.
   */
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  /**
   * What the top bar's layer buttons DO (decision 0006) — see `builtIn.tsx` for which are offered.
   *
   * Absent ⇒ the bar still says where the file came from and offers nothing, which is right for the
   * graph's side panel and for a form rendered outside the shell: neither has a tree to follow an
   * override into. "Compare with what ships" needs only {@link readFile}, so it is not in here.
   */
  layerActions?: LayerActions;
}): JSX.Element {
  // The document, the drafts, the form and every decision over them are `stateEditorModel.ts`'s — the
  // same hook the universal copy runs (decision 0015). What is left here is the drawing, and the
  // scroll to a revealed issue, which needs the DOM.
  const {
    tab,
    setTab,
    shipped,
    copyOnEdit,
    readOnly,
    onDisk,
    text,
    dirty,
    setText,
    schemaId,
    setSchemaId,
    functions,
    parseError,
    form,
    targets,
    marks,
    declared,
    childStateId,
    bindings,
    guards,
    loadForm,
    comparing,
    shippedText,
    compareError,
    onLayerAction,
    namedFunction,
    offFunction,
    editForm,
    reader,
  } = useWorkflowEditor({
    source,
    tree,
    executors,
    loadStateSlots,
    ui,
    issues,
    reveal,
    draft,
    onDraft,
    tab: tabProp,
    onTab,
    tabs,
    readFile,
    layerActions,
    outerReadOnly: useReadOnly(),
  });

  /**
   * The form's root, for {@link anchorFor} to search.
   *
   * Scoped to this element rather than the document: the same anchor paths appear in every open
   * editor's form, and `outputs.report` in a state you are not looking at is not the one to scroll.
   */
  const formRef = useRef<HTMLDivElement>(null);

  /**
   * Show the control an inspector diagnostic is about: scroll to it and flash it, once the form is up
   * (the hook switched to it).
   *
   * The flash is applied to the node rather than held in React state, deliberately. A rendered
   * "which one is flashing" would have to be threaded through every table down to every row, and it
   * describes a second of animation rather than anything about the document. The red OUTLINE, which
   * is a fact about the document, is a class the components render from `marks` in the ordinary way.
   */
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

  return (
    <ReadOnlyContext.Provider value={readOnly}>
    <LinkReaderProvider value={reader}>
    <div className="pane editor">
      {/* One line of chrome. All three of these are standing facts about the file rather than things
          you act on, and each used to own a row: a path, a padded notice, and a pair of tabs
          stretched the width of the pane. Together they cost more height than the first two fields
          of the form — so they share a line, and the warning keeps its sentence in its tooltip. */}
      <div className="edit-bar editor-top">
        <div className="sub file-path" title={source.file}>
          {/* A shipped file is named the way a reference names it. Where the app is installed is
              nobody's business while reading a state, and it is one hover away. */}
          {/* Isolated from the bar's `direction: rtl` (which exists to ellipsize at the START): without
              it the bidi algorithm moves a leading `$` or `.` to the far end of the path. */}
          <bdi>
            {editorPathOf(source, shipped)}
          </bdi>
        </div>
        {/* Which layer supplied this file, and what can be done about it (decision 0006): a shipped
            file is read-only and overridable, a file that overrides one can be compared with it, and
            a shared file says — as it always has — that every project sees an edit to it. */}
        <LayerBar
          model={layerBarOf(source, layerActions?.hasProject === true, copyOnEdit)}
          busy={busy}
          comparing={comparing}
          onAction={onLayerAction}
        />
        {/* The two that EDIT first, in the order they are reached for; the reading is what you step
            out to, so it is last. A host may offer fewer — see {@link tabs}. */}
        <div className="tabs seg">
          {tabs.map((one) => (
            <button
              key={one}
              className={tab === one ? "layer-on" : "ghost"}
              title={TAB_TITLES[one]}
              onClick={() => setTab(one)}
            >
              {TAB_WORDS[one]}
            </button>
          ))}
        </div>
      </div>

      {/* The DRAWING is never made inert. Nothing in it edits the state — its own controls pan, zoom
          and fit, which are ways of looking rather than ways of changing — and a graph you cannot
          zoom in a column this narrow is a picture of a state rather than a reading of one. It was
          inside the reading's fieldset for one round, which disabled all three buttons. */}
      {comparing ? (
        // The whole body, whatever tab was up: a comparison is of the DOCUMENT, and it is a way of
        // looking rather than a fourth way of editing. The shipped file is the original, because the
        // question is "what did I change", and both sides are read-only — the way to act on what it
        // shows is the form, one click back.
        shippedText === null ? (
          <p className="empty">{compareError ?? "reading what ships…"}</p>
        ) : (
          <Suspense fallback={<div className="diff-pane-loading">loading the diff editor…</div>}>
            <MonacoDiffPane original={shippedText} modified={text} mime={WORKFLOW_JSON} sideBySide readOnly />
          </Suspense>
        )
      ) : tab === "graph" ? (
        <StateGraphView
          text={text}
          stateId={source.stateId}
          // What the children declare, which the form has already asked for to seed its wiring rows.
          // The graph shows a child's whole surface — every slot it takes and hands back — and only
          // the children themselves know what that is.
          declared={declared}
          {...(onOpenState !== undefined ? { onOpenState } : {})}
          // What the side panel's editor needs when a box is clicked: the state that box mounts is
          // another file, and showing it properly means the same form, the same lists to complete
          // against, and the same writer.
          {...(readState !== undefined ? { readState } : {})}
          {...(saveState !== undefined ? { saveState } : {})}
          {...(readFile !== undefined ? { readFile } : {})}
          tree={tree}
          executors={executors}
          busy={busy}
          {...(validateSchema !== undefined ? { validateSchema } : {})}
          loadStateSlots={loadStateSlots}
          {...(wrapJson !== undefined ? { wrapJson } : {})}
          onWrapJson={onWrapJson}
          ui={ui}
        />
      ) : tab === "form" ? (
        parseError !== null ? (
          // The form cannot represent a document it could not parse, and guessing would destroy it.
          <div className="reason">
            This file is not valid JSON ({parseError}) — fix it on the JSON tab to use the form.
          </div>
        ) : (
          /*
            The FORM is what a reading makes inert, and `fieldset[disabled]` is the one element that
            does it in a single move — including for whatever somebody adds here later without
            reading this file. The controls that would change the state are not rendered at all (see
            `reading.ts`); this is the backstop for the boxes that remain, which show values and must
            not take any.
          */
          <Body readOnly={readOnly}>
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
            {/* A reading shows what the state SAYS. An empty box under a label is how a form invites
                you to fill one in, and there is nothing to fill in here. */}
            <div className="identity">
              {readOnly && form.label.length === 0 ? null : (
                <label className="field inline">
                  <span>Label</span>
                  <input
                    value={form.label}
                    placeholder="a short name — what the board shows"
                    onChange={(e) => editForm({ label: e.target.value })}
                  />
                </label>
              )}
              {readOnly && form.description.length === 0 ? null : (
                <label className="field inline">
                  <span>Description</span>
                  <textarea
                    rows={2}
                    value={form.description}
                    placeholder="an author's note — also useful prompt context"
                    onChange={(e) => editForm({ description: e.target.value })}
                  />
                </label>
              )}
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
            {/* §3.3 lets an output with no binding be PRODUCED — the operation's result of the same
                name fills it — and JaiRA does not: an empty box here is an error, because a wire
                nobody wrote down is a wire nobody can check. The exception is a FUNCTION operation,
                whose result the engine cannot index, so a component's answer still lands by name. */}
            <SlotTable
              title="Outputs"
              rows={form.outputs}
              bindingHint=".children.critique.output.outcome"
              targets={targets}
              bindingListId={BINDING_TARGETS_ID}
              emptyBindingMeans={outputsEmptyMeans(form)}
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
                  about what kind of operation this is.

                  A STACKED label, not an inline one: the rest of this block's fields stack, and an
                  inline label pushes its control 86px to the right of them. The Kind picker then sat
                  further in than the Prompt box whose existence it decides, which reads as a nesting
                  level that is not there. */}
              {/* A picker showing "inherited" is a picker showing that nothing was picked. The
                  reading's answer to "what kind of operation is this" is the block below it. */}
              {readOnly && form.operationKind === "inherit" ? null : (
              <label {...kindMarksOf(form, marks).label}>
                <span>Kind</span>
                <select
                  className={kindMarksOf(form, marks).select}
                  value={form.operationKind}
                  onChange={(e) => editForm({ operationKind: e.target.value as FormModel["operationKind"] })}
                >
                  {/* WORKFLOWS.md §5/§6.1: `inherit` — a block with no `kind` of its own takes one
                      from an ancestor's `environment`. It is also how one state is mounted under two
                      runtimes, so it has to be selectable and not just readable. */}
                  {OPERATION_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
              )}
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
                  {/* The whole operation lives in another file — so what that file says is here. */}
                  {form.operationRef.length > 0 ? <LinkPreview reference={form.operationRef} /> : null}
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
            {readOnly && form.environment === null ? null : (
            <div className="slots">
              <div className="slots-head">
                <span>Environment</span>
                <span className="sub">defaults for this state and every descendant</span>
                {/* The block's own `kind`, which nothing rendered before: a file reading
                    `{"kind": "prompt", "model": …}` showed the model and no sign of the first half,
                    so an inherited kind was one you could neither see nor change. Blank states
                    none, which is what a defaults layer supplying only a session wants. */}
                {form.environment === null ? null : (
                  <select
                    value={form.environmentKind}
                    title="what this layer declares its descendants' operations to be"
                    onChange={(e) => editForm({ environmentKind: e.target.value as FormModel["environmentKind"] })}
                  >
                    {ENVIRONMENT_KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                )}
                {readOnly ? null : (
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => editForm({ environment: form.environment === null ? EMPTY_OPERATION_FIELDS : null })}
                  >
                    {form.environment === null ? "+ Add" : "Remove"}
                  </button>
                )}
              </div>
              {form.environment === null ? (
                <div className="sub">none — this state adds no defaults to what it inherits</div>
              ) : (
                <OperationFieldsEditor
                  form={form.environment}
                  // Both halves, because a defaults layer may legitimately supply either — but the
                  // kind above narrows what is worth showing, so a layer declared `function` stops
                  // offering a prompt and a model it would never use.
                  show={{
                    prompt: form.environmentKind !== "function",
                    function: form.environmentKind !== "prompt",
                  }}
                  targets={targets}
                  bindingListId={BINDING_TARGETS_ID}
                  onChange={(environment: OperationFieldsForm) => editForm({ environment })}
                />
              )}
            </div>
            )}

            {readOnly && form.limits.maxIterations.length === 0 && form.limits.timeout.length === 0 ? null : (
            <div {...markFor(marks, "limits", "slots")}>
              <div className="slots-head">
                <span>Limits</span>
                <span className="sub">how far this state may go before it is stopped</span>
              </div>
              <div className="row-controls">
                {readOnly && form.limits.maxIterations.length === 0 ? null : (
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
                )}
                {readOnly && form.limits.timeout.length === 0 ? null : (
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
                )}
              </div>
            </div>
            )}

            {/* Advice about EDITING, which is not what a reading is for. */}
            {readOnly ? null : (
              <div className="sub">
                A plain reference is editable here — 🔗 links a value to a file and unlinking gives back
                what was inline. Anything richer than that (a reference with sibling overrides, a
                computed binding) is kept exactly as written and shown read-only; edit those on the
                JSON tab.
              </div>
            )}
          </div>
          </Body>
        )
      ) : readOnly ? (
        // The document, as a document. `SchemaJsonEditor` below is an authoring surface — a schema
        // picker, a validation report, a field reference — and every part of it is about writing
        // this file correctly. A reading wants the text: selectable, copyable, scrolling in its own
        // box, and taking no input.
        <textarea className="code-editor tall reading-doc" spellCheck={false} value={text} readOnly />
      ) : validateSchema ? (
        // Schema-aware: the picker defaults to the state schema, because that is unambiguously what
        // this file is. It stays a choice rather than being forced — a state whose operation is a
        // prompt has a tighter schema available, and picking `none` is how you silence the panel
        // while restructuring something mid-edit.
        <SchemaJsonEditor
          text={text}
          busy={busy}
          // A state file is JSON and takes JSON's palette through the mime chain, unless somebody has
          // said something about states in particular.
          mime={WORKFLOW_JSON}
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
          only visible when there is nothing left to fill in. See `editorChrome`.

          Absent altogether in a reading — not disabled. A greyed-out Save at the foot of a panel
          describing a run that finished last week is an offer about a document nobody is editing,
          and it takes a row of the column to make it. */}
      {!savesOf(readOnly, shipped) ? null : (
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
      )}
    </div>
    </LinkReaderProvider>
    </ReadOnlyContext.Provider>
  );
}
