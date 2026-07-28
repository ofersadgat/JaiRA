/**
 * Owning a run from a process (DESIGN §4.2a): claim it, keep breathing, record the
 * children, and let go.
 *
 * Both the app and the CLI drive runs, so both need exactly this sequence. Putting
 * it here rather than in each is not tidiness — the two surfaces have already
 * drifted once (the CLI silently skipped agent registration entirely, §1j), and a
 * claim that only one of them takes would make recovery's answer depend on which
 * program started the run.
 */
import type { ExecObserver } from "@jaira/runtime";
import { DEFAULT_HEARTBEAT_MS, newOwnerToken, type JobStore } from "./jobs";

export interface RunOwnerOptions {
  jobs: JobStore;
  taskId: string;
  runId: number;
  /** Beat interval; the stale window is the store's. */
  heartbeatMs?: number;
  now?: () => number;
  /** Called when another process asks this run to stop (the polled cancel flag). */
  onCancelRequested?: () => void;
}

/**
 * A process's claim on one run.
 *
 * The heartbeat timer is `unref`'d: an idle claim must never be the reason a CLI
 * process refuses to exit.
 */
export class RunOwner {
  readonly ownerToken = newOwnerToken();
  readonly jobId: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private released = false;

  constructor(private readonly options: RunOwnerOptions) {
    this.now = options.now ?? Date.now;
    this.jobId = options.jobs.claimRun({
      taskId: options.taskId,
      runId: options.runId,
      ownerToken: this.ownerToken,
      pid: process.pid,
      nowMs: this.now(),
    });
    this.timer = setInterval(() => this.beat(), options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /** Refresh the claim, and notice a cancel another process requested. */
  beat(): void {
    if (this.released) return;
    this.options.jobs.heartbeat(this.ownerToken, this.now());
    if (this.options.onCancelRequested && this.options.jobs.cancelRequested(this.jobId)) {
      this.options.onCancelRequested();
    }
  }

  /**
   * Record a child process against this claim.
   *
   * Handed to `NodeExec` and to the CLI agent adapter, so git, `wsl.exe`, `bash`
   * commands and the agent itself all land in the same place.
   */
  observer(): ExecObserver<number> {
    return {
      onSpawn: (event) =>
        this.options.jobs.spawned({
          ownerToken: this.ownerToken,
          parentJobId: this.jobId,
          taskId: this.options.taskId,
          runId: this.options.runId,
          command: [event.command, ...event.argv].join(" "),
          ...(event.pid !== undefined ? { pid: event.pid } : {}),
          nowMs: this.now(),
        }),
      onExit: (token, event) => {
        if (token === undefined) return;
        this.options.jobs.end(token, event.signal !== null ? `signal:${event.signal}` : `exit:${event.code ?? "?"}`, this.now());
      },
    };
  }

  /** Give up the claim and close any child still recorded as running. */
  release(outcome = "released"): void {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    this.options.jobs.endOwner(this.ownerToken, outcome, this.now());
  }
}
