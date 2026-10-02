/**
 * The state editor's state and decisions — everything `WorkflowEditor`
 * (`packages/universal/src/components/workflow/WorkflowEditor.tsx`) holds and derives, as one hook
 * ({@link useWorkflowEditor}): the document, the drafts, the merge and the completions. Only the drawing
 * stays in the component.
 *
 * The three views share one source of truth — the document as text — so switching tabs never loses
 * an edit made in another. Every write goes through `applyForm`, which MERGES rather than rebuilds —
 * see `stateForm` for why that distinction is the whole safety property.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isWritableLayer,
  type ExecutorInfo,
  type FileTree,
  type LintIssue,
  type StateSlots,
  type WorkflowLayer,
  type WorkflowSource,
  type WritableLayer,
} from "@jaira/shared/browser";
import { applyForm, EMPTY_FORM, formOf, type BindingRow, type ChildRow, type FormModel, type TransitionRow } from "./stateForm";
import { overrideTarget, type LayerBarAction } from "./builtInModel";
import { fieldClass, formIssues, markFor, NO_ISSUES, type FormIssues } from "./issues";
import type { UiSurface } from "./fileTypes";
import type { LinkReader } from "./linkModel";
import { operationFieldPaths } from "./operationFieldsModel";
import { bindingTargets, childStateIdOf, functionOptions, guardTargets, linkTargets, operationOutputNames, resolveRef } from "./completions";

/**
 * The readings a state file's editor offers, and the name the store remembers one under.
 *
 * Here rather than in the editor because three modules that are not React pass it around — the
 * surface registry, the store that holds one per file, and the app that wires them together — and a
 * type imported from a component only so a record can be keyed by it is a dependency none of them
 * need. Two of these EDIT the document and the third only reads it; that asymmetry is deliberate:
 * the graph answers what the other two cannot — what runs after what, and where each value comes
 * from — and a control on every box would cost the room the picture is made of.
 */
export type EditorTab = "form" | "json" | "graph";

/** What the operation block's own controls mark, so the kind picker can take what is left over. */
export const OPERATION_FIELD_PATHS = operationFieldPaths("operation");

/** The three readings of a state file, in the order the tab strip offers them. */
export const TABS: readonly EditorTab[] = ["form", "json", "graph"];
export const TAB_WORDS: Record<EditorTab, string> = { form: "Form", json: "JSON", graph: "Graph" };
export const TAB_TITLES: Record<EditorTab, string> = {
  form: "the fields, as controls",
  json: "the document, as text",
  graph: "what runs after what, and what makes it",
};

/** Move a row within a list. Order is semantics for children and transitions alike. */
export function moved<T>(rows: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row!);
  return next;
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
 * The default for `WorkflowEditor`'s `loadStateSlots` — a form with no store behind it.
 *
 * A module constant rather than an inline default, so its identity is stable: it is an effect
 * dependency, and a fresh closure per render would fire the effect on every paint.
 */
export const NO_STATE_SLOTS = async (): Promise<null> => null;

/** What the top bar's layer buttons DO (decision 0006) — see `builtInModel.ts` for which are offered. */
export type LayerActions =
  | {
      hasProject: boolean;
      /** Copy this shipped file up into a layer a person owns, and open the copy. */
      onOverride: (toLayer: WritableLayer) => void;
      /** Copy-on-edit: the first change copies the file into Shared with the change as its draft. */
      onEditCopy?: ((text: () => string) => void) | undefined;
    }
  | undefined;

/** What {@link useWorkflowEditor} needs — `WorkflowEditor`'s props, as far as its state reads them. */
export interface WorkflowEditorInput {
  source: WorkflowSource;
  tree: FileTree | null;
  executors: ExecutorInfo[];
  loadStateSlots: (stateIds: string[]) => Promise<Record<string, StateSlots> | null>;
  ui?: UiSurface | undefined;
  issues: readonly LintIssue[];
  reveal: { path: string; nonce: number } | null;
  draft?: string | null | undefined;
  onDraft?: ((text: string | null) => void) | undefined;
  tab?: EditorTab | undefined;
  onTab?: ((tab: EditorTab) => void) | undefined;
  tabs: readonly EditorTab[];
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  layerActions?: LayerActions;
  /** True where an enclosing provider already made the form a reading (`useReadOnly()`). */
  outerReadOnly: boolean;
}

