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
  constructor(private readonly tasksDir: string) {}

  private file(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`);
  }

  write(meta: TaskMeta): void {
    mkdirSync(this.tasksDir, { recursive: true });
    writeFileSync(this.file(meta.id), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }

  read(taskId: string): TaskMeta {
    const meta = this.tryRead(taskId);
    if (!meta) throw refusal(log, `no task file for '${taskId}' in ${this.tasksDir}`, { taskId });
    return meta;
  }

  /** Idempotent: deleting a file that is already gone is the outcome asked for, not an error. */
  remove(taskId: string): void {
    rmSync(this.file(taskId), { force: true });
  }

  tryRead(taskId: string): TaskMeta | undefined {
    const file = this.file(taskId);
    if (!existsSync(file)) return undefined;
    return parseTaskMeta(readJsonFile(file), taskId);
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
