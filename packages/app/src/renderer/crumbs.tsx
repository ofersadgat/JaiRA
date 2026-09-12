/**
 * The address bar, as chrome — the part that is the same wherever a path is drawn.
 *
 * Files and Tasks both answer "where am I" with a path, and they answered it with two different
 * controls: a file explorer bar with chevron menus in one view, and a plainer strip of buttons in
 * the other. The two are the same thing about different hierarchies — a folder path with runs on
 * the end, and a project with a workflow and its levels on the end — so what is shared is everything
 * except which crumbs go in it.
 *
 * This file holds the crumb MODEL and the bar that renders it. Who builds the crumbs is the caller's
 * business: `files.tsx` builds them from the open document, `taskBar.tsx` from the focused project.
 */
import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import type { BoardCard, InstanceNode } from "@jaira/shared/browser";
import { ContextMenu, type MenuAnchor, type MenuItem } from "./menu";
import { taskNameOf } from "./taskName";
import { nodeAt, stepOf, type TrailStep } from "./trail";

/**
 * One segment of an address.
 *
 * `go` is what clicking it does; a crumb with none is either where you are standing or a segment
 * that names nothing openable. The KINDS are drawn differently because they are different things:
 * the file's own hierarchy is fixed by which document is open, and the runs after it are a walk you
 * can take back.
 */
export interface Crumb {
  text: string;
  /**
   * Which family it belongs to, which is what it LOOKS like.
   *
   * Four, and they are four different kinds of thing rather than four levels of importance: a
   * `folder` is a place on disk, a `state` is a level of the workflow hierarchy, a `run` is one
   * execution, and a `project` is the checkout all three of those belong to. Every member of a
   * family looks identical to every other — including the layer root, which is a folder like any
   * other and had a pill of its own for no reason except that it happened to be first.
   */
  kind: "folder" | "state" | "run" | "project";
  /**
   * The project's colour, for a `project` crumb — see `hueOf`.
   *
   * The head of the address wears the same mark its sidebar row and its inbox chip wear, which is
   * what ties three surfaces to one project without any of them repeating a path.
   */
  hue?: string;
  /** The full story, for the tooltip: which instance, which state it ran, where on disk. */
  title?: string;
  /**
   * The text is a PLACEHOLDER — a state's label standing in for a computed title still settling
   * (SPEC §5.2). Drawn the way `TaskName` draws one, so the bar and the board agree on what is final.
   */
  pending?: boolean;
  go?: () => void;
  /**
   * The other things that could be at this level — what the `›` before this crumb drops down.
   *
   * The Explorer move: a separator is not decoration, it is the join between two levels, and the
   * question it can answer is "what else is in the one on the left". For a path crumb that is the
   * containing directory's entries; for a run it is the sibling runs, which is the board one level
   * up without going back to it; for the ROOT it is the other roots, and the way to another project.
   *
   * Absent when there is no OTHER — a menu whose one entry names where you already are is a control
   * that does nothing, so the chevron stays a plain glyph. See {@link alternatives}.
   */
  options?: MenuItem[];
}

/**
 * A level's menu, or nothing when there is nowhere else to go.
 *
 * The list always CONTAINS where you are — that is what the mark is for, and a list that dropped it
 * would make you count the path to see which one you were on. But a list that is ONLY where you are
 * is a chevron that opens to tell you what the crumb beside it already says.
 */
export function alternatives(options: MenuItem[]): MenuItem[] | undefined {
  return options.some((option) => option.checked !== true) ? options : undefined;
}

/**
 * The run's own name with the state it ran stripped off the front.
 *
 * A task started from `debug/hello_world` is called `debug/hello_world #2`, and the state is already
 * the crumb immediately to the left — so spelled in full the path says the same thing twice and the
 * second copy reads as a level of its own.
 */
export function shortRunName(title: string, stateId: string | undefined): string {
  if (stateId === undefined || !title.startsWith(stateId)) return title;
  const rest = title.slice(stateId.length).trim();
  return rest.length > 0 ? rest : title;
}

/**
 * How a run reads in the path: which TASK at the base, its own name below that.
 *
 * The rule is POSITIONAL, and it has to be. The first step is the state the walk began at — that
 * state is the crumb immediately before it, by construction — so whatever the run is CALLED there is
 * another word for a level the path already has. What is new about a deeper step is which pass it
 * is, and that is what those say.
 */
