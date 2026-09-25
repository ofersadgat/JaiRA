/**
 * The events task's supervisor (decision 0010 §4): ONE task of `system/events` per open project — and
 * one in Shared — running whenever that workflow has an automation, and only then.
 *
 * Asked again whenever the answer may have changed: a project opening (after its suspended runs are
 * resumed), the shared root's first open, any workflow write (a copy of `system/events` in any layer
 * changes what every project below it runs), and the events task's own run ending. Each ask is one
 * comparison of what the workflow IS against what its task runs:
 *
 *  - no automations → a running events task is stopped (and left, so its history stays readable);
 *  - automations and no task → one is made (title `events`, `TaskMeta.system: "events"`) and started;
 *  - the task pinned an older version → it is stopped, deleted, and a new one started on the new version
 *    — a task pins its workflow at its first start (DESIGN §5.3), so a new version is a new task;
 *  - stopped by a restart (interrupted, or canceled) → resumed, keeping what it waited on;
 *  - ended (completed, failed) → replaced by a fresh one: resuming a failed chain would retry the step
 *    that failed, and the next one after it, forever.
 *
 * The task runs UNATTENDED. What it may call is restricted where its run is built (the service's
 * `startRun`, by the marker), so every path that starts or resumes it gets the same registry.
 */
import { createTask, EVENTS_TASK, EVENTS_WORKFLOW, eventsTaskOf, readEventsWorkflow, type EventsWorkflowReading, type Project } from "@jaira/persistence";
import type { LogEntry } from "@jaira/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSession } from "./session";

/** What the supervisor borrows from the service: its own verbs, each exactly as a person reaches it. */
export interface EventsSupervisorDeps {
  /** Still the session this service holds under its key — false once it is closing. */
  isOpen(session: ProjectSession): boolean;
  startTask(session: ProjectSession, taskId: string): Promise<unknown>;
  resumeTask(session: ProjectSession, taskId: string): Promise<unknown>;
  cancelTask(session: ProjectSession, taskId: string): void;
  deleteTask(session: ProjectSession, taskId: string): Promise<unknown>;
  invalidate(session: ProjectSession): void;
  log(entry: Omit<LogEntry, "id" | "at">): void;
}

/** Whether any layer this project searches holds a `system/events` file — none: nothing to supervise. */
export function hasEventsWorkflow(project: Project): boolean {
  const dirs = [project.paths.workflowsDir, project.paths.base.workflowsDir, project.paths.builtIn.workflowsDir];
  return dirs.some((dir) => [".json", ".yaml", ".yml"].some((ext) => existsSync(join(dir, `${EVENTS_WORKFLOW}${ext}`))));
}

/** `2 automations: push_main, nightly` */
const linesSaid = (lines: readonly string[]): string => `${lines.length} automation${lines.length === 1 ? "" : "s"}: ${lines.join(", ")}`;

export class EventsSupervisor {
  constructor(private readonly deps: EventsSupervisorDeps) {}

  private say(session: ProjectSession, level: LogEntry["level"], message: string, taskId?: string): void {
    this.deps.log({ level, source: "events", message, project: session.key, ...(taskId !== undefined ? { taskId } : {}) });
  }

  /** Bring one session's events task in line with its events workflow. Never throws: each outcome is logged. */
  async supervise(session: ProjectSession): Promise<void> {
    if (!this.deps.isOpen(session)) return;
    const project = session.project;
    if (!hasEventsWorkflow(project)) return;
    let reading: EventsWorkflowReading;
    try {
      reading = readEventsWorkflow(project);
    } catch (e) {
      // A broken copy is not "no automations": a task already running keeps running what it pinned.
      this.say(session, "warn", `the events workflow does not load, so its task is left as it is: ${(e as Error).message}`);
      return;
    }
    const task = eventsTaskOf(project);
    const row = task !== undefined ? project.runtime.get(task.id) : undefined;
    const live = task !== undefined && session.live.has(task.id);

    if (reading.lines.length === 0) {
      if (task !== undefined && live) {
        this.say(session, "info", "stopping the events task: its workflow has no automations now", task.id);
        this.deps.cancelTask(session, task.id);
      }
      return;
    }
    if (task === undefined || row === undefined) {
      await this.begin(session, reading, "starting the events task");
      return;
    }
    if (row.snapshotHash !== undefined && row.snapshotHash !== reading.hash) {
      this.say(session, "info", `the events workflow changed: restarting the events task on the new version (${linesSaid(reading.lines)})`, task.id);
      if (live) {
        const running = session.live.get(task.id);
        this.deps.cancelTask(session, task.id);
        await running?.done;
      }
      if (!this.deps.isOpen(session)) return;
      await this.replace(session, task.id, reading);
      return;
    }
    if (live) return;
    switch (row.status) {
      case "queued":
        await this.act(session, task.id, "started the events task", () => this.deps.startTask(session, task.id));
        return;
      case "interrupted":
      case "canceled":
        await this.act(session, task.id, `resumed the events task (${linesSaid(reading.lines)})`, () => this.deps.resumeTask(session, task.id));
        return;
      case "completed":
      case "failed":
        this.say(session, row.status === "failed" ? "warn" : "info", `the events task ${row.status === "failed" ? "failed" : "ended"}: starting a new one`, task.id);
        await this.replace(session, task.id, reading);
        return;
      default:
        // `running` with no run in this process: another process holds it, and is its supervisor.
        return;
    }
  }

  /** Delete the old task, then begin a new one — so there is ONE events task, and it runs the current version. */
  private async replace(session: ProjectSession, oldId: string, reading: EventsWorkflowReading): Promise<void> {
    try {
      await this.deps.deleteTask(session, oldId);
    } catch (e) {
      this.say(session, "warn", `could not remove the old events task: ${(e as Error).message}`, oldId);
      return;
    }
    await this.begin(session, reading, "started the events task");
  }

  private async begin(session: ProjectSession, reading: EventsWorkflowReading, said: string): Promise<void> {
    if (!this.deps.isOpen(session)) return;
    const meta = createTask(session.project, { title: EVENTS_TASK, workflow: EVENTS_WORKFLOW, system: EVENTS_TASK });
    this.deps.invalidate(session);
    await this.act(session, meta.id, `${said} (${linesSaid(reading.lines)})`, () => this.deps.startTask(session, meta.id));
  }

  private async act(session: ProjectSession, taskId: string, said: string, run: () => Promise<unknown>): Promise<void> {
    if (!this.deps.isOpen(session)) return;
    try {
      await run();
      this.say(session, "info", said, taskId);
    } catch (e) {
      this.say(session, "warn", `could not run the events task: ${(e as Error).message}`, taskId);
    }
  }
}
