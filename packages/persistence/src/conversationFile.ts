/**
 * Conversations as files — the second concern to get a writer (DESIGN §4.4).
 *
 * Same inversion as the journal: the file is the truth, the table is an index replayed from it, and
 * a write reaches disk before it reaches the row. What makes this one harder is that the journal is
 * append-only and this is not. `operation_records` is UPDATED — `open` → `completed`, a streamed
 * partial refreshed on a debounce, a provider handle stamped mid-flight — so a file that held one
 * line per row would have to be rewritten in place, which is the one thing an append-only format
 * must never need.
 *
 * ## Append-only, last-wins
 *
 * Every write appends the row's CURRENT STATE, whole, and replay folds the file keeping the last
 * line per key. No deltas and no in-place edits: a merge of two appends is resolved by whichever
 * line ends up later, which is the same rule the format already uses within one process, so a git
 * merge cannot produce a state the reader has no rule for.
 *
 * It costs size — a record that streams ten partials writes ten lines — and buys the property that
 * matters: a file only ever grows, so two people appending to one run's conversations conflict on
 * nothing but the final newline. Compaction, if it is ever wanted, is a rewrite of a file nobody is
 * appending to and can be added without changing the reader.
 *
 * ## Three kinds of line, because there are three tables
 *
 * `record` (an `operation_records` row, keyed by task/run/record/attempt), `position` (a
 * `session_positions` row, keyed by session and seq), `session` (a `sessions` lineage row, keyed by
 * id). They share a file because they share a lifetime: the conversations concern is one concern
 * precisely so a fork cannot lose the parent row its prefix hangs off.
 *
 * ## Dialects, and what is and is not being claimed
 *
 * `config.storage.format` chooses the line SHAPE, and reading detects the shape per file rather than
 * trusting the setting — a repository outlives a preference, and a colleague may have written the
 * other one. Both dialects carry the same information under different envelopes.
 *
 * Both envelopes were read off REAL files rather than written from memory — a Claude Code session
 * under `~/.claude/projects/<cwd>/<id>.jsonl` and a Codex rollout under `~/.codex/sessions/…`:
 *
 *  - **claude**: `{uuid, parentUuid, sessionId, timestamp, type, …}`, with a conversation turn
 *    carrying `message` (the API message verbatim, `{role, content}`) plus `isSidechain` and
 *    `userType`. Unknown `type`s are kept whole by its reader rather than filtered, deliberately, so
 *    JaiRA's own rows ride under `jaira.*` types beside the turns.
 *  - **codex**: `{timestamp, type, payload}`, where a conversation turn is
 *    `type: "response_item"` with `payload: {type: "message", role, content: [{type: "input_text" |
 *    "output_text", text}]}`.
 *
 * ## Two kinds of line, and only one of them is load-bearing
 *
 * A settled record emits its turns as NATIVE lines — the shapes above — so those tools render a
 * JaiRA transcript rather than merely tolerating it. Replay ignores them completely: the `jaira.*`
 * row lines are the truth and are sufficient on their own. That asymmetry is deliberate and worth
 * relying on. A merge that drops a turn line costs a foreign reader one bubble and costs JaiRA
 * nothing; a format change to the native shapes cannot break a replay.
 *
 * Turns are emitted at the SETTLE only, not on every partial flush — a call that streams ten times
 * would otherwise spray ten copies of a growing transcript into the file.
 */
import type { JsonValue } from "@declarative-ai/json";
import { messagesOfRecord } from "./recordMessages";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JairaSessionFormat } from "@jaira/shared";
import type { JairaDb } from "./db";

/** An `operation_records` row. `record_id` is the row's id (the scoped hash, migration 13). */
export interface RecordRow {
  record_id: string;
  task_id: string | null;
  /** Legacy lines only — files written before the runs collapse stamped rows per run. */
  run_id?: number | null;
  /** Legacy lines only — files written before the scoped id retired the attempt column. */
  attempt?: number;
  status: string;
  request_json: string | null;
  result_json: string | null;
  error_json: string | null;
  metrics_json: string | null;
  /** Legacy lines only — the column migration 14 folded into `result_json` and dropped. */
  session_outcome_json?: string | null;
  provider_session_id: string | null;
  /** Where the call demonstrably ran, when that is not where it was asked to (migration 14). */
  landed_session_id?: string | null;
  landed_seq?: number | null;
  started_at: number;
  ended_at: number | null;
}

