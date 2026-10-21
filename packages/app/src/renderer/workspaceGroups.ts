/**
 * One project, however many clones it has (decision 0013 §4): the workspaces the engine lists —
 * this machine's clones and the paired machines' — grouped by the repository they are clones of, with
 * the chip that says where each card runs and the board a group shows, merged from its workspaces'.
 *
 * Pure, so the grouping is testable without drawing the sidebar.
 */
import { projectNameOf, type BoardCard, type BoardColumn, type BoardView, type ProjectSummary } from "@jaira/shared/browser";

export interface ProjectGroup {
  /** The key the group is addressed by: its primary workspace's — this machine's first clone, if any. */
  key: string;
  label: string;
  /** Beside the name: how many machines and workspaces, or which machine a lone remote one is on. */
  where?: string;
  identity?: string;
  kind: ProjectSummary["kind"];
  members: ProjectSummary[];
}

const tail = (dir: string): string => projectNameOf(dir);

/** This machine's workspace: marked so, or listed by an engine that does not say (one of this machine's). */
const isSelf = (p: ProjectSummary): boolean => p.machine === undefined || p.machine.self === true;

/** The directory a workspace key stands for: the key itself here, the decoded directory on another machine. */
export function dirOf(project: string): string {
  const match = /^jaira-machine:\/\/[^/]+\/(.+)$/.exec(project);
  return match === null ? project : decodeURIComponent(match[1]!);
}

export function groupProjects(projects: readonly ProjectSummary[], grouped: boolean): ProjectGroup[] {
  const buckets = new Map<string, ProjectSummary[]>();
  for (const p of projects) {
    const bucket = grouped && p.identity !== undefined ? `id:${p.identity}` : `p:${p.project}`;
    const list = buckets.get(bucket);
    if (list === undefined) buckets.set(bucket, [p]);
    else list.push(p);
  }
  const groups: ProjectGroup[] = [];
  for (const members of buckets.values()) {
    // This machine's clones first, then the others, each in the order the engine listed them.
    const ordered = [...members.filter(isSelf), ...members.filter((m) => !isSelf(m))];
    const primary = ordered[0]!;
    const machines = new Set(ordered.map((m) => m.machine?.id ?? "self"));
    const remote = !isSelf(primary);
    const where =
      ordered.length > 1
        ? `${machines.size} machine${machines.size === 1 ? "" : "s"} · ${ordered.length} workspaces`
        : remote
          ? `${primary.machine!.label}${primary.machine!.state === "online" ? "" : ` · ${primary.machine!.state}`}`
          : undefined;
    groups.push({
      key: primary.project,
      label: ordered.length > 1 && primary.identity !== undefined ? projectNameOf(primary.identity) : remote ? tail(dirOf(primary.project)) : primary.label,
      ...(where !== undefined ? { where } : {}),
      ...(primary.identity !== undefined ? { identity: primary.identity } : {}),
      kind: primary.kind,
      members: ordered,
    });
  }
  return groups;
}

/** The group a workspace belongs to. */
export function groupOf(groups: readonly ProjectGroup[], project: string | null): ProjectGroup | undefined {
  if (project === null) return undefined;
  return groups.find((g) => g.members.some((m) => m.project === project));
}

/**
 * Where a card runs, for a group of more than one workspace: the machine's name, and the folder too
 * when that machine has more than one clone in the group. Nothing for a group of one — there is no
 * question to answer.
 */
export function chipFor(member: ProjectSummary, group: ProjectGroup): BoardCard["where"] {
  if (group.members.length <= 1) return undefined;
  const machine = member.machine;
  const machineId = machine?.id ?? "self";
  const onSame = group.members.filter((m) => (m.machine?.id ?? "self") === machineId).length;
  const label = `${machine?.label ?? "this machine"}${onSame > 1 ? ` / ${tail(dirOf(member.project))}` : ""}`;
  const state = isSelf(member) || machine?.state === "online" ? "on" : machine?.state === "mismatch" ? "warn" : "off";
  return {
    label,
    state,
    title: `${state === "off" ? `${machine?.label} is offline · ` : ""}runs on ${machine?.label ?? "this machine"}, in ${dirOf(member.project)}`,
  };
}

