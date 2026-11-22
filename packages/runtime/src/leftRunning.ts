/**
 * What a foreground shell call left running (decision 0032, ruling 5): the processes it started that
 * are still alive once its own process has exited.
 *
 * - **POSIX.** A call's process is spawned as its own process group (`detachedForTree`), and what it
 *   starts stays in that group unless it leaves it (`setsid`, which the policy refuses). So: every
 *   process whose group is the call's pid, but the call's own.
 * - **Windows.** No groups: what it started is found by parent pid and start time, from the call's
 *   process down — the walk `killTree` does. A parent pid outlives its process here, so a child whose
 *   parent has exited still names it; a child must have started no earlier than its parent, which is
 *   how a pid reused since is told from the one the call had.
 *
 * Looking costs a process list (a PowerShell start on Windows), so the shell tool looks only when
 * there is a reason to: the call's output was held open past its exit (`ExecResult.outputHeld`), or the
 * line names a way of starting something in the background ({@link mayLeaveRunning}).
 *
 * **With containment** (`containment.ts`: the session's Job Object on Windows, its systemd slice on
 * Linux), the session's members are looked at too: the walk over them, plus every member that started
 * during the call and is not under one of the session's other processes ({@link leftAmongMembers}). That
 * finds what the walk alone loses — a daemon that left the call's group with `setsid`, a child whose
 * parent's start time could not be read. The walk stays: a child created before its shell joined the
 * job is outside it.
 */
import { execFile } from "node:child_process";
import type { ProcessRow } from "./system/types";
import type { ContainedProcess, ContainmentGroup } from "./containment";

export interface LeftProcess {
  pid: number;
  name: string;
  /** Its parent, where the platform says. */
  parent?: number;
  /** As the platform writes it, when it can say. */
  started?: string;
}

/** The process lister, injectable: Windows' is the System tools' backend. */
export type ProcessLister = () => Promise<readonly ProcessRow[]>;

/**
 * Whether a line, in its dialect, names a way of starting something that outlives it — what makes it
 * worth a process list after it ends. A cheap reading, not the policy's: a miss here is caught by
 * `outputHeld` when the process kept the call's pipes, and the policy refuses the escapes outright.
 */
export function mayLeaveRunning(command: string, dialect: "posix" | "powershell"): boolean {
  if (dialect === "powershell") {
    if (/\bstart-process\b|\bsaps\b|\bstart-job\b|\bstart-threadjob\b/i.test(command) && !/-wait\b/i.test(command)) return true;
    if (/(^|[;&|(\s])(start|cmd(\.exe)?\s+\/c\s+start)\s/i.test(command)) return true;
    return /&\s*$/.test(command.trim());
  }
  // A lone `&` (not `&&`) ends a background job; nohup and disown are about outliving the shell.
  return /(^|[^&])&(\s*$|\s*[;)\n]|\s+[^&\s])/.test(command) || /\bnohup\b|\bdisown\b/.test(command);
}

/** The session's containment, for {@link findLeftRunning}. */
export interface LeftRunningContainment {
  group: ContainmentGroup;
  /**
   * The session's processes that are not this call's, each with what is under it: the live shell,
   * background and adopted processes, and any other call running at the same time. Members under them
   * are not this call's leftovers.
   */
  exclude?: readonly number[];
}

/**
 * The processes under `rootPid` (started at `rootStartedAt`, epoch ms) still alive — with `contained`,
 * also the session's members that started during the call (see the module note).
 */
export async function findLeftRunning(
  rootPid: number,
  rootStartedAt: number,
  lister?: ProcessLister,
  platform: NodeJS.Platform = process.platform,
  contained?: LeftRunningContainment,
): Promise<LeftProcess[]> {
  const members = contained !== undefined && contained.group.available() ? await contained.group.members() : undefined;
  const fromMembers = members !== undefined ? leftAmongMembers(members, rootPid, rootStartedAt, contained?.exclude ?? []) : [];
  let walked: LeftProcess[];
  if (platform === "win32") {
    walked = lister !== undefined ? descendantsByStart(await lister(), rootPid, rootStartedAt) : [];
  } else {
    const rows = await psGroups();
    walked = rows.filter((row) => row.pgid === rootPid && row.pid !== rootPid).map((row) => ({ pid: row.pid, name: row.name, parent: row.ppid }));
  }
  return mergeLeft(walked, fromMembers);
}

