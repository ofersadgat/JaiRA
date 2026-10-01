/**
 * The shell's derivations that are not drawing: which rows the sidebar has and what each one counts.
 *
 * Pulled out of `App.tsx` (decision 0015) so the desktop's shell and the universal one derive them once
 * — a project row on the phone and the same row on the desktop can never disagree about how much is
 * waiting. Nothing here renders; the drawers the rows open onto stay each shell's own.
 */
import type { ProjectSummary, ProjectTask } from "@jaira/shared/browser";
import { addCounts, minusCounts, projectCounts, sumCounts, taskCounts, unseenRows, unseenTasks, type PillCounts } from "./pillModel";
import { projectName } from "./projects";
import type { SidebarProject, SidebarView } from "./sidebarTypes";
import type { View } from "./store";
import { groupOf, type ProjectGroup } from "./workspaceGroups";

/**
 * The rooms INSIDE a project — nested under whichever one the address is standing on (SHELL.md
 * §5.1). Each is a view of that project's work, so none of them means anything at the root.
 */
export const VIEWS: readonly SidebarView[] = [
  { id: "files", glyph: "❏", label: "Files" },
  { id: "tasks", glyph: "▶", label: "Tasks" },
  // The third activity, and the newest: TALKING. Files designs, Tasks operates, and this is the one
  // you open when what you want is a conversation rather than a workflow — see `chatPane.tsx`.
  { id: "chat", glyph: "✎", label: "Chat" },
];

/**
 * The rooms that belong to NO project, and therefore sit in the footer beside Settings.
 *
 * Debug is here rather than inside Settings for the same reason it always was: the self-test is what
 * you reach for when the app is not behaving, and burying it behind a configuration screen would
 * make it hardest to find in exactly the situation it exists for.
 */
export const FOOTER_VIEWS: readonly SidebarView[] = [
  { id: "logs", glyph: "≡", label: "Logs" },
  { id: "debug", glyph: "⌁", label: "Debug" },
  // The gallery was the foot of Debug once. It is about authoring rather than diagnosis — what a
  // gate looks like before a run has to reach it — and a page you scroll to the bottom of a
  // self-test for is a page nobody opens on purpose.
  { id: "gallery", glyph: "▤", label: "Components" },
];

/**
 * The views that live INSIDE the settings panel — see `App.tsx`'s `beforeSettings` and the sidebar's
 * own rule. Leaving Settings returns to the last view that is not one of these.
 */
export const PANEL_VIEWS: ReadonlySet<string> = new Set<string>(["settings", ...FOOTER_VIEWS.map((v) => v.id)]);

/**
 * The rooms at the ROOT of the address — every project's work at once.
 *
 * The same two view ids the projects nest, because they are the same rooms seen from one level up:
 * Tasks at the root is the board sectioned by project, and Chat at the root is every conversation in
 * recency order. Named for the level rather than the room, because "Tasks" appearing twice in one
 * column with no way to tell which is which is the thing that would make this unreadable.
 *
 * No Files. The tree's top level is ALREADY every project with `~/.jaira` beside them (§2.2), so a
 * root Files row would open the same tree a project row opens — two ways to one view.
 */
export const ROOT_VIEWS: readonly SidebarView[] = [
  { id: "tasks", glyph: "▦", label: "All tasks" },
  { id: "chat", glyph: "✻", label: "All conversations" },
];

/** Every nav row, for the lookups that do not care which group a view is in. */
const ALL_VIEWS: readonly SidebarView[] = [...VIEWS, ...FOOTER_VIEWS];

/**
 * The window's name, for the taskbar and the window switcher.
 *
 * `document.title` only — with no frame there is nothing else to set, and nothing on screen shows
 * it. The strip along the top of the body used to, and the caption was removed: it named the
 * project, which the sidebar names, and then the open path, which the address bar in that very
 * strip states properly. Outside the window the pair is still what identifies this one, because
 * "JaiRA" alone is what every window of this app would say.
 */
export function windowTitle(project: string | null, view: View | "settings", doc: string | null): string {
  const where = project === null ? "no project" : projectName(project);
  const what = view === "files" && doc !== null ? doc : (ALL_VIEWS.find((v) => v.id === view)?.label ?? "Settings");
  return `${where} · ${what}`;
}

/**
 * The projects, as the sidebar draws them.
 *
 * The counts are the same ones the address bar carries — one derivation, so a project row and the
 * crumb over its board can never disagree about how much is waiting.
 */
