/**
 * A CUT in a task's journal — the one argument Rewind and Fork take.
 *
 * A task has one journal, and everything a person could rewind to or fork from is an event in it:
 * a chat turn is a transition on the chat instance, a state is its `instance.entered`, a rule
 * firing is a `transition.taken`, an answered gate is the settle of the operation that asked. So
 * both verbs are spelled the same way — a journal seq — and both views hand over the seq of the
 * row they drew.
 *
 * ## What a cut keeps
 *
 * Every instance entered BEFORE the point keeps everything it did, including a call that settled
 * after the point: the sibling that was already running when the cut landed finished its work, and
 * deleting the answer would be paying for it twice. Everything entered AT OR AFTER the point goes,
 * with its conversations. Of a kept instance, what goes is the machine's own motion past the point
 * — a transition taken, a child entered, a turn typed — and what stays is the settle of an
 * operation that had already started. That is {@link partitionAt}, and both verbs are defined over
 * it: {@link rewindTask} deletes the other half in place; {@link forkTask} copies the kept half
 * into a new task.
 *
 * ## Then the machine resumes, and nothing here knows how
 *
 * Neither verb re-enters a state itself. A rewind leaves the task `interrupted`, and the ordinary
 * resume (`buildTaskLoad` → `loadRun`) reads the truncated journal exactly as it reads a crash: a
 * parent whose child was cut is a parent with a finished child it never answered, so it advances
 * again; a state whose settle was cut is a live instance with no answer, so it dispatches again — a
 * gate asks again. The fork is the same load over the copy.
 *
 * ## Fork copies; rewind deletes
 *
 * A copy makes a fork self-contained: deleting or pruning either task never reaches the other,
 * which sharing rows by lineage (what an EDIT does inside one conversation) would need a re-owning
 * rule to promise. The copy re-mints every instance id and re-scopes every record id, which is what
 * keeps a fork's later dispatch on a kept instance from colliding with the parent's completed
 * record — a record's id is its request folded with its instance and site, and the site is the
 * same. Values are blob-shared by content hash, so a copy is rows, not payloads.
 *
 * ## The remote is never truncated
 *
 * A provider cannot delete turns from a conversation, so a rewound (or copied) session's rows end
 * where its remote does not. `SqliteSessionStore.cutSession` stamps the cut, and `resolve` offers
 * the handle as a copy source cut at the last kept message rather than as a resume target — the
 * `--resume-session-at` primitive. Without a message id to cut at, the handle is dropped and the
 * next call replays the prefix.
 *
 * ## The files stay append-only
 *
 * The journal file and the conversations file are the truth where they are on, and both merge on
 * the property that a line is never taken back. So a rewind APPENDS: a `jaira.rewound` line naming
 * the journal lines that are gone (by physical ordinal, the one coordinate a file has that nothing
 * re-mints), and a `jaira.tombstone` line per deleted record and session. Replay honours both.
 */
import { createHash } from "node:crypto";
import { hashOperation, scopedOperationId } from "@declarative-ai/exec";
import { uuidv7, type EngineEvent } from "@declarative-ai/hw";
import { createLogger } from "@declarative-ai/log";
import { PROCESS_NOTE_EVENTS, refusal, remoteBranchName, type SplitEntry, type TaskProvenance, type TaskStatus } from "@jaira/shared";
import { CHAT_INSTANCE_PREFIX } from "@jaira/runtime";
import type { Project } from "./project";
import { sessionStoreFor } from "./project";
import type { StoredEvent } from "./eventLog";
import { appendRewound, effectiveLines, journalFileFor } from "./journalFile";
import { ConversationLog, type NameRow, type RecordRow, type SessionRow } from "./conversationFile";
import { createTask } from "./lifecycle";
import { dropConnectUndo } from "./connectUndo";
import { pinAt, type Pin } from "./documents";
import { isFileBacked } from "./shadow";

const log = createLogger("jaira.persistence.cut");

/** The two halves of a journal at a cut — see the header. */
export interface Partition {
  kept: StoredEvent[];
  dropped: StoredEvent[];
  /** Instances entered at or after the cut: gone whole. */
  doomed: Set<string>;
  /** Record ids the dropped events dispatched or settled — what the deletion reaches by name. */
  droppedRecords: Set<string>;
}

