/**
 * Task metadata JSON files — `.jaira/tasks/<taskId>.json` (DESIGN §4.1).
 * Human-readable and hand-editable while the task is not running; the SQLite
 * side references tasks by id only and never duplicates these fields.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskMeta, readJsonFile, type TaskMeta } from "@jaira/shared";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.taskStore");

export class TaskFileStore {
  /**
   * `changed` is told of every write and removal: a task's file is not in the database, so the change
   * log (decision 0018, `sync.ts`) learns of it from here rather than from a trigger.
   */
  constructor(
    private readonly tasksDir: string,
    private readonly changed?: (taskId: string, removed: boolean) => void,
  ) {}

  private file(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`);
  }

  write(meta: TaskMeta): void {
    mkdirSync(this.tasksDir, { recursive: true });
    writeFileSync(this.file(meta.id), JSON.stringify(meta, null, 2) + "\n", "utf8");
    this.changed?.(meta.id, false);
  }

  read(taskId: string): TaskMeta {
    const meta = this.tryRead(taskId);
    if (!meta) throw refusal(log, `no task file for '${taskId}' in ${this.tasksDir}`, { taskId });
    return meta;
  }

  /** Idempotent: deleting a file that is already gone is the outcome asked for, not an error. */
  remove(taskId: string): void {
    rmSync(this.file(taskId), { force: true });
    this.changed?.(taskId, true);
  }

  tryRead(taskId: string): TaskMeta | undefined {
    const file = this.file(taskId);
    if (!existsSync(file)) return undefined;
    return parseTaskMeta(readJsonFile(file), taskId);
  }

  /**
   * A ONE-TIME STEP over this workspace's task files (decision 0021), run at every open and writing
   * only what it has not written before. A conversation used to be known by its workflow's id
   * (`chat/session`, `chat/control`) and is now one because the Chat view started it — `startedBy:
   * { by: "chat" }`, which every conversation made since carries. A file from before is stamped here,
   * so nothing reads the old form. Delete it with its call in `openAt` once every workspace has opened
   * (written 2026-10-26). Answers how many it stamped.
   */
  stampConversations(): number {
    let names: string[];
    try {
      names = readdirSync(this.tasksDir).filter((n) => n.endsWith(".json"));
    } catch {
      return 0;
    }
    let stamped = 0;
    for (const name of names) {
      // At OPEN, so one file that does not read is passed over rather than failing the project: it is
      // reported where it is read for itself, as it always was.
      let meta: TaskMeta | undefined;
      try {
        meta = this.tryRead(name.slice(0, -".json".length));
      } catch {
        continue;
      }
      if (meta === undefined || meta.startedBy !== undefined || (meta.workflow !== "chat/session" && meta.workflow !== "chat/control")) continue;
      this.write({ ...meta, startedBy: { by: "chat" } });
      stamped += 1;
    }
    return stamped;
  }

  list(): TaskMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.tasksDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => this.read(n.slice(0, -".json".length)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
}
