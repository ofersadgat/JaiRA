/**
 * The journal as files — one JSONL per task (DESIGN §4.4).
 *
 * The table is the truth while JaiRA runs and the file its export (decision 0018 §11,
 * `fileStorage.ts`): an event is appended here synchronously, just before its row is written, so the
 * file never lacks what the table has and there is no flush policy to lose a line across a crash. The
 * file is read back only at an open that finds it moved since JaiRA last left it (a pull, a clone).
 *
 * ## One file per task
 *
 * `<system>/journal/<taskId>/journal.jsonl`. A task IS one machine now (Identity and Resume §05) —
 * a resume continues the same journal and a re-run is a new task with a new directory — so the
 * per-run split has nothing left to separate. Two people running tasks on one branch still write
 * different filenames (different task ids), so their appends never conflict — and after a pull,
 * both are imported into the same table and appear on the board.
 *
 * ## The line, and why it is JaiRA's own shape
 *
 * `config.storage.format` chooses between Claude Code's and Codex's line shapes, and it applies to
 * CONVERSATIONS — a record of what a model was asked and said, which is what those formats are for.
 * A journal line is not a conversation turn: `instance.entered` and `transition.taken` are the state
 * machine talking to itself, and dressing them as `{type: "assistant"}` to fit somebody else's
 * schema would be a lie told for the sake of a reader that would make no sense of it anyway.
 *
 * So the shape is JaiRA's, and deliberately legible in the same way theirs are: one object per line,
 * `type` and an ISO `timestamp` first, the event verbatim under `event`. A person who greps a Claude
 * session file can grep this.
 *
 * ## What is NOT in the line
 *
 * `seq`. It is `INTEGER PRIMARY KEY AUTOINCREMENT` — assigned by whichever database is holding the
 * rows — and writing it down would put a database artifact in a file that outlives databases. Line
 * ORDER is the order; an import inserts in that order and lets the column re-mint, which preserves
 * every ordering anything actually asks for (`ORDER BY seq` within a run, and `created_at` carries
 * the real time regardless). Nothing persists a `seq` to point at — the one cursor that takes one,
 * `list({ afterSeq })`, has no caller outside a test.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JairaDb } from "./db";
import { noteRemoved, noteWriting, noteWritten } from "./fileLedger";

/** One line of a task's journal — the row, minus the id the database assigns. */
export interface JournalLine {
  type: string;
  /** ISO 8601, because a file is read by people. `created_at` keeps the epoch millis. */
  timestamp: string;
  taskId: string;
  instanceId?: string;
  event: EngineEvent | RewoundEvent;
}

/**
 * A REWIND, as the append-only file records one: which earlier lines are no longer part of the
 * journal (see `cut.ts`).
 *
 * The lines are named by their PHYSICAL ordinal in this file — the position among every line the
 * file holds, tombstones included — because that is the one coordinate a file has that nothing
 * re-mints: the table's `seq` is assigned on replay and written down nowhere. Replay applies
 * tombstones in order and inserts what survives, so the deleted events never reach the table again
 * and the bytes stay where a merge can still see them.
 */
export interface RewoundEvent {
  type: typeof REWOUND;
  lines: number[];
}

export const REWOUND = "jaira.rewound";

export function isRewound(line: JournalLine): line is JournalLine & { event: RewoundEvent } {
  return line.type === REWOUND;
}

/** Where a task's journal lives. */
export function journalFileFor(journalDir: string, taskId: string): string {
  return join(journalDir, sanitize(taskId), "journal.jsonl");
}

/**
 * Task ids are minted (`t-…`), so they cannot carry a separator today. Checked anyway, because a
 * path built from a value that turns out to be caller-supplied is the ordinary way a writer escapes
 * its own directory.
 */
function sanitize(segment: string): string {
  const clean = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean === "" || clean === "." || clean === ".." ? "_" : clean;
}

/**
 * Append one event, synchronously.
 *
 * `appendFileSync` rather than a held handle: a run writes a few events a second, and a handle would
 * have to be closed by someone on every path a run can end — including the ones where the process is
 * being killed, which is exactly when the last line matters most.
 */
export function appendJournal(journalDir: string, line: JournalLine): void {
  const file = journalFileFor(journalDir, line.taskId);
  mkdirSync(join(journalDir, sanitize(line.taskId)), { recursive: true });
  noteWriting(file);
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  noteWritten(file);
}

/** The journal files a directory holds, in a deterministic order. */
export function journalFiles(journalDir: string): Array<{ taskId: string; file: string }> {
  if (!existsSync(journalDir)) return [];
  const out: Array<{ taskId: string; file: string }> = [];
  for (const taskId of readdirSync(journalDir).sort()) {
    const file = join(journalDir, taskId, "journal.jsonl");
    if (existsSync(file)) out.push({ taskId, file });
  }
  return out;
}