/**
 * Which events survive a cut at `seq`, and which go.
 *
 * Pure over the rows, so it can be asked without doing anything — the same partition decides a
 * rewind's deletion, a fork's copy, and what a view dims while it asks.
 */
export function partitionAt(events: readonly StoredEvent[], seq: number): Partition {
  const enteredAt = new Map<string, number>();
  for (const row of events) {
    if (row.type === "instance.entered" && row.instanceId !== undefined && !enteredAt.has(row.instanceId)) {
      enteredAt.set(row.instanceId, row.seq);
    }
  }
  const doomed = new Set<string>();
  for (const [id, at] of enteredAt) if (at >= seq) doomed.add(id);

  const kept: StoredEvent[] = [];
  const dropped: StoredEvent[] = [];
  const droppedRecords = new Set<string>();
  /** The seq of each instance's newest `operation.started`, as the scan reaches it. */
  const lastStarted = new Map<string, number>();
  for (const row of events) {
    const inst = row.instanceId;
    if (row.type === "operation.started" && inst !== undefined) lastStarted.set(inst, row.seq);
    let keep: boolean;
    if (row.seq < seq) keep = true;
    else if (inst === undefined || doomed.has(inst)) keep = false;
    else {
      // A kept instance's event past the cut: only the settle of a call that had already started
      // survives — and the instance's own end, when that end is the settle's (a leaf finishing).
      // A composite's end, a transition, a child entered, a turn typed: the machine moving, cut.
      const started = lastStarted.get(inst);
      const before = started !== undefined && started < seq;
      switch (row.type) {
        case "operation.dispatched":
        case "operation.completed":
        case "operation.failed":
        case "instance.terminated":
          keep = before;
          break;
        default:
          keep = false;
      }
    }
    (keep ? kept : dropped).push(row);
    // `call.waiting`/`call.settled` name a content key, not a record — nothing to delete by it.
    if (!keep && row.operationId !== undefined && row.type !== "call.waiting" && row.type !== "call.settled") {
      droppedRecords.add(row.operationId);
    }
  }
  return { kept, dropped, doomed, droppedRecords };
}

/** What a rewind removed, for the caller's log line. */
export interface RewindResult {
  taskId: string;
  events: number;
  records: number;
}

interface SeatRow {
  id: string;
  sid: string | null;
  seat: number | null;
}

/**
 * The task's journal, checked for the two things a cut cannot be made through.
 *
 * `ofLiveTask` lifts the standing check for the one caller that cuts a RUNNING task on purpose: a
 * split (decision 0003) copies its parent while the parent is parked inside the mount, which is a
 * stable point — nothing is being appended past it until the host answers. The seq may then be one
 * past the last event, meaning "everything so far": a cut BEFORE the newest event would drop it.
 */
function journalOf(project: Project, taskId: string, seq: number, ofLiveTask = false): StoredEvent[] {
  const row = project.runtime.get(taskId);
  if (row === undefined) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  if (!ofLiveTask && (row.status === "running" || row.status === "stopping")) {
    throw refusal(log, `task '${taskId}' is ${row.status} — stop it before cutting its journal`, { taskId });
  }
  const events = project.events.list(taskId);
  const last = events.length > 0 ? events[events.length - 1]!.seq : 0;
  if (!events.some((event) => event.seq === seq) && !(ofLiveTask && seq === last + 1)) {
    throw refusal(log, `task '${taskId}' has no journal event ${seq}`, { taskId, seq });
  }
  return events;
}

/**
 * What the task ran under at the cut (decision 0005 §3): the version its journal says was current
 * just before `seq` — not the one it runs under now, which a later modification may have moved on.
 *
 * A rewound task goes back under it, so what it draws is the workflow as it was there; the load that
 * follows picks up the document's latest version like any other load, and says so in the journal. A
 * cut behind the row that moved the task INTO a document puts it back under the snapshot it had
 * before, in no document at all: rewinding past a divergence un-diverges, as rewinding past a mirror
 * row un-adopts. A fork's copy starts under the same answer.
 */
