/**
 * The Tasks address bar's MODEL — which crumbs it has, and whose counts ride at its end.
 *
 * Moved out of `taskBar.tsx` unchanged (decision 0015), so the desktop's `TaskAddressBar` and the
 * universal copy build one address from one function: the phone's bar and the desktop's can never
 * disagree about what the path says, what a chevron offers or where a crumb goes. Nothing here renders;
 * read `taskBar.tsx` for why the bar is what it is.
 */
import type { BoardCard, BoardView, InstanceNode, ProjectSummary } from "@jaira/shared/browser";
import { alternatives, runCrumbs, type Crumb, type MenuItem } from "./crumbModel";
import { hueOf } from "./pill";
import type { TrailStep } from "./trail";

/**
 * How much room the bar's trailing end can spare for pills.
 *
 * The crumbs shrink before this does — an address that has been truncated to `…/plan` is still an
 * address, where a pill row folded to `+7` has stopped being an answer. Generous enough for all five
 * at three digits each, which is the case where folding would cost the most.
 */
export const CRUMB_PILL_BUDGET = 220;

/** What to call the project crumb when nothing has been scrolled to and nothing is chosen. */
const ALL = "All projects";

/** What the Tasks address is built from — `TaskAddressBar`'s props, less the tools at its end. */
export interface TaskAddressProps {
  projects: readonly ProjectSummary[];
  /**
   * The project the column is narrowed to, or null for all of them.
   *
   * Null is not "none": it is the listing, which is the Tasks view's own root and the state the app
   * opens in.
   */
  focus: string | null;
  /**
   * Which group is under the bar right now, while the column is showing all of them.
   *
   * This is what makes the bar the pinned section header — it is the group you have scrolled to, not
   * a selection, and clicking it is how a section becomes the whole column. Ignored when {@link focus}
   * is set, because then there is only one group and it is that one.
   */
  at: string | null;
  boards: Record<string, BoardView | null>;
  /**
   * The runs walked into below the level — the tail of the address.
   *
   * Empty for the section headers down the column, which stand on a project and nothing deeper.
   */
  trail: readonly TrailStep[];
  /** What the run crumbs need beyond the trail itself. Absent when there is no trail to draw. */
  run?:
    | {
        instances: readonly InstanceNode[];
        /** The other tasks at this level — what the chevron before the base run offers. */
        runs: readonly BoardCard[];
        selectedTask: string | null;
        taskTitle?: string | undefined;
        taskTitlePending?: boolean | undefined;
        onWalkTo: (index: number, node: InstanceNode) => void;
        onSelectTask: (taskId: string) => void;
      }
    | undefined;
  /**
   * How far each conversation has been read — see `JairaUiState.seen`.
   *
   * The bar's pills are the same two kinds as everywhere else (SHELL.md §4.3): the active ones are
   * live facts, the status ones count only what has moved since this person last looked.
   */
  seen: Readonly<Record<string, number>>;
  /** Marking this project's share read, which is what clears its status pills. */
  onSeen: (project: string) => void;
  onFocus: (project: string | null) => void;
  onDrill: (project: string, level: string | null) => void;
  onWalkBack: (index: number) => void;
  onOpenProject: () => void;
}

/**
 * The address: its crumbs, and the project whose counts go at its end (null: no pills — the bar is
 * standing on a chosen project, or on nothing).
 */
