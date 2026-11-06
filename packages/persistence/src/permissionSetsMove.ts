/**
 * The permission sets left `chat/` (2026-11-05): the conversation presets moved to the TOP LEVEL of
 * `permission-sets/` (`$/permission-sets/read-only`), and `chat_control/` became `control/`.
 *
 * The person: "can we move the chat/* permission sets out of chat and into the global namespace so its
 * just read-only.json? … sure, rename chat_control to control as well". By the no-back-compat rule
 * nothing reads the old names: this rewrites what names them, once per layer root, and the readers
 * of `chat/…` are gone. What it rewrites:
 *
 *  - a layer's own set FILES: `permission-sets/chat/*` moved up a folder, `chat_control/*` into
 *    `control/`, and the references inside them (an override's `$ref` to what ships);
 *  - the references in its WORKFLOWS (`"tools": "$/permission-sets/chat/read-only"`) and its SETTINGS
 *    (a standing layer's reference, and the bucket keys `permissions.layers.chat` → `""`,
 *    `chat_control` → `control`);
 *  - its TASKS (`system/tasks/*.json`): a conversation's composer settings name its stack by
 *    reference. A conversation that never picked one takes the set its pinned snapshot's state names
 *    (`permissions.source`), and a snapshot is frozen — its hash is its content — so that
 *    conversation is given the renamed reference as its own stack, which is what the composer would
 *    have read from the snapshot;
 *  - the DATABASE (migration 32): each turn's request files the composer's settings beside it, and a
 *    rewind or a fork takes them back from there.
 *
 * Left as it was: what is HISTORY — frozen snapshots, the journal, tool outputs, an approval's
 * record of the layer that decided it. They say what was, under the names it had.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JairaDb } from "./db";
import { loadSnapshot } from "./snapshots";
import { latestVersion, tryReadDocument } from "./documents";
import { createLogger } from "@declarative-ai/log";
import { touch } from "./sync";

const log = createLogger("jaira.persistence.permission-sets-move");

/** The old folder → its new place under `permission-sets/` (`""` is the top level). */
const MOVES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["chat_control", "control"],
  ["chat", ""],
];

/** The references that named them, and what they name now. `chat_control/` first: `chat/` is not its prefix, but keep the longer one first anyway. */
const RENAMES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["/permission-sets/chat_control/", "/permission-sets/control/"],
  ["/permission-sets/chat/", "/permission-sets/"],
];

/** The bucket keys of `permissions.layers` that were renamed. */
const BUCKET_KEYS: Readonly<Record<string, string>> = { chat: "", chat_control: "control" };

/** Every old reference in `text` renamed — whatever root it was searched from (`$`, `$SYSTEM`, `$BASE`, `$JAIRA`). */
export function renamedPermissionSetReferences(text: string): string {
  let out = text;
  for (const [from, to] of RENAMES) out = out.split(from).join(to);
  return out;
}

/** Does `text` name a set by an old reference? */
export function namesOldPermissionSet(text: string): boolean {
  return RENAMES.some(([from]) => text.includes(from));
}

/** The files of a tree the references may be written in: workflow and set files, and the scripts beside them. */
const TEXT_FILE = /\.(json|jsonc|ya?ml|ts|mts|cts|js|mjs|cjs|md)$/i;

function filesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() && TEXT_FILE.test(entry.name) ? [full] : [];
  });
}

/** Rewrite one file's references in place; whether it changed. */
function rewriteFile(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!namesOldPermissionSet(text)) return false;
  writeFileSync(file, renamedPermissionSetReferences(text), "utf8");
  return true;
}

/**
 * Move one layer's set files out of `chat/` and `chat_control/`. A file whose new place is already
 * taken is left where it was, and said so: two files cannot be one, and which one the person meant is
 * theirs to say. Returns what it could not move, as sentences.
 */
function moveSetFolders(permissionSetsDir: string): string[] {
  const left: string[] = [];
  for (const [from, to] of MOVES) {
    const source = join(permissionSetsDir, from);
    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    const target = to === "" ? permissionSetsDir : join(permissionSetsDir, to);
    const move = (dir: string, into: string): boolean => {
      mkdirSync(into, { recursive: true });
      let emptied = true;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, entry.name);
        const there = join(into, entry.name);
        if (entry.isDirectory() && existsSync(there) && statSync(there).isDirectory()) {
          if (!move(at, there)) emptied = false;
          continue;
        }
        if (existsSync(there)) {
          left.push(`${at} was not moved: ${there} is already there`);
          emptied = false;
          continue;
        }
        renameSync(at, there);
      }
      if (emptied) rmdirSync(dir);
      return emptied;
    };
    move(source, target);
  }
  return left;
}

