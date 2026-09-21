/**
 * The dynamic workflow generator's HOST half, and "Save as workflow" (decision 0005 §3, step 4).
 *
 * `dynamicWorkflow.ts` decides what a document says, from schemas alone. This module is everything
 * that needs a project: reading the task being moved and what it recorded, loading the target,
 * turning the authored result into a resolved bundle, LINTING it, freezing it as a snapshot, and
 * writing it as the next version of a document (`documents.ts`).
 *
 * ## Three resolutions, one call
 *
 *  - **new** — the task FINISHED a real workflow. Its outputs are readable only as a child of
 *    something, so a new dynamic document is made: the conversation state as root, the task's root
 *    state as its first child (mounted with what the task ran with), the target as the second, wired
 *    from the first by schema fit. The task is not touched — joining it to the document is
 *    adoption's (§2), which `connect` composes with this.
 *  - **augmented** — the task already stands in a document. The document gains a child and a rule,
 *    as its next version, for every task standing in it.
 *  - **cloned** — the task stands INSIDE a real workflow, which has no move to the target. Its frozen
 *    copy becomes a `diverged` document whose first version is that copy with the child and the rule
 *    grafted onto its root, and the task is pointed at it. A diverged document is augmented the same
 *    way afterwards.
 *
 * ## A child that has run is never rewritten
 *
 * A version is built by loading — and the loader reads LIVE files. So every state the previous
 * version held (or, for a new document, every state the task's own snapshot held) is carried into
 * the new version AS IT WAS FROZEN, over whatever the live layers say now. Only the root changes, and
 * the root only grows. That is what lets a task standing mid-way pick a new version up on its next
 * load, and what keeps a record made under version 1 meaning under version 3 what it meant.
 *
 * ## The graft
 *
 * A real workflow's frozen root is a RESOLVED state: bindings lowered, references spliced, names
 * scoped. It cannot be re-authored, and feeding it back through the loader does not reproduce it. So
 * a clone's additions are lowered BY THE LOADER, in a scaffold root that mounts the same child keys,
 * and only the two lowered pieces — the new mount, the new rules — are moved onto the frozen root.
 * Nothing is lowered by hand. One consequence, stated rather than hidden: the grafted child resolves
 * under its own defaults, not under the `environment` the cloned root hands its other children.
 *
 * The control OPERATION is recorded on the document and not grafted onto a diverged root here: an
 * instance loaded with an operation it never ran dispatches it, so giving a standing task's root a
 * conversation is only safe once that conversation's run semantics exist (step 6).
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FunctionCapabilities, JsonValue } from "@declarative-ai/exec";
import { computeFanOut, sourceStateId, uuidv7, validateBundle, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import { createLogger } from "@declarative-ai/log";
import { isWritableLayer, refusal, type WorkflowLayer } from "@jaira/shared";
import {
  appendVersion,
  createDocument,
  DYNAMIC_ROOT_PREFIX,
  latestVersion,
  readDocument,
  type DocumentVersion,
  type FrozenDocument,
} from "./documents";
import {
  generateDynamicWorkflow,
  isStandingMoveRule,
  type AuthoredState,
  type DynamicBase,
  type GenerateResult,
  type Producer,
  type SlotShape,
  type StateSurface,
  type SuppliedValue,
} from "./dynamicWorkflow";
import { snapshotWithModules } from "./lifecycle";
import type { Project } from "./project";
import { loadSnapshot, readWorkflowFiles } from "./snapshots";
import { loadWorkflowBundle } from "./toolsets";
import { workflowLoadOptions } from "./workflowRefs";

const log = createLogger("jaira.persistence.dynamicDocuments");

// ---------------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------------

/** A resolved state's declared surface. `elementwise` reads every output as the list a fan-out mount gives back. */
export function stateShapeOf(state: LoadedState, options: { elementwise?: boolean } = {}): StateSurface {
  const slot = (section: "inputs" | "outputs", name: string, decl: { kind?: string; schema?: unknown }): SlotShape => {
    const meta = state.slotMeta?.[`${section}.${name}`];
    const schema = (decl.schema ?? {}) as JsonValue;
    return {
      ...(decl.kind !== undefined ? { kind: decl.kind } : {}),
      schema: section === "outputs" && options.elementwise === true ? { type: "array", items: schema } : schema,
      ...(meta?.optional === true || meta?.default !== undefined || meta?.defaultRef !== undefined ? { optional: true } : {}),
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
    };
  };
  const section = (which: "inputs" | "outputs"): Record<string, SlotShape> =>
    Object.fromEntries(Object.entries(state[which] ?? {}).map(([name, decl]) => [name, slot(which, name, decl as { kind?: string; schema?: unknown })]));
  return { id: sourceStateId(state.id), ...(state.label !== undefined ? { label: state.label } : {}), inputs: section("inputs"), outputs: section("outputs") };
}

