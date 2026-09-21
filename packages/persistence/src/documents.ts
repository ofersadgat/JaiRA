/**
 * Versioned frozen documents (decision 0005 §3, step 4).
 *
 * A snapshot is immutable and content-addressed, and stays so. What this adds is the one frozen
 * thing that CHANGES: a **document** — an identity outside any one task, and an ordered list of
 * versions, each of which is an ordinary snapshot.
 *
 * ```
 * system/snapshots/
 *   <hash>/                      one version's resolved closure — exactly what a snapshot always was
 *   _documents/<documentId>.json the document: what it is, and which snapshot each version is
 * ```
 *
 * ## Why an identity outside the task
 *
 * The workflow is independent of the items flowing through it. Several tasks stand in one dynamic
 * workflow exactly as split tasks stand in a real one, and a modification changes the document for
 * all of them — so "which document" cannot be a fact about a task. A task names its document
 * (`task_runtime.document_id`); the document names its versions; nothing is copied per task.
 *
 * ## Why a version is a snapshot
 *
 * Pause, resume and rewind already read `system/snapshots/<hash>/` and nothing else. A version that
 * was anything but a snapshot would need every one of those readers taught a second format. Instead
 * the ONLY new reader is the one that asks "which hash, for this task, now" — {@link currentPin}.
 *
 * ## Records keep the version they ran under
 *
 * A task's journal says which version it ran under, in order: a `workflow.version` row is written
 * each time a task picks a version up, so every row after it — and every record those rows name —
 * ran under that version until the next such row. It is a journal row rather than a column or a
 * side table because the journal is the one thing every mechanism already carries faithfully: a
 * rewind drops the rows past its cut (and with them the pick-ups that came after), a fork copies the
 * rows before its cut, and a journal replayed from its file re-mints every seq while keeping order.
 * {@link versionAt} is the read.
 *
 * ## Only appended to
 *
 * A version is never edited and never removed. `task_runtime.snapshot_hash` remains what it always
 * was — the snapshot this task last ran under — so every existing reader of a pinned task is right
 * without knowing documents exist.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, WorkflowBundle } from "@declarative-ai/hw";
import { createLogger } from "@declarative-ai/log";
import { readJsonFile, refusal } from "@jaira/shared";
import type { AuthoredState, DocumentAdditions } from "./dynamicWorkflow";
import type { StoredEvent } from "./eventLog";
import type { Project } from "./project";
import type { TaskRuntimeRow } from "./runtime";
import { loadSnapshot } from "./snapshots";

const log = createLogger("jaira.persistence.documents");

/** The directory documents live in, beside the snapshots their versions are. */
export const DOCUMENTS_DIR_NAME = "_documents";

/** The namespace a dynamic document's root state id is minted under. */
export const DYNAMIC_ROOT_PREFIX = "dynamic/";

/** Why a version was written — for a person reading the history, never read back by the machine. */
export interface VersionCause {
  /** The task whose move asked for it. */
  taskId?: string;
  /** The state it was moved to. */
  target?: string;
  note?: string;
}

export interface DocumentVersion {
  /** 1-based, dense. */
  version: number;
  /** The snapshot this version IS — `system/snapshots/<hash>/`. */
  snapshotHash: string;
  createdAt: string;
  /**
   * The whole authored root, for a `dynamic` document: what the next version augments, and what
   * "Save as workflow" writes out.
   */
  authored?: AuthoredState;
  /**
   * What this version ADDED, in the authored format. For a `diverged` document it is all there is —
   * the root it was grafted onto is a resolved state, and a resolved state is not an authored one.
   */
  additions?: DocumentAdditions;
  cause?: VersionCause;
}

