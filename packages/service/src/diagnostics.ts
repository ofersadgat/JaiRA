/**
 * What the app is doing, and what went wrong doing it.
 *
 * There was no such thing. Not a logger, not a channel, not a `console.log` — `service.ts`,
 * `runtime/src` and `persistence/src` contain zero between them. Several failure paths are swallowed
 * ON PURPOSE and should stay swallowed: a snapshot that will not load must not blank the board, and a
 * throwing `ExecObserver` must not change a command's outcome. What was missing is the second half of
 * that bargain — somewhere for the swallowed thing to be seen.
 *
 * ## In memory, and on disk, but not in the database
 *
 * "The system project could not be opened" has no project whose database could hold it, and that is
 * exactly the entry someone will be looking for. So the ring is in memory and the mirror is a file.
 * Neither is a store to query; both are a tail to read.
 *
 * The NDJSON file earns its place separately: it survives a crash, it is greppable without the app,
 * and it is the only form of this that is useful in a bug report.
 *
 * ## And read back, a page at a time
 *
 * The mirror is also what the Logs panel READS (see {@link Diagnostics.read}). A panel served from
 * the ring answers "what happened" only for the launch you are in, and the question is almost always
 * about the one before — the run that failed last night, the crash that made you restart. The file
 * was already on disk holding exactly that, and nothing read it.
 *
 * Read BACKWARDS, newest entry first, a page at a time. That is not an optimisation: a log is read
 * from its recent end, so the page a reader wants first is the last one written, and paging towards
 * the past is the only direction that never needs the middle. Nothing is held in memory to make it
 * work — the ring stays what it always was, a live tail for the case where there is no file.
 *
 * ## And gated
 *
 * A {@link LogPolicy} decides what is worth keeping BEFORE it is written, per scope and per tag —
 * the same policy `@declarative-ai/log` applies to the libraries, applied here to the app's own
 * entries so both streams answer to one setting.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import type { LogEntry, LogLevel, LogOverride, LogPage, LogPolicy, LogQuery } from "@jaira/shared";

/**
 * The live tail, for the case where there is no file.
 *
 * Not what the panel reads — that is {@link Diagnostics.read}, straight off the mirror. This is what
 * a memory-only `Diagnostics` (a test, a disk that cannot be written) has instead, and it is bounded
 * because a ring that grows is a leak nobody notices.
 */
const RING = 2000;

/** How much of a day's mirror is read in one step of a backwards scan. */
const CHUNK = 128 * 1024;

/**
 * The most a single page may read before giving up and handing back a cursor.
 *
 * A filter that matches nothing would otherwise scan every day on disk to answer one request, on the
 * main process, while the window waits. Past this the reader returns what it has WITH a cursor, and
 * the panel — which is already asking for more as it scrolls — simply asks again.
 */
const SCAN_LIMIT = 8 * 1024 * 1024;

const PAGE = 200;

/** What {@link Diagnostics.mirror} writes and the backwards reader below reads. */
const DAY_FILE = /^jaira-\d{4}-\d{2}-\d{2}\.log$/;

export interface DiagnosticsOptions {
  /** Where the NDJSON mirror goes. Absent ⇒ memory only, which is what a test wants. */
  dir?: string;
  now?: () => number;
  /** Called for every entry — how the renderer hears about one without polling. */
  publish?: (entry: LogEntry) => void;
  /** What to keep. Absent ⇒ everything, which is what this was before the policy existed. */
  policy?: LogPolicy;
  /** The sampling die. Injected so a test can decide rather than guess. */
  random?: () => number;
}

export class Diagnostics {
  private readonly entries: LogEntry[] = [];
  private id = 0;
  private warnedAboutFile = false;

  /** What is worth keeping. Swapped by {@link setPolicy} when the setting changes. */
  private policy: LogPolicy | undefined;

  constructor(private readonly options: DiagnosticsOptions = {}) {
    this.policy = options.policy;
  }

  /**
   * Change what is kept, without restarting.
   *
   * The point of the whole arrangement: a person turns `run` down to `warn` because a run is
   * flooding them, or turns it up to `debug` because one is stuck, and the next entry obeys. A
   * policy that only applied at launch would be a policy you had to quit the app to use.
   */
  setPolicy(policy: LogPolicy | undefined): void {
    this.policy = policy;
  }