/**
 * One board from a group's boards: columns by key in the order they first appear, every card stamped
 * with its workspace and chip. The level and trail are the primary's — clones share their workflows.
 */
export function mergeBoards(group: ProjectGroup, boards: Readonly<Record<string, BoardView | null | undefined>>): BoardView | null {
  const present = group.members.flatMap((member) => {
    const board = boards[member.project];
    return board === null || board === undefined ? [] : [{ member, board }];
  });
  if (present.length === 0) return null;
  if (group.members.length === 1) return present[0]!.board;
  const stamp = (member: ProjectSummary, cards: readonly BoardCard[]): BoardCard[] => {
    const where = chipFor(member, group);
    return cards.map((card) => ({ ...card, project: member.project, ...(where !== undefined ? { where } : {}) }));
  };
  const base = present[0]!.board;
  const columns: BoardColumn[] = [];
  const byKey = new Map<string, BoardColumn>();
  for (const { member, board } of present) {
    for (const column of board.columns) {
      let merged = byKey.get(column.key);
      if (merged === undefined) {
        merged = { ...column, cards: [] };
        byKey.set(column.key, merged);
        columns.push(merged);
      }
      merged.cards.push(...stamp(member, column.cards));
    }
  }
  for (const column of columns) column.cards.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    ...base,
    columns,
    atLevel: present.flatMap(({ member, board }) => stamp(member, board.atLevel)),
    finished: present.flatMap(({ member, board }) => stamp(member, board.finished)).sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt)),
  };
}

/**
 * Which tasks are waiting on the person, and for what — from the inbox: a gate (not a move's question),
 * an agent's approval, an agent's question, live or found in the record after the app closed. A
 * question outranks an approval, which outranks a gate: the one an agent is blocked on is the one named.
 */
export function askingTasksOf(
  pending: ReadonlyArray<{ taskId?: string; about?: string; moves?: boolean }>,
  approvals: ReadonlyArray<{ taskId?: string }>,
  questions: ReadonlyArray<{ taskId?: string }>,
): Map<string, NonNullable<BoardCard["asking"]>> {
  const asking = new Map<string, NonNullable<BoardCard["asking"]>>();
  // A gate is the parked run's (`taskId`) and the task it is about (`about`) alike, as `parkedGateOf` reads it.
  for (const gate of pending) {
    if (gate.moves === true) continue;
    for (const taskId of [gate.taskId, gate.about]) if (taskId !== undefined) asking.set(taskId, "gate");
  }
  for (const approval of approvals) if (approval.taskId !== undefined) asking.set(approval.taskId, "approval");
  for (const question of questions) if (question.taskId !== undefined) asking.set(question.taskId, "question");
  return asking;
}

/** Cards whose task is waiting on the person, marked so — see `BoardCard.asking`. */
export function markAsking(board: BoardView | null, asking: ReadonlyMap<string, NonNullable<BoardCard["asking"]>>): BoardView | null {
  if (board === null || asking.size === 0) return board;
  const mark = (card: BoardCard): BoardCard => {
    const kind = asking.get(card.taskId);
    return kind === undefined || card.archived !== undefined ? card : { ...card, asking: kind };
  };
  return {
    ...board,
    columns: board.columns.map((c) => ({ ...c, cards: c.cards.map(mark) })),
    atLevel: board.atLevel.map(mark),
    finished: board.finished.map(mark),
  };
}

/** Cards waiting for a workspace, chipped so (decision 0013 §5): the dashed "no machine yet". */
export function markQueued(board: BoardView | null, queue: ReadonlyArray<{ taskId: string; requires: string[] }>): BoardView | null {
  if (board === null || queue.length === 0) return board;
  const waiting = new Map(queue.map((q) => [q.taskId, q] as const));
  const mark = (card: BoardCard): BoardCard => {
    const q = waiting.get(card.taskId);
    if (q === undefined) return card;
    const needs = q.requires.length > 0 ? `needs ${q.requires.join(", ")} · ` : "";
    return { ...card, where: { label: "no machine yet", state: "none", title: `${needs}waits for a workspace with room` } };
  };
  return {
    ...board,
    columns: board.columns.map((c) => ({ ...c, cards: c.cards.map(mark) })),
    atLevel: board.atLevel.map(mark),
    finished: board.finished.map(mark),
  };
}