/** Everything the editor draws from, and every way it changes the document. */
export function useWorkflowEditor(input: WorkflowEditorInput) {
  const { source, tree, executors, loadStateSlots, ui, issues, reveal, draft, onDraft, tab: tabProp, onTab, tabs, readFile, layerActions } = input;
  const [localTab, setLocalTab] = useState<EditorTab>("form");
  /**
   * Used only when nothing outside is holding the draft — see `draft`.
   *
   * Carries the file it belongs to. This component is not remounted when the panel opens another
   * state, so an unkeyed draft would be shown over the next file the tree selected.
   */
  const [localDraft, setLocalDraft] = useState<{ file: string; text: string } | null>(null);

  // A tab this host does not offer falls back to the first one it does — a remembered `graph` must
  // not leave the side panel showing nothing at all.
  const asked = tabProp ?? localTab;
  const tab = tabs.includes(asked) ? asked : tabs[0]!;
  const setTab = (next: EditorTab): void => (onTab ? onTab(next) : setLocalTab(next));

  // What ships is never edited (decision 0006): the form is a reading, there is no Save, and the
  // provider at the foot of the editor says so to every table below — the same switch the panel
  // beside a finished run throws, for a different reason. `AppService.writable` would refuse the
  // write anyway; this is the editor not offering it.
  const shipped = !isWritableLayer(source.layer);
  /**
   * COPY-ON-EDIT (the person's ruling, 2026-09-24): a shipped state is edited where it is shown, and
   * the first change is a copy into Shared carrying that change — so the form is live, not a reading.
   * Not when Shared already has a copy: that copy is the one that loads, and editing the built-in
   * would write a second one over it. The bar says to open the copy instead.
   */
  const copyOnEdit = shipped && layerActions?.onEditCopy !== undefined && source.builtIn?.layers.includes("base") !== true;
  const readOnly = input.outerReadOnly || (shipped && !copyOnEdit);
  /** The newest text while the copy is being written, and whether it has been asked for. */
  const copying = useRef<{ file: string; text: string } | null>(null);
  /** Redraws the form while the copy is being written — the text lives in the ref above. */
  const [, redraw] = useState(0);
  /**
   * The file as this editor found it — what Revert goes back to, and what `dirty` is measured
   * against.
   *
   * `source.text` itself, not a copy taken at mount: a save comes back as a new `source.text`, and
   * the document is unmodified again the moment it does. Comparing against the mount value instead
   * would leave the editor claiming unsaved changes forever after the first save.
   */
  const onDisk = source.text || "{}";
  const inFlight = copying.current !== null && copying.current.file === source.file ? copying.current.text : null;
  const held = inFlight !== null
    ? inFlight
    : onDraft
    ? (draft ?? null)
    : localDraft !== null && localDraft.file === source.file
      ? localDraft.text
      : null;
  const text = held ?? onDisk;
  const dirty = text !== onDisk;

  /** Write the document. A draft equal to the file is not a draft — see `drafts.ts`. */
  const setText = (next: string): void => {
    if (copyOnEdit) {
      // The copy is asked for once; every keystroke until it opens lands in what it will carry.
      const started = copying.current !== null && copying.current.file === source.file;
      copying.current = { file: source.file, text: next };
      if (!started) layerActions?.onEditCopy?.(() => copying.current?.text ?? next);
      redraw((n) => n + 1);
      return;
    }
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

  // An inspector diagnostic asked to be shown: switch to the form.
  useEffect(() => {
    if (reveal !== null) setTab("form");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

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

  /**
   * "Compare with what ships": this document beside the built-in file of the same id.
   *
   * Held here rather than by the host because it is a way of LOOKING at the open file, like a tab,
   * and it ends when the file does — a comparison left up over the next file the tree selected
   * would be comparing the wrong pair.
   */
  const [comparing, setComparing] = useState(false);
  const [shippedText, setShippedText] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  useEffect(() => {
    setComparing(false);
    setShippedText(null);
    setCompareError(null);
  }, [source.file]);

  const onLayerAction = (id: LayerBarAction["id"]): void => {
    const toLayer = overrideTarget(id);
    if (toLayer !== null) return layerActions?.onOverride(toLayer);
    if (comparing) return setComparing(false);
    setComparing(true);
    if (shippedText !== null) return;
    if (readFile === undefined) return setCompareError("This panel cannot read the built-in file.");
    void readFile("system", `workflows/${source.stateId}.json`).then((found) =>
      found === null ? setCompareError("The built-in file could not be read.") : setShippedText(found),
    );
  };

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

  /**
   * What a link preview needs, supplied once for the whole form — see `useLinkPreview` (`linkModel.ts`).
   *
   * `null` when this editor was given no reader: a form rendered outside the shell shows its links
   * as paths, which is what it can prove.
   */
  const reader = useMemo<LinkReader | null>(
    () =>
      readFile === undefined
        ? null
        : { resolve: (ref: string) => resolveRef(tree, ref), read: readFile, ...(ui !== undefined ? { ui } : {}) },
    [tree, readFile, ui],
  );

  return {
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
  };
}

/** The file's name in the top bar: a shipped file as a reference names it, and whether it is new. */
export function editorPathOf(source: WorkflowSource, shipped: boolean): string {
  return `${shipped ? `$SYSTEM/workflows/${source.stateId}.json` : source.file}${source.exists ? "" : " · new file"}`;
}

/** Whether the editor offers Save: not in a reading, and never for what ships. */
export const savesOf = (readOnly: boolean, shipped: boolean): boolean => !(readOnly || shipped);

// --- the tables' decisions ---------------------------------------------------------

/** One row of a table: its index-wise edit. */
export function editedRow<T>(rows: readonly T[], index: number, patch: Partial<T>): T[] {
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/** One wire of a child's BindingTable, as it draws: which boxes are marked and what they say. */
export interface BindingRowView {
  slot: { name: string; optional: boolean; description?: string | undefined } | undefined;
  unwired: boolean;
  rowPath: string | undefined;
  /** The row's own lint class (`slot-row binding-row …`). */
  base: string;
  nameMark: string;
  valueMark: string;
  valuePlaceholder: string;
  valueTitle: string | undefined;
}

/**
 * The binding table's rows (`BindingTable` in `WorkflowEditor.tsx`): the child it wires, what the run
 * called it with, and each wire's marks — the table's own error ("required child input 'goal' is not
 * wired") goes to the seeded row it is about.
 */
export function bindingTableOf(
  rows: readonly BindingRow[],
  slots: readonly { name: string; optional: boolean; description?: string | undefined }[],
  path: string | undefined,
  issues: FormIssues,
  refHint: string,
): { childKey: string | undefined; rows: BindingRowView[] } {
  const childKey = /^children\.([^.]+)\.inputs$/.exec(path ?? "")?.[1];
  const byName = new Map(slots.map((slot) => [slot.name, slot]));
  const pathOf = (row: BindingRow): string | undefined =>
    path === undefined || row.name.trim().length === 0 ? undefined : `${path}.${row.name.trim()}`;
  const missing = path === undefined ? "" : fieldClass(issues, path, rows.map(pathOf).filter(Boolean) as string[]);
  return {
    childKey,
    rows: rows.map((row) => {
      const slot = byName.get(row.name.trim());
      // Seeded and still blank. Left as an ERROR rather than filled with a guess: the whole point of
      // the row appearing is that this is a decision only the author can make.
      const unwired = slot !== undefined && !slot.optional && row.structured !== true && row.value.trim().length === 0;
      const rowPath = pathOf(row);
      const rowMark = rowPath === undefined ? "" : fieldClass(issues, rowPath);
      const absent = unwired ? missing : "";
      return {
        slot,
        unwired,
        rowPath,
        base: `slot-row binding-row${unwired ? " unwired" : ""}`,
        nameMark: absent.trim(),
        valueMark: (rowMark.length > 0 ? rowMark : absent).trim(),
        valuePlaceholder: unwired ? "required — nothing runs until this is bound" : ".inputs.issue",
        valueTitle: row.structured === true ? refHint : slot?.description,
      };
    }),
  };
}

/** One child of the ChildrenTable, as it draws. */
export interface ChildRowView {
  childPath: string | undefined;
  inputsPath: string | undefined;
  stateMark: string;
  /** What this mount RUNS, when the box does not already say it. */
  resolved: string;
  statePlaceholder: string;
  /** Whether its environment block is drawn, and open. */
  environmentShown: boolean;
  environmentOpen: boolean;
  environmentMark: string;
}

export function childRowOf(row: ChildRow, issues: FormIssues, stateIdOf: (row: ChildRow) => string, readOnly: boolean): ChildRowView {
  const childPath = row.key.trim().length === 0 ? undefined : `children.${row.key.trim()}`;
  const inputsPath = childPath === undefined ? undefined : `${childPath}.inputs`;
  // What the child MOUNTS. Everything reported against a child except its wiring and its per-mount
  // environment is about the state it names.
  const stateMark = childPath === undefined ? "" : fieldClass(issues, childPath, [inputsPath!, `${childPath}.environment`]);
  // A child's `state` is optional and a `./` one is relative to the parent's id (WORKFLOWS.md §6), so
  // the two commonest spellings both name a file whose id appears nowhere on the row.
  const mounted = stateIdOf(row);
  const resolved = mounted.length > 0 && mounted !== row.state.trim() ? mounted : "";
  const says = row.environment.kind !== "" || row.environment.functionRef.length > 0 || row.environment.model.length > 0;
  return {
    childPath,
    inputsPath,
    stateMark,
    resolved,
    statePlaceholder: row.key ? `./${row.key}` : "state id (defaults to the key)",
    environmentShown: !(readOnly && !says),
    environmentOpen: says,
    environmentMark: childPath === undefined ? "" : fieldClass(issues, `${childPath}.environment`).trim(),
  };
}

/** Keys already used are not offered again: a `children` map cannot hold the same key twice. */
export function freeChildKeys(keyOptions: readonly string[], rows: readonly ChildRow[]): string[] {
  const taken = new Set(rows.map((row) => row.key.trim()).filter((key) => key.length > 0));
  return keyOptions.filter((key) => !taken.has(key));
}

/** A transition row's two boxes' marks: the guard takes the row's own (the cycle warning) too. */
export function transitionMarksOf(issues: FormIssues, i: number): { when: string; to: string } {
  return {
    when: fieldClass(issues, `transitions[${i}]`, [`transitions[${i}].to`]).trim(),
    to: fieldClass(issues, `transitions[${i}].to`).trim(),
  };
}

/** Where a transition may go: the child keys, and the two outcomes. */
export const transitionTargetsOf = (childKeys: readonly string[]): string[] => [...childKeys, "terminate.success", "terminate.error"];

/** The kind picker's mark: it answers for `operation` only when there is no block below to do so. */
export function kindMarksOf(form: FormModel, marks: FormIssues): { label: ReturnType<typeof markFor> | { className: string }; select: string } {
  return {
    label: form.operationKind === "" || form.operationKind === "ref" ? markFor(marks, "operation", "field") : { className: "field" },
    select: fieldClass(marks, "operation", OPERATION_FIELD_PATHS).trim(),
  };
}

/** The operation's kind picker, in the order it offers them. */
export const OPERATION_KINDS: readonly { value: FormModel["operationKind"]; label: string }[] = [
  { value: "", label: "none — groups its children" },
  { value: "prompt", label: "prompt — one model call" },
  { value: "function", label: "function — host code, a gate, or an agent" },
  // WORKFLOWS.md §5/§6.1: a block with no `kind` of its own takes one from an ancestor's `environment`.
  { value: "inherit", label: "inherited — whatever the environment chain says" },
  { value: "ref", label: "linked — a block held in another file" },
];

/** The environment block's own kind. */
export const ENVIRONMENT_KINDS: readonly { value: FormModel["environmentKind"]; label: string }[] = [
  { value: "", label: "kind: inherited" },
  { value: "prompt", label: "kind: prompt" },
  { value: "function", label: "kind: function" },
];

/** A mount's environment kind. */
export const MOUNT_KINDS: readonly { value: ChildRow["environment"]["kind"]; label: string }[] = [
  { value: "", label: "kind…" },
  { value: "prompt", label: "prompt" },
  { value: "function", label: "function" },
];

/** What an Outputs table's empty binding means, by the operation's kind. */
export const outputsEmptyMeans = (form: FormModel): string =>
  form.operationKind === "function" ? "the component's answer lands here by name" : "unbound — say where the value comes from";

export type { TransitionRow };