export function sidebarProjectsOf(
  groups: readonly ProjectGroup[],
  projectHues: Readonly<Record<string, string>>,
  seen: Readonly<Record<string, number>>,
  markProjectSeen: (project: string) => void,
): SidebarProject[] {
  return groups.map((g) => ({
    project: g.key,
    label: g.label,
    kind: g.kind,
    ...(g.where !== undefined ? { where: g.where } : {}),
    // Looked up rather than recomputed from THIS list's index: the sidebar hides one project and the
    // strip and the crumb bar hide none, and a hue derived from each list's own position would give
    // one project two colours the moment those lists differ.
    hue: projectHues[g.key] ?? "var(--p0)",
    // A group's pills are its workspaces', together.
    counts: sumCounts(g.members.map((m) => projectCounts(m, seen))),
    onSeen: () => {
      for (const m of g.members) markProjectSeen(m.project);
    },
  }));
}

/** What the room rows count, at the root and in the project the address stands in, and what clears each. */
export interface RoomCounts {
  rootTasks: PillCounts;
  rootChat: PillCounts;
  atTasks: PillCounts;
  atChat: PillCounts;
  /** The rows each row's "mark these seen" marks. */
  seenRootTasks: { taskId: string; at: number }[];
  seenRootChat: { taskId: string; at: number }[];
  seenAtTasks: { taskId: string; at: number }[];
  seenAtChat: { taskId: string; at: number }[];
}

export function roomCountsOf(
  projects: readonly ProjectSummary[],
  allConversations: readonly ProjectTask[],
  groups: readonly ProjectGroup[],
  at: string | null,
  seen: Readonly<Record<string, number>>,
): RoomCounts {
  /**
   * The conversations of the projects the sidebar lists, and of the OPEN one.
   *
   * `allConversations` is fetched for every open project whatever view is showing, so it is the one
   * list that can answer "which of these ended rows is a conversation" — a project summary cannot:
   * its `ended` rows carry a status and a clock and no workflow. That question is what makes a view
   * row's pills honest, and answering it wrong is what put a `✓` on **All conversations** for a
   * task that was never a conversation.
   */
  const chatsOf = (project: string): ProjectTask[] => allConversations.filter((t) => t.project === project);
  /** The stopped rows of a project that are NOT conversations — what the Tasks rows count. */
  const runsOf = (p: ProjectSummary): { taskId: string; at: number }[] => {
    const chats = new Set(chatsOf(p.project).map((t) => t.taskId));
    return unseenTasks(p, seen).filter(({ taskId }) => !chats.has(taskId));
  };
  /**
   * The root rows: every project's work at once, split by which ROOM it is in.
   *
   * Summed rather than per-project, which is what makes them a level: "all tasks" is one place, and
   * the number beside it is how much is in it. Clicking the pills marks that row's share seen.
   *
   * Split, because the two rows are two rooms and the counts have to say which. Given the same
   * total, **All conversations** carried a `✓` for a run that finished in a workflow — a mark
   * pointing at a place that did not contain the thing it was pointing at, and no row below it
   * repeating the mark, so there was nothing to follow it to. Chat counts conversations; Tasks
   * counts what is left.
   */
  const chatCounts = taskCounts(allConversations, seen);
  /** The project the address is standing on, as the summary its rows count from. */
  const atSummary = at === null ? null : (projects.find((p) => p.project === at) ?? null);
  /** Every workspace of the group the address stands in — a grouped project's rows count them all (decision 0013 §4). */
  const atMembers = groupOf(groups, at)?.members ?? (atSummary === null ? [] : [atSummary]);
  const atChats = atMembers.flatMap((m) => chatsOf(m.project));
  /** Every project's work, before it is split between the two rooms. */
  const allCounts = projects.reduce<PillCounts>((sum, p) => addCounts(sum, projectCounts(p, seen)), {});
  return {
    rootTasks: minusCounts(allCounts, chatCounts),
    rootChat: chatCounts,
    // This project's work, less what is in the room next door.
    atTasks: minusCounts(sumCounts(atMembers.map((m) => projectCounts(m, seen))), taskCounts(atChats, seen)),
    atChat: taskCounts(atChats, seen),
    seenRootTasks: projects.flatMap(runsOf),
    seenRootChat: unseenRows(allConversations, seen),
    seenAtTasks: atMembers.flatMap(runsOf),
    seenAtChat: unseenRows(atChats, seen),
  };
}