/** A `session_positions` row — the claim, and what it points at. */
export interface PositionRow {
  session_id: string;
  seq: number;
  task_id: string | null;
  run_id: number | null;
  record_id: string;
  /** Legacy lines only — see {@link RecordRow.attempt}. */
  attempt?: number;
}

/** A `sessions` row — the lineage a fork's prefix hangs off, and its remote identity (migration 14). */
export interface SessionRow {
  id: string;
  parent: string | null;
  cursor: number;
  /** Who owns the handle below — absent on legacy lines. */
  provider?: string | null;
  /** The conversation's current handle; NULL on a fork until it earns one. Absent on legacy lines. */
  provider_session_id?: string | null;
  created_at: number;
}

/** A `session_names` row — what an author wrote, and the session it is an alias to (migration 15). */
export interface NameRow {
  task_id: string;
  name: string;
  session_id: string;
}

export type ConversationEntry =
  | { kind: "record"; row: RecordRow }
  | { kind: "position"; row: PositionRow }
  | { kind: "session"; row: SessionRow }
  | { kind: "name"; row: NameRow };

// --- dialects ------------------------------------------------------------------

/**
 * How one entry becomes a line, and back.
 *
 * A dialect is an ENVELOPE and nothing more: it never decides what is recorded, only how the line
 * is dressed, so switching `format` cannot change what a replay reconstructs. That is what lets the
 * reader accept either shape whatever the setting says.
 */
interface Dialect {
  name: JairaSessionFormat;
  /** True when a parsed line is this dialect's. Checked in order, so it must be specific. */
  owns: (line: Record<string, unknown>) => boolean;
  encode: (entry: ConversationEntry, at: number, previous: string | undefined) => Record<string, unknown>;
  decode: (line: Record<string, unknown>) => ConversationEntry | undefined;
  /**
   * The native conversation lines a settled record contributes — for the OTHER tool's reader, never
   * for replay. See the header: these are decorative to JaiRA and load-bearing to Claude and Codex.
   */
  turns: (row: RecordRow, at: number) => Array<Record<string, unknown>>;
}

/** The messages a settled record contributed, if it settled and contributed any. */
function messagesOf(row: RecordRow): Array<{ role?: string; content?: unknown }> {
  if (row.status === "open" || row.result_json === null) return [];
  try {
    return messagesOfRecord(JSON.parse(row.result_json) as JsonValue) as Array<{ role?: string; content?: unknown }>;
  } catch {
    return [];
  }
}

/** `jaira.record` and friends — namespaced so neither agent's reader mistakes one for its own. */
const TYPE_OF: Record<ConversationEntry["kind"], string> = {
  record: "jaira.record",
  position: "jaira.position",
  session: "jaira.session",
  name: "jaira.name",
};
const KIND_OF: Record<string, ConversationEntry["kind"]> = {
  "jaira.record": "record",
  "jaira.position": "position",
  "jaira.session": "session",
  "jaira.name": "name",
};

/** A line id that does not need a random source — the file's own position is already unique. */
const uuidOf = (at: number, n: number): string => `jaira-${at.toString(36)}-${n.toString(36)}`;

const claude: Dialect = {
  name: "claude",
  // Claude threads its lines with `uuid`/`parentUuid`; a line carrying both plus one of our types is
  // unambiguously ours, and one carrying neither is not this dialect.
  owns: (line) => typeof line["uuid"] === "string" && typeof line["type"] === "string" && "parentUuid" in line,
  encode: (entry, at, previous) => ({
    uuid: uuidOf(at, 0),
    parentUuid: previous ?? null,
    timestamp: new Date(at).toISOString(),
    type: TYPE_OF[entry.kind],
    jaira: entry.row,
  }),
  decode: (line) => {
    const kind = KIND_OF[String(line["type"])];
    const row = line["jaira"];
    return kind === undefined || row === null || typeof row !== "object" ? undefined : ({ kind, row } as ConversationEntry);
  },
  // `message` verbatim: a Claude line's body IS the API message, which is exactly what a record's
  // `messages` array holds, so there is nothing to translate. `userType: "external"` and
  // `isSidechain: false` are what a real file carries on a main-chain turn.
  turns: (row, at) =>
    messagesOf(row).map((message) => ({
      uuid: uuidOf(at, 0),
      parentUuid: null,
      sessionId: row.record_id,
      timestamp: new Date(at).toISOString(),
      type: message.role === "user" ? "user" : "assistant",
      userType: "external",
      isSidechain: false,
      message,
    })),
};