/**
 * The children of the task's root that have ENDED WELL, nearest first — what may feed a target.
 *
 * Read from the journal: a child entered under the root instance and terminated `success`, newest
 * termination first, one entry per key (its latest pass). A mirrored task element is such a row too.
 */
export function producersOf(project: Project, taskId: string, bundle: WorkflowBundle): Producer[] {
  const row = project.runtime.get(taskId);
  const events = project.events.list(taskId);
  let rootInstance = row?.rootInstanceId;
  const keyOf = new Map<string, string>();
  for (const { event } of events) {
    if (event.type !== "instance.entered") continue;
    if (event.parentInstanceId === undefined) rootInstance ??= event.instanceId;
    else if (event.parentInstanceId === rootInstance && event.childKey !== undefined) keyOf.set(event.instanceId, event.childKey);
  }
  const root = bundle.states[bundle.rootId];
  const ended: string[] = [];
  for (const { event } of events) {
    if (event.type !== "instance.terminated") continue;
    const key = keyOf.get(event.instanceId);
    if (key === undefined) continue;
    const at = ended.indexOf(key);
    if (at >= 0) ended.splice(at, 1);
    if (event.outcome === "success") ended.unshift(key);
  }
  const producers: Producer[] = [];
  for (const key of ended) {
    const mount = root?.children?.[key];
    const state = mount !== undefined ? bundle.states[mount.state] : undefined;
    if (mount === undefined || state === undefined) continue;
    // An inline or task fan-out reads back as lists in element order; a split reads as its one element.
    const elementwise = mount.each !== undefined && mount.each.length > 0 && mount.eachKind !== "split";
    producers.push({ key, state: stateShapeOf(state, { elementwise }) });
  }
  return producers;
}

// ---------------------------------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------------------------------

export interface GenerateVersionRequest {
  /** The task being moved. Its document is augmented; a real workflow it stands in is cloned; one it finished is wrapped. */
  taskId: string;
  /** The target state, as a reference (`feature/ux`). */
  target: string;
  /** The conversation that controls the document — `chat/control`, `chat/session`, any state with an operation. */
  conversation: string;
  targetKey?: string;
  /** Values the caller settled, by the target's own declared input, with who settled them. */
  supplied?: Readonly<Record<string, SuppliedValue>>;
  /**
   * For a task in no document: `new` wraps it in a new dynamic document, `clone` modifies its frozen
   * copy. Absent ⇒ by where the task stands — finished well ⇒ `new`, anywhere inside its workflow ⇒ `clone`.
   */
  mode?: "new" | "clone";
  /** Override the producers derived from the task (nearest first). */
  producers?: readonly Producer[];
  /** The registry's `functions` facet, so validation resolves every function ref — as `beginTaskRun` takes it. */
  functions?: ReadonlyMap<string, FunctionCapabilities>;
  /**
   * Say which resolution this WOULD be and what it would wire, and write nothing: no snapshot, no
   * document, no pin. What `connect`'s dry run asks while a card hovers. The document is not lowered
   * or linted either — a generated document that fails lint is the generator's bug, not an answer.
   */
  dryRun?: boolean;
  nowMs?: number;
}

export interface GenerateVersionResult {
  /**
   * `unsettled` — required inputs of the target are open; nothing was written, `generated.unsettled`
   * says what to supply. `existing` — the document already offers the move; nothing was written.
   */
  resolution: "new" | "augmented" | "cloned" | "existing" | "unsettled";
  generated: GenerateResult;
  document?: FrozenDocument;
  version?: DocumentVersion;
}

/** Load a state and its closure from the LIVE layers — the project's files first, the rest found on the path. */
function loadLive(project: Project, rootRef: string, extra: Record<string, unknown> = {}): WorkflowBundle {
  const files = { ...readWorkflowFiles(project.paths.workflowsDir, { onError: () => undefined }), ...extra };
  return loadWorkflowBundle(files, rootRef, workflowLoadOptions(project.paths, { path: project.config.workflows.path }));
}

/** Only what the root reaches — so a version's identity never varies with a state it no longer mounts. */
function closureOf(bundle: WorkflowBundle): WorkflowBundle {
  const states: Record<string, LoadedState> = {};
  const queue = [bundle.rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const state = bundle.states[id];
    if (state === undefined || states[id] !== undefined) continue;
    states[id] = state;
    for (const child of Object.values(state.children ?? {})) queue.push(child.state);
  }
  return { rootId: bundle.rootId, states };
}

