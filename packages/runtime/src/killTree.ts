/**
 * Killing a child that has children of its own.
 *
 * `ChildProcess.kill()` signals ONE process, and "stop the agent" is not a statement about one
 * process. The gap is not theoretical: on Windows `claude` resolves off PATH to a Chocolatey shim, so
 * the process JaiRA spawns is a launcher and the agent is its child. Killing the launcher left a
 * `claude` running — holding the stdout pipe it had inherited, talking to the API, and editing the
 * repository for seven minutes after the run that owned it was canceled and recorded as stopped.
 *
 * The shim is only the clearest case. Any agent that runs a tool spawns children of its own, so a
 * kill that reaches one level was always going to leak: a `Bash` tool call is a grandchild on every
 * platform, shim or no shim.
 *
 * Two mechanisms, because the platforms hand out different grips on "the tree":
 *
 *  - **Windows** has no process group a parent may signal, but `taskkill /T` walks the child list the
 *    kernel already keeps. It is a separate program, so it is spawned rather than called — which also
 *    means its failure is asynchronous, hence the `error` listener rather than a `try`.
 *
 *    And it is a program that can fail by NOT FINISHING. `taskkill` reads the process list through
 *    WMI, and when the machine's WMI service is wedged it neither exits nor errors (measured
 *    2026-09-19: even `taskkill /PID 999999 /F`, a pid that does not exist, never returned). With only
 *    an `error` listener that meant nothing was killed at all, and every timeout and abort built on
 *    this waited forever on a child nobody had signalled. So the helper gets a deadline, and a helper
 *    that overruns it or exits non-zero is killed and replaced by {@link TREE_WALK}: the same walk
 *    over a toolhelp snapshot, which asks the kernel rather than WMI.
 *  - **POSIX** has process groups, and a child is in its own group only if it was spawned `detached`.
 *    That is what {@link detachedForTree} is for, and it has to be passed at SPAWN time — a decision
 *    made here, at kill time, is too late. Without it `process.kill(-pid)` names a group that does not
 *    exist and fails with ESRCH, which is why the fallback below is not optional.
 *
 * `/F` rather than a polite close: this is the LAST rung of a stop, reached only after the gate has
 * been shut and the turn interrupted. A stop that has got this far has already asked nicely.
 *
 * Best-effort throughout, and deliberately so — every failure path falls back to `child.kill()`,
 * which is what the caller would have done anyway. A tree kill that threw would leave the caller
 * worse off than the single-process kill it replaces.
 */
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Spawn options a child must carry for {@link killTree} to reach its descendants on POSIX.
 *
 * Spread into the options of a long-lived child worth killing as a tree. Empty on Windows, where
 * `taskkill /T` needs nothing arranged in advance.
 *
 * Not applied blanket to every child JaiRA starts: `detached` also removes the child from the
 * parent's signal group, so a terminal's Ctrl-C stops reaching it. That is the right trade for an
 * agent — long-lived, expensive, and stopped through JaiRA rather than through the terminal — and the
 * wrong one for a short git command, which should keep dying with the shell that started it.
 */
export const detachedForTree: { detached?: boolean } = process.platform === "win32" ? {} : { detached: true };

/** A helper program and its arguments. */
export interface TreeKillCommand {
  command: string;
  args: readonly string[];
}

/**
 * The Windows helpers, replaceable so a test can stand in the failure that cannot be arranged on
 * demand: a `taskkill` that never exits. Ignored on POSIX, where no helper runs.
 */
export interface KillTreeOptions {
  /** The first attempt. Default: `taskkill /PID <pid> /T /F`. */
  taskkill?: (pid: number) => TreeKillCommand;
  /** How long `taskkill` gets before it is killed and the walk takes over. Default {@link TASKKILL_DEADLINE_MS}. */
  taskkillDeadlineMs?: number;
  /** The WMI-free second attempt. Default: {@link TREE_WALK} through `powershell.exe`. */
  treeWalk?: (pid: number, notAfterMs: number) => TreeKillCommand;
  /** How long the walk gets before the direct child is killed regardless. Default {@link TREE_WALK_DEADLINE_MS}. */
  treeWalkDeadlineMs?: number;
}

/**
 * A healthy `taskkill` answers in about a tenth of a second; one that has not answered in two is not
 * slow, it is stuck, and every further second is a second the agent keeps working.
 */
export const TASKKILL_DEADLINE_MS = 2_000;

/**
 * The walk costs a PowerShell start and one `Add-Type` compile — 1.0–1.3 s measured on a warm machine.
 * Generous beyond that, because what waits behind it is only the single-process kill.
 */
export const TREE_WALK_DEADLINE_MS = 8_000;

/**
 * The tree walk that does not go through WMI: `CreateToolhelp32Snapshot` is the kernel's own process
 * list, parent pids included. PowerShell is only the carrier — Windows PowerShell 5.1, the one every
 * machine has, exposes no parent pid of its own (`Process.Parent` arrived in PowerShell 7, and
 * `Win32_Process` is the WMI this exists to avoid), so the snapshot is reached through `Add-Type`.
 *
 * A parent pid is a number, not a handle, and Windows reuses numbers. Two checks keep the walk inside
 * the tree it was asked for:
 *
 *  - the ROOT must have started no later than the moment the kill was asked for. A root pid that has
 *    died and been handed to a newer process fails that, and the walk kills nothing (exit 2).
 *  - a CHILD must have started no earlier than its parent. A process whose real parent died, and whose
 *    parent pid now names something younger, fails that and is left alone.
 *
 * A process whose start time cannot be read (access denied) is never ours, and is skipped. Killed
 * root first, so a parent is gone before it can replace the children being taken from under it.
 */