export interface FrozenDocument {
  id: string;
  /**
   * `dynamic` — generated: a conversation with children, authored from nothing.
   * `diverged` — a real workflow's frozen copy that took a move its workflow did not support. It no
   * longer follows the workflow it came from, which a pinned task never did anyway.
   */
  kind: "dynamic" | "diverged";
  /** The root state id every version's bundle has. A diverged copy keeps its workflow's. */
  rootId: string;
  /** The conversation state that controls it — its root's operation, for a `dynamic` one. */
  conversation: string;
  /** Where a `diverged` copy came from. */
  divergedFrom?: { workflow: string; snapshotHash: string };
  createdAt: string;
  versions: DocumentVersion[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function documentFile(snapshotsDir: string, id: string): string {
  if (!SAFE_ID.test(id)) throw refusal(log, `document id '${id}' is not a safe file name`);
  return join(snapshotsDir, DOCUMENTS_DIR_NAME, `${id}.json`);
}

/** Write whole, then rename: a reader finds the old document or the new one, never half of either. */
function writeDocument(snapshotsDir: string, document: FrozenDocument): void {
  const file = documentFile(snapshotsDir, document.id);
  mkdirSync(join(snapshotsDir, DOCUMENTS_DIR_NAME), { recursive: true });
  const staging = `${file}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(document, null, 2) + "\n", "utf8");
  renameSync(staging, file);
}

export function tryReadDocument(snapshotsDir: string, id: string): FrozenDocument | undefined {
  const file = documentFile(snapshotsDir, id);
  if (!existsSync(file)) return undefined;
  return readJsonFile(file) as FrozenDocument;
}

export function readDocument(snapshotsDir: string, id: string): FrozenDocument {
  const document = tryReadDocument(snapshotsDir, id);
  if (document === undefined) throw refusal(log, `frozen document '${id}' not found under ${snapshotsDir}`);
  if (document.versions.length === 0) throw refusal(log, `frozen document '${id}' has no versions`);
  return document;
}

export function listDocuments(snapshotsDir: string): FrozenDocument[] {
  let names: string[];
  try {
    names = readdirSync(join(snapshotsDir, DOCUMENTS_DIR_NAME));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile(join(snapshotsDir, DOCUMENTS_DIR_NAME, name)) as FrozenDocument)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export const latestVersion = (document: FrozenDocument): DocumentVersion => document.versions[document.versions.length - 1]!;

export function versionOf(document: FrozenDocument, version: number): DocumentVersion {
  const found = document.versions.find((entry) => entry.version === version);
  if (found === undefined) throw refusal(log, `frozen document '${document.id}' has no version ${version}`);
  return found;
}

/** Create a document with its first version. The snapshot must already be on disk. */
export function createDocument(
  snapshotsDir: string,
  document: Omit<FrozenDocument, "versions">,
  first: Omit<DocumentVersion, "version">,
): FrozenDocument {
  if (tryReadDocument(snapshotsDir, document.id) !== undefined) throw refusal(log, `frozen document '${document.id}' already exists`);
  const created: FrozenDocument = { ...document, versions: [{ version: 1, ...first }] };
  writeDocument(snapshotsDir, created);
  log.info(`frozen document ${document.id} (${document.kind}, root '${document.rootId}') created at ${first.snapshotHash.slice(0, 12)}`);
  return created;
}

/**
 * Append a version. `expected` is the version the caller generated FROM: a document that moved on in
 * the meantime is refused rather than overwritten, because the additions were computed against
 * children that are no longer the whole list.
 *
 * A version whose snapshot is the latest one's is not a version — nothing changed — and the document
 * is returned as it stands.
 */
export function appendVersion(
  snapshotsDir: string,
  id: string,
  expected: number,
  next: Omit<DocumentVersion, "version">,
): { document: FrozenDocument; version: DocumentVersion; appended: boolean } {
  const document = readDocument(snapshotsDir, id);
  const latest = latestVersion(document);
  if (latest.version !== expected) {
    throw refusal(log, `frozen document '${id}' is at version ${latest.version}, not ${expected} — it changed while this modification was being made; make it again`);
  }
  if (latest.snapshotHash === next.snapshotHash) return { document, version: latest, appended: false };
  const version: DocumentVersion = { version: latest.version + 1, ...next };
  const updated: FrozenDocument = { ...document, versions: [...document.versions, version] };
  writeDocument(snapshotsDir, updated);
  log.info(`frozen document ${id} → version ${version.version} at ${next.snapshotHash.slice(0, 12)}`);
  return { document: updated, version, appended: true };
}

// ---------------------------------------------------------------------------------------------------
// which version, for this task, now — and then
// ---------------------------------------------------------------------------------------------------

/** What a task runs under at some moment: a snapshot, and the document version it is when it is one. */
export interface Pin {
  snapshotHash: string;
  documentId?: string;
  version?: number;
}

/**
 * What a task runs under THE NEXT TIME IT LOADS: its document's latest version, or — for a task in
 * no document — the snapshot it pinned. Absent for a task that has pinned nothing yet.
 *
 * The one place "a task picks up the latest version" is decided. `beginTaskRun` pins what this
 * returns; every fold that prepares a load reads the states of what this returns, so the machine is
 * described against the document it is about to continue under.
 */
export function currentPin(project: Project, row: Pick<TaskRuntimeRow, "snapshotHash" | "documentId">): Pin | undefined {
  if (row.documentId !== undefined) {
    const document = readDocument(project.paths.snapshotsDir, row.documentId);
    const latest = latestVersion(document);
    return { snapshotHash: latest.snapshotHash, documentId: document.id, version: latest.version };
  }
  return row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : undefined;
}

/** The bundle a task continues under — {@link currentPin}, loaded. */
export function loadPinnedBundle(project: Project, row: Pick<TaskRuntimeRow, "taskId" | "snapshotHash" | "documentId">): WorkflowBundle {
  const pin = currentPin(project, row);
  if (pin === undefined) throw refusal(log, `task '${row.taskId}' has pinned no workflow`, { taskId: row.taskId });
  return loadSnapshot(project.paths.snapshotsDir, pin.snapshotHash);
}

/** The journal row a version pick-up writes. Host vocabulary: the engine neither writes nor reads it. */
export const WORKFLOW_VERSION_EVENT = "workflow.version";

export interface WorkflowVersionEvent {
  type: typeof WORKFLOW_VERSION_EVENT;
  documentId: string;
  version: number;
  snapshotHash: string;
  /** What the task ran under before this row — absent on the first start of a task born in the document. */
  previous?: Pin;
}

export function isWorkflowVersionEvent(event: unknown): event is WorkflowVersionEvent {
  return event !== null && typeof event === "object" && (event as { type?: unknown }).type === WORKFLOW_VERSION_EVENT;
}

/** Journal that this task now runs under `pin` — a no-op for a pin that is no document version. */
export function recordVersionPickUp(project: Project, taskId: string, pin: Pin, previous: Pin | undefined, nowMs: number): void {
  if (pin.documentId === undefined || pin.version === undefined) return;
  const event: WorkflowVersionEvent = {
    type: WORKFLOW_VERSION_EVENT,
    documentId: pin.documentId,
    version: pin.version,
    snapshotHash: pin.snapshotHash,
    ...(previous !== undefined ? { previous } : {}),
  };
  project.events.recorder(taskId).record(event as unknown as EngineEvent, nowMs);
}

/**
 * What the task ran under JUST BEFORE journal event `seq` — the version that was current at a cut
 * there, and the version the row at `seq - 1` was written under.
 *
 * Pure over the rows. The newest pick-up strictly before `seq` decides. With none before it, the
 * answer is what the FIRST pick-up says came before — the snapshot a task ran under before it was
 * moved into a document, which is how a cut behind a divergence un-diverges — and, for a task with
 * no pick-ups at all, `fallback`: the task's own pin.
 */
export function pinAt(events: readonly StoredEvent[], seq: number, fallback: Pin | undefined): Pin | undefined {
  let current: Pin | undefined;
  let first: WorkflowVersionEvent | undefined;
  for (const row of events) {
    // Host vocabulary in an engine-typed journal: asked of the row as data, not as an `EngineEvent`.
    const event: unknown = row.event;
    if (!isWorkflowVersionEvent(event)) continue;
    first ??= event;
    if (row.seq >= seq) break;
    current = { snapshotHash: event.snapshotHash, documentId: event.documentId, version: event.version };
  }
  if (current !== undefined) return current;
  if (first !== undefined) return first.previous;
  return fallback;
}

/** {@link pinAt}, for a task — `seq` absent asks about the end of the journal. */
export function versionAt(project: Project, taskId: string, seq?: number): Pin | undefined {
  const row = project.runtime.get(taskId);
  if (row === undefined) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  const fallback = row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : undefined;
  return pinAt(project.events.list(taskId), seq ?? Number.POSITIVE_INFINITY, fallback);
}

/** The resolved workflow a given journal row ran under — history, read against its own version. */
export function bundleAt(project: Project, taskId: string, seq?: number): WorkflowBundle | undefined {
  const pin = versionAt(project, taskId, seq);
  return pin === undefined ? undefined : loadSnapshot(project.paths.snapshotsDir, pin.snapshotHash);
}
