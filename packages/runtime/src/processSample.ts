/**
 * One look at the machine's processes for the window (decision 0032, "The view"): each one's parent,
 * CPU time and memory, and the TCP ports each listens on — what a process's card draws as its stats line
 * and load trace, and what makes it `listening`.
 *
 * Cheap and best-effort, as `processTree.ts` is: one `ps` and one `lsof` (or `ss`) on POSIX; on Windows
 * the parents from a lister (the containment helper's snapshot, which costs milliseconds), one
 * `Get-Process` for the pids asked about and their trees, and one `netstat -ano`. A tool that is missing
 * or fails leaves its part out; nothing is guessed.
 */
import { execFile } from "node:child_process";
import { cpuSecondsOf } from "./processTree";
import type { ProcessRow } from "./system/types";

/** One process as a sample saw it. */
export interface SampledProcess {
  pid: number;
  parentPid?: number;
  /** Epoch ms, where the platform says. */
  startedAt?: number;
  name?: string;
  /** CPU time used since it started, seconds. */
  cpuSeconds?: number;
  memoryMb?: number;
}

/** What one look saw: every process it could see, and the ports listened on by pid. */
export interface ProcessSample {
  at: number;
  rows: Map<number, SampledProcess>;
  ports: Map<number, number[]>;
  /** False when the process table could not be read: an absent pid then says nothing about whether it runs. */
  complete: boolean;
}

/** Looks at the machine; `pids` are the processes (with their trees) whose CPU and memory are wanted. */
export type ProcessSampler = (pids: readonly number[]) => Promise<ProcessSample>;

function run(file: string, args: readonly string[], timeoutMs = 5_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      // `lsof` answers 1 with nothing found: that is an answer, not a failure.
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ ok: error === null || (code === 1 && stdout !== undefined), stdout: stdout ?? "" });
    });
  });
}

/** `ps -A -o pid=,ppid=,rss=,time=` rows. */
export function parsePsSample(text: string): SampledProcess[] {
  const out: SampledProcess[] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    const rss = Number(cols[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ pid, ...(Number.isInteger(ppid) ? { parentPid: ppid } : {}), ...(Number.isFinite(rss) ? { memoryMb: Math.round((rss / 1024) * 10) / 10 } : {}), cpuSeconds: cpuSecondsOf(cols[3]!) });
  }
  return out;
}

/** The port of an address as `lsof`, `ss` and `netstat` write it: `*:8145`, `127.0.0.1:5173`, `[::1]:3000`, `[::]:80`. */
export function portOf(address: string): number | undefined {
  const m = address.match(/:(\d+)$/);
  if (m === null) return undefined;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? port : undefined;
}

function addPort(ports: Map<number, number[]>, pid: number, port: number | undefined): void {
  if (port === undefined) return;
  const list = ports.get(pid) ?? [];
  if (!list.includes(port)) list.push(port);
  ports.set(pid, list.sort((a, b) => a - b));
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn`: a `p<pid>` line, then an `n<address>` line per socket. */
export function parseLsofListen(text: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) addPort(ports, pid, portOf(line.slice(1).replace(/->.*$/, "")));
  }
  return ports;
}

/** `ss -ltnpH`: `LISTEN 0 511 0.0.0.0:8145 0.0.0.0:* users:(("node",pid=1234,fd=20))`. */
export function parseSsListen(text: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const port = portOf(cols[3]!);
    for (const m of line.matchAll(/pid=(\d+)/g)) addPort(ports, Number(m[1]), port);
  }
  return ports;
}

/** `netstat -ano`: `  TCP    0.0.0.0:8145   0.0.0.0:0   LISTENING   84456` (and the IPv6 rows). */
export function parseNetstatListen(text: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    addPort(ports, Number(cols[4]), portOf(cols[1]!));
  }
  return ports;
}

/** `Get-Process` lines this module asks for: `<pid> <cpu seconds> <working set bytes>`. */
export function parseWindowsUsage(text: string): Map<number, { cpuSeconds?: number; memoryMb?: number }> {
  const out = new Map<number, { cpuSeconds?: number; memoryMb?: number }>();
  for (const line of text.split(/\r?\n/)) {
    const [pid, cpu, ws] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, {
      ...(cpu !== undefined && Number.isFinite(cpu) ? { cpuSeconds: cpu } : {}),
      ...(ws !== undefined && Number.isFinite(ws) ? { memoryMb: Math.round((ws / 1024 / 1024) * 10) / 10 } : {}),
    });
  }
  return out;
}

/** `pids` and every process under them, by parent and start time (a parent pid is reused). */
export function withTrees(rows: ReadonlyMap<number, SampledProcess>, pids: readonly number[]): number[] {
  const children = new Map<number, SampledProcess[]>();
  for (const row of rows.values()) if (row.parentPid !== undefined) children.set(row.parentPid, [...(children.get(row.parentPid) ?? []), row]);
  const out = new Set<number>();
  const queue = [...pids];
  for (let i = 0; i < queue.length && i < 20_000; i++) {
    const pid = queue[i]!;
    if (out.has(pid)) continue;
    out.add(pid);
    const parent = rows.get(pid);
    for (const child of children.get(pid) ?? []) {
      if (child.pid === pid) continue;
      if (parent?.startedAt !== undefined && child.startedAt !== undefined && child.startedAt < parent.startedAt) continue;
      queue.push(child.pid);
    }
  }
  return [...out];
}

/** The platform's sampler. `lister` gives Windows its process table (parents, names, start times). */
export function processSampler(options: { platform?: NodeJS.Platform; lister?: () => Promise<readonly ProcessRow[]> } = {}): ProcessSampler {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return async (pids) => {
      const at = Date.now();
      const rows = new Map<number, SampledProcess>();
      let complete = false;
      if (options.lister !== undefined) {
        try {
          for (const row of await options.lister()) {
            const started = row.started !== undefined ? Date.parse(row.started) : NaN;
            rows.set(row.pid, { pid: row.pid, name: row.name, ...(row.parent_pid !== undefined ? { parentPid: row.parent_pid } : {}), ...(Number.isNaN(started) ? {} : { startedAt: started }) });
          }
          complete = rows.size > 0;
        } catch {
          // Parents unknown: the asked pids alone.
        }
      }
      const wanted = withTrees(rows, pids).slice(0, 400);
      const [usage, netstat] = await Promise.all([
        wanted.length === 0
          ? Promise.resolve({ ok: true, stdout: "" })
          : run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${wanted.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([math]::Round($_.TotalProcessorTime.TotalSeconds, 2)) $($_.WorkingSet64)" }`], 10_000),
        run("netstat.exe", ["-ano"]),
      ]);
      for (const [pid, use] of parseWindowsUsage(usage.stdout)) rows.set(pid, { ...(rows.get(pid) ?? { pid }), ...use });
      return { at, rows, ports: netstat.ok ? parseNetstatListen(netstat.stdout) : new Map(), complete };
    };
  }
  return async () => {
    const at = Date.now();
    const [ps, lsof] = await Promise.all([run("ps", ["-A", "-o", "pid=,ppid=,rss=,time="]), run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"])]);
    const rows = new Map(parsePsSample(ps.ok ? ps.stdout : "").map((row) => [row.pid, row]));
    let ports = lsof.ok ? parseLsofListen(lsof.stdout) : undefined;
    if (ports === undefined && platform === "linux") {
      const ss = await run("ss", ["-ltnpH"]);
      if (ss.ok) ports = parseSsListen(ss.stdout);
    }
    return { at, rows, ports: ports ?? new Map(), complete: ps.ok && rows.size > 0 };
  };
}