function pinAtCut(project: Project, taskId: string, events: readonly StoredEvent[], seq: number): Pin | undefined {
  const row = project.runtime.get(taskId)!;
  const standing: Pin | undefined =
    row.snapshotHash === undefined ? undefined : { snapshotHash: row.snapshotHash, ...(row.documentId !== undefined ? { documentId: row.documentId } : {}) };
  return pinAt(events, seq, standing);
}

/** Every record of a task at or after the cut — by the events that name them, and by doomed instance. */
function doomedRecordsOf(project: Project, taskId: string, part: Partition): Set<string> {
  const ids = new Set(part.droppedRecords);
  if (part.doomed.size > 0) {
    const marks = [...part.doomed].map(() => "?").join(", ");
    const rows = project.db
      .prepare(`SELECT id FROM operation_records WHERE task_id = ? AND instance_id IN (${marks})`)
      .all(taskId, ...part.doomed) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }
  return ids;
}

/**
 * Delete everything past a point, in place — see the header for what "past" means.
 *
 * Refused while the task runs, and refused for a cut with nothing after it: a deletion that deletes
 * nothing is a question about what the caller meant. The task is left `interrupted`, which is the
 * truthful word for a run whose end was taken away, and the caller resumes it.
 */
export function rewindTask(project: Project, taskId: string, seq: number, nowMs = Date.now()): RewindResult {
  const events = journalOf(project, taskId, seq);
  const part = partitionAt(events, seq);
  if (part.dropped.length === 0) throw refusal(log, `nothing in task '${taskId}' comes after event ${seq}`, { taskId, seq });

  const recordIds = doomedRecordsOf(project, taskId, part);
  const store = sessionStoreFor(project, { taskId });
  const before = project.runtime.get(taskId)!;
  const pin = pinAtCut(project, taskId, events, seq);
  let deletedRecords = 0;
  project.db.transaction(() => {
    // Conversations first: a seated record is cut from its conversation, which also takes every
    // branch that left the conversation past that seat and stamps where the remote was cut.
    const seated =
      recordIds.size === 0
        ? []
        : (project.db
            .prepare(
              `SELECT id, COALESCE(landed_session_id, session_id) AS sid, COALESCE(landed_seq, session_seq) AS seat
                 FROM operation_records WHERE id IN (${[...recordIds].map(() => "?").join(", ")})`,
            )
            .all(...recordIds) as SeatRow[]);
    const cutAt = new Map<string, number>();
    for (const row of seated) {
      if (row.sid === null || row.seat === null) continue;
      cutAt.set(row.sid, Math.min(cutAt.get(row.sid) ?? Number.POSITIVE_INFINITY, row.seat));
    }
    const gone = new Set<string>();
    for (const [sid, seat] of cutAt) for (const id of store.cutSession(sid, seat)) gone.add(id);
    deletedRecords = gone.size + store.dropRecords([...recordIds].filter((id) => !gone.has(id)));

    // The journal: the file says which lines are gone, then the table forgets them.
    if (isFileBacked(project.config.storage.journal)) {
      const file = journalFileFor(project.paths.journalDir, taskId);
      const effective = effectiveLines(file);
      if (effective.length !== events.length) {
        throw refusal(
          log,
          `task '${taskId}': the journal file holds ${effective.length} events and the table ${events.length} — refusing to cut a journal that disagrees with its file`,
          { taskId },
        );
      }
      const rank = new Map(events.map((event, i) => [event.seq, i] as const));
      const ordinals = part.dropped.map((event) => effective[rank.get(event.seq)!]!.ordinal);
      appendRewound(project.paths.journalDir, taskId, ordinals, nowMs);
    }
    const marks = part.dropped.map(() => "?").join(", ");
    project.db
      .prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND seq IN (${marks})`)
      .run(taskId, ...part.dropped.map((event) => event.seq));

    // A question parked past the cut is a question about a state that no longer ran.
    project.interactions.clearTask(taskId);
    project.runtime.markCut(taskId, nowMs);
    // Back under the version that was current at the cut — see {@link pinAtCut}.
    if (pin !== undefined && (pin.snapshotHash !== before.snapshotHash || pin.documentId !== before.documentId)) {
      project.runtime.setPin(taskId, pin.snapshotHash, pin.documentId ?? null, nowMs);
    }
  })();
  // A rewind is a decision about the task: a connect's Undo it kept is over (`connectUndo.ts`).
  dropConnectUndo(project, taskId);
  log.info(`rewound ${taskId} to before event ${seq}: ${part.dropped.length} event(s) and ${deletedRecords} record(s) deleted`);
  return { taskId, events: part.dropped.length, records: deletedRecords };
}

export interface ForkOptions {
  /**
   * The copy's id, when the caller has already chosen — and recorded — it. A split (decision 0003)
   * writes the ids of every copy into the parent's journal BEFORE cutting them, so that each copy
   * carries the list; the cut must then land on the id the list names. Minted when absent.
   */
  id?: string;
  /** The copy's title. Defaults to the parent's. */
  title?: string;
  /**
   * How the copy stands once made. `startable` leaves it `interrupted` for the resume that follows
   * (a run fork); `asIs` copies the parent's own standing (a chat fork, whose next message is a chat
   * turn rather than a resume, and whose row should read as its parent's does); `queued` is a copy
   * that has never run and is not about to — a SPLIT's (decision 0003), which stands where it was
   * put until somebody or its dependencies release it. It keeps no start, no end and no outcome.
   */
  standing: "startable" | "asIs" | "queued";
  /**
   * The copy's branch. Absent copies the parent's binding, which is right for a fork — the same
   * work, tried another way — and wrong for a split, whose copy is other work on the same base:
   * `null` unbinds the copy, a string binds it to its own branch.
   */
  branch?: string | null;
  /** The copy's parent for the re-run chain. Defaults to the task copied. */
  parentTaskId?: string;
  /** How a fan-out made the copy — see `TaskMeta.origin`. */
  origin?: TaskProvenance;
  /** The lists the copy is split on — see `TaskMeta.split`. */
  split?: SplitEntry[];
  /** Tasks the copy must wait for — see `TaskMeta.dependsOn`. */
  dependsOn?: string[];
  /**
   * The task copied is RUNNING and parked at the point of the cut — a split's parent (decision
   * 0003). The seq may then be one past its last event: everything so far.
   */
  ofLiveTask?: boolean;
  nowMs?: number;
}

export interface ForkResult {
  taskId: string;
  /** The copy's last journaled event — the seam, in its own coordinates. */
  boundarySeq: number;
  /** Old instance id → new, for a caller that held one (the chat host, most often). */
  instanceIds: ReadonlyMap<string, string>;
}

interface ParentSessionRow {
  id: string;
  parent: string | null;
  cursor: number;
  provider: string | null;
  provider_session_id: string | null;
  created_at: number;
}

interface CopyRecordRow {
  id: string;
  status: string;
  request_json: string | null;
  result_json: string | null;
  error_json: string | null;
  metrics_json: string | null;
  provider_session_id: string | null;
  landed_session_id: string | null;
  landed_seq: number | null;
  started_at: number;
  ended_at: number | null;
  rowid: number;
}

const BLOB_KEY = "$blob";

/** Every blob hash a stored JSON text references — for the reference count a copy has to pay into. */
function blobsIn(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const child of v) walk(child);
      return;
    }
    const ref = (v as Record<string, unknown>)[BLOB_KEY];
    if (typeof ref === "string") {
      out.push(ref);
      return;
    }
    for (const child of Object.values(v as Record<string, unknown>)) walk(child);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    // Unreadable JSON references nothing a count could be wrong about.
  }
  return out;
}

/**
 * The provider's own id for the LAST message the given rows hold — where a copy of the remote is
 * cut. The same reading `SqliteSessionStore.messageIdAt` makes, over rows already in hand.
 */
function lastMessageIdOf(resultsNewestFirst: readonly (string | null)[]): string | undefined {
  for (const text of resultsNewestFirst) {
    if (text === null) continue;
    let value: { value?: { entries?: Array<{ uuid?: unknown }> } };
    try {
      value = JSON.parse(text) as typeof value;
    } catch {
      continue;
    }
    const entries = value?.value?.entries;
    if (!Array.isArray(entries)) continue;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const uuid = entries[i]?.uuid;
      if (typeof uuid === "string") return uuid;
    }
  }
  return undefined;
}

/**
 * Copy everything before a point into a new task, linked by `parentTaskId` — see the header.
 *
 * The copy is left for the caller to continue: `startable` for a run (the resume walks the copied
 * machine to its frontier), `asIs` for a chat (the next message is a turn on the copied thread).
 */
export function forkTask(project: Project, taskId: string, seq: number, options: ForkOptions): ForkResult {
  const nowMs = options.nowMs ?? Date.now();
  const events = journalOf(project, taskId, seq, options.ofLiveTask === true);
  const parent = project.runtime.get(taskId)!;
  if (parent.snapshotHash === undefined) throw refusal(log, `task '${taskId}' has never run, so there is nothing to fork`, { taskId });
  const meta = project.tasks.read(taskId);
  const part = partitionAt(events, seq);
  if (part.kept.length === 0) throw refusal(log, `nothing in task '${taskId}' comes before event ${seq}`, { taskId, seq });
  // The copy stands in the workflow as it was at the cut, and in the same document: a copy is
  // another item flowing through it, which is what a split's copies already are.
  const pin = pinAtCut(project, taskId, events, seq) ?? { snapshotHash: parent.snapshotHash };

  // --- fresh identity for everything copied ------------------------------------------------
  let minted = 0;
  const mint = (): string => uuidv7(nowMs + minted++);
  const instanceIds = new Map<string, string>();
  const mapInstance = (old: string): string => {
    // A chat child's id is DERIVED from its host's (`chat:<host>`), so it maps through the host.
    if (old.startsWith(CHAT_INSTANCE_PREFIX)) return `${CHAT_INSTANCE_PREFIX}${mapInstance(old.slice(CHAT_INSTANCE_PREFIX.length))}`;
    let fresh = instanceIds.get(old);
    if (fresh === undefined) {
      fresh = mint();
      instanceIds.set(old, fresh);
    }
    return fresh;
  };
  const sessionIds = new Map<string, string>();
  const mapSession = (old: string): string => {
    let fresh = sessionIds.get(old);
    if (fresh === undefined) {
      fresh = mint();
      sessionIds.set(old, fresh);
    }
    return fresh;
  };
  const mapRef = (ref: string): string => {
    const at = ref.lastIndexOf("@");
    if (at <= 0) return ref;
    const id = ref.slice(0, at);
    return sessionIds.has(id) ? `${mapSession(id)}${ref.slice(at)}` : ref;
  };

  // --- what is copied ---------------------------------------------------------------------
  const doomedRecords = doomedRecordsOf(project, taskId, part);
  const records = (
    project.db
      .prepare(
        `SELECT rowid, id, status, request_json, result_json, error_json, metrics_json, provider_session_id,
                landed_session_id, landed_seq, started_at, ended_at
           FROM operation_records WHERE task_id = ? ORDER BY started_at, rowid`,
      )
      .all(taskId) as CopyRecordRow[]
  ).filter((row) => !doomedRecords.has(row.id));

  // The sessions those records sit in, with every ancestor a branch's prefix hangs off — a fork
  // inherits by lineage inside one task, so the lineage comes whole.
  const sessionRow = project.db.prepare(`SELECT id, parent, cursor, provider, provider_session_id, created_at FROM sessions WHERE id = ?`);
  const sessions = new Map<string, ParentSessionRow>();
  // A session holding ANOTHER task's records is not this task's to copy: it is a conversation a task
  // this one adopted began, and this one continued under an alias (`adopt.ts`). Its copy is a BRANCH
  // of it at the copy's first seat, so the prefix is read where it is — copying the rows without the
  // other task's records would hand the copy a conversation with its beginning missing.
  const othersIn = project.db.prepare(
    `SELECT MAX(COALESCE(landed_seq, session_seq)) AS m, COUNT(*) AS n FROM operation_records
      WHERE COALESCE(landed_session_id, session_id) = ? AND (task_id IS NULL OR task_id != ?)`,
  );
  const foreign = new Map<string, number>();
  const claim = (id: string | null | undefined): void => {
    let at = id ?? undefined;
    while (at !== undefined && !sessions.has(at)) {
      const row = sessionRow.get(at) as ParentSessionRow | undefined;
      if (row === undefined) return;
      sessions.set(at, row);
      const others = othersIn.get(at, taskId) as { m: number | null; n: number };
      if (others.n > 0) {
        foreign.set(at, others.m === null ? row.cursor : others.m + 1);
        return;
      }
      at = row.parent ?? undefined;
    }
  };
  const seatOf = (row: CopyRecordRow): { id: string; seq: number } | undefined => {
    if (row.landed_session_id !== null && row.landed_seq !== null) return { id: row.landed_session_id, seq: row.landed_seq };
    const request = parsedObject(row.request_json) as { session?: { id?: unknown; seq?: unknown } } | undefined;
    const session = request?.session;
    return typeof session?.id === "string" && typeof session.seq === "number" ? { id: session.id, seq: session.seq } : undefined;
  };
  for (const row of records) {
    claim(seatOf(row)?.id);
    claim(row.landed_session_id);
  }
  const names = project.db
    .prepare(`SELECT task_id, name, session_id FROM session_names WHERE task_id = ?`)
    .all(taskId) as NameRow[];
  for (const name of names) claim(name.session_id);
  for (const id of sessions.keys()) mapSession(id);

  // --- the copy, in one transaction ----------------------------------------------------------
  const copy = createTask(
    project,
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      title: options.title ?? meta.title,
      workflow: meta.workflow,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.labels !== undefined ? { labels: meta.labels } : {}),
      ...(meta.inputs !== undefined ? { inputs: meta.inputs } : {}),
      ...(options.branch === undefined ? (meta.branch !== undefined ? { branch: meta.branch } : {}) : options.branch === null ? {} : { branch: options.branch }),
      parentTaskId: options.parentTaskId ?? taskId,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.split !== undefined ? { split: options.split } : {}),
      ...(options.dependsOn !== undefined ? { dependsOn: options.dependsOn } : {}),
    },
    nowMs,
  );
  const filed = isFileBacked(project.config.storage.conversations);
  const convo = filed ? new ConversationLog(project.paths.conversationsDir, project.config.storage.format, copy.id) : undefined;
  const recordIds = new Map<string, string>();
  let boundarySeq = 0;
  project.db.transaction(() => {
    // Lineage first, parents before children: the parent column references the table.
    const insertSession = project.db.prepare(
      `INSERT INTO sessions (id, parent, cursor, provider, provider_session_id, cut_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted = new Set<string>();
    const insertLineage = (old: string): void => {
      if (inserted.has(old)) return;
      const row = sessions.get(old)!;
      if (row.parent !== null && sessions.has(row.parent)) insertLineage(row.parent);
      inserted.add(old);
      // The copy's rows on this conversation, newest first, say where its remote is to be cut: a
      // copy must never RESUME the parent's remote, or two tasks write into one conversation. No
      // message id to cut at means no handle — the next call replays.
      const own = records
        .filter((record) => seatOf(record)?.id === old)
        .sort((a, b) => (seatOf(b)?.seq ?? 0) - (seatOf(a)?.seq ?? 0))
        .map((record) => record.result_json);
      const cut = row.provider_session_id === null ? undefined : lastMessageIdOf(own);
      const handle = cut === undefined ? null : row.provider_session_id;
      // Another task's conversation: a branch of the ORIGINAL, at the first seat of this task's own
      // (or where the other task's end, when this one only named it) — see `foreign` above.
      const seats = records.map((record) => seatOf(record)).filter((seat) => seat?.id === old).map((seat) => seat!.seq);
      const branch = foreign.has(old) ? { parent: old, cursor: seats.length > 0 ? Math.min(...seats) : foreign.get(old)! } : undefined;
      const parent = branch !== undefined ? branch.parent : row.parent === null ? null : sessions.has(row.parent) ? mapSession(row.parent) : null;
      const cursor = branch?.cursor ?? row.cursor;
      insertSession.run(mapSession(old), parent, cursor, row.provider, handle, cut ?? null, row.created_at);
      convo?.append({
        kind: "session",
        row: {
          id: mapSession(old),
          parent,
          cursor,
          provider: row.provider,
          provider_session_id: handle,
          cut_at: cut ?? null,
          created_at: row.created_at,
        } satisfies SessionRow,
      });
    };
    for (const old of sessions.keys()) insertLineage(old);

    const insertName = project.db.prepare(`INSERT OR REPLACE INTO session_names (task_id, name, session_id) VALUES (?, ?, ?)`);
    for (const name of names) {
      // An engine-minted name is the instance's (`#i<id>`), so it follows the instance's new id;
      // an authored name stays the word the author wrote.
      const fresh = name.name.startsWith("#i") ? `#i${mapInstance(name.name.slice(2))}` : name.name;
      const session = sessionIds.has(name.session_id) ? mapSession(name.session_id) : name.session_id;
      insertName.run(copy.id, fresh, session);
      convo?.append({ kind: "name", row: { task_id: copy.id, name: fresh, session_id: session } });
    }

    const insertRecord = project.db.prepare(
      `INSERT INTO operation_records
         (id, task_id, status, request_json, result_json, error_json, metrics_json, provider_session_id,
          landed_session_id, landed_seq, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bump = project.db.prepare(`UPDATE blobs SET refs = refs + 1 WHERE hash = ?`);
    for (const row of records) {
      const request = parsedObject(row.request_json) as Record<string, unknown> | undefined;
      const { scope, session, ...op } = request ?? {};
      const oldScope = scope as { instanceId?: unknown; sequence?: unknown } | undefined;
      const scoped = typeof oldScope?.instanceId === "string" && typeof oldScope.sequence === "number";
      const newScope = scoped ? { instanceId: mapInstance(oldScope!.instanceId as string), sequence: oldScope!.sequence as number } : undefined;
      const oldSession = session as { id?: unknown } | undefined;
      const newSession =
        typeof oldSession?.id === "string" ? { ...(session as object), id: sessionIds.has(oldSession.id) ? mapSession(oldSession.id) : oldSession.id } : undefined;
      // The id is the request folded with the site (migration 13) — recomputed over the NEW scope,
      // which is what keeps a later dispatch at the same site from colliding with the parent's row.
      // An unscoped record has no site to fold; it takes an id nothing else can compute.
      const id = newScope !== undefined
        ? scopedOperationId(hashOperation(op as never), newScope)
        : createHash("sha256").update(`${row.id}\0${copy.id}`).digest("hex");
      recordIds.set(row.id, id);
      const newRequest =
        request === undefined
          ? null
          : JSON.stringify({
              ...op,
              ...(newScope !== undefined ? { scope: newScope } : scope !== undefined ? { scope } : {}),
              ...(newSession !== undefined ? { session: newSession } : session !== undefined ? { session } : {}),
            });
      const metrics = parsedObject(row.metrics_json) as { sessionRef?: unknown } | undefined;
      const newMetrics =
        metrics !== undefined && typeof metrics.sessionRef === "string"
          ? JSON.stringify({ ...metrics, sessionRef: mapRef(metrics.sessionRef) })
          : row.metrics_json;
      const landed = row.landed_session_id === null ? null : sessionIds.has(row.landed_session_id) ? mapSession(row.landed_session_id) : row.landed_session_id;
      insertRecord.run(
        id,
        copy.id,
        row.status,
        newRequest,
        row.result_json,
        row.error_json,
        newMetrics,
        row.provider_session_id,
        landed,
        row.landed_seq,
        row.started_at,
        row.ended_at,
      );
      // A blob is shared by content and counted per record naming it (RECORDS.md §8).
      for (const hash of new Set([...blobsIn(row.result_json), ...blobsIn(newRequest)])) bump.run(hash);
      convo?.append({
        kind: "record",
        row: {
          record_id: id,
          task_id: copy.id,
          status: row.status,
          request_json: newRequest,
          result_json: row.result_json,
          error_json: row.error_json,
          metrics_json: newMetrics,
          provider_session_id: row.provider_session_id,
          landed_session_id: landed,
          landed_seq: row.landed_seq,
          started_at: row.started_at,
          ended_at: row.ended_at,
        } satisfies RecordRow,
      });
    }

    // The journal, re-addressed. Through the recorder, so the file gets its lines too.
    const recorder = project.events.recorder(copy.id);
    // What a process was doing WITH the parent — a fast-forward, a held move — is not the copy's.
    for (const row of part.kept) if (!PROCESS_NOTE_EVENTS.has(row.type)) recorder.record(rewriteEvent(row.event, mapInstance, mapRef, recordIds), row.createdAt);
    const last = project.db.prepare(`SELECT MAX(seq) AS seq FROM state_machine_events WHERE task_id = ?`).get(copy.id) as { seq: number | null };
    boundarySeq = last.seq ?? 0;

    // A fork copies each request's IDENTITY and not the request: its first push opens its own, on a
    // branch carrying its own id (decision 0004). A rewind, above, keeps the row — the forge cannot
    // be rewound, and the next push simply adds commits.
    project.remotes.copyIdentity(taskId, copy.id, (row) => remoteBranchName(copy.id, row.key));

    const standing = standingOf(parent.status, options.standing);
    project.runtime.stampFork(
      copy.id,
      {
        snapshotHash: pin.snapshotHash,
        documentId: pin.documentId,
        rootInstanceId: parent.rootInstanceId !== undefined && instanceIds.has(parent.rootInstanceId) ? mapInstance(parent.rootInstanceId) : undefined,
        forkedAtSeq: seq,
        forkBoundarySeq: boundarySeq,
        status: standing,
        startedAt: standing === "queued" ? undefined : parent.startedAt,
        endedAt: standing === "interrupted" ? nowMs : standing === "queued" ? undefined : parent.endedAt,
        outcome: standing === "interrupted" ? "interrupted" : standing === "queued" ? undefined : parent.outcome,
      },
      nowMs,
    );
  })();
  // A fork — or a split, which is a fork per element — is a decision about the task copied: a
  // connect's Undo it kept is over, and the copy never had one (`connectUndo.ts`).
  dropConnectUndo(project, taskId);
  log.info(`forked ${taskId} before event ${seq} as ${copy.id}:${part.kept.length} event(s), ${records.length} record(s), ${sessions.size} conversation(s)`);
  return { taskId: copy.id, boundarySeq, instanceIds };
}

/** How a copy stands: its parent's standing where that is settled, `interrupted` otherwise — or `queued`, a copy that has not run. */
function standingOf(parent: TaskStatus, wanted: ForkOptions["standing"]): TaskStatus {
  if (wanted === "startable") return "interrupted";
  if (wanted === "queued") return "queued";
  return parent === "completed" || parent === "failed" || parent === "canceled" ? parent : "interrupted";
}

/** One journal event re-addressed to the copy's ids — every field that names an instance, a record or a position. */
function rewriteEvent(
  event: EngineEvent,
  mapInstance: (old: string) => string,
  mapRef: (ref: string) => string,
  recordIds: ReadonlyMap<string, string>,
): EngineEvent {
  const out = { ...(event as unknown as Record<string, unknown>) };
  if (typeof out["instanceId"] === "string") out["instanceId"] = mapInstance(out["instanceId"]);
  if (typeof out["parentInstanceId"] === "string") out["parentInstanceId"] = mapInstance(out["parentInstanceId"]);
  if (typeof out["operationId"] === "string" && recordIds.has(out["operationId"])) out["operationId"] = recordIds.get(out["operationId"]);
  const metrics = out["metrics"];
  if (metrics !== null && typeof metrics === "object" && typeof (metrics as { sessionRef?: unknown }).sessionRef === "string") {
    out["metrics"] = { ...(metrics as object), sessionRef: mapRef((metrics as { sessionRef: string }).sessionRef) };
  }
  return out as unknown as EngineEvent;
}

function parsedObject(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
