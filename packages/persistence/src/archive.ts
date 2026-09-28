/**
 * Finished tasks put away by themselves (the person, 2026-09-27: "leave the latest 5 tasks in terminal
 * state visible, but those aside, if a task is failed leave it for 2 days, but if it is successful
 * leave it for 1 day. this should be configurable").
 *
 * Over one workspace, newest finished first: the latest `keepLatest` stay whatever their age; past
 * those, a task that did not succeed (failed or canceled) is archived `failedAfterDays` after it
 * finished, and one that succeeded `succeededAfterDays` after. Conversations and JaiRA's own tasks
 * are left alone — a chat is read from the Chat list, not the board.
 */
import { isArchivableStatus, isChatWorkflow, type JairaArchiveConfig } from "@jaira/shared";
import type { Project } from "./project";

const DAY_MS = 86_400_000;

/** Archive what the rule says is due. Returns the task ids archived. */
export function autoArchive(project: Project, rule: JairaArchiveConfig = project.config.archive, nowMs = Date.now()): string[] {
  if (!rule.auto) return [];
  const finished = project.runtime
    .list()
    .filter((row) => isArchivableStatus(row.status))
    .filter((row) => {
      const meta = project.tasks.tryRead(row.taskId);
      return meta !== undefined && !isChatWorkflow(meta.workflow) && meta.system === undefined;
    })
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const archived: string[] = [];
  for (const row of finished.slice(Math.max(0, Math.floor(rule.keepLatest)))) {
    const days = row.status === "completed" ? rule.succeededAfterDays : rule.failedAfterDays;
    if (row.endedAt === undefined || nowMs - row.endedAt < days * DAY_MS) continue;
    if (project.runtime.archive(row.taskId, nowMs)) archived.push(row.taskId);
  }
  return archived;
}