function runCrumbOf(step: TrailStep, index: number, taskTitle: string | undefined, stateId: string | undefined): string {
  // A sidechain step is named at the doorway it was pushed from — the Task call's own description —
  // and the instance id would name its HOST, which is the crumb before it.
  if (step.sidechain !== undefined) return step.name ?? "⑂ subagent";
  if (index > 0) return step.name ?? `#${shortId(step.instanceId)}`;
  return taskTitle === undefined ? `#${shortId(step.instanceId)}` : shortRunName(taskTitle, stateId);
}

/**
 * A durable instance id, cut to something a person can scan.
 *
 * The TAIL, never the head: a UUIDv7 leads with its timestamp, so every id minted in one run opens
 * with the same characters and a head-truncated label would read identically across the whole bar.
 * The random bits are at the end. A short legacy id passes through whole.
 */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(-8) : id;
}

/** What the tail of an address needs to draw itself. See {@link runCrumbs}. */
export interface RunCrumbInput {
  trail: readonly TrailStep[];
  /** The selected task's instance tree — where a run's siblings come from. */
  instances: readonly InstanceNode[];
  /** The other runs of the state the walk began at: what the chevron before the base run offers. */
  runs: readonly BoardCard[];
  selectedTask: string | null;
  /** The state the walk began at — what the base crumb's name is shortened against. */
  stateId?: string | undefined;
  /** The selected task's own name, which is what the base crumb reads — its computed title where it has one. */
  taskTitle?: string | undefined;
  /** {@link taskTitle} is a label standing in for a title still settling — see `Crumb.pending`. */
  taskTitlePending?: boolean | undefined;
  onWalkBack: (index: number) => void;
  /** Replace the path from `index` down with this run — walking sideways rather than in. */
  onWalkTo: (index: number, node: InstanceNode) => void;
  onSelectTask: (taskId: string) => void;
}

/**
 * The tail of an address: one crumb per run walked into.
 *
 * Shared by both views on purpose. Files reaches a run by opening its state's file and Tasks by
 * drilling a board, but from the run down the two addresses are the same address — same crumbs, same
 * chevrons, same way back out — and the moment that stopped being one function was the moment the
 * two could start disagreeing about what `#3` means.
 */
export function runCrumbs(input: RunCrumbInput): Crumb[] {
  const { trail, instances, runs, selectedTask, stateId, taskTitle } = input;
  return trail.map((step, i) => {
    const last = i === trail.length - 1;
    // A sidechain crumb has no chevron: its siblings would be the host session's other chains, and
    // the host is not on hand here to list them. The name and the way back are the crumb's job.
    if (step.sidechain !== undefined) {
      return {
        text: runCrumbOf(step, i, taskTitle, stateId),
        kind: "run" as const,
        title: `subagent conversation in run #${shortId(step.instanceId)} of ${step.stateId}`,
        ...(last ? {} : { go: () => input.onWalkBack(i) }),
      };
    }
    // The BASE's alternatives are the other runs of this state — which are other tasks, since one
    // task's newest pass is what the base stands for. Deeper, they are the sibling runs under the
    // same parent, which is the board one level up without having to go back to it.
    const parent = i === 0 ? undefined : nodeAt(instances, trail[i - 1]!.instanceId);
    const options = alternatives(
      i === 0
        ? runs.map((card) => ({
            // Shortened exactly as the crumb it would become, so picking `#2` out of this list puts
            // `#2` on the bar rather than something that has to be recognised as the same run.
            label: shortRunName(taskNameOf(card), stateId),
            note: card.activeStateId ?? card.status,
            checked: card.taskId === selectedTask,
            onSelect: () => input.onSelectTask(card.taskId),
          }))
        : [...(parent?.children ?? [])]
            .filter((child) => !child.superseded)
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((child) => {
              const sibling = stepOf(child);
              return {
                label: sibling.name ?? `#${shortId(child.instanceId)}`,
                note: child.status.replace(/_/g, " "),
                checked: child.instanceId === step.instanceId,
                onSelect: () => input.onWalkTo(i, child),
              };
            }),
    );
    return {
      text: runCrumbOf(step, i, taskTitle, stateId),
      kind: "run" as const,
      ...(i === 0 && taskTitle !== undefined && input.taskTitlePending === true ? { pending: true } : {}),
      title:
        i === 0 && taskTitle !== undefined
          ? `${taskTitle} — run #${shortId(step.instanceId)} of ${step.stateId}`
          : `run #${shortId(step.instanceId)} of ${step.stateId}`,
      ...(last ? {} : { go: () => input.onWalkBack(i) }),
      ...(options !== undefined ? { options } : {}),
    };
  });
}

