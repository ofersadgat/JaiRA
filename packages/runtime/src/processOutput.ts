/**
 * Reading a process JaiRA did not spawn (decision 0032, ruling 6): where its stdout and stderr go, and,
 * where that can be read, following it from the first read on.
 *
 * | Source       | When                                              | What is read                                   |
 * | ------------ | ------------------------------------------------- | ---------------------------------------------- |
 * | `file`       | a stream is a regular file (`> log`)              | the file's last {@link HISTORY_BYTES}, then what it grows by |
 * | `console`    | Windows: a stream is a console                    | the console's screen and scrollback, then what is new on it |
 * | `unreadable` | a pipe or socket another program holds, a terminal device (POSIX), closed, or no access | nothing; why |
 *
 * Where a stream goes is the platform's: Linux reads `/proc/<pid>/fd/1` and `fd/2` (here, with no
 * backend); macOS asks `lsof` and Windows the process's standard handles (the System backends'
 * `outputTargets`). A file is opened once and held, so a file renamed or deleted under the writer is
 * still the writer's; one cut back is read again from its start.
 *
 * A follower starts at the first read or wait for its pid and keeps reading on its own (a file every
 * {@link FILE_POLL_MS}, a console every {@link CONSOLE_POLL_MS}) so what scrolls off a console between
 * reads is kept. It ends with its process — after one last read — or after {@link FOLLOW_IDLE_MS}
 * without a read. Like the session's own processes (`sessionProcesses.ts`), each read answers what is
 * new since the last, or the last `tail` lines, or from `since`; the last {@link OUTPUT_KEEP}
 * characters are kept.
 */
