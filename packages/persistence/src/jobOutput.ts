/**
 * What a child process printed, kept — bounded, batched, and readable afterwards.
 *
 * An agent that fails prints the reason on stderr. JaiRA sent that stream to `/dev/null`, so "the
 * agent exited 1" was the whole story of every failure. Now it is piped (and unconditionally drained
 * — see `agentSpawn`), which raises two questions this module answers.
 *
 * **How much to keep.** A head and a tail, and nothing in between. The interesting parts of a failing
 * process's output are its first error and its last line; the middle is repetition, and a 10 MB
 * install log is not evidence, it is a denial of service on the database. What was elided is COUNTED
 * rather than hidden, because a reader who cannot see the gap will misread the tail as the whole.
 *
 * **How often to write.** Not per chunk. `better-sqlite3` is synchronous and this runs on the Electron
 * main thread, so one INSERT per `data` event on a chatty child is a stutter in the UI for output
 * nobody is reading yet. Flushed on a debounce while running, and once more at exit — so a live tail
 * has something to read and a finished process has everything it printed.
 */
import type { JairaDb } from "./db";

/** Per stream, per job. Generous enough to hold a stack trace at each end. */
const DEFAULT_KEEP_BYTES = 256 * 1024;
const DEFAULT_FLUSH_MS = 500;

// The wire shape lives in `@jaira/shared`, for the reason `jobs.ts` gives.
import type { JobOutputChunk } from "@jaira/shared";
export type { JobOutputChunk } from "@jaira/shared";

export interface JobOutputSinkOptions {
  keepBytes?: number;
  flushMs?: number;
  /** Injected so a test need not wait on a real timer. */
  now?: () => number;
}

interface Buffered {
  head: string;
  tail: string;
  /** Bytes elided between the two ends. */
  dropped: number;
}

export class JobOutputSink {
  private readonly buffers = new Map<string, Buffered>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly keepBytes: number;
  private readonly flushMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: JairaDb,
    options: JobOutputSinkOptions = {},
  ) {
    this.keepBytes = options.keepBytes ?? DEFAULT_KEEP_BYTES;
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Take a chunk. Never touches the database — that is {@link flush}'s job.
   *
   * The head fills first; everything after it rolls through the tail, and what falls out of the tail
   * is added to `dropped`. So the two ends are always the two ends, whatever arrives in between — and
   * a short process whose whole output fits in the head has no gap at all.
   */
  write(jobId: number, stream: "stdout" | "stderr", chunk: string): void {
    const key = `${jobId}:${stream}`;
    const at = this.buffers.get(key) ?? { head: "", tail: "", dropped: 0 };
    let rest = chunk;
    if (at.head.length < this.keepBytes) {
      const room = this.keepBytes - at.head.length;
      at.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest.length > 0) {
      at.tail += rest;
      if (at.tail.length > this.keepBytes) {
        const over = at.tail.length - this.keepBytes;
        at.dropped += over;
        at.tail = at.tail.slice(over);
      }
    }
    this.buffers.set(key, at);
    this.schedule();
  }

  /** Write what has accumulated. Idempotent: a flush with nothing new writes nothing. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // In ONE transaction. Each stream is deleted and rewritten, so a reader landing between the two
    // would see the job's output as empty — which is indistinguishable from a process that printed
    // nothing, and happens every 500ms while one is running.
    this.db.transaction(() => this.write0())();
  }

  private write0(): void {
    const insert = this.db.prepare(
      `INSERT INTO job_output (job_id, stream, seq, chunk, dropped, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const clear = this.db.prepare(`DELETE FROM job_output WHERE job_id = ? AND stream = ?`);
    for (const [key, at] of this.buffers) {
      const [jobId, stream] = key.split(":") as [string, "stdout" | "stderr"];
      if (at.head.length === 0 && at.tail.length === 0) continue;
      // REWRITTEN whole, both ends, every flush. The head is not append-only until it is FULL — a
      // short-lived process's entire output lives in it and keeps growing — and a tail that appended
      // instead of replacing would show its last window once per flush. Two rows per stream, so
      // rewriting them costs less than the bookkeeping needed to avoid it.
      clear.run(Number(jobId), stream);
      insert.run(Number(jobId), stream, 0, at.head, 0, this.now());
      if (at.tail.length > 0) insert.run(Number(jobId), stream, 1, at.tail, at.dropped, this.now());
    }
  }

  /** Flush and forget one job — what an exit does. */
  end(jobId: number): void {
    this.flush();
    for (const key of [...this.buffers.keys()]) if (key.startsWith(`${jobId}:`)) this.buffers.delete(key);
  }

  /** Drop everything pending without writing it. For a session closing under a run. */
  discard(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffers.clear();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }
}

/**
 * One job's captured output, oldest first. `dropped` marks where the middle was elided.
 *
 * WHOLE each time, with no cursor. {@link JobOutputSink.flush} rewrites both ends on every flush, so
 * row ids change while a process runs — an `afterId` over them would re-deliver everything and call
 * it new. Two rows per stream is a cheap thing to re-read.
 */
export function jobOutput(
  db: JairaDb,
  request: { jobId: number; stream?: "stdout" | "stderr"; limit?: number },
): JobOutputChunk[] {
  const rows = db
    .prepare(
      `SELECT id, job_id, stream, seq, chunk, dropped, created_at FROM job_output
        WHERE job_id = ?
          ${request.stream === undefined ? "" : "AND stream = ?"}
        ORDER BY stream, seq, id
        LIMIT ?`,
    )
    .all(
      ...([
        request.jobId,
        ...(request.stream === undefined ? [] : [request.stream]),
        request.limit ?? 200,
      ] as never[]),
    ) as Array<{
    id: number;
    job_id: number;
    stream: string;
    seq: number;
    chunk: string;
    dropped: number;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    stream: row.stream as "stdout" | "stderr",
    seq: row.seq,
    chunk: row.chunk,
    dropped: row.dropped,
    createdAt: row.created_at,
  }));
}
