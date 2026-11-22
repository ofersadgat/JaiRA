/**
 * The project panel's Tasks tab as a list (the sidebar mockups, boards 39, 44, 47): the project's
 * tasks — not its conversations, which are the Chat tab's — in the workspaces its title narrows to,
 * arranged by the list's column head. What a row says of where a task stands is here too, so the list
 * and its tests agree on one word per status.
 *
 * Pure. The rows are the board's own cards (`BoardCard`), every one already marked with the workspace
 * it runs in and whether it waits on the person (`mergeBoards`, `markAsking`).
 */
import { isConversation, type BoardCard } from "@jaira/shared/browser";

/** What the column head groups by: nothing, how the task stands, the workflow it runs, or where. */
export const TASK_GROUPS = ["none", "status", "workflow", "workspace"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];
export const TASK_GROUP_LABELS: Record<TaskGroup, string> = { none: "Nothing", status: "Status", workflow: "Workflow", workspace: "Workspace" };
/** What it sorts by, and which way: State (most urgent first), Name, When. */
export const TASK_SORTS = ["when-desc", "when-asc", "name-asc", "name-desc", "state-asc", "state-desc"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
/**
 * Which moment the When column says, and sorts by: the task's last activity (its row's clock, which
 * anything that touches the task moves) or when it was made. Chosen like the Chat list's
 * (`chatListModel.CHAT_WHENS`), by a press and hold or a right-click on the column's head.
 */
export const TASK_WHENS = ["activity", "created"] as const;
export type TaskWhen = (typeof TASK_WHENS)[number];
export const TASK_WHEN_LABELS: Record<TaskWhen, string> = { activity: "Updated", created: "Created" };
export const TASK_WHEN_MODE = "tasks.list.when";

/** A card's moment by the chosen field; a card that does not say when it was made gives its last activity. */
export function cardWhenOf(card: Pick<BoardCard, "updatedAt" | "createdAt">, when: TaskWhen): number {
  return when === "created" ? (card.createdAt ?? card.updatedAt) : card.updatedAt;
}

export type TaskTone = "warn" | "accent" | "bad" | "dim" | "ok";

/** How a task stands, in a word, the colour it wears, and its place when sorted or grouped by it. */
export interface TaskStanding {
  word: string;
  tone: TaskTone;
  rank: number;
}

/** One status word per task. A task the person is holding up (a gate, an approval, a question) says so first. */
export function standingOf(card: Pick<BoardCard, "status" | "asking"> & { process?: BoardCard["process"] }): TaskStanding {
  if (card.asking !== undefined && card.status !== "archived") return { word: "Asks you", tone: "warn", rank: 0 };
  // A process waiting for input waits on whoever types into it (decision 0032, board 6).
  if (card.process?.state === "waiting") return { word: "Asks you", tone: "warn", rank: 0 };
  switch (card.status) {
    case "running":
    case "stopping":
      return { word: card.status === "stopping" ? "Stopping" : "Running", tone: "accent", rank: 1 };
    case "failed":
      return { word: "Failed", tone: "bad", rank: 2 };
    case "queued":
    case "interrupted":
      return { word: card.status === "queued" ? "Queued" : "Paused", tone: "dim", rank: 3 };
    case "completed":
      return { word: "Done", tone: "ok", rank: 4 };
    case "canceled":
      return { word: "Canceled", tone: "dim", rank: 5 };
    case "archived":
      return { word: "Archived", tone: "dim", rank: 6 };
  }
}

/** The project's tasks among a board's cards: every card once, conversations left to the Chat tab. */
export function tasksOf(cards: readonly BoardCard[]): BoardCard[] {
  const seen = new Set<string>();
  const out: BoardCard[] = [];
  for (const card of cards) {
    if (seen.has(card.taskId) || isConversation(card) || card.workflow.startsWith("chat/")) continue;
    seen.add(card.taskId);
    out.push(card);
  }
  return out;
}

export interface TaskSection {
  key: string;
  /** Empty when the list is not grouped: one section, drawn without a head. */
  label: string;
  /** A status group's colour (Asks you in amber, Failed in red); absent for the others. */
  tone?: TaskTone;
  rows: BoardCard[];
}

/**
 * The rows as the column head arranges them: sorted, then cut into groups — by status in the order of
 * {@link standingOf}, by workflow in name order, by workspace the project's own first. `placeOf` names a
 * card's workspace where it is not the project's first; `home` names that first one.
 */
export function arrangeTasks(
  cards: readonly BoardCard[],
  how: { group: TaskGroup; sort: TaskSort; when?: TaskWhen },
  facts: { placeOf: (card: BoardCard) => string | undefined; home: string },
): TaskSection[] {
  const [by, way] = how.sort.split("-") as ["when" | "name" | "state", "asc" | "desc"];
  const when = how.when ?? "activity";
  const sign = way === "asc" ? 1 : -1;
  const sorted = [...cards].sort((a, b) => {
    if (by === "name") return sign * a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    if (by === "state") return sign * (standingOf(a).rank - standingOf(b).rank) || cardWhenOf(b, when) - cardWhenOf(a, when);
    return sign * (cardWhenOf(a, when) - cardWhenOf(b, when));
  });
  if (how.group === "none") return [{ key: "all", label: "", rows: sorted }];
  const sections: TaskSection[] = [];
  for (const card of sorted) {
    const standing = standingOf(card);
    const key = how.group === "status" ? standing.word : how.group === "workflow" ? card.workflow : (facts.placeOf(card) ?? facts.home);
    let section = sections.find((s) => s.key === key);
    if (section === undefined) {
      section = { key, label: key, ...(how.group === "status" && (standing.tone === "warn" || standing.tone === "bad") ? { tone: standing.tone } : {}), rows: [] };
      sections.push(section);
    }
    section.rows.push(card);
  }
  const rank = (s: TaskSection): number =>
    how.group === "status" ? standingOf(s.rows[0]!).rank : how.group === "workspace" ? (s.key === facts.home ? 0 : 1) : 0;
  return sections.sort((a, b) => rank(a) - rank(b) || (how.group === "workflow" ? a.key.localeCompare(b.key) : 0));
}