  /**
   * Is this entry worth keeping?
   *
   * ERRORS ALWAYS ARE. Not as a convenience: a policy that can drop an error makes every absence
   * ambiguous, and a log you cannot reason about the absences in is not evidence of anything.
   *
   * Otherwise the most specific rule wins — a tag over a scope, and among scopes the longest
   * dot-path that is the source or an ancestor of it — and the floor applies where none matches.
   */
  private keeps(entry: Omit<LogEntry, "id" | "at">): boolean {
    const policy = this.policy;
    if (policy === undefined || entry.level === "error") return true;
    const rule = matchOverride(policy, entry.source, tagOf(entry));
    const minLevel = rule?.minLevel ?? policy.minLevel;
    if (RANK[entry.level] < RANK[minLevel]) return false;
    const rate = rule?.samplingRate;
    return rate === undefined || rate >= 1 || (this.options.random ?? Math.random)() < rate;
  }

  /**
   * Record one entry.
   *
   * NEVER THROWS. This is the channel other code reports failures through, and a reporting channel
   * that can fail is one every caller has to defend against — which is how the swallowing started.
   */
  log(entry: Omit<LogEntry, "id" | "at">): LogEntry | undefined {
    if (!this.keeps(entry)) return undefined;
    const full: LogEntry = { ...entry, id: ++this.id, at: (this.options.now ?? Date.now)() };
    this.entries.push(full);
    if (this.entries.length > RING) this.entries.splice(0, this.entries.length - RING);
    try {
      this.options.publish?.(full);
    } catch {
      // A listener that throws must not take the reporter down with it.
    }
    this.mirror(full);
    return full;
  }

  /**
   * A page of the log, newest first — what the Logs panel reads.
   *
   * From the MIRROR when there is one, which is what makes the answer span every launch on disk
   * rather than the one this process is in; from the ring when there is not, which is a test and a
   * disk that could not be written. Both honour the same filters, applied while scanning rather than
   * after, so a search reaches the past instead of whatever happened to be in memory.
   */
  read(query: LogQuery = {}): LogPage {
    const dir = this.options.dir;
    const limit = Math.max(1, Math.min(query.limit ?? PAGE, 1000));
    if (dir === undefined || !existsSync(dir)) return this.readRing(query, limit);
    try {
      return readBack(dir, query, limit);
    } catch {
      // The mirror is a convenience over the ring, never a replacement for having an answer.
      return this.readRing(query, limit);
    }
  }

  /**
   * The same page, out of memory — the fallback, and the whole of the answer for a memory-only
   * `Diagnostics`. The cursor is an id, because that is what identifies a position in a ring.
   */
  private readRing(query: LogQuery, limit: number): LogPage {
    const before = query.before === undefined ? undefined : Number(query.before);
    const matched = this.entries.filter(
      (e) => (before === undefined || Number.isNaN(before) || e.id < before) && matches(e, query),
    );
    const page = matched.slice(-limit).reverse();
    const oldest = page.at(-1);
    // A cursor only when something older might match: the reader has the whole ring in hand, so it
    // can say for certain rather than making the caller ask again to find out.
    const more = oldest !== undefined && matched.length > page.length;
    return { entries: page, ...(more && oldest !== undefined ? { cursor: String(oldest.id) } : {}) };
  }

