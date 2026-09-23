/**
 * A connect's **Undo** — kept on the card's task file, and judged against the journal whenever it is
 * read (decision 0005 step 5; made durable, then made to mean only "take back what I just did",
 * both 2026-09-22).
 *
 * Undoing a move rewinds the task's journal to the moment of the drop, and undoing an adoption cuts
 * the parent's back past the mirror row. Pressed after the task has done work of its own, either
 * would throw that work away. So the token stands only while everything the task has done since the
 * drop is the drop's own effect, and two things end it:
 *
 *  - **The next decision about the task.** Another connect replaces it (the host keeps the new one),
 *    and a rewind, a fork or split, an adoption, a stop and a re-run drop it where each is made —
 *    {@link dropConnectUndo}, called from the primitive every host shares (`cut.ts`, `adopt.ts`,
 *    `lifecycle.ts`, `connect.ts`) and from the app's stop and re-run. These leave nothing in the
 *    task's own journal that a reader could judge afterwards, which is why they are dropped at the act.
 *  - **The task's own progress past where the drop landed.** Judged on read, by ONE rule
 *    ({@link staleReason}) that the board's `undoable` and the host's `undoConnect` both go through,
 *    so a window still holding a token in memory cannot use a stale one. A later move is caught here
 *    too, by what it writes.
 *
 * "Past the landing", per kind:
 *
 *  - **A move** — the state it was moved to has settled (any outcome but `canceled`, which is a run
 *    being unwound by a close, a crash or a Stop), or anything outside it has been entered, or a
 *    state of the task's own finished after the drop (a held move's source state, which the move
 *    waited for), or a turn of the task's conversation was taken. The way down to a nested target,
 *    the landing's own children, and states stepped past are the drop's.
 *  - **An adoption** — the same rule on the PARENT's journal from the mirror row on (its landing is
 *    where the plan said it stands), plus the adopted task itself: any state it enters or settles
 *    after the drop is work of its own.
 *  - **An `asking` drop** — the conversation's turns are the drop's; the moment its `start_task`
 *    mounts the target (a `jaira.supplied` or `jaira.moved` row, or any non-conversation entry), the
 *    Undo is over, and taking the drop back is a rewind.
 *  - **A fast-forward the drop started** — everything while it runs is the drop's; when it ARRIVES
 *    the landing is the target, judged as a move's. A Skip or Stop that ends it is a decision; a
 *    failure on the way is not work of the task's own, and leaves the Undo offered.
 *
 * Every place in a journal this reads is a ROW, found by the token's `mark`: the connect's own
 * `jaira.connect` rows (`connect.ts`). Its `intent` row is where a move's Undo cuts and where judging
 * starts (for an adoption, the adopted task's place at the drop); its `done` row closes the drop's own
 * writes on the watched journal. Not a count of rows — a retry that deleted a row from before the drop
 * made that land too late — and not a seq, which a file-backed journal's replay re-mints.
 */
import { CHAT_INSTANCE_PREFIX } from "@jaira/runtime";
import {
  FAST_FORWARD_ENDED_EVENT,
  FAST_FORWARD_EVENT,
  MOVE_HELD_EVENT,
  MOVED_EVENT,
  REOPENED_EVENT,
  SUPPLIED_EVENT,
  type ConnectUndo,
  type FastForwardEndedEvent,
  type MovedEvent,
  type StoredConnectUndo,
  type TaskMeta,
} from "@jaira/shared";
import type { StoredEvent } from "./eventLog";
import { connectRowAt } from "./hostRows";
import type { Project } from "./project";

/** Where the drop landed, as the host knows it from the connect's plan. */
export interface ConnectLanding {
  /** `ConnectPlan.standsAt.path`. */
  landing: readonly string[];
  /** The drop opened a conversation that asks, and moved nothing. */
  asking?: boolean;
}

/** The journal a token is judged against: the moved task's, or the parent's for an adoption. */
function watchedTask(undo: ConnectUndo): string {
  return undo.kind === "adopt" ? undo.parentTaskId : undo.taskId;
}

/** The journal a token's `intent` row is on — the DRAGGED task's: the moved task, or the adopted one. */
function droppedTask(undo: ConnectUndo): string {
  return undo.kind === "adopt" ? undo.adoptedTaskId : undo.taskId;
}

/**
 * Keep a connect's Undo on the card it made or moved (replacing whatever that card kept), so it
 * survives a restart. Called once the connect has returned: its `done` row, on the watched journal,
 * already closes the drop's own writes (`connect.ts`).
 */