const codex: Dialect = {
  name: "codex",
  // A rollout line is flat: a `type` and the payload beside it, with no threading envelope. So the
  // discriminator is the absence of Claude's, plus one of our types.
  owns: (line) => typeof line["type"] === "string" && KIND_OF[String(line["type"])] !== undefined && !("uuid" in line),
  // `timestamp` and not `at`: a real rollout line is `{timestamp, type, payload}`, and the field
  // name was wrong here until it was checked against one.
  encode: (entry, at) => ({ timestamp: new Date(at).toISOString(), type: TYPE_OF[entry.kind], payload: entry.row }),
  decode: (line) => {
    const kind = KIND_OF[String(line["type"])];
    const row = line["payload"];
    return kind === undefined || row === null || typeof row !== "object" ? undefined : ({ kind, row } as ConversationEntry);
  },
  // A rollout's conversation record is `response_item` / `message`, whose content is a list of typed
  // blocks rather than a string — `input_text` from the person, `output_text` from the model. A
  // message that already carries blocks is passed through; only a bare string is wrapped.
  turns: (row, at) =>
    messagesOf(row).map((message) => {
      const role = message.role === "user" ? "user" : "assistant";
      const content = Array.isArray(message.content)
        ? (message.content as unknown[])
        : [{ type: role === "user" ? "input_text" : "output_text", text: String(message.content ?? "") }];
      return {
        timestamp: new Date(at).toISOString(),
        type: "response_item",
        payload: { type: "message", role, content },
      };
    }),
};

const DIALECTS: readonly Dialect[] = [claude, codex];

const dialectNamed = (format: JairaSessionFormat): Dialect => (format === "codex" ? codex : claude);

/**
 * Which dialect wrote a line — asked per LINE rather than per file.
 *
 * Per line because a file can honestly contain both: a project that changed `format` keeps
 * appending to the run files it already had, and a merge can interleave two people who disagreed.
 * Refusing the file, or trusting the first line for the rest of it, would both lose real history.
 */
function decodeLine(line: Record<string, unknown>): ConversationEntry | undefined {
  for (const dialect of DIALECTS) if (dialect.owns(line)) return dialect.decode(line);
  return undefined;
}

// --- files ---------------------------------------------------------------------

/**
 * One file per task, like the journal and for the same reason: two people running tasks on one
 * branch write different filenames, so their appends never conflict. Files written before the runs
 * collapse (migration 16) are named `<runId>.jsonl`; the replay reads every file in the task's
 * directory, so they stay legible and nothing writes them any more.
 *
 * An unscoped store — no task — writes nowhere, because it has nothing to write. It is a read
 * that has already been narrowed (see `SessionScope`), and giving it a file would invent a task to
 * name it by.
 */
export function conversationFileFor(dir: string, taskId: string): string {
  return join(dir, sanitize(taskId), "conversations.jsonl");
}

function sanitize(segment: string): string {
  const clean = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean === "" || clean === "." || clean === ".." ? "_" : clean;
}

/** Appends one task's conversation state. Held by the session store for the life of its scope. */
export class ConversationLog {
  private previous: string | undefined;
  private n = 0;

  constructor(
    private readonly dir: string,
    private readonly format: JairaSessionFormat,
    private readonly taskId: string,
  ) {}