/** `fresh`, with every state `frozen` held carried over as it was frozen — except the root being rewritten. */
function carryOver(fresh: WorkflowBundle, frozen: WorkflowBundle | undefined): WorkflowBundle {
  const states = { ...fresh.states };
  for (const [id, state] of Object.entries(frozen?.states ?? {})) if (id !== fresh.rootId) states[id] = state;
  return closureOf({ rootId: fresh.rootId, states });
}

function lintOrRefuse(bundle: WorkflowBundle, what: string, functions?: ReadonlyMap<string, FunctionCapabilities>): void {
  const report = validateBundle(bundle, { strict: true, ...(functions !== undefined ? { functions } : {}) });
  if (report.errors.length === 0) return;
  const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
  // A generated document that fails lint is a bug in the generator, never the person's to fix.
  throw refusal(log, `${what} does not lint — this is a bug in the generator:\n  ${detail}`);
}

/**
 * Generate the document version a move needs, lint it, freeze it, and write it.
 *
 * Nothing is written when the target's required inputs are not all settled, or when the document
 * already offers the move — see {@link GenerateVersionResult.resolution}.
 */
export async function generateDocumentVersion(project: Project, request: GenerateVersionRequest): Promise<GenerateVersionResult> {
  const nowMs = request.nowMs ?? Date.now();
  const { taskId } = request;
  const row = project.runtime.get(taskId);
  if (row === undefined) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  if (row.snapshotHash === undefined) throw refusal(log, `task '${taskId}' has never run, so it stands nowhere to be moved from`, { taskId });
  const meta = project.tasks.read(taskId);
  const snapshotsDir = project.paths.snapshotsDir;

  const live = loadLive(project, request.target);
  const target = stateShapeOf(live.states[live.rootId]!);
  const existing = row.documentId !== undefined ? readDocument(snapshotsDir, row.documentId) : undefined;
  const previous = loadSnapshot(snapshotsDir, existing !== undefined ? latestVersion(existing).snapshotHash : row.snapshotHash);
  const previousRoot = previous.states[previous.rootId]!;
  const cause = { taskId, target: target.id };
  const createdAt = new Date(nowMs).toISOString();

  const finishedWell = row.status === "completed" && row.outcome === "success";
  const mode = existing !== undefined ? existing.kind : (request.mode ?? (finishedWell ? "new" : "clone")) === "new" ? "new" : "diverged";

  // ---- a finished task, wrapped in a new document -------------------------------------------------
  if (mode === "new") {
    if (!finishedWell) throw refusal(log, `task '${taskId}' is ${row.status} — only a task that finished well has outputs a new document can wire from`, { taskId });
    const conversation = workflowLoadOptions(project.paths, { path: project.config.workflows.path }).loadState?.(request.conversation);
    if (conversation === null || typeof conversation !== "object" || Array.isArray(conversation)) {
      throw refusal(log, `conversation state '${request.conversation}' was not found on the workflow path`);
    }
    if ((conversation as { operation?: unknown }).operation === undefined) {
      throw refusal(log, `conversation state '${request.conversation}' has no operation — a dynamic workflow's root is a state with an operation and children`);
    }
    const source: Producer = {
      key: sourceStateId(previous.rootId).split("/").at(-1)!.replace(/[^A-Za-z0-9_]+/g, "_") || "source",
      state: stateShapeOf(previousRoot),
      ...(row.outputsJson !== undefined ? { outputs: JSON.parse(row.outputsJson) as Record<string, JsonValue> } : {}),
      ...(meta.inputs !== undefined ? { inputs: meta.inputs } : {}),
      taskId,
    };
    const generated = generateDynamicWorkflow({
      base: { kind: "new", conversation: conversation as AuthoredState },
      producers: request.producers ?? [source],
      target,
      ...(request.targetKey !== undefined ? { targetKey: request.targetKey } : {}),
      ...(request.supplied !== undefined ? { supplied: request.supplied } : {}),
    });
    if (!generated.ok) return { resolution: "unsettled", generated };
    if (request.dryRun === true) return { resolution: "new", generated };
    const id = `d-${uuidv7(nowMs)}`;
    const rootId = `${DYNAMIC_ROOT_PREFIX}${id}`;
    const bundle = carryOver(loadLive(project, rootId, { [`${rootId}.json`]: generated.document! }), previous);
    lintOrRefuse(bundle, `the generated workflow for '${target.id}'`, request.functions);
    const snap = await snapshotWithModules(project, bundle);
    const document = createDocument(
      snapshotsDir,
      { id, kind: "dynamic", rootId, conversation: request.conversation, createdAt },
      { snapshotHash: snap.hash, createdAt, authored: generated.document!, additions: generated.additions, cause },
    );
    return { resolution: "new", generated, document, version: latestVersion(document) };
  }

  const producers = request.producers ?? producersOf(project, taskId, previous);

  // ---- a dynamic document, augmented --------------------------------------------------------------
  if (mode === "dynamic") {
    const from = latestVersion(existing!);
    if (from.authored === undefined) throw refusal(log, `frozen document '${existing!.id}' version ${from.version} holds no authored root to augment`);
    const generated = generateDynamicWorkflow({
      base: { kind: "dynamic", document: from.authored },
      producers,
      target,
      ...(request.targetKey !== undefined ? { targetKey: request.targetKey } : {}),
      ...(request.supplied !== undefined ? { supplied: request.supplied } : {}),
    });
    if (!generated.ok) return { resolution: "unsettled", generated };
    if (generated.existing) return { resolution: "existing", generated, document: existing!, version: from };
    if (request.dryRun === true) return { resolution: "augmented", generated, document: existing! };
    const bundle = carryOver(loadLive(project, existing!.rootId, { [`${existing!.rootId}.json`]: generated.document! }), previous);
    lintOrRefuse(bundle, `version ${from.version + 1} of the dynamic workflow '${existing!.id}'`, request.functions);
    const snap = await snapshotWithModules(project, bundle);
    const appended = appendVersion(snapshotsDir, existing!.id, from.version, {
      snapshotHash: snap.hash,
      createdAt,
      authored: generated.document!,
      additions: generated.additions,
      cause,
    });
    return { resolution: appended.appended ? "augmented" : "existing", generated, document: appended.document, version: appended.version };
  }

  // ---- a real workflow's frozen copy, cloned — or a diverged one, augmented ------------------------
  const mounted = Object.entries(previousRoot.children ?? {}).find(([, child]) => sourceStateId(child.state) === target.id);
  const offered = (previousRoot.transitions ?? []).filter((t) => isStandingMoveRule(t)).map((t) => t.to);
  if (mounted !== undefined && request.targetKey === undefined && offered.includes(mounted[0])) {
    // The workflow mounts the target and already offers the move: `connect`'s first rule, not ours.
    const nothing: GenerateResult = { ok: true, additions: { children: {}, transitions: [] }, targetKey: mounted[0], existing: true, mount: "plain", wires: [], literals: [], unsettled: [] };
    return { resolution: "existing", generated: nothing, ...(existing !== undefined ? { document: existing, version: latestVersion(existing) } : {}) };
  }
  const base: DynamicBase = { kind: "clone", children: Object.keys(previousRoot.children ?? {}), offered };
  const generated = generateDynamicWorkflow({
    base,
    producers,
    target,
    ...(request.targetKey !== undefined ? { targetKey: request.targetKey } : {}),
    ...(request.supplied !== undefined ? { supplied: request.supplied } : {}),
  });
  if (!generated.ok) return { resolution: "unsettled", generated };
  if (request.dryRun === true) return { resolution: existing !== undefined ? "augmented" : "cloned", generated, ...(existing !== undefined ? { document: existing } : {}) };

  const bundle = graft(project, previous, generated);
  lintOrRefuse(bundle, `the diverged copy of '${sourceStateId(previous.rootId)}'`, request.functions);
  const snap = await snapshotWithModules(project, bundle);
  const next = { snapshotHash: snap.hash, createdAt, additions: generated.additions, cause };
  if (existing !== undefined) {
    const appended = appendVersion(snapshotsDir, existing.id, latestVersion(existing).version, next);
    return { resolution: appended.appended ? "augmented" : "existing", generated, document: appended.document, version: appended.version };
  }
  const id = `d-${uuidv7(nowMs)}`;
  const document = createDocument(
    snapshotsDir,
    { id, kind: "diverged", rootId: previous.rootId, conversation: request.conversation, divergedFrom: { workflow: meta.workflow, snapshotHash: row.snapshotHash }, createdAt },
    next,
  );
  // The task stops following the workflow it came from: it names the document, and its next load
  // picks version 1 up. The snapshot it last ran under is left as it is — that is still true.
  project.runtime.setPin(taskId, row.snapshotHash, id, nowMs);
  log.info(`task ${taskId} diverged from '${meta.workflow}' into ${id}`);
  return { resolution: "cloned", generated, document, version: latestVersion(document) };
}