/**
 * "All projects" — the one APP crumb in an otherwise data-voiced address bar (SHELL.md §3.2).
 *
 * It names a LEVEL rather than a directory, so it is a word JaiRA chose and takes the sans; every
 * other project crumb prints a basename and takes the mono. Told apart by the absence of a hue,
 * which is the same fact from the other side: there is no project for a colour to be of.
 */
function allCrumb(crumb: Crumb): string {
  return crumb.kind === "project" && crumb.hue === undefined ? " crumb-all" : "";
}

/**
 * The bar itself: the crumbs, then whatever the view wants at the right-hand end.
 *
 * Clicking the bar's own background is the caller's to define — in Files it puts the inspector back
 * on the open file — which is why every crumb and every tool stops the click from propagating.
 */
export function CrumbBar({
  crumbs,
  title,
  onClick,
  trailing,
  tools,
}: {
  crumbs: readonly Crumb[];
  title?: string;
  /** What clicking the bar's background means. Absent ⇒ nothing, and the bar is not a button. */
  onClick?: (() => void) | undefined;
  /** Read-only annotations after the path: a label, an error count. Not controls. */
  trailing?: ReactNode;
  /** Controls: a mode toggle, a New button. Clicks here never reach {@link onClick}. */
  tools?: ReactNode;
}): JSX.Element {
  // Which chevron is open, so the same click closes it and the glyph can turn to face down.
  const [menu, setMenu] = useState<(MenuAnchor & { at: number }) | null>(null);
  return (
    <header
      className={`doc-bar${onClick === undefined ? " inert" : ""}`}
      {...(onClick !== undefined ? { onClick } : {})}
      {...(title !== undefined ? { title } : {})}
    >
      {crumbs.map((crumb, i) => (
        <span
          key={`${i}:${crumb.kind}:${crumb.text}`}
          className="crumb-part"
          {...(crumb.hue !== undefined ? { style: { "--hue": crumb.hue } as CSSProperties } : {})}
        >
          {/* The separator is the join between two levels, so it is where "what ELSE is at this
              level" belongs — Explorer's move, and the reason it turns to face down when open. A
              level with no alternatives keeps a plain glyph rather than an empty menu. */}
          {crumb.options === undefined ? (
            // The root has nothing to its left, so its chevron would be a separator between the bar
            // and the window. It keeps the menu and loses the glyph.
            i === 0 ? null : <span className="crumb-sep">›</span>
          ) : (
            <button
              className={`crumb-sep${menu?.at === i ? " open" : ""}${i === 0 ? " first" : ""}`}
              title="what else is at this level"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                const box = e.currentTarget.getBoundingClientRect();
                setMenu(menu?.at === i ? null : { at: i, x: box.left, y: box.bottom + 2, items: crumb.options! });
              }}
            >
              {menu?.at === i ? "⌄" : "›"}
            </button>
          )}
          {crumb.go === undefined ? (
            <span
              className={`crumb crumb-${crumb.kind}${allCrumb(crumb)}${crumb.pending === true ? " crumb-pending" : ""} ${i === crumbs.length - 1 ? "last" : "inert"}`}
              title={crumb.title}
            >
              {crumb.text}
            </span>
          ) : (
            <button
              className={`crumb crumb-${crumb.kind}${allCrumb(crumb)}${crumb.pending === true ? " crumb-pending" : ""}`}
              title={crumb.title ?? (crumb.kind === "run" ? "back to this run" : "open this state")}
              onClick={(e) => {
                e.stopPropagation();
                crumb.go?.();
              }}
            >
              {crumb.text}
            </button>
          )}
        </span>
      ))}
      <span className="grow" />
      {trailing}
      {/* Controls, not navigation: the bar's own click means "describe this file", and a toggle that
          also did that would be a toggle you cannot press without a side effect. */}
      {tools !== undefined ? (
        <span className="doc-bar-tools" onClick={(e) => e.stopPropagation()}>
          {tools}
        </span>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </header>
  );
}

export type { MenuItem };
