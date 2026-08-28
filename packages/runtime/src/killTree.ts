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

/**
 * Terminate `child` and everything it started.
 *
 * Returns immediately: on Windows the kill is another process's work, and callers already await the
 * child's own `exit`/`close`, which is the signal that actually means it is gone.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
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
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      // `taskkill` missing from PATH is the one failure that leaves nothing dead, and it arrives
      // asynchronously. Falling back keeps the old behaviour rather than silently keeping none.
      killer.on("error", single);
    } catch {
      single();
    }
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