/** Lower a clone's additions through the loader, and move the lowered pieces onto the frozen root — see the header. */
function graft(project: Project, frozen: WorkflowBundle, generated: GenerateResult): WorkflowBundle {
  const root = frozen.states[frozen.rootId]!;
  const rootId = sourceStateId(frozen.rootId);
  const scaffold: Record<string, unknown> = {
    [`${rootId}.json`]: {
      label: root.label ?? rootId,
      children: {
        ...Object.fromEntries(Object.entries(root.children ?? {}).map(([key, child]) => [key, { state: sourceStateId(child.state) }])),
        ...generated.additions.children,
      },
      sequence: [],
      transitions: generated.additions.transitions,
    },
  };
  // The keys it already mounts are STUBS here: only their names matter to a wire, and the real
  // states come from the frozen copy below. `children: {}` keeps the directory from supplying any.
  for (const child of Object.values(root.children ?? {})) scaffold[`${sourceStateId(child.state)}.json`] ??= { children: {} };
  const lowered = loadWorkflowBundle(scaffold, rootId, workflowLoadOptions(project.paths, { path: project.config.workflows.path }));
  const loweredRoot = lowered.states[lowered.rootId]!;

  const added = Object.keys(generated.additions.children);
  const grafted: LoadedState = {
    ...root,
    children: { ...(root.children ?? {}), ...Object.fromEntries(added.map((key) => [key, loweredRoot.children![key]!])) },
    transitions: [...(root.transitions ?? []), ...(loweredRoot.transitions ?? [])],
  };
  const fanOut = computeFanOut(grafted);
  if (fanOut !== undefined) grafted.fanOut = fanOut;
  else delete (grafted as { fanOut?: unknown }).fanOut;

  const { [lowered.rootId]: _scaffoldRoot, ...fresh } = lowered.states;
  return closureOf({ rootId: frozen.rootId, states: { ...fresh, ...frozen.states, [frozen.rootId]: grafted } });
}