  private mirror(entry: LogEntry): void {
    const dir = this.options.dir;
    if (dir === undefined) return;
    try {
      mkdirSync(dir, { recursive: true });
      const day = new Date(entry.at).toISOString().slice(0, 10);
      appendFileSync(join(dir, `jaira-${day}.log`), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // A read-only or full disk must not turn every diagnostic into a second failure. Reported once,
      // in memory, so the absence of a file is itself visible somewhere.
      if (this.warnedAboutFile) return;
      this.warnedAboutFile = true;
      // Through `log`, not straight onto the ring: pushed to the renderer like every other entry, and
      // trimmed like every other entry. Written directly, a panel already open never saw the one
      // message explaining why its file is missing.
      this.log({
        level: "warn",
        source: "app",
        message: "the diagnostics log file could not be written; entries are in memory only",
      });
    }
  }
}

/**
 * A position in the mirror: which day's file, and the byte the entry begins at.
 *
 * Spelled `<day>:<offset>` on the wire and opaque to everyone but this file. It has to name the FILE
 * and not just a time, because two entries can share a millisecond and because a scan that resumed
 * by timestamp would have to re-read a day to find its place.
 */
interface Spot {
  day: string;
  offset: number;
}

function parseSpot(cursor: string | undefined): Spot | undefined {
  if (cursor === undefined) return undefined;
  const cut = cursor.lastIndexOf(":");
  if (cut <= 0) return undefined;
  const offset = Number(cursor.slice(cut + 1));
  if (!Number.isInteger(offset) || offset < 0) return undefined;
  return { day: cursor.slice(0, cut), offset };
}

const spotCursor = (spot: Spot): string => `${spot.day}:${spot.offset}`;

/**
 * A page of entries read BACKWARDS from the mirror, newest first.
 *
 * The shape of the walk: newest day first, and within a day the last {@link CHUNK} bytes first,
 * stepping back a chunk at a time. Each chunk is split into lines and consumed from the END, which
 * is what makes the whole thing newest-first without ever sorting anything or holding a day in
 * memory.
 *
 * A chunk that does not begin at byte 0 begins mid-line, so its first fragment is joined onto the
 * chunk before it rather than parsed — otherwise every 128 KB boundary would silently eat an entry.
 *
 * Stops on three conditions, and the difference between them is what the cursor means: the page is
 * full (cursor ⇒ ask again), {@link SCAN_LIMIT} bytes were read without filling it (cursor ⇒ ask
 * again, this filter is sparse), or the oldest day ran out (NO cursor ⇒ that is all there is).
 */
function readBack(dir: string, query: LogQuery, limit: number): LogPage {
  const from = parseSpot(query.before);
  const days = readdirSync(dir)
    .filter((name) => DAY_FILE.test(name))
    // Lexical IS chronological for `jaira-YYYY-MM-DD.log`, which is why the name has that shape.
    .sort()
    .reverse()
    // Resuming: everything newer than the cursor's day has already been served.
    .filter((name) => from === undefined || name <= from.day);

  const entries: LogEntry[] = [];
  let scanned = 0;
  for (const day of days) {
    const file = join(dir, day);
    // Where this day's scan begins: the cursor's byte on the day it names, the end of the file on
    // every day older than it.
    let end = day === from?.day ? from.offset : statSync(file).size;
    if (end <= 0) continue;
    const fd = openSync(file, "r");
    try {
      /** The fragment the previous (later) chunk began with, waiting for the line it belongs to. */
      let overflow = "";
      while (end > 0) {
        const start = Math.max(0, end - CHUNK);
        const length = end - start;
        const buffer = Buffer.allocUnsafe(length);
        readSync(fd, buffer, 0, length, start);
        scanned += length;
        const text = buffer.toString("utf8") + overflow;
        const lines = text.split("\n");
        // The first piece is only a whole line when this chunk started at the beginning of the file.
        overflow = start === 0 ? "" : (lines.shift() ?? "");
        // Byte offsets are computed forwards from the chunk's start, so an entry's `Spot` is where
        // its line actually begins — the one thing the next page needs to resume exactly here.
        let at = start + Buffer.byteLength(overflow, "utf8") + (start === 0 ? 0 : 1);
        const spots: { spot: Spot; line: string }[] = [];
        for (const line of lines) {
          spots.push({ spot: { day, offset: at }, line });
          at += Buffer.byteLength(line, "utf8") + 1;
        }
        for (let i = spots.length - 1; i >= 0; i--) {
          const { spot, line } = spots[i]!;
          const parsed = parseEntry(line);
          if (parsed === undefined) continue;
          const entry = { ...parsed, id: spot.offset } as LogEntry;
          if (!matches(entry, query)) continue;
          entries.push(entry);
          if (entries.length >= limit) return { entries, cursor: spotCursor(spot) };
        }
        end = start;
        if (scanned >= SCAN_LIMIT) {
          // Out of budget, not out of log. The cursor is the chunk boundary rather than an entry:
          // nothing between here and it matched, so resuming from it loses nothing.
          return { entries, cursor: spotCursor({ day, offset: end }) };
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  // Ran out of days: no cursor, which is the reader's only way of saying "that is all there is".
  return { entries };
}

/**
 * Does this entry answer the question that was asked?
 *
 * `source` matches exactly or as a dot-path ancestor, the same rule the policy uses, so "show me
 * `jaira.persistence`" means the family and not one scope of it. `text` reaches into the DETAIL as
 * well as the message, because what a person types here is a file name or a frame.
 */
function matches(entry: LogEntry, query: LogQuery): boolean {
  if (query.level !== undefined && RANK[entry.level] < RANK[query.level]) return false;
  if (query.source !== undefined && query.source !== "" && !underScope(entry.source, query.source)) return false;
  if (query.project !== undefined && entry.project !== query.project) return false;
  const needle = query.text?.trim().toLowerCase();
  if (needle === undefined || needle === "") return true;
  if (entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)) return true;
  return entry.detail !== undefined && JSON.stringify(entry.detail).toLowerCase().includes(needle);
}

/** `a.b.c` is under `a.b` and under itself, and under nothing else. */
const underScope = (scope: string, ancestor: string): boolean => scope === ancestor || scope.startsWith(`${ancestor}.`);

/**
 * The rule that applies to a record, or none.
 *
 * A tag beats a scope: a tag says what KIND of record this is, wherever it came from, which is the
 * more specific of the two statements. Among scopes the longest ancestor wins, so a rule about
 * `jaira.persistence.views` overrules one about `jaira`, which is the only ordering that lets a
 * broad rule be written at all.
 */
function matchOverride(policy: LogPolicy, source: string, tag: string | undefined): LogOverride | undefined {
  if (tag !== undefined) {
    const hit = policy.overrides.find((o) => o.match === "tag" && o.key === tag);
    if (hit !== undefined) return hit;
  }
  let best: LogOverride | undefined;
  for (const o of policy.overrides) {
    if (o.match !== "scope" || !underScope(source, o.key)) continue;
    if (best === undefined || o.key.length > best.key.length) best = o;
  }
  return best;
}

/**
 * A record's classification tag, when a library set one.
 *
 * It arrives inside `detail` (see `entryOfRecord`, which puts everything that is not a pointer
 * there) rather than as a field of its own — a tag is a library's vocabulary, and promoting every
 * library's vocabulary into this app's type is how a shared shape stops being shared.
 */
function tagOf(entry: Omit<LogEntry, "id" | "at">): string | undefined {
  const detail = entry.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const tag = (detail as Record<string, unknown>)["tag"];
  return typeof tag === "string" ? tag : undefined;
}

/**
 * One mirrored line, back into an entry — or nothing.
 *
 * Checked rather than cast. The file is appended to by every launch, including one that was killed
 * mid-write, so a truncated last line is the NORMAL case after a crash; and a log reader that throws
 * on the evidence of a crash is a log reader that fails exactly when it is needed. The `id` is
 * dropped here because the caller assigns its own — see {@link Diagnostics.hydrate}.
 */
function parseEntry(line: string): Omit<LogEntry, "id"> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const raw = JSON.parse(line) as Partial<LogEntry>;
    if (typeof raw.at !== "number" || typeof raw.message !== "string" || typeof raw.source !== "string") {
      return undefined;
    }
    if (raw.level === undefined || !(raw.level in RANK)) return undefined;
    // The id is dropped rather than kept: it was this entry's position in the launch that wrote it.
    const { id: _dropped, ...rest } = raw as LogEntry;
    return rest;
  } catch {
    return undefined;
  }
}

/**
 * What was caught, as a `detail` — spread into a `log` call.
 *
 * Because a message is not a report. `${(e as Error).message}` is the shape nearly every catch block
 * in this app reaches for, and it produces entries like `recording a child process failed: ENOENT` —
 * true, unactionable, and identical for four different callers. The stack is the half that says
 * WHICH, it is already sitting on the error, and the only reason it was being dropped is that
 * attaching it took three lines of ternary at every site. It takes one now.
 *
 * Returns nothing at all for a non-`Error` with no extras, so a site that spreads this never invents
 * an empty `detail` for a reader to expand into nothing.
 */
export function stackDetail(error: unknown, extra: Record<string, JsonValue> = {}): { detail?: JsonValue } {
  const stack = error instanceof Error ? error.stack : undefined;
  const detail: Record<string, JsonValue> = { ...extra, ...(stack === undefined ? {} : { stack }) };
  return Object.keys(detail).length === 0 ? {} : { detail: detail as JsonValue };
}

/** Severity order, so a filter of `warn` means "warn and worse" rather than "warn exactly". */
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Everything a caller might attach. Kept as one helper so call sites stay one line. */
export type LogDetail = JsonValue;