/**
 * The call's leftovers among the session's members: the walk from `rootPid` over them, and every member
 * that started no earlier than the call and is neither one of `exclude` nor under one. The second is what
 * the walk cannot see — a process whose chain to the call is cut.
 */
export function leftAmongMembers(members: readonly ContainedProcess[], rootPid: number, rootStartedAt: number, exclude: readonly number[]): LeftProcess[] {
  const rows: ProcessRow[] = members.map((m) => ({
    pid: m.pid,
    name: m.name.replace(/\.exe$/i, ""),
    ...(m.parent !== undefined ? { parent_pid: m.parent } : {}),
    ...(m.startedAt !== undefined ? { started: new Date(m.startedAt).toISOString() } : {}),
  }));
  const walked = descendantsByStart(rows, rootPid, rootStartedAt);
  // Over-excluding is the safe side: an excluded process is never stopped as a leftover.
  const others = new Set<number>(exclude);
  for (const pid of exclude) for (const under of descendantsByStart(rows, pid, 0)) others.add(under.pid);
  const seen = new Set([rootPid, ...walked.map((p) => p.pid)]);
  const windowed: LeftProcess[] = [];
  for (const row of rows) {
    if (seen.has(row.pid) || others.has(row.pid) || row.started === undefined) continue;
    if (Date.parse(row.started) < rootStartedAt - 1_000) continue;
    windowed.push({ pid: row.pid, name: row.name, started: row.started, ...(row.parent_pid !== undefined ? { parent: row.parent_pid } : {}) });
  }
  return [...walked.filter((p) => !others.has(p.pid)), ...windowed];
}

function mergeLeft(first: readonly LeftProcess[], second: readonly LeftProcess[]): LeftProcess[] {
  const out = [...first];
  const pids = new Set(first.map((p) => p.pid));
  for (const p of second) if (!pids.has(p.pid)) out.push(p);
  return out;
}

/**
 * The tops of what was left: those whose parent was not left too. A console program on Windows comes
 * with its `conhost`, and a server with its workers; what the agent started is the top, and stopping it
 * stops the rest.
 */
export function topsOf(left: readonly LeftProcess[]): LeftProcess[] {
  const pids = new Set(left.map((p) => p.pid));
  return left.filter((p) => p.parent === undefined || !pids.has(p.parent));
}

/** Under `rootPid` by parent pid, each child started no earlier than its parent (the root: `rootStartedAt`). */
export function descendantsByStart(rows: readonly ProcessRow[], rootPid: number, rootStartedAt: number): LeftProcess[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) if (row.parent_pid !== undefined) byParent.set(row.parent_pid, [...(byParent.get(row.parent_pid) ?? []), row]);
  const out: LeftProcess[] = [];
  const queue: Array<{ pid: number; startedAt: number }> = [{ pid: rootPid, startedAt: rootStartedAt - 1_000 }];
  for (let i = 0; i < queue.length && i < 10_000; i++) {
    const parent = queue[i]!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (child.pid === parent.pid || child.pid === rootPid || out.some((o) => o.pid === child.pid)) continue;
      const started = child.started !== undefined ? Date.parse(child.started) : Number.NaN;
      // Unknown start: not ours — a guess here would stop a stranger's program.
      if (Number.isNaN(started) || started < parent.startedAt) continue;
      // The call's own console host (Windows): the shell's `conhost`, which ends with it and may still be
      // ending when the call is looked at. A program the call started brings its own, as its child.
      if (parent.pid === rootPid && /^conhost(.exe)?$/i.test(child.name ?? "")) continue;
      out.push({ pid: child.pid, name: child.name, parent: parent.pid, started: child.started! });
      queue.push({ pid: child.pid, startedAt: started });
    }
  }
  return out;
}

/** Whether `pid` is alive (signal 0 delivers nothing and fails for a pid with no process). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is another user's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Stop the processes a call left: each tree on Windows, the call's group on POSIX. */
export function stopLeft(rootPid: number, left: readonly LeftProcess[], signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    for (const p of left) execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-rootPid, signal);
  } catch {
    for (const p of left) {
      try {
        process.kill(p.pid, signal);
      } catch {
        // Gone already.
      }
    }
  }
}

interface GroupRow {
  pid: number;
  pgid: number;
  ppid: number;
  name: string;
}

function psGroups(): Promise<GroupRow[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,pgid=,ppid=,comm="], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error !== null) return resolve([]);
      resolve(
        stdout
          .split("\n")
          .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), name: m[4]!.split("/").pop()! })),
      );
    });
  });
}
