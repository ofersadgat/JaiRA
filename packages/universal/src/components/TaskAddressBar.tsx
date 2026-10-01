import type { JSX, ReactNode } from "react";
import { projectCounts } from "@jaira/ui/pillModel";
import { CRUMB_PILL_BUDGET, taskAddressOf, type TaskAddressProps } from "@jaira/ui/taskBarModel";
import { CrumbBar } from "./Crumbs";
import { Pills } from "./Pills";

/**
 * `taskBar.tsx`'s `TaskAddressBar`, universal (decision 0015): the Tasks room's address — the project, the
 * workflow levels drilled into, the runs walked into — with the section's pills at its end while the
 * column lists every project. Which crumbs, and whose pills, is `taskAddressOf` (`taskBarModel.ts`), the
 * desktop's own function; the drawing is {@link CrumbBar}.
 *
 * The same control heads every board group but the first down the Tasks column (`App.tsx`,
 * `i > 0 && state.taskFocus === null`): there it is `place="section"`, standing on that group
 * (`focus={null}`, `at={group}`, `trail={[]}`), with no tools.
 */
export type { TaskAddressProps };

export function TaskAddressBar({
  tools,
  place = "title",
  ...props
}: TaskAddressProps & {
  /** The right-hand end: New task, when the bar is standing on a project you can create into. */
  tools?: ReactNode;
  /** In the title bar, or over a board group — see `CrumbBar`. */
  place?: "title" | "section";
}): JSX.Element {
  const { seen, onSeen } = props;
  const { crumbs, pills: project } = taskAddressOf(props);
  return (
    <CrumbBar
      crumbs={crumbs}
      place={place}
      trailing={project !== null ? <Pills counts={projectCounts(project, seen)} budget={CRUMB_PILL_BUDGET} onClear={() => onSeen(project.project)} /> : null}
      {...(tools !== undefined ? { tools } : {})}
    />
  );
}
