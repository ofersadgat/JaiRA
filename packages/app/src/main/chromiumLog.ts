/**
 * What Chromium says about itself, in the app's log.
 *
 * Chromium's own complaints — "Unable to move the cache: Access is denied", "Gpu Cache Creation
 * failed: -2" — are `LOG(ERROR)` in C++. They go to the process's stderr and nowhere else: no event
 * reaches JavaScript, so no handler could file them. A dev window printed them to a terminal; a
 * packaged app and a detached `--serve` (`stdio: "ignore"`) have no terminal, and there they were
 * simply lost. The collision that printed them went unexplained until somebody happened to be
 * watching a console.
 *
 * So Chromium is told to write a FILE as well, and the file is read back into the log under a source
 * of its own. Electron's documentation says `--enable-logging` cannot be set by `appendSwitch`
 * because it is read before the app loads; on Electron 44 it is read again after the main script has
 * run, and a switch set here takes (measured 2026-09-27: the cache errors of a second process on one
 * profile land in the file). `--log-level=1` keeps it to warnings and worse: at INFO the file carries
 * every renderer `console.*` call, which `desktop.ts` already records itself.
 *
 * One file per claimed profile (`profile.ts`), because the profile is what a process holds alone —
 * two processes appending to one file would each read the other's lines as their own. Chromium
 * APPENDS to an existing file, so it is deleted when claimed: what is in it is this launch's.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { app as App } from "electron";
import type { LogLevel } from "@jaira/shared";

export interface ChromiumRecord {
  level: LogLevel;
  message: string;
  detail: { pid: number; at: string; where: string };
}

let file: string | undefined;

/**
 * Point Chromium's logging at this process's file. Before `ready`, and before anything Chromium would
 * say: the first thing a colliding profile says is said while the profile opens.
 */
export function enableChromiumLog(electron: typeof App, userData: string, profile: number | undefined): void {
  const dir = join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  file = join(dir, profile === undefined ? "chromium.log" : `chromium-${profile}.log`);
  rmSync(file, { force: true });
  electron.commandLine.appendSwitch("enable-logging", "file");
  electron.commandLine.appendSwitch("log-file", file);
  electron.commandLine.appendSwitch("log-level", "1");
}

/**
 * Read the file as it grows and hand each record to `sink`. A no-op when logging was never enabled.
 * Polled rather than watched: `fs.watch` on Windows does not reliably report appends to a file
 * another process holds open. The timer is unref'd, so it never keeps a quitting process alive.
 */
export function tailChromiumLog(sink: (record: ChromiumRecord) => void, everyMs = 1000): () => void {
  if (file === undefined) return () => undefined;
  const path = file;
  const reader = new ChromiumLogReader();
  let offset = 0;
  const poll = (): void => {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size === offset) {
        for (const record of reader.idle()) sink(record);
        return;
      }
      const chunk = Buffer.alloc(size - offset);
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      offset += read;
      for (const record of reader.push(chunk.subarray(0, read).toString("utf8"))) sink(record);
    } catch {
      // Not written yet — Chromium opens the file at its first line — or gone: the next poll looks again.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const timer = setInterval(poll, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    poll();
    for (const record of reader.flush()) sink(record);
  };
}

/** `[pid:MMDD/HHMMSS.mmm:LEVEL:file.cc(line)] message` — the head every record starts with. */
const HEAD = /^\[(\d+):(\d{4}\/\d{6}\.\d{3}):([A-Z]+|VERBOSE\d+):([^\]]*)\] ?(.*)$/;

const LEVELS: Record<string, LogLevel> = { FATAL: "error", ERROR: "error", WARNING: "warn", INFO: "info" };

/**
 * Chromium's log text → records. A record can span lines (a console message quotes its multi-line
 * text), so one is held until the next head arrives — or until the file goes quiet (`idle`), since
 * a record whose successor never comes is still a record.
 */
export class ChromiumLogReader {
  private partial = "";
  private pending: ChromiumRecord | undefined;

  push(text: string): ChromiumRecord[] {
    const out: ChromiumRecord[] = [];
    const lines = (this.partial + text).split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const head = HEAD.exec(line);
      if (head !== null) {
        if (this.pending !== undefined) out.push(this.pending);
        this.pending = {
          level: LEVELS[head[3]!] ?? "debug",
          message: head[5]!,
          detail: { pid: Number(head[1]), at: head[2]!, where: head[4]! },
        };
      } else if (this.pending !== undefined) {
        this.pending.message += `\n${line}`;
      } else if (line.trim() !== "") {
        // Text before any head: a record whose head was written before this reader started.
        out.push({ level: "info", message: line, detail: { pid: 0, at: "", where: "" } });
      }
    }
    return out;
  }

  /** Nothing new arrived: the held record is complete, unless half a line of it is still unread. */
  idle(): ChromiumRecord[] {
    return this.partial === "" ? this.flush() : [];
  }

  /** The end: whatever is held, and whatever half line is left. */
  flush(): ChromiumRecord[] {
    const out = this.partial === "" ? [] : this.push("\n");
    if (this.pending !== undefined) out.push(this.pending);
    this.pending = undefined;
    return out;
  }
}