export function taskAddressOf({
  projects,
  focus,
  at,
  boards,
  trail,
  run,
  onFocus,
  onDrill,
  onWalkBack,
  onOpenProject,
}: TaskAddressProps): { crumbs: Crumb[]; pills: ProjectSummary | null } {
  // Which project the path is ABOUT: the chosen one, else the one scrolled to, else the first group.
  const standing = focus ?? at ?? projects[0]?.project ?? null;
  const project = projects.find((p) => p.project === standing) ?? null;

  /**
   * The chevron before the project: every other project, and the way to one that is not open.
   *
   * "All projects" is in the list rather than a separate control, because it is a place in the same
   * hierarchy — the level above every project — and a "back to all" button beside a path would be a
   * second way to do what the path already does.
   */
  const options: MenuItem[] = [
    { label: ALL, checked: focus === null, onSelect: () => onFocus(null) },
    ...projects.map((p, i) => ({
      label: p.label,
      note: `${p.tasks} task${p.tasks === 1 ? "" : "s"}${p.running > 0 ? ` · ${p.running} running` : ""}`,
      checked: focus === p.project,
      ...(i === 0 ? { separator: true } : {}),
      onSelect: () => onFocus(p.project),
    })),
    { label: "Open another project…", separator: true, onSelect: onOpenProject },
  ];

  // The workflow, then every level drilled into below it. Only for a chosen project: while the
  // column is a list of groups, there is no single board for the path to describe.
  const levels = focus === null ? [] : (boards[focus]?.breadcrumb ?? []);

  const crumbs: Crumb[] = [];
  const hueAt = projects.findIndex((p) => p.project === project?.project);
  crumbs.push({
    text: project?.label ?? ALL,
    kind: "project",
    // "All projects" takes no hue: it is the one APP crumb in an otherwise data-voiced address bar
    // (§3.2), naming a level rather than a directory, so there is no project for a colour to be of.
    ...(project !== null && hueAt >= 0 ? { hue: hueOf(project.kind, hueAt) } : {}),
    title: project?.project ?? "every project this window can see",
    // Never empty — "Open another project…" is always somewhere else to go — but asked through the
    // same gate as every other level, so the rule stays one rule.
    ...(alternatives(options) !== undefined ? { options } : {}),
    // Clicking it: in the listing, the section you are in becomes the whole column; in a project,
    // back to its workflow roots. Neither where there is nowhere to go — standing on the roots of a
    // chosen project, this crumb IS where you are, and it goes inert like any last crumb.
    ...(standing === null || (focus !== null && levels.length === 0)
      ? {}
      : { go: focus === null ? () => onFocus(standing) : () => onDrill(standing, null) }),
  });

  // The STATE segments, each under the name the BOARD calls it — the state's label where it has one,
  // and otherwise the last part of its id. Never the whole id: the rest of `debug/hello_world` is
  // where the FILE lives, and a folder path is the one thing this address is not about. That is the
  // difference between the two bars — Files spells the path out because the path is what it opens,
  // and here `debug/` names nothing you can go to.
  const walked = trail.length > 0 && run !== undefined;
  for (const [i, level] of levels.entries()) {
    // Never inert while a run is on the path: the last state crumb is then the way back OUT of the
    // walk, exactly as it is in the Files bar.
    const last = i === levels.length - 1 && !walked;
    crumbs.push({
      text: level.label ?? level.stateId.split("/").pop() ?? level.stateId,
      kind: "state",
      title: level.stateId,
      ...(focus === null
        ? {}
        : last
          ? {}
          : i === levels.length - 1
            ? { go: () => onWalkBack(-1) }
            : { go: () => onDrill(focus, level.stateId) }),
    });
  }

  // The tail: one crumb per run walked into, built by the same function the Files address uses.
  //
  // Only under a chosen project. The trail is ONE trail, shared with the Files view — walking into a
  // run there and switching over here must not grow a tail on an address that has no state segments
  // for it to hang off. Every walk started from this board narrows first, so nothing that belongs
  // here is lost to the guard.
  if (focus !== null && trail.length > 0 && run !== undefined) {
    crumbs.push(
      ...runCrumbs({
        trail,
        instances: run.instances,
        runs: run.runs,
        selectedTask: run.selectedTask,
        ...(levels.at(-1) !== undefined ? { stateId: levels.at(-1)!.stateId } : {}),
        ...(run.taskTitle !== undefined ? { taskTitle: run.taskTitle } : {}),
        ...(run.taskTitlePending === true ? { taskTitlePending: true } : {}),
        onWalkBack,
        onWalkTo: run.onWalkTo,
        onSelectTask: run.onSelectTask,
      }),
    );
  }

  // The counts the group header carried. They belong to the section, so they travel with it into the
  // bar rather than being a fact about the view — and only while the column lists every section.
  return { crumbs, pills: project !== null && focus === null ? project : null };
}