/**
 * Read one file into lines, skipping what will not parse.
 *
 * Skipped rather than thrown, and this is the case it is for: a git merge of two appends can leave a
 * conflict marker in the middle of a file. Refusing to open the project would make one unmergeable
 * line cost the whole history; dropping it costs one event and leaves everything either side
 * readable. A truncated last line — a process killed mid-append — is the same case.
 */
export function readJournalFile(file: string): JournalLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as JournalLine;
      if (typeof parsed?.type === "string" && typeof parsed.taskId === "string") out.push(parsed);
    } catch {
      // See above: one unreadable line is one event, not the file.
    }
  }
  return out;
}

/**
 * Replay every run's file into the journal table.
 *
 * Returns the number of rows inserted, or `undefined` when there is nothing on disk at all — the
 * case where the files are instead written from the database (an export, `fileStorage.ts`).
 */
export function replayJournal(db: JairaDb, journalDir: string): number | undefined {
  const files = journalFiles(journalDir);
  if (files.length === 0) return undefined;
  const insert = db.prepare(
    `INSERT INTO state_machine_events (task_id, instance_id, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let rows = 0;
  db.transaction(() => {
    for (const { file } of files) {
      for (const { line } of effectiveLines(file)) {
        insert.run(
          line.taskId,
          line.instanceId ?? null,
          line.type,
          JSON.stringify(line.event),
          Date.parse(line.timestamp) || 0,
        );
        rows++;
      }
    }
  })();
  return rows;
}

/**
 * The lines a file still stands for, each with the physical ordinal it sits at.
 *
 * Tombstones are applied in order and are not themselves lines of the journal: what comes back is
 * exactly what a replay inserts, in the order it inserts it — which is also how a rewind maps the
 * table's rows back onto the file (see `cut.ts`): the n-th surviving line IS the n-th row.
 */
export function effectiveLines(file: string): Array<{ line: JournalLine; ordinal: number }> {
  const physical = readJournalFile(file);
  const dropped = new Set<number>();
  for (const line of physical) {
    if (isRewound(line)) for (const ordinal of line.event.lines) dropped.add(ordinal);
  }
  const out: Array<{ line: JournalLine; ordinal: number }> = [];
  for (const [ordinal, line] of physical.entries()) {
    if (isRewound(line) || dropped.has(ordinal)) continue;
    out.push({ line, ordinal });
  }
  return out;
}

/** Say that lines are gone — see {@link RewoundEvent}. */
export function appendRewound(journalDir: string, taskId: string, lines: readonly number[], atMs = Date.now()): void {
  appendJournal(journalDir, {
    type: REWOUND,
    timestamp: new Date(atMs).toISOString(),
    taskId,
    event: { type: REWOUND, lines: [...lines] },
  });
}

/** Delete a task's whole journal directory — what deleting the task does, so a pull cannot bring it back. */
export function removeTaskJournal(journalDir: string, taskId: string): void {
  rmSync(join(journalDir, sanitize(taskId)), { recursive: true, force: true });
  noteRemoved(join(journalDir, sanitize(taskId)));
}

/**
 * Write tasks' journal files from the table — what a journal just put in files starts from, so its
 * files hold everything the database does (decision 0018 §11). Returns the lines written.
 */
export function exportJournal(db: JairaDb, journalDir: string, taskIds: readonly string[]): number {
  const read = db.prepare(`SELECT instance_id, type, payload_json, created_at FROM state_machine_events WHERE task_id = ? ORDER BY seq`);
  let written = 0;
  for (const taskId of taskIds) {
    const rows = read.all(taskId) as Array<{ instance_id: string | null; type: string; payload_json: string; created_at: number }>;
    removeTaskJournal(journalDir, taskId);
    if (rows.length === 0) continue;
    const lines = rows.map((row) =>
      JSON.stringify({
        type: row.type,
        timestamp: new Date(row.created_at).toISOString(),
        taskId,
        ...(row.instance_id !== null ? { instanceId: row.instance_id } : {}),
        event: JSON.parse(row.payload_json) as unknown,
      } satisfies Omit<JournalLine, "event"> & { event: unknown }),
    );
    mkdirSync(join(journalDir, sanitize(taskId)), { recursive: true });
    writeFileSync(journalFileFor(journalDir, taskId), lines.join("\n") + "\n", "utf8");
    noteWritten(journalFileFor(journalDir, taskId));
    written += rows.length;
  }
  return written;
}
