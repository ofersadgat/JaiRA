/**
 * Task model (DESIGN §4.1, §12): the human-readable half of the hybrid store.
 * A TaskMeta is what lives in `.jaira/tasks/<taskId>.json`; runtime status and
 * history live in SQLite (@jaira/persistence) and reference tasks by id only.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { InputProvenance } from "./adopt";
import type { StoredConnectUndo } from "./connect";

export type TaskStatus =
  | "queued"
  | "running"
  /**
   * A stop has been ASKED FOR and the run has not settled yet.
   *
   * The interval between the decision and the end of the stream is a real state, and it used to be
   * invisible: a task jumped to `canceled` the instant somebody pressed stop, while output was
   * visibly still arriving — the panel said the run had ended and the transcript kept growing.
   *
   * It is not terminal (nothing has settled) and not startable (something still is), which is why it
   * is neither set below. What ends it is the run settling, at which point it becomes `canceled`.
   */
  | "stopping"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  /**
   * Put away by a person, or by the rule that tidies finished work (`tasks.autoArchive`): kept, with
   * its history, and left off the board (the person, 2026-09-27: "the state should be archived"). Only
   * a FINISHED task is archived, and the row remembers which finish (`archived_from`), so a card can
   * say what it was and Unarchive puts it back exactly.
   */
  | "archived";

export interface TaskMeta {
  id: string;
  title: string;
  description?: string;
  labels?: string[];
  /** Root state ID of the workflow this task runs, relative to `.jaira/workflows/`. */
  workflow: string;
  /** Root workflow inputs, fixed at task creation (e.g. the issue text). JSON by
   *  construction — the task file is JSON, and these are bound as the run's
   *  operation inputs. */
  inputs?: Record<string, JsonValue>;
  /**
   * How each of {@link inputs} was settled (decision 0005 §4): `bound` by wiring, `inferred` by a
   * conversation, `asked` of a person. Recorded when the value is, per input name. An entry whose
   * `from` names a task and whose input is still ABSENT is a value that task has yet to produce —
   * the task holds for it (`dependsOn`) and the value is read when it starts.
   */
  inputProvenance?: Record<string, InputProvenance>;
  /** Branch binding (DESIGN §9.2) — recorded now, acted on in phase 5. */
  branch?: string;
  parentTaskId?: string;
  /**
   * How this task came to be, when a fan-out made it (decision 0003).
   *
   * A `split` copy carries its parent's history up to the mount and stands at it; a `task` is fresh,
   * rooted at the mounted state. Either way the task exists because an element of a list did, and
   * this is what lets a list file it under — or beside — the task that had the list.
   */
  origin?: TaskProvenance;
  /**
   * The lists this task is SPLIT ON, one entry per `each: "split"` it was made from.
   *
   * Inside this task, a wire whose `each: "split"` names one of these expressions resolves to the
   * element at its index rather than the whole list — which is what keeps a feature's task from
   * fanning out over its siblings' features when its journal is loaded.
   */
  split?: SplitEntry[];
  /**
   * Tasks that must complete before this one may start — the `requires` of the element that made
   * it, mapped through its batch. A task with an unfinished dependency is HOLDING: not a status,
   * a fact derived wherever the row is read, so a dependency finishing releases it without a write.
   */
  dependsOn?: string[];
  /**
   * How to take back the connect that last made or moved this task — the card's **Undo**, kept here
   * so it survives a restart. It means only "take back what I just did": the next decision about the
   * task drops it (another connect replaces it), and it is judged against the journal whenever it is
   * read — once the task has done work of its own past where the drop landed, it is neither offered
   * nor used (`@jaira/persistence` `connectUndo.ts`).
   */
  connectUndo?: StoredConnectUndo;
  /**
   * What STARTED this task ON ITS OWN, when the events task did (decision 0010 §4, the rulings of
   * 2026-09-25): a `start_task` asked with `top_level: true`. A task the events task starts as its
   * CHILD (the default) says so in {@link origin} instead — `kind: "started"` — and is never both.
   */
  startedBy?: TaskStartedBy;
  /**
   * A task JaiRA keeps for itself rather than one a person made: `events` is a project's events task
   * (decision 0010 §4), found by this marker and its workflow, and supervised — never started by hand.
   */
  system?: "events";
  createdAt: string; // ISO 8601
}

/** Where a task the events task started ON ITS OWN came from — see {@link TaskMeta.startedBy}. */
export interface TaskStartedBy {
  by: "events";
  /** The events task that started it. */
  fromTask: string;
  /**
   * The STATE of that task that called `start_task` — the automation — and which firing of it. Absent
   * on a task started before the state was recorded (it cannot be recovered, so it is left out).
   */
  state?: StartingState;
  /** The event's name (`git.pushed`), or empty when the step was handed none. */
  event: string;
  /** What happened, in a line: "git.pushed a1b2c3d on main" — see `eventSummary`. */
  summary: string;
}

/** The state that called `start_task`, as its task's journal records it. */
export interface StartingState {
  /** Its child key under the events root — the automation's name. */
  key: string;
  /** Its path from the root (`push_main`), the conversation's spelling. */
  path: string;
  /** Its state id (`system/events/push_main`) — what opening the task AT it names. */
  stateId: string;
  /** Which entry of that key — the n-th firing of the automation, from 0. */
  occurrence: number;
  /** Which call of its operation list made the start. */
  call: number;
}

/** What a started task keeps of the event that started it — the card's line. */
export interface StartingEvent {
  /** `git.pushed`. */
  name: string;
  /** "git.pushed a1b2c3d on main" — `eventSummary`. */
  summary: string;
}