export const TREE_WALK = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class JairaTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static DateTime? Started(int pid) {
    try { using (Process p = Process.GetProcessById(pid)) return p.StartTime.ToUniversalTime(); } catch { return null; }
  }
  public static int Kill(int root, long notAfterMs) {
    var children = new Dictionary<int, List<int>>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return 3;
    try {
      Entry entry = new Entry(); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        List<int> list;
        if (!children.TryGetValue((int)entry.th32ParentProcessID, out list)) children[(int)entry.th32ParentProcessID] = list = new List<int>();
        list.Add((int)entry.th32ProcessID);
      }
    } finally { CloseHandle(snapshot); }
    DateTime? rootStarted = Started(root);
    DateTime notAfter = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(notAfterMs);
    if (rootStarted == null || rootStarted.Value > notAfter) return 2;
    var tree = new List<KeyValuePair<int, DateTime>>();
    tree.Add(new KeyValuePair<int, DateTime>(root, rootStarted.Value));
    for (int i = 0; i < tree.Count; i++) {
      List<int> list;
      if (!children.TryGetValue(tree[i].Key, out list)) continue;
      foreach (int pid in list) {
        DateTime? started = Started(pid);
        if (pid != tree[i].Key && started != null && started.Value >= tree[i].Value) tree.Add(new KeyValuePair<int, DateTime>(pid, started.Value));
      }
    }
    foreach (var node in tree) { try { using (Process p = Process.GetProcessById(node.Key)) p.Kill(); } catch { } }
    return 0;
  }
}
'@
`;

const defaultTaskkill = (pid: number): TreeKillCommand => ({ command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] });

/**
 * `-EncodedCommand` rather than `-Command`: the script carries a here-string and quotes of both
 * kinds, and base64 is the one spelling no layer of Windows argument quoting can reinterpret. The two
 * numbers are interpolated as numbers, so nothing a caller controls reaches the script as text.
 */
const defaultTreeWalk = (pid: number, notAfterMs: number): TreeKillCommand => ({
  command: "powershell.exe",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(`${TREE_WALK}\nexit [JairaTree]::Kill(${Math.trunc(pid)}, ${Math.trunc(notAfterMs)})`, "utf16le").toString("base64"),
  ],
});

/**
 * Run one helper to its end or to its deadline, and report which.
 *
 * `done` is called exactly once: `true` only for exit code 0. A helper that cannot start, exits
 * non-zero, or is still running at the deadline is all the same answer to the caller — it did not do
 * the job — and the overrunning one is killed so a wedged helper is not left behind for every stop.
 * That kill is the plain single-process one on purpose: it lands on a helper, and a helper stuck in a
 * WMI call still dies to `TerminateProcess`.
 */
function runHelper(helper: TreeKillCommand, deadlineMs: number, done: (ok: boolean) => void): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    done(ok);
  };
  try {
    const running = spawn(helper.command, [...helper.args], { windowsHide: true, stdio: "ignore" });
    // A helper missing from PATH arrives here, asynchronously, rather than in the `catch` below.
    running.on("error", () => settle(false));
    running.on("exit", (code) => settle(code === 0));
    timer = setTimeout(() => {
      try {
        running.kill();
      } catch {
        // It went in the same instant. The deadline has still passed without an answer.
      }
      settle(false);
    }, deadlineMs);
  } catch {
    settle(false);
  }
}

/**
 * Terminate `child` and everything it started.
 *
 * Returns immediately: on Windows the kill is another process's work, and callers already await the
 * child's own `exit`/`close`, which is the signal that actually means it is gone.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM", options: KillTreeOptions = {}): void {
  const pid = child.pid;
  const single = (): void => {
    try {
      child.kill(signal);
    } catch {
      // Already gone, or never started. Either way there is nothing left to stop.
    }
  };
  // No pid means the spawn itself failed; there is no tree, only the error the caller will see.
  if (pid === undefined) return single();

  if (process.platform === "win32") {
    // Taken NOW, before any helper has had seconds to spend: the walk refuses a root younger than
    // this, which is how a pid recycled while `taskkill` sat wedged is told from the child it named.
    const askedAt = Date.now();
    runHelper((options.taskkill ?? defaultTaskkill)(pid), options.taskkillDeadlineMs ?? TASKKILL_DEADLINE_MS, (ok) => {
      if (ok) return;
      // A non-zero `taskkill` is most often a child that had already exited, and then there is no
      // root left for the walk to stand on — its descendants are not findable safely once the pid at
      // the top of them is free for reuse. Not worth a PowerShell to learn that.
      if (child.exitCode !== null || child.signalCode !== null) return;
      runHelper(
        (options.treeWalk ?? defaultTreeWalk)(pid, askedAt),
        options.treeWalkDeadlineMs ?? TREE_WALK_DEADLINE_MS,
        // Whatever the walk did, the direct child is killed after it: a no-op when the walk worked,
        // and the old single-process behaviour rather than none when it did not. After, not before —
        // a root that is already dead is exactly what the walk refuses to start from.
        () => single(),
      );
    });
    return;
  }

  try {
    // The negative pid is the process GROUP — every descendant that has not started its own.
    process.kill(-pid, signal);
  } catch {
    // No group to name: the child was not spawned detached (see `detachedForTree`), or it has already
    // exited. The single-process kill is then both the best available and exactly what used to happen.
    single();
  }
}