/** A settings file's references renamed and its bucket keys moved; the file is written only when something changed. */
function rewriteSettings(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // Not plain JSON (a comment, a trailing comma): the references are renamed as text, and a bucket
    // key, if there is one, is the person's to rename — the loader says which.
    if (namesOldPermissionSet(text)) writeFileSync(file, renamedPermissionSetReferences(text), "utf8");
    return;
  }
  let changed = false;
  const permissions = (doc as { permissions?: { layers?: Record<string, unknown> } } | null)?.permissions;
  let layers = permissions?.layers;
  if (layers !== null && typeof layers === "object" && !Array.isArray(layers)) {
    for (const [from, to] of Object.entries(BUCKET_KEYS)) {
      if (!Object.hasOwn(layers, from) || Object.hasOwn(layers, to)) continue;
      const renamed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(layers)) renamed[key === from ? to : key] = value;
      layers = renamed;
      permissions!.layers = renamed;
      changed = true;
    }
  }
  const out = renamedPermissionSetReferences(JSON.stringify(doc, null, 2));
  if (changed || out !== JSON.stringify(doc, null, 2)) writeFileSync(file, `${out}\n`, "utf8");
}

/** One layer root's files: where its sets, workflows and settings are. */
export interface PermissionSetMoveRoot {
  /** The root's `permission-sets/` folder. */
  permissionSetsDir: string;
  workflowsDir: string;
  /** Its settings files — a project's `settings.json`; the base's, and the person's own. */
  settingsFiles: readonly string[];
}

/**
 * Move one layer root's sets and rename the references in its files. Idempotent — a root with nothing
 * old in it is read and left alone — and cheap enough to run at every open: the folders it reads are
 * the ones a load reads anyway.
 */
export function movePermissionSetsOutOfChat(root: PermissionSetMoveRoot): void {
  const left = moveSetFolders(root.permissionSetsDir);
  for (const sentence of left) log.warn(sentence);
  for (const file of [...filesUnder(root.permissionSetsDir), ...filesUnder(root.workflowsDir)]) rewriteFile(file);
  for (const file of root.settingsFiles) rewriteSettings(file);
}

/** The workflows whose tasks are conversations: their composer's stack is the task's own. */
const CONVERSATION_WORKFLOWS = new Set(["chat/session", "chat/control"]);

/**
 * A workspace's TASK files, after its database is open: each one's references renamed, and a
 * conversation that picked no stack given the renamed set its snapshot named (see the module header).
 * A task whose pinned workflow cannot be read is left as it is.
 */
export function moveTaskPermissionSets(tasksDir: string, snapshotsDir: string, db: JairaDb): void {
  let names: string[];
  try {
    names = readdirSync(tasksDir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  const pinOf = db.prepare(`SELECT snapshot_hash AS snapshotHash, document_id AS documentId FROM task_runtime WHERE task_id = ?`);
  for (const name of names) {
    const file = join(tasksDir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    if (namesOldPermissionSet(text)) {
      meta = JSON.parse(renamedPermissionSetReferences(text)) as Record<string, unknown>;
      changed = true;
    }
    const settings = (meta["chatSettings"] ?? {}) as Record<string, unknown>;
    if (typeof meta["workflow"] === "string" && CONVERSATION_WORKFLOWS.has(meta["workflow"]) && settings["permissionSet"] === undefined && typeof meta["id"] === "string") {
      const source = pinnedSourceOf(snapshotsDir, pinOf.get(meta["id"]) as { snapshotHash: string | null; documentId: string | null } | undefined);
      if (source !== undefined && namesOldPermissionSet(source)) {
        meta["chatSettings"] = { ...settings, permissionSet: { layers: [renamedPermissionSetReferences(source)] } };
        changed = true;
      }
    }
    if (!changed) continue;
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    // A task's file is not in the database, so the change log learns of the write here — as
    // `TaskFileStore.write` tells it — and a reader on another device takes the renamed file.
    const taskId = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.json$/, "");
    touch(db, "task", taskId, taskId, false);
  }
}

/** The reference a task's pinned workflow names its root's permission set by, if it names one. */
function pinnedSourceOf(snapshotsDir: string, row: { snapshotHash: string | null; documentId: string | null } | undefined): string | undefined {
  if (row === undefined) return undefined;
  try {
    const document = row.documentId !== null ? tryReadDocument(snapshotsDir, row.documentId) : undefined;
    const hash = document !== undefined && document.versions.length > 0 ? latestVersion(document).snapshotHash : (row.snapshotHash ?? undefined);
    if (hash === undefined) return undefined;
    const bundle = loadSnapshot(snapshotsDir, hash);
    const root = bundle.states[bundle.rootId] as { environment?: { permissions?: { source?: unknown } } } | undefined;
    const source = root?.environment?.permissions?.source;
    return typeof source === "string" ? source : undefined;
  } catch {
    return undefined;
  }
}

/** Migration 32's body: every turn request's filed settings, and every result, renamed. */
export function moveRecordedPermissionSets(db: JairaDb): void {
  const rows = db
    .prepare(`SELECT rowid AS id, request_json AS request, result_json AS result FROM operation_records WHERE request_json LIKE '%/permission-sets/chat%' OR result_json LIKE '%/permission-sets/chat%'`)
    .all() as Array<{ id: number; request: string | null; result: string | null }>;
  const update = db.prepare(`UPDATE operation_records SET request_json = ?, result_json = ? WHERE rowid = ?`);
  for (const row of rows) {
    update.run(row.request === null ? null : renamedPermissionSetReferences(row.request), row.result === null ? null : renamedPermissionSetReferences(row.result), row.id);
  }
}