export function keepConnectUndo(project: Project, taskId: string, undo: ConnectUndo, at: ConnectLanding): void {
  const meta = project.tasks.tryRead(taskId);
  if (meta === undefined) return;
  const stored: StoredConnectUndo = {
    undo,
    landing: [...at.landing],
    ...(at.asking === true || (undo.kind === "move" && undo.asking === true) ? { asking: true as const } : {}),
  };
  project.tasks.write({ ...meta, connectUndo: stored });
}

/**
 * The token a task keeps, judged now: usable — with the seq a move's Undo cuts at, read off where its
 * `intent` row sits NOW — or stale and why.
 */
export type KeptConnectUndo = { undo: ConnectUndo; cutAt?: number } | { stale: string };

export function keptConnectUndo(project: Project, taskId: string): KeptConnectUndo | undefined {
  const kept = project.tasks.tryRead(taskId)?.connectUndo;
  if (kept === undefined) return undefined;
  const stale = staleReason(project, kept);
  if (stale !== undefined) return { stale };
  const undo = kept.undo;
  if (undo.kind !== "move") return { undo };
  const events = project.events.list(undo.taskId);
  const drop = events[connectRowAt(events, undo.mark, "intent")];
  return { undo, ...(drop !== undefined ? { cutAt: drop.seq } : {}) };
}

/** Whether the card carries **Undo** — the board's and the task list's reading of {@link keptConnectUndo}. */
export function connectUndoStands(project: Project, meta: TaskMeta | undefined): boolean {
  return meta?.connectUndo !== undefined && staleReason(project, meta.connectUndo) === undefined;
}

/** The next decision about the task was made (or the Undo was used): the card stops offering it. */
export function dropConnectUndo(project: Project, taskId: string): void {
  const meta = project.tasks.tryRead(taskId);
  if (meta?.connectUndo === undefined) return;
  const { connectUndo: _over, ...rest } = meta;
  project.tasks.write(rest);
}

/**
 * The journal is about to FORGET rows that may be what ended a token — a retry deletes the failure
 * it revives (`releaseRevivedFailures`). Judge first, and drop a stale token, so an Undo the landing's
 * failure had ended does not come back when the failure is taken out of the journal.
 */
export function settleConnectUndo(project: Project, taskId: string): void {
  const kept = project.tasks.tryRead(taskId)?.connectUndo;
  if (kept !== undefined && staleReason(project, kept) !== undefined) dropConnectUndo(project, taskId);
}

// --- the rule ---------------------------------------------------------------------------------------

const typeOf = (row: StoredEvent): string => (row.event as { type: string }).type;
const isChat = (instanceId: string | undefined): boolean => instanceId?.startsWith(CHAT_INSTANCE_PREFIX) === true;

/**
 * Why a kept token no longer means "take back what I just did" — or `undefined` while it does. The
 * ONE rule; see the module header for what it reads, per kind.
 */
export function staleReason(project: Project, kept: StoredConnectUndo): string | undefined {
  const { undo } = kept;
  const dropped = project.events.list(droppedTask(undo));
  const drop = connectRowAt(dropped, undo.mark, "intent");
  if (undo.kind === "adopt") {
    // The adopted task's `intent` row is its place at the drop; a rewind that took it took the drop too.
    if (drop < 0) return "the adopted task was rewound to before it was adopted";
    const own = dropped.slice(drop + 1);
    if (own.some((row) => typeOf(row) === "instance.entered" || typeOf(row) === "instance.terminated")) return "the adopted task has done work of its own since it was adopted";
    const events = project.events.list(undo.parentTaskId);
    const mirror = events.findIndex((row) => row.event.type === "instance.entered" && row.event.instanceId === undo.adoptedTaskId);
    if (mirror < 0) return "the task no longer holds the task it adopted";
    return pastLanding(events, mirror + 1, connectRowAt(events, undo.mark, "done"), kept);
  }
  if (drop < 0) return "the task was rewound to before the move";
  return pastLanding(dropped, drop + 1, connectRowAt(dropped, undo.mark, "done"), kept);
}

interface Entry {
  parent?: string;
  key?: string;
  mirror: boolean;
}

/**
 * Read the watched journal from `from` on: is everything there the drop's own? `keptAt` is where the
 * token's `kept` mark sits — the drop's own host rows are before it. -1 (no such row) reads every
 * host row as a later move's, which withdraws the Undo rather than offering a stale one.
 */