/** One list a task is split on — see {@link TaskMeta.split}. */
export interface SplitEntry {
  /** The wire's expression, verbatim — the key the engine matches a later wire against. */
  expr: string;
  /** This task's element in that list. */
  index: number;
}

/** Where a fan-out-made task came from — see {@link TaskMeta.origin}. */
export interface TaskProvenance {
  /**
   * `split`: a copy of the parent, standing at the mount. `task`: a fresh task rooted at the mounted
   * state. `adopt`: a task that ran ALONE and was taken up afterwards (decision 0005 §2) — `taskId`
   * is the parent that adopted it and `key` the child it stands for there. It keeps its own journal,
   * sessions and workspace; only where it files changes. `started`: a task the EVENTS task started
   * as its child (decision 0010 §4, the rulings of 2026-09-25) — `taskId` is the events task, `key`
   * the automation (the calling state's key), `occurrence` which firing of it, `index` which call of
   * its operation list. A fresh task in its own workspace, filed under the events task as a
   * `task` child is, and mirrored into its journal the same way.
   */
  kind: "split" | "task" | "adopt" | "started";
  /** The task whose list made this one. */
  taskId: string;
  /** The mount key the list was on, in that task. */
  key: string;
  /** Which entry of that mount — a loop around the mount makes a new batch each pass. Default 0. */
  occurrence?: number;
  /** The element's position in the list. */
  index: number;
  /** For `started`: the event it was started because of — the card's "started by events · …" line. */
  event?: StartingEvent;
  /** For `started`: the calling state's id and path, so opening the events task lands at it. */
  state?: { stateId: string; path: string };
  /** The element's own identity, when the wire named an id field. */
  item?: string;
  /**
   * For a split: who starts this task once its dependencies are done — the host (`"when_ready"`, at
   * once when it depends on nothing) or a person (`"manual"`). Absent reads as `"when_ready"`, the
   * wire's default.
   */
  start?: "manual" | "when_ready";
  /** For an adoption: the `parentTaskId` the task had before — a re-run's predecessor — put back if it is un-adopted. */
  formerParentTaskId?: string;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "canceled", "archived"]);

/** What can be archived: a task that finished, whichever way. */
const ARCHIVABLE: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "canceled"]);

export function isArchivableStatus(status: TaskStatus): boolean {
  return ARCHIVABLE.has(status);
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Statuses from which a (re-)run may begin.
 *
 * `canceled` is in the set, and that is the whole of what makes a stopped run resumable. A stop is
 * an INTERRUPTION — the difference between it and a crash is who caused it, which is not a fact about
 * whether there is anything left to pick up. Excluding it meant `resumable()` returned "no plan"
 * before it had looked, so a task whose record held eleven finished operations was offered a fresh
 * copy of itself.
 *
 * Pause and cancel differ in what they RELEASE — a paused run keeps its process and its worktree, a
 * canceled one gives them up — and not in whether they can be continued. Neither is the end of a
 * task's life; deleting is.
 */
export function isStartableStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "interrupted" || status === "failed" || status === "canceled";
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newTaskId(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 10; i++) {
    suffix += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return `t-${suffix}`;
}

export function isTaskId(value: string): boolean {
  return /^t-[a-z0-9]{10}$/.test(value);
}

export function parseTaskMeta(raw: unknown, expectedId?: string): TaskMeta {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("task metadata must be a JSON object");
  }
  const meta = raw as Partial<TaskMeta>;
  if (typeof meta.id !== "string" || meta.id.length === 0) throw new Error("task metadata missing 'id'");
  if (expectedId !== undefined && meta.id !== expectedId) {
    throw new Error(`task metadata id '${meta.id}' does not match file name '${expectedId}'`);
  }
  if (typeof meta.title !== "string" || meta.title.length === 0) throw new Error("task metadata missing 'title'");
  if (typeof meta.workflow !== "string" || meta.workflow.length === 0) {
    throw new Error("task metadata missing 'workflow' (root state id)");
  }
  if (typeof meta.createdAt !== "string") throw new Error("task metadata missing 'createdAt'");
  return meta as TaskMeta;
}

/**
 * What the Chat view STARTS (decisions 0005 §3, 0006): a person began a conversation, and it may work
 * in the project, start a workflow, or only talk — the project's tools and the workflow tools, under
 * `chat/ask-first`.
 */
export const CHAT_SESSION = "chat/session";
/**
 * What a task gets when a person MOVES it and the move makes a dynamic workflow: the conversation
 * that steers that work, holding the task and workflow tools and nothing of the project. Never
 * started from the Chat view, and never what a session turns into.
 */
export const CHAT_CONTROL = "chat/control";
/** Where a dynamic workflow's root state is minted (`persistence/documents.ts`): a conversation with children. */
export const DYNAMIC_WORKFLOW_PREFIX = "dynamic/";

/** Every state a Chat-view conversation can be. Both ship in the built-in layer. */
export const CHAT_STATES = [CHAT_SESSION, CHAT_CONTROL] as const;

/** Which conversation a task is: the workflow it was created from, or `null` for a task that is not one. */
export type ChatKind = (typeof CHAT_STATES)[number];

/**
 * True for a task the Chat view owns — its workflow is one of {@link CHAT_STATES}, or a dynamic
 * workflow, which IS a conversation: a row in the Chat list and not a column of its own.
 */
export function isChatWorkflow(workflow: string | undefined): boolean {
  return workflow !== undefined && ((CHAT_STATES as readonly string[]).includes(workflow) || workflow.startsWith(DYNAMIC_WORKFLOW_PREFIX));
}
