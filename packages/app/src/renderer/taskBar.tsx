/**
 * The Tasks view's address bar.
 *
 * The same control the Files view puts over its columns (see `crumbs.tsx`), over a different
 * hierarchy: not a folder path with runs on the end, but the PROJECT, the workflow inside it, and
 * the levels drilled into from there — `.jaira › review › triage`.
 *
 * It replaced a breadcrumb per board group. That arrangement had one bar per project stacked down
 * the column, so the answer to "where am I" moved as you scrolled and there were as many of them as
 * you had checkouts open. There is one address now, at the top of the window, in the row the Files
 * view puts its own in — which is what makes the two views one app rather than two.
 *
 * With NO project chosen every group is on screen, and the bar names whichever one you have scrolled
 * to: the group headers below are sections of one list, and the bar is the header of the section you
 * are in. Choosing a project — from the chevron, or by clicking the header — narrows the column to
 * that project alone, and the bar grows the levels you drill into.
 */
import type { JSX } from "react";
import { CrumbBar } from "./crumbs";
import { Pills, projectCounts } from "./pill";
import { CRUMB_PILL_BUDGET, taskAddressOf, type TaskAddressProps } from "./taskBarModel";

export type { TaskAddressProps };

/**
 * The bar. Which crumbs it has, and whose counts ride at its end, is `taskAddressOf` (`taskBarModel.ts`),
 * shared with the universal copy; this draws them.
 */
export function TaskAddressBar({
  tools,
  ...props
}: TaskAddressProps & {
  /** The right-hand end: New task, when the bar is standing on a project you can create into. */
  tools?: React.ReactNode;
}): JSX.Element {
  const { seen, onSeen } = props;
  const { crumbs, pills: project } = taskAddressOf(props);
  return (
    <CrumbBar
      crumbs={crumbs}
      trailing={
        project !== null ? (
          // The counts the group header carried. They belong to the section, so they travel with it
          // into the bar rather than being a fact about the view.
          //
          // As pills now (SHELL.md §4): "12 tasks · 2 running" answered how many and left the four
          // other things a person came to check — what is parked, what failed — to be read off the
          // board. The bar has room for one row of pills and that row is the whole answer.
          <Pills counts={projectCounts(project, seen)} budget={CRUMB_PILL_BUDGET} onClear={() => onSeen(project.project)} />
        ) : null
      }
      {...(tools !== undefined ? { tools } : {})}
    />
  );
}
