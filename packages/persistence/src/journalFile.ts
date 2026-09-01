/**
 * The journal as files — one JSONL per run (DESIGN §4.4).
 *
 * This is the write half of the storage policy, for the first concern to get one. The file is the
 * TRUTH and the table is an index replayed from it: an event is appended here synchronously and
 * mirrored into the (shadowed) table in the same call, so nothing is ever only in memory and there
 * is no flush policy to lose a journal across a crash. That inversion is the whole reason the design
 * does not describe a cache.
 *
 * ## One file per task
 *
 * `<system>/journal/<taskId>/journal.jsonl`. A task IS one machine now (Identity and Resume §05) —
 * a resume continues the same journal and a re-run is a new task with a new directory — so the
 * per-run split has nothing left to separate. Two people running tasks on one branch still write
 * different filenames (different task ids), so their appends never conflict — and after a pull,
 * both replay into the same table and appear on the board. Files written before the collapse are
 * named `<runId>.jsonl`; they replay first, in run order, and nothing writes them any more.
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
 * ORDER is the order; a replay inserts in that order and lets the column re-mint, which preserves
 * every ordering anything actually asks for (`ORDER BY seq` within a run, and `created_at` carries
 * the real time regardless). Nothing persists a `seq` to point at — the one cursor that takes one,
 * `list({ afterSeq })`, has no caller outside a test.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JairaDb } from "./db";

/** One line of a task's journal — the row, minus the id the database assigns. */
export interface JournalLine {
  type: string;
  /** ISO 8601, because a file is read by people. `created_at` keeps the epoch millis. */
  timestamp: string;
  taskId: string;
  /** Only on lines written before the runs collapse (migration 16) — read, never written. */
  runId?: number;
  /** `number` only on lines journaled before instance ids became durable strings. */
  instanceId?: string | number;
  event: EngineEvent;
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
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

/** The journal files a directory holds, in a deterministic order. */
export function journalFiles(journalDir: string): Array<{ taskId: string; file: string }> {
  if (!existsSync(journalDir)) return [];
  const out: Array<{ taskId: string; file: string }> = [];
  for (const taskId of readdirSync(journalDir).sort()) {
    const dir = join(journalDir, taskId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // a file where a task directory was expected — not ours to explain
    }
    // Legacy per-run files first, in run order, then the task file — so `seq` is re-minted in the
    // order things happened: the old runs, then everything the collapsed journal appended.
    const legacy = names
      .filter((n) => n.endsWith(".jsonl") && Number.isInteger(Number(n.slice(0, -".jsonl".length))))
      .sort((a, b) => Number(a.slice(0, -".jsonl".length)) - Number(b.slice(0, -".jsonl".length)));
    for (const name of legacy) out.push({ taskId, file: join(dir, name) });
    if (names.includes("journal.jsonl")) out.push({ taskId, file: join(dir, "journal.jsonl") });
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
 * Returns the number of rows inserted, or `undefined` when there is nothing on disk at all — which
 * is the signal the caller needs to seed the shadow from `main` instead. An EMPTY journal directory
 * is not the same as no journal: the first means the files are the truth and there is no history,
 * the second means this concern has just been switched on and the history is still in the database.
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
      for (const line of readJournalFile(file)) {
        insert.run(
          line.taskId,
          // Stringified for lines journaled before ids were strings; `-1` was a sentinel for absence.
          line.instanceId === undefined || line.instanceId === -1 ? null : String(line.instanceId),
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

/** Delete a task's whole journal directory — what deleting the task does now that the file is the truth. */
export function removeTaskJournal(journalDir: string, taskId: string): void {
  rmSync(join(journalDir, sanitize(taskId)), { recursive: true, force: true });
}