  append(entry: ConversationEntry, at: number = Date.now()): void {
    const dialect = dialectNamed(this.format);
    // The row line first, then the turns it settled with. Order matters only to a human reading the
    // file: the state that produced the turns should come before them.
    const lines = [dialect.encode(entry, at, this.previous)];
    if (entry.kind === "record") lines.push(...dialect.turns(entry.row, at));

    const out: string[] = [];
    for (const line of lines) {
      if (typeof line["uuid"] === "string") {
        // Threading, cheaply: each line points at the one before it, which is what makes a Claude
        // reader treat the file as a chain rather than a bag.
        line["parentUuid"] = this.previous ?? null;
        line["uuid"] = uuidOf(at, this.n++);
        this.previous = line["uuid"] as string;
      }
      out.push(JSON.stringify(line));
    }
    const file = conversationFileFor(this.dir, this.taskId);
    mkdirSync(join(this.dir, sanitize(this.taskId)), { recursive: true });
    appendFileSync(file, out.join("\n") + "\n", "utf8");
  }
}

/** Every conversation file — per-task, plus legacy per-run ones — in a deterministic order. */
export function conversationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const taskId of readdirSync(dir).sort()) {
    let names: string[];
    try {
      names = readdirSync(join(dir, taskId));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) out.push(join(dir, taskId, name));
  }
  return out;
}

/**
 * Read one file into entries, in order, skipping what will not parse.
 *
 * Same rule as the journal's, for the same reason: a git merge can leave a conflict marker mid-file
 * and a killed process can leave half a line. One unreadable line costs one state, not the file.
 */
export function readConversationFile(file: string): ConversationEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: ConversationEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const entry = decodeLine(parsed as Record<string, unknown>);
      if (entry !== undefined) out.push(entry);
    } catch {
      // See above.
    }
  }
  return out;
}

/**
 * Fold every run's file into the three conversation tables.
 *
 * LAST WINS, per key, which is the whole of the update story: a record that opened and then settled
 * wrote two lines and the second is its state. Folded in memory before any insert, so a record is
 * written once however many partials it streamed — and so the order rows land in is the order the
 * keys were first seen, which keeps a transcript's positions in sequence.
 *
 * `undefined` when there is nothing on disk at all — the signal `applyStorage` needs to seed from
 * `main` instead. See {@link ReplaySource}.
 */
