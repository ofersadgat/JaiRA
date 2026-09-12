/**
 * What a task is CALLED on screen — the computed title its path gives it (SPEC §5.2), or the name a
 * person gave the task when nothing on the path declares one.
 *
 * The choice is made in main (`headingOf`), so the board, the detail header and the address bar
 * cannot disagree about it; this module only draws it. One component rather than a `heading?.text ??
 * title` at every site, because the pending and fallback cases have to look the same everywhere a
 * task's name appears, and a site that forgot the styling would draw a placeholder label as though
 * it were the settled name.
 */
import type { JSX } from "react";
import type { TaskHeading } from "@jaira/shared/browser";

/** Anything with a task's own name and, maybe, the name its path gives it. */
export interface Named {
  title: string;
  heading?: TaskHeading | undefined;
}

/** The name as text — for a crumb, a menu entry, anywhere a string is all there is room for. */
export function taskNameOf(task: Named): string {
  return task.heading?.text ?? task.title;
}

/** True while the text is the declaring state's label, standing in for a title still settling. */
export function taskNamePending(task: Named): boolean {
  return task.heading?.pending === true;
}

/**
 * The hover note: why the name looks the way it does, and the task's own name when the path's title
 * has replaced it — the name a rename edits, which is otherwise nowhere on the card.
 */
export function taskNameNote(task: Named): string | undefined {
  const heading = task.heading;
  if (heading === undefined) return undefined;
  if (heading.pending === true) return `${task.title} · the title is still being worked out`;
  if (heading.error !== undefined) {
    return heading.fallback === true
      ? `${task.title} · the title could not be computed, so this is its fallback: ${heading.error}`
      : `${task.title} · the title could not be computed: ${heading.error}`;
  }
  return heading.text !== task.title ? task.title : undefined;
}

/** The name, drawn — italic and dimmed while pending, marked when it is a fallback. */
export function TaskName({ task, className }: { task: Named; className?: string }): JSX.Element {
  const heading = task.heading;
  const note = taskNameNote(task);
  const classes = [
    "task-name",
    heading?.pending === true ? "task-name-pending" : "",
    heading?.error !== undefined ? "task-name-fallback" : "",
    className ?? "",
  ].filter((c) => c !== "");
  return (
    <span className={classes.join(" ")} {...(note !== undefined ? { title: note } : {})}>
      {taskNameOf(task)}
    </span>
  );
}