function pastLanding(events: readonly StoredEvent[], from: number, keptAt: number, kept: StoredConnectUndo): string | undefined {
  const entries = new Map<string, Entry>();
  let root: string | undefined;
  for (const row of events) {
    const e = row.event as { type: string; instanceId?: string; parentInstanceId?: string; childKey?: string; adopted?: boolean };
    if (e.type !== "instance.entered" || e.instanceId === undefined) continue;
    entries.set(e.instanceId, { ...(e.parentInstanceId !== undefined ? { parent: e.parentInstanceId } : {}), ...(e.childKey !== undefined ? { key: e.childKey } : {}), mirror: e.adopted === true });
    if (e.parentInstanceId === undefined && root === undefined && !isChat(e.instanceId)) root = e.instanceId;
  }
  const pathOf = (id: string): string[] => {
    const keys: string[] = [];
    for (let at = entries.get(id); at?.key !== undefined; at = at.parent !== undefined ? entries.get(at.parent) : undefined) keys.unshift(at.key);
    return keys;
  };
  const inside = (id: string, ancestor: string): boolean => {
    for (let at: string | undefined = id; at !== undefined; at = entries.get(at)?.parent) if (at === ancestor) return true;
    return false;
  };
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key, i) => key === b[i]);
  const prefix = (a: readonly string[], b: readonly string[]): boolean => a.length < b.length && a.every((key, i) => key === b[i]);

  const landing = kept.landing;
  const asking = kept.asking === true;
  // A drop that lands on the root itself (an adoption with nothing after its child) stands in it.
  let landed: string | undefined = landing.length === 0 ? root : undefined;
  let forwarding = false;
  for (let i = from; i < events.length; i += 1) {
    const row = events[i]!;
    const type = typeOf(row);
    const e = row.event as { type: string; instanceId?: string; outcome?: string };
    const later = i > keptAt;

    // Host rows: the drop's own were written before it was kept; the same kinds after are a later move.
    if (type === FAST_FORWARD_EVENT) {
      if (later) return "the task was moved again";
      forwarding = true;
      continue;
    }
    if (type === FAST_FORWARD_ENDED_EVENT) {
      forwarding = false;
      const end = (row.event as unknown as FastForwardEndedEvent).end;
      if (end === "skipped" || end === "stopped") return `its fast-forward was ${end}`;
      continue;
    }
    // What a conversation's `start_task` writes on its own task: what it supplied, then what it did.
    const started = (type === SUPPLIED_EVENT && later) || (type === MOVED_EVENT && (row.event as unknown as MovedEvent).tool === "start_task");
    if (started && asking) return "the conversation started the target";
    if (started || ((type === MOVE_HELD_EVENT || type === REOPENED_EVENT) && later)) return "the task was moved again";
    if (type.startsWith("jaira.")) continue;

    // Engine rows. A conversation's turns are the drop's only when the drop opened it to ask.
    if (isChat(e.instanceId)) {
      if (asking) continue;
      return "a turn of the task's conversation was taken since";
    }
    // While a fast-forward the drop started is on its way, the states between are its effect.
    if (forwarding) {
      if (type === "instance.entered" && landed === undefined && e.instanceId !== undefined && same(pathOf(e.instanceId), landing)) landed = e.instanceId;
      continue;
    }
    if (type === "instance.entered" && e.instanceId !== undefined) {
      const id = e.instanceId;
      if (entries.get(id)?.mirror === true) continue;
      if (asking) return "the conversation started the target";
      const path = pathOf(id);
      if (landed === undefined && same(path, landing)) {
        landed = id;
        continue;
      }
      if (landed !== undefined && inside(id, landed)) continue;
      if (landed === undefined && prefix(path, landing)) continue;
      return `'${path.join("/") || "the root"}' was entered after where the drop landed`;
    }
    if (type === "instance.terminated" && e.instanceId !== undefined) {
      const id = e.instanceId;
      // `canceled` is a run being UNWOUND — by a close, a crash, or a Stop (which ended the Undo where
      // it was made) — not the state settling: the resume that follows carries on in it.
      if (id === landed && e.outcome !== "canceled") return "the state the drop landed in has settled";
      if (id === landed) continue;
      if (landed !== undefined && inside(id, landed)) continue;
      if (entries.get(id)?.mirror === true) continue;
      // Stepped past, stopped or failed is the drop's run going; a state FINISHING is the task's work.
      if (e.outcome === "success") return `'${pathOf(id).join("/") || "the root"}' finished after the drop`;
      continue;
    }
  }
  return undefined;
}