import { closeSync, fstatSync, openSync, readSync, readlinkSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { isAlive } from "./leftRunning";
import { OUTPUT_KEEP, PROCESS_WAIT_MAX_MS } from "./sessionProcesses";
import type { OutputTarget, OutputTargets, SystemBackend } from "./system/types";

/** How much of a file's past the first read answers with. */
export const HISTORY_BYTES = 1_000_000;
/** How often a followed file is looked at. */
export const FILE_POLL_MS = 500;
/** How often a followed console is read. */
export const CONSOLE_POLL_MS = 2_000;
/** A follower no one has read for this long is let go. */
export const FOLLOW_IDLE_MS = 10 * 60_000;
/** The most one look at a file reads; past it, the middle is skipped and said. */
const POLL_MAX_BYTES = 4_000_000;

/** What a platform offers for finding and reading another program's output. */
export interface OutputSource {
  targets(pid: number): Promise<OutputTargets>;
  /** Windows: the console's screen and scrollback, rows joined by `\n`. */
  readConsole?(pid: number): Promise<string>;
  /** The path a file stream is opened by, where it differs from the path said (Linux: `/proc/<pid>/fd/<n>`). */
  openPath?(pid: number, stream: "stdout" | "stderr", path: string): string;
}

/** The platform's way of finding where a process's output goes, or `undefined` where there is none. */
export function outputSourceFor(backend: SystemBackend | undefined, platform: NodeJS.Platform = process.platform): OutputSource | undefined {
  if (backend?.outputTargets !== undefined) {
    return {
      targets: (pid) => backend.outputTargets!(pid),
      ...(backend.readConsole !== undefined ? { readConsole: (pid: number) => backend.readConsole!(pid) } : {}),
    };
  }
  if (platform === "linux") return { targets: async (pid) => procTargets(pid), openPath: (pid, stream) => `/proc/${pid}/fd/${stream === "stdout" ? 1 : 2}` };
  return undefined;
}

// --- where it goes ------------------------------------------------------------------------------

/** Linux: the uid `pid` runs as (its `/proc` entry's owner), or `undefined` when it does not run. */
export function procOwner(pid: number): number | undefined {
  try {
    return statSync(`/proc/${pid}`).uid;
  } catch {
    return undefined;
  }
}

/** Linux: each stream's `/proc/<pid>/fd/<n>` link, read and placed. */
export function procTargets(pid: number): OutputTargets {
  const one = (fd: 1 | 2): OutputTarget => {
    const link = `/proc/${pid}/fd/${fd}`;
    let target: string;
    try {
      target = readlinkSync(link);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      let exists = false;
      try {
        statSync(`/proc/${pid}`);
        exists = true;
      } catch {
        // Gone.
      }
      return procLinkTarget(undefined, code, exists);
    }
    let kind: ProcLinkStat | undefined;
    try {
      const st = statSync(link);
      kind = st.isFile() ? "file" : st.isCharacterDevice() ? "char" : st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : "other";
    } catch {
      // A deleted file still stats through its link; anything else answers from its name.
    }
    return procLinkTarget(target, undefined, true, kind);
  };
  return { stdout: one(1), stderr: one(2) };
}

export type ProcLinkStat = "file" | "char" | "fifo" | "socket" | "other";

/**
 * One `/proc/<pid>/fd/<n>` link placed: `target` is what it reads as (`/var/log/x.log`,
 * `/var/log/x.log (deleted)`, `pipe:[123]`, `socket:[456]`, `/dev/pts/3`, `/dev/null`), `error` the
 * code reading it failed with, `exists` whether the process does.
 */
export function procLinkTarget(target: string | undefined, error?: string, exists = true, stat?: ProcLinkStat): OutputTarget {
  if (target === undefined) {
    if (!exists) return { kind: "denied", why: "it is not running" };
    if (error === "EACCES" || error === "EPERM") return { kind: "denied", why: "it is another account's process, whose descriptors JaiRA may not read" };
    return { kind: "none" };
  }
  if (/^pipe:\[/.test(target)) return { kind: "pipe" };
  if (/^socket:\[/.test(target)) return { kind: "socket" };
  if (!target.startsWith("/")) return { kind: "none" };
  const path = target.replace(/ \(deleted\)$/, "");
  if (path === "/dev/null") return { kind: "none" };
  if (/^\/dev\/(pts\/|tty|console$)/.test(path)) return { kind: "tty", path };
  if (stat === "fifo") return { kind: "pipe" };
  if (stat === "socket") return { kind: "socket" };
  if (stat === "char" || (stat === undefined && path.startsWith("/dev/"))) return { kind: "none" };
  if (stat === "other") return { kind: "none" };
  return { kind: "file", path };
}

/**
 * macOS: `lsof -a -p <pid> -d 1,2 -F ftn` placed — each descriptor's `f`, its `t` (type: `REG`, `CHR`,
 * `PIPE`, `FIFO`, `unix`, `IPv4`…) and `n` (name). `failed`: why lsof listed nothing, when it did not.
 */
export function lsofTargets(text: string, failed?: string): OutputTargets {
  const seen: Record<string, { type?: string; name?: string }> = {};
  let fd: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const field = line[0]!;
    const value = line.slice(1);
    if (field === "f") seen[(fd = value)] = {};
    else if (fd !== undefined && field === "t") seen[fd]!.type = value;
    else if (fd !== undefined && field === "n") seen[fd]!.name = value;
  }
  const one = (n: "1" | "2"): OutputTarget => {
    const entry = seen[n];
    if (entry === undefined) return Object.keys(seen).length === 0 && failed !== undefined ? { kind: "denied", why: failed } : { kind: "none" };
    const type = (entry.type ?? "").toUpperCase();
    const name = entry.name ?? "";
    if (type === "REG") return { kind: "file", path: name };
    if (type === "PIPE" || type === "FIFO") return { kind: "pipe" };
    if (type === "UNIX" || type === "IPV4" || type === "IPV6" || type === "SOCK" || type === "SYSTM") return { kind: "socket" };
    if (type === "CHR") return name === "/dev/null" ? { kind: "none" } : /^\/dev\/(ttys|pts\/|tty|console)/.test(name) ? { kind: "tty", path: name } : { kind: "none" };
    return { kind: "none" };
  };
  return { stdout: one("1"), stderr: one("2") };
}

/** Why one stream cannot be read, said to the model. */
export function unreadableWhy(target: OutputTarget): string {
  switch (target.kind) {
    case "pipe":
      return "its output goes to a pipe another program holds";
    case "socket":
      return "its output goes to a socket another program holds";
    case "tty":
      return `its output goes to a terminal${target.path !== undefined ? ` (${target.path})` : ""} — another app's, which JaiRA cannot read`;
    case "none":
      return "its output goes nowhere (closed, or the null device)";
    case "denied":
      return target.why ?? "it could not be looked into";
    case "console":
      return "its output goes to a console, which only Windows can read";
    case "file":
      return `its file ${target.path ?? ""} could not be read`;
  }
}

/** Each stream as the answer says it: `file C:\x.log`, `console`, `pipe`… */
function streamSaid(target: OutputTarget): string {
  return target.kind === "file" || target.kind === "tty" ? `${target.kind} ${target.path ?? ""}`.trim() : target.kind === "denied" ? `unreadable: ${target.why ?? ""}` : target.kind;
}

// --- following ----------------------------------------------------------------------------------

interface Feed {
  /** What is new since the last look; the first look answers the history. */
  poll(): Promise<string>;
  close(): void;
}

/** A file, held open and read on from where the last look ended. */
export class FileFeed implements Feed {
  private readonly fd: number;
  private pos = 0;
  private decoder: StringDecoder;
  private readonly encoding: BufferEncoding;
  private started = false;
  /** Whether the first look began at byte 0. */
  whole = true;

  constructor(
    openPath: string,
    private readonly shownPath: string,
    private readonly notes: string[],
  ) {
    this.fd = openSync(openPath, "r");
    const bom = Buffer.alloc(2);
    const got = readSync(this.fd, bom, 0, 2, 0);
    this.encoding = got === 2 && bom[0] === 0xff && bom[1] === 0xfe ? "utf16le" : "utf8";
    this.decoder = new StringDecoder(this.encoding);
  }

  async poll(): Promise<string> {
    const size = fstatSync(this.fd).size;
    const utf16 = this.encoding === "utf16le";
    if (!this.started) {
      this.started = true;
      let start = Math.max(0, size - HISTORY_BYTES);
      if (utf16 && start % 2 === 1) start++;
      this.whole = start === 0;
      this.pos = start;
      let text = this.readTo(size);
      if (start > 0) {
        // Begun mid-file: from the first whole line on.
        const nl = text.indexOf("\n");
        if (nl >= 0 && nl < 4_096) text = text.slice(nl + 1);
      }
      return stripBom(text);
    }
    if (size < this.pos) {
      this.notes.push(`${this.shownPath} was cut back to ${size} bytes; read again from its start`);
      this.pos = 0;
      this.decoder = new StringDecoder(this.encoding);
      return stripBom(this.readTo(size));
    }
    if (size - this.pos > POLL_MAX_BYTES) {
      let skip = size - HISTORY_BYTES;
      if (utf16 && skip % 2 === 1) skip++;
      this.notes.push(`${this.shownPath} grew by ${size - this.pos} bytes at once; the first ${skip - this.pos} were skipped`);
      this.pos = skip;
      this.decoder = new StringDecoder(this.encoding);
    }
    return this.readTo(size);
  }

  private readTo(size: number): string {
    let text = "";
    const buffer = Buffer.alloc(Math.min(1 << 20, Math.max(1, size - this.pos)));
    while (this.pos < size) {
      const n = readSync(this.fd, buffer, 0, Math.min(buffer.length, size - this.pos), this.pos);
      if (n <= 0) break;
      this.pos += n;
      text += this.decoder.write(buffer.subarray(0, n));
    }
    return text;
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      // Closed already.
    }
  }
}

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** A Windows console, read whole each look and compared with the last. */
class ConsoleFeed implements Feed {
  private last: string[] | undefined;

  constructor(
    private readonly pid: number,
    private readonly readConsole: (pid: number) => Promise<string>,
  ) {}

  async poll(): Promise<string> {
    const rows = trimRows((await this.readConsole(this.pid)).split("\n"));
    const delta = this.last === undefined ? rows.join("\n") : consoleDelta(this.last, rows);
    this.last = rows;
    return delta;
  }

  close(): void {}
}

/** The rows of a screen without the blank ones after the last that holds anything. */
function trimRows(rows: string[]): string[] {
  let end = rows.length;
  while (end > 1 && rows[end - 1]!.length === 0) end--;
  return rows.slice(0, end);
}

/**
 * What a console shows now that it did not before, as text to append to what was said of `before`.
 *
 * A console scrolls: what was on its row `k` is on row `0` once `k` rows have gone off the top. The
 * smallest `k` for which every row of `before` but its last is still there, in order, is the scroll;
 * its last row (the cursor's) may have grown — the growth is new — or been rewritten (a progress bar),
 * which is said again on a line of its own. A screen that matches nowhere (cleared) is new whole.
 */
export function consoleDelta(before: readonly string[], after: readonly string[]): string {
  if (before.length === 0) return after.join("\n");
  const last = before[before.length - 1]!;
  for (let k = 0; k < before.length; k++) {
    const overlap = before.length - k;
    if (overlap > after.length) continue;
    let same = true;
    for (let i = 0; i < overlap - 1 && same; i++) same = before[k + i] === after[i];
    if (!same) continue;
    const row = after[overlap - 1]!;
    const rest = after.slice(overlap);
    const tail = rest.length > 0 ? `\n${rest.join("\n")}` : "";
    if (row.startsWith(last)) return row.slice(last.length) + tail;
    return `\n${row}${tail}`;
  }
  return `\n${after.join("\n")}`;
}

/** What `read` answers for a followed process. */
export interface FollowedRead {
  pid: number;
  source: "file" | "console";
  /** When following began, ISO. */
  from: string;
  /** True only for a file read from its first byte. */
  whole: boolean;
  /** The file read, when one is. */
  path?: string;
  /** Each file read, when stdout and stderr are two. */
  paths?: string[];
  /** Where each stream goes. */
  stdout: string;
  stderr: string;
  running: boolean;
  output: string;
  /** Where this reader now stands, to pass back as `since`. */
  offset: number;
  /** Characters dropped from the head before the part answered, because the keep is full. */
  dropped?: number;
  /** What happened to the files meanwhile (cut back, skipped). */
  notes?: string[];
}

/** What `read` answers for a process whose output cannot be read. */
export interface UnreadableRead {
  pid: number;
  source: "unreadable";
  output: null;
  why: string;
  stdout: string;
  stderr: string;
}

export type OutputRead = FollowedRead | UnreadableRead;

export interface WaitedRead extends FollowedRead {
  matched: boolean;
  timedOut: boolean;
  match?: string;
}

/** A refusal said to the model as it is: the output cannot be read, or the process is not running. */
export class ProcessOutputRefusal extends Error {}

interface Follower {
  pid: number;
  from: number;
  whole: boolean;
  source: "file" | "console";
  paths: string[];
  targets: OutputTargets;
  feeds: Feed[];
  text: string;
  length: number;
  read: number;
  running: boolean;
  lastRead: number;
  timer: ReturnType<typeof setInterval> | undefined;
  polling: Promise<void> | undefined;
  listeners: Set<() => void>;
  notes: string[];
}

export interface ProcessOutputsOptions {
  /** Whether a pid runs. Default: a signal 0. */
  alive?: (pid: number) => boolean;
  now?: () => number;
  filePollMs?: number;
  consolePollMs?: number;
  idleMs?: number;
}

/** The followers of one session's reads of other programs (decision 0032, ruling 6). */
export class ProcessOutputs {
  private readonly followers = new Map<number, Follower>();
  private readonly alive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(
    private readonly source: OutputSource,
    private readonly options: ProcessOutputsOptions = {},
  ) {
    this.alive = options.alive ?? isAlive;
    this.now = options.now ?? Date.now;
  }

  /** The pids followed now. */
  followed(): number[] {
    return [...this.followers.keys()];
  }

  /**
   * What `pid` printed since the last read — or its last `tail` lines, or from `since`. The first read
   * starts following it, and answers its history (a file's last part, a console's screen and
   * scrollback); one whose output cannot be read answers why.
   */
  async read(pid: number, options: { tail?: number; since?: number } = {}): Promise<OutputRead> {
    const follower = await this.follow(pid);
    if ("why" in follower) return follower;
    await this.poll(follower);
    return this.answer(follower, options);
  }

  /**
   * Wait until what `pid` prints after the last read matches `pattern`, it ends, or `timeoutMs`
   * passes; answers as {@link read}, with why it stopped waiting. Refused for output that cannot be read.
   */
  async wait(pid: number, pattern: RegExp, timeoutMs: number, signal?: AbortSignal): Promise<WaitedRead> {
    const found = await this.follow(pid);
    if ("why" in found) throw new ProcessOutputRefusal(`the output of ${pid} cannot be read (${found.why}); wait for its exit instead (until: exit)`);
    const follower: Follower = found;
    await this.poll(follower);
    const unread = (): string => follower.text.slice(Math.max(0, follower.read - (follower.length - follower.text.length)));
    const matchNow = (): string | undefined => pattern.exec(unread())?.[0];
    const settled = (): boolean => matchNow() !== undefined || !follower.running;
    follower.lastRead = this.now();
    if (!settled()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), PROCESS_WAIT_MAX_MS));
        function done(): void {
          clearTimeout(timer);
          follower.listeners.delete(check);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        const check = (): void => {
          if (settled()) done();
        };
        follower.listeners.add(check);
        if (signal?.aborted === true) done();
        else signal?.addEventListener("abort", done, { once: true });
      });
    }
    const match = matchNow();
    const answer = this.answer(follower, {});
    return { ...answer, matched: match !== undefined, timedOut: match === undefined && answer.running, ...(match !== undefined ? { match } : {}) };
  }

  /** Let every follower go. */
  stopAll(): void {
    for (const follower of [...this.followers.values()]) this.drop(follower);
  }

  // --- inside -------------------------------------------------------------------------------

  private async follow(pid: number): Promise<Follower | UnreadableRead> {
    const existing = this.followers.get(pid);
    // One that ended whose pid runs again is another process's now.
    if (existing !== undefined && !existing.running && this.alive(pid)) this.drop(existing);
    else if (existing !== undefined) return existing;
    if (!this.alive(pid)) throw new ProcessOutputRefusal(`no process ${pid} is running`);
    const targets = await this.source.targets(pid);
    const unreadable = (why: string): UnreadableRead => ({ pid, source: "unreadable", output: null, why, stdout: streamSaid(targets.stdout), stderr: streamSaid(targets.stderr) });
    const notes: string[] = [];
    const feeds: Feed[] = [];
    const paths: string[] = [];
    let whole = true;
    let failed: string | undefined;
    for (const stream of ["stdout", "stderr"] as const) {
      const target = targets[stream];
      if (target.kind !== "file" || target.path === undefined || paths.includes(target.path)) continue;
      try {
        const feed = new FileFeed(this.source.openPath?.(pid, stream, target.path) ?? target.path, target.path, notes);
        feeds.push(feed);
        paths.push(target.path);
      } catch (e) {
        failed = `its file ${target.path} could not be opened: ${(e as Error).message}`;
      }
    }
    const onConsole = targets.stdout.kind === "console" || targets.stderr.kind === "console";
    if (onConsole && this.source.readConsole !== undefined) feeds.push(new ConsoleFeed(pid, this.source.readConsole));
    if (feeds.length === 0) {
      if (failed !== undefined) return unreadable(failed);
      const a = unreadableWhy(targets.stdout);
      const b = unreadableWhy(targets.stderr);
      return unreadable(a === b ? a : `stdout: ${a}; stderr: ${b}`);
    }
    const follower: Follower = {
      pid,
      from: this.now(),
      whole,
      source: paths.length > 0 ? "file" : "console",
      paths,
      targets,
      feeds,
      text: "",
      length: 0,
      read: 0,
      running: true,
      lastRead: this.now(),
      timer: undefined,
      polling: undefined,
      listeners: new Set(),
      notes,
    };
    this.followers.set(pid, follower);
    try {
      await this.poll(follower);
    } catch (e) {
      this.drop(follower);
      return unreadable((e as Error).message);
    }
    for (const feed of feeds) if (feed instanceof FileFeed && !feed.whole) whole = false;
    follower.whole = whole && paths.length > 0 && !onConsole;
    const every = onConsole ? (this.options.consolePollMs ?? CONSOLE_POLL_MS) : (this.options.filePollMs ?? FILE_POLL_MS);
    follower.timer = setInterval(() => void this.tick(follower), every);
    follower.timer.unref?.();
    return follower;
  }

  /** The follower's own look: let go when idle, otherwise read on. */
  private async tick(follower: Follower): Promise<void> {
    if (this.now() - follower.lastRead > (this.options.idleMs ?? FOLLOW_IDLE_MS)) return this.drop(follower);
    if (!follower.running) return;
    await this.poll(follower).catch(() => undefined);
  }

  /** Read every feed on, once at a time; a process that had ended before the look ends after it. */
  private poll(follower: Follower): Promise<void> {
    if (follower.polling !== undefined) return follower.polling;
    if (!follower.running) return Promise.resolve();
    const run = async (): Promise<void> => {
      const wasAlive = this.alive(follower.pid);
      let error: Error | undefined;
      for (const feed of follower.feeds) {
        try {
          const text = await feed.poll();
          if (text.length > 0) this.append(follower, text);
        } catch (e) {
          // A console that went with its process answers nothing more.
          if (wasAlive) error = e as Error;
        }
      }
      if (!wasAlive) this.ended(follower);
      if (error !== undefined && follower.length === 0) throw error;
    };
    follower.polling = run().finally(() => (follower.polling = undefined));
    return follower.polling;
  }

  private append(follower: Follower, text: string): void {
    follower.length += text.length;
    follower.text += text;
    if (follower.text.length > OUTPUT_KEEP) follower.text = follower.text.slice(follower.text.length - OUTPUT_KEEP);
    for (const listener of [...follower.listeners]) listener();
  }

  private ended(follower: Follower): void {
    if (!follower.running) return;
    follower.running = false;
    if (follower.timer !== undefined) clearInterval(follower.timer);
    // Kept to answer the reads still to come, until it has gone unread long enough.
    follower.timer = setInterval(() => void this.tick(follower), 60_000);
    follower.timer.unref?.();
    for (const feed of follower.feeds) feed.close();
    for (const listener of [...follower.listeners]) listener();
  }

  private drop(follower: Follower): void {
    if (follower.timer !== undefined) clearInterval(follower.timer);
    for (const feed of follower.feeds) feed.close();
    if (this.followers.get(follower.pid) === follower) this.followers.delete(follower.pid);
  }

  private answer(follower: Follower, options: { tail?: number; since?: number }): FollowedRead {
    const head = follower.length - follower.text.length;
    let from = options.since ?? follower.read;
    let output: string;
    if (options.tail !== undefined) {
      const lines = follower.text.split(/\r?\n/);
      const trailing = lines.at(-1) === "" ? 1 : 0;
      output = lines.slice(Math.max(0, lines.length - options.tail - trailing)).join("\n");
      from = follower.length - output.length;
    } else {
      output = follower.text.slice(Math.max(0, from - head));
    }
    follower.read = follower.length;
    follower.lastRead = this.now();
    const notes = follower.notes.splice(0);
    return {
      pid: follower.pid,
      source: follower.source,
      from: new Date(follower.from).toISOString(),
      whole: follower.whole,
      ...(follower.paths.length === 1 ? { path: follower.paths[0]! } : follower.paths.length > 1 ? { paths: [...follower.paths] } : {}),
      stdout: streamSaid(follower.targets.stdout),
      stderr: streamSaid(follower.targets.stderr),
      running: follower.running,
      output,
      offset: follower.length,
      ...(from < head ? { dropped: head - from } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
}
