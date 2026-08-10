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
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import type { LogEntry, LogLevel } from "@jaira/shared";

/** Enough to cover a long run without becoming a memory leak nobody notices. */
const RING = 2000;

export interface DiagnosticsOptions {
  /** Where the NDJSON mirror goes. Absent ⇒ memory only, which is what a test wants. */
  dir?: string;
  now?: () => number;
  /** Called for every entry — how the renderer hears about one without polling. */
  publish?: (entry: LogEntry) => void;
}

export class Diagnostics {
  private readonly entries: LogEntry[] = [];
  private id = 0;
  private warnedAboutFile = false;

  constructor(private readonly options: DiagnosticsOptions = {}) {}

  /**
   * Record one entry.
   *
   * NEVER THROWS. This is the channel other code reports failures through, and a reporting channel
   * that can fail is one every caller has to defend against — which is how the swallowing started.
   */
  log(entry: Omit<LogEntry, "id" | "at">): LogEntry {
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

  /** The tail, oldest first. `afterId` makes it a cursor for a panel that is following along. */
  list(request: { afterId?: number; level?: LogLevel; source?: string; project?: string; limit?: number } = {}): LogEntry[] {
    const limit = request.limit ?? 500;
    const matched = this.entries.filter(
      (e) =>
        (request.afterId === undefined || e.id > request.afterId) &&
        (request.level === undefined || RANK[e.level] >= RANK[request.level]) &&
        (request.source === undefined || e.source === request.source) &&
        (request.project === undefined || e.project === request.project),
    );
    // The NEWEST when there are more than asked for: a tail is what a log panel opens on.
    return matched.slice(-limit);
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

/** Severity order, so a filter of `warn` means "warn and worse" rather than "warn exactly". */
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Everything a caller might attach. Kept as one helper so call sites stay one line. */
export type LogDetail = JsonValue;