// ---------------------------------------------------------------------------------------------------
// save as workflow
// ---------------------------------------------------------------------------------------------------

export interface SaveAsWorkflowRequest {
  documentId: string;
  /** The layer to write into. `system` — what ships — is read-only and refused. */
  layer: WorkflowLayer;
  /** The state id to save it as — `support/triage_flow`. */
  as: string;
  overwrite?: boolean;
}

export interface SavedWorkflow {
  stateId: string;
  layer: WorkflowLayer;
  file: string;
  version: number;
}

/**
 * Write a dynamic document's LATEST version into a layer's `workflows/`, as an ordinary state file.
 *
 * What is written is the authored root: its children name real states by id, so the saved workflow
 * loads, lints and runs like any other, and from then on has nothing to do with the document — a
 * task started from it pins an immutable snapshot, as every real workflow's does.
 */
export function saveDocumentAsWorkflow(project: Project, request: SaveAsWorkflowRequest): SavedWorkflow {
  if (!isWritableLayer(request.layer)) throw refusal(log, "what ships with JaiRA is read-only — save the workflow into the project or the shared root");
  const document = readDocument(project.paths.snapshotsDir, request.documentId);
  const latest = latestVersion(document);
  if (document.kind !== "dynamic" || latest.authored === undefined) {
    throw refusal(
      log,
      `'${request.documentId}' is a diverged copy of '${document.divergedFrom?.workflow ?? document.rootId}': its root is that workflow's frozen state, ` +
        `which cannot be written back as an authored file. Edit the workflow it came from instead.`,
    );
  }
  const segments = request.as.split("/");
  if (request.as.length === 0 || segments.some((s) => s === "" || s === "." || s === ".." || /[\\:*?"<>|#]/.test(s))) {
    throw refusal(log, `'${request.as}' is not a state id a workflow can be saved as`);
  }
  if (request.as.startsWith(DYNAMIC_ROOT_PREFIX)) throw refusal(log, `'${DYNAMIC_ROOT_PREFIX}' is where frozen documents are rooted — save the workflow under a name of its own`);
  const dir = request.layer === "project" ? project.paths.workflowsDir : project.paths.base.workflowsDir;
  const file = `${join(dir, ...segments)}.json`;
  if (existsSync(file) && request.overwrite !== true) throw refusal(log, `'${request.as}' already exists in the ${request.layer} layer`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(latest.authored, null, 2) + "\n", "utf8");
  log.info(`saved ${document.id} version ${latest.version} as '${request.as}' (${request.layer})`);
  return { stateId: request.as, layer: request.layer, file, version: latest.version };
}