export function replayConversations(db: JairaDb, dir: string): number | undefined {
  const files = conversationFiles(dir);
  if (files.length === 0) return undefined;

  const records = new Map<string, RecordRow>();
  const positions = new Map<string, PositionRow>();
  const sessions = new Map<string, SessionRow>();
  const names = new Map<string, NameRow>();
  for (const file of files) {
    for (const entry of readConversationFile(file)) {
      if (entry.kind === "record") {
        records.set(`${entry.row.task_id ?? ""} ${entry.row.run_id ?? ""} ${entry.row.record_id} ${entry.row.attempt ?? 1}`, entry.row);
      } else if (entry.kind === "position") {
        positions.set(`${entry.row.session_id} ${entry.row.seq}`, entry.row);
      } else if (entry.kind === "name") {
        names.set(entry.row.task_id + " " + entry.row.name, entry.row);
      } else {
        sessions.set(entry.row.id, entry.row);
      }
    }
  }

  // LEGACY lines carry an attempt, and a legacy content-hash id repeats across attempts and runs 
  // the same collision migration 13 resolves in the table, resolved here the same way: per content
  // id, the newest (greatest run, then attempt) keeps the bare id, and every other row moves to
  // '<id>~~<run>.<attempt>'. Computable from either table's columns, which is what lets a position
  // line name the same id its record line got. A current-format line has no attempt and passes
  // through untouched  its id is already unique.
  // The rank carries the TASK too, as tiebreak and as suffix: a content hash collides across tasks
  // exactly as it does across runs (two tasks running one workflow hash identical requests), the
  // rebuilt table's id is a primary key, and the DB migration's disambiguator — the old rowid,
  // "unique by construction" — has no counterpart in a file. (task, run, attempt) is the file's own
  // unique key, so folding all three in restores the same construction.
  const newest = new Map();
  const rankOf = (row: { task_id?: string | null; run_id?: number | null; attempt?: number }): [number, number, string] => [
    row.run_id ?? -1,
    row.attempt ?? 1,
    row.task_id ?? "",
  ];
  const outranks = (rank: [number, number, string], seen: [number, number, string]): boolean =>
    rank[0] !== seen[0] ? rank[0] > seen[0] : rank[1] !== seen[1] ? rank[1] > seen[1] : rank[2] > seen[2];
  for (const row of records.values()) {
    if (row.attempt === undefined) continue;
    const rank = rankOf(row);
    const seen = newest.get(row.record_id) as [number, number, string] | undefined;
    if (seen === undefined || outranks(rank, seen)) newest.set(row.record_id, rank);
  }
  const idOf = (row: { record_id: string; task_id?: string | null; run_id?: number | null; attempt?: number }): string => {
    if (row.attempt === undefined) return row.record_id;
    const [run, attempt, task] = rankOf(row);
    const top = newest.get(row.record_id) as [number, number, string] | undefined;
    return top !== undefined && (top[0] !== run || top[1] !== attempt || top[2] !== task)
      ? `${row.record_id}~~${task}.${run}.${attempt}`
      : row.record_id;
  };

  // LEGACY position lines fold into their record's request — where a position lives now (migration
  // 14). Keyed the way the old table joined, so each record collects the one seat it claimed.
  const seatOf = new Map<string, { id: string; seq: number }>();
  for (const row of positions.values()) {
    const key = `${row.task_id ?? ""} ${row.run_id ?? ""} ${idOf(row)}`;
    seatOf.set(key, { id: row.session_id, seq: row.seq });
  }

  /** A legacy record's request with its seat spliced in; a current line already carries its own. */
  const requestOf = (row: RecordRow, id: string): string | null => {
    const seat = seatOf.get(`${row.task_id ?? ""} ${row.run_id ?? ""} ${id}`);
    if (seat === undefined) return row.request_json;
    const request = (parsedObject(row.request_json) ?? {}) as Record<string, unknown>;
    if (request["session"] !== undefined) return row.request_json;
    return JSON.stringify({ ...request, session: seat });
  };

  /** Migration 14's fold, restated for legacy lines: the outcome's one earned case joins the result. */
  const resultOf = (row: RecordRow): string | null => {
    const outcome = parsedObject(row.session_outcome_json ?? null) as { messages?: unknown } | undefined;
    if (outcome?.messages === undefined) return row.result_json;
    const result = (parsedObject(row.result_json) ?? {}) as { value?: { entries?: unknown } };
    if (result.value?.entries !== undefined) return row.result_json;
    return JSON.stringify({ ...result, messages: outcome.messages });
  };

  let rows = 0;
  db.transaction(() => {
    // Lineage first: a position's session must exist before anything reads the chain it is on.
    const session = db.prepare(
      `INSERT OR REPLACE INTO sessions (id, parent, cursor, provider, provider_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of sessions.values()) {
      session.run(row.id, row.parent, row.cursor, row.provider ?? null, row.provider_session_id ?? null, row.created_at);
      rows++;
    }
    const record = db.prepare(
      `INSERT INTO operation_records
         (id, task_id, status, request_json, result_json, error_json,
          metrics_json, provider_session_id, landed_session_id, landed_seq, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of records.values()) {
      const id = idOf(row);
      record.run(
        id,
        row.task_id,
        row.status,
        requestOf(row, id),
        resultOf(row),
        row.error_json,
        row.metrics_json,
        row.provider_session_id,
        row.landed_session_id ?? null,
        row.landed_seq ?? null,
        row.started_at,
        row.ended_at,
      );
      rows++;
    }
    const alias = db.prepare(
      `INSERT OR REPLACE INTO session_names (task_id, name, session_id) VALUES (?, ?, ?)`,
    );
    for (const row of names.values()) {
      alias.run(row.task_id, row.name, row.session_id);
      rows++;
    }
  })();
  return rows;
}

/** JSON that should be an object, or nothing — a helper the legacy folds above share. */
function parsedObject(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Delete a task's whole conversation directory, for the same reason. */
export function removeTaskConversations(dir: string, taskId: string): void {
  rmSync(join(dir, sanitize(taskId)), { recursive: true, force: true });
}
