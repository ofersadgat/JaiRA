/**
 * A process and what it started, as `ps` and `lsof` see them (decision 0030): who is under a live
 * shell, how much CPU they have used, and whether any of them listens on a port — what the idle rule
 * asks before closing a shell, and what an interrupt reaches.
 *
 * POSIX only, and best-effort: a tool that is missing or fails answers `undefined` ("cannot tell"),
 * never a guess.
 */
import { execFileSync } from "node:child_process";

interface Row {
  pid: number;
  ppid: number;
  /** Cumulative CPU, seconds. */
  cpu: number;
}

/** `ps`'s `time` column (`[[dd-]hh:]mm:ss[.ff]`) in seconds. */
export function cpuSecondsOf(text: string): number {
  const [days, rest] = text.includes("-") ? [Number(text.split("-")[0]), text.split("-")[1]!] : [0, text];
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
  return days * 86_400 + seconds;
}

function table(): Row[] | undefined {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8", timeout: 5_000 });
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 3)
      .map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: cpuSecondsOf(time!) }));
  } catch {
    return undefined;
  }
}

/** Every process under `pid`, deepest last; not `pid` itself. Empty when `ps` cannot be read. */
export function descendantsOf(pid: number, rows: Row[] | undefined = table()): number[] {
  if (rows === undefined) return [];
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const out: number[] = [];
  const walk = (at: number): void => {
    for (const child of children.get(at) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(pid);
  return out;
}

/** The CPU seconds `pid` and everything under it have used; undefined when `ps` cannot be read. */
export function treeCpuSeconds(pid: number): number | undefined {
  const rows = table();
  if (rows === undefined) return undefined;
  const pids = new Set([pid, ...descendantsOf(pid, rows)]);
  return rows.filter((row) => pids.has(row.pid)).reduce((sum, row) => sum + row.cpu, 0);
}

/** `pid` and everything under it. */
export function processTreeOf(pid: number): number[] {
  return [pid, ...descendantsOf(pid)];
}

/**
 * Whether any of `pids` listens on a TCP port (a dev server, a watcher's socket): `lsof`, else Linux's
 * `ss`. Undefined when neither can say.
 */
export function listensOnAPort(pids: readonly number[]): boolean | undefined {
  if (pids.length === 0) return false;
  try {
    // `-a` ANDs the selections; exit 1 with no output is "none found".
    const out = execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n").length > 1;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
  }
  try {
    const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const want = new Set(pids.map(String));
    return [...out.matchAll(/pid=(\d+)/g)].some((m) => want.has(m[1]!));
  } catch {
    return undefined;
  }
}

/** Send `signal` to each of `pids`, ignoring any already gone. */
export function signalEach(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Gone already.
    }
  }
}
