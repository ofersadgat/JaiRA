/**
 * `chat/session` is `session` (the person, 2026-11-18: "can we move that out so that its just
 * session.ts?"). The conversation the Chat view starts is a workflow named `session`, as a program
 * (decision 0029 §2). Migrated, not aliased — as the permission sets' move was (`permissionSetsMove.ts`):
 *
 *  - a layer root's own copy of it (`workflows/chat/session.*`, and a `workflows/chat/session/` beside
 *    it) moves to `workflows/session.*`, unless a file is already there, and a reference in it to
 *    `$SYSTEM/workflows/chat/session` names `$SYSTEM/workflows/session`;
 *  - a settings file's `conversations.workflow` of `chat/session` becomes `session`;
 *  - a task file whose `workflow` is `chat/session` names `session`. Its pinned snapshot is its own and
 *    is left as it was: a conversation that started before this goes on as it began.
 *
 * Idempotent and cheap: run at every open, before anything reads the files it moves.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@declarative-ai/log";
import type { JairaDb } from "./db";
import { touch } from "./sync";

const log = createLogger("jaira:session-rename");

export const OLD_SESSION = "chat/session";
export const NEW_SESSION = "session";

const SUFFIXES = [".json", ".yaml", ".yml", ".ts", ".js"] as const;

/** A text with every reference to the old built-in renamed. */
export function renamedSessionReferences(text: string): string {
  return text.split("$SYSTEM/workflows/chat/session").join("$SYSTEM/workflows/session");
}

/** One layer root's workflows and settings, moved and renamed. */
export function renameSessionWorkflow(root: { workflowsDir: string; settingsFiles: readonly string[] }): void {
  for (const suffix of SUFFIXES) {
    const from = join(root.workflowsDir, "chat", `session${suffix}`);
    if (!existsSync(from)) continue;
    const to = join(root.workflowsDir, `session${suffix}`);
    if (SUFFIXES.some((s) => existsSync(join(root.workflowsDir, `session${s}`)))) {
      log.warn(`left ${from} where it is: ${root.workflowsDir}/session already holds a state`);
      continue;
    }
    // Written at its new place first, then the old one removed: a crash between the two leaves both,
    // and the next open finds the new one there and leaves the old for a person to see.
    writeFileSync(to, renamedSessionReferences(readFileSync(from, "utf8")), "utf8");
    rmSync(from);
  }
  const subtree = join(root.workflowsDir, "chat", "session");
  const target = join(root.workflowsDir, "session");
  if (existsSync(subtree) && !existsSync(target)) renameSync(subtree, target);
  for (const file of root.settingsFiles) renameInSettings(file);
}

function renameInSettings(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const conversations = doc["conversations"] as Record<string, unknown> | undefined;
  let changed = false;
  if (conversations !== undefined && conversations !== null && typeof conversations === "object") {
    for (const key of ["workflow", "moved"]) {
      if (conversations[key] === OLD_SESSION) {
        conversations[key] = NEW_SESSION;
        changed = true;
      }
    }
  }
  const out = renamedSessionReferences(JSON.stringify(doc, null, 2));
  if (changed || out !== JSON.stringify(doc, null, 2)) writeFileSync(file, `${out}\n`, "utf8");
}

/** A workspace's task files: a conversation's `workflow` renamed. Its pinned snapshot is left alone. */
export function renameSessionTasks(tasksDir: string, db: JairaDb): void {
  let names: string[];
  try {
    names = readdirSync(tasksDir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(tasksDir, name);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (meta["workflow"] !== OLD_SESSION) continue;
    meta["workflow"] = NEW_SESSION;
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    // A task's file is not in the database: the change log learns of the write here, as
    // `TaskFileStore.write` tells it, so a reader on another device takes the renamed file.
    const taskId = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.json$/, "");
    touch(db, "task", taskId, taskId, false);
  }
}
