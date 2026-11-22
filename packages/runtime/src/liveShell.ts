/**
 * A live zsh, bash or sh kept for a task (decision 0030, ruling 4): one process, commands run in it one
 * at a time, so `cd`, variables, aliases and functions carry over from one call to the next.
 *
 * Each command is `eval`-ed on one line with marks after it (`shellMarks.ts`): its stdout is through
 * (`out`), and its exit, where it ended and its environment (`end`). The whole line is read before it
 * runs, so a command that reads stdin reads what a person types, never the marks. A login shell, its
 * rc file read with nothing to read from and nothing shown; one whose rc file does not settle in
 * {@link STARTUP_MS} is started again without it.
 *
 * Ctrl-C signals what the shell started, not the shell: a non-interactive shell has no job control, and
 * a signal to its group would end it. Stop does the same with SIGTERM and, a second later, replaces the
 * shell. POSIX only (`liveShellRefusal`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MarkFilter, shellQuote } from "./shellMarks";
import { descendantsOf, signalEach } from "./processTree";

export const LIVE_SHELLS = ["zsh", "bash", "sh"] as const;
export type LiveShellKind = (typeof LIVE_SHELLS)[number];

/** How long a new shell's profile and rc file have to settle. */
export const STARTUP_MS = 10_000;
/** After Stop asked what runs to end, how long before the shell is replaced. */
export const STOP_GRACE_MS = 1_000;

/** Which live shell a path is, by its name; undefined for anything else. */
export function liveShellKindOf(path: string): LiveShellKind | undefined {
  const name = basename(path);
  return (LIVE_SHELLS as readonly string[]).includes(name) ? (name as LiveShellKind) : undefined;
}

export interface LiveRun {
  /** Null when the shell went away under the command. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Where the shell stands after it, absolute. */
  cwd?: string;
  /** Its environment after it. */
  env?: Record<string, string>;
  /** Stop or the time limit ended it. */
  stopped: boolean;
  /** The shell went away during it, and why. */
  ended?: string;
}

export interface LiveRunHooks {
  /** What the command printed, stdout and stderr alike, marks taken out. */
  onOutput?: (text: string) => void;
  /** The command is running: how a person reaches it. */
  onStart?: (io: { write: (text: string) => boolean; interrupt: () => void; stop: () => void }) => void;
}

interface Running {
  stdout: string;
  stderr: string;
  outDone: boolean;
  end?: { exitCode: number; cwd: string; env: Record<string, string> };
  stopped: boolean;
  hooks: LiveRunHooks;
  finish: (run: LiveRun) => void;
}

const END_LINE = (status: string): string =>
  `printf '\\036JAIRA:out:\\036'; printf '\\036JAIRA:end:%s\\000%s\\000' ${status} "$PWD" >&2; env -0 >&2 2>/dev/null; printf '\\036' >&2`;

/** What a login shell of each kind is started with, and the rc file it reads quietly. */
function startupOf(kind: LiveShellKind, rc: boolean): { args: string[]; init: string } {
  if (kind === "zsh") return { args: ["-l"], init: rc ? `[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" </dev/null >/dev/null 2>&1` : ":" };
  if (kind === "bash") return { args: ["--login"], init: `shopt -s expand_aliases 2>/dev/null${rc ? `; [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" </dev/null >/dev/null 2>&1` : ""}` };
  return { args: [], init: ":" };
}

export class LiveShell {
  readonly kind: LiveShellKind;
  /** Why it went: set once it has. */
  gone: string | undefined;
  /** When it last finished a command, epoch ms. */
  lastUsedAt = Date.now();
  private readonly child: ChildProcess;
  private running: Running | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly onGone = new Set<(why: string) => void>();
  /** Why the shell is being ended, by us, for whoever is told. */
  private ending: string | undefined;

  private constructor(
    readonly path: string,
    cwd: string,
    private readonly rc: boolean,
    env: Record<string, string> | undefined,
  ) {
    this.kind = liveShellKindOf(path) ?? "sh";
    const { args } = startupOf(this.kind, rc);
    this.child = spawn(path, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, PS1: "", PS2: "", PROMPT: "", RPROMPT: "" },
      windowsHide: true,
    });
    this.child.stdin?.on("error", () => undefined);
    const outFilter = new MarkFilter((kind) => {
      if (kind === "out" && this.running !== undefined) {
        this.running.outDone = true;
        this.settle();
      }
    });
    const errFilter = new MarkFilter((kind, payload) => {
      if (kind !== "end" || this.running === undefined) return;
      const [status, where, ...entries] = payload.split("\u0000");
      const env: Record<string, string> = {};
      for (const entry of entries) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      this.running.end = { exitCode: Number(status), cwd: where ?? "", env };
      this.settle();
    });
    // A character cut between two chunks is decoded whole, with the second.
    const outText = new StringDecoder("utf8");
    const errText = new StringDecoder("utf8");
    this.child.stdout?.on("data", (chunk: Buffer) => this.heard("stdout", outFilter.feed(outText.write(chunk))));
    this.child.stderr?.on("data", (chunk: Buffer) => this.heard("stderr", errFilter.feed(errText.write(chunk))));
    this.child.on("exit", (code, signal) => {
      const why = this.ending ?? (signal !== null ? `was ended by ${signal}` : `exited with code ${String(code)}`);
      this.gone = why;
      const running = this.running;
      this.running = undefined;
      running?.finish({ exitCode: code, stdout: running.stdout, stderr: running.stderr, stopped: running.stopped, ended: why });
      for (const listener of this.onGone) listener(why);
    });
    this.child.on("error", () => undefined);
  }

  /**
   * A new live shell at `cwd`, its startup done. Its rc file is read; one that does not settle in
   * {@link STARTUP_MS} is given up and the shell started again without it.
   */
  static async start(path: string, cwd: string, options: { env?: Record<string, string>; startupMs?: number } = {}): Promise<LiveShell> {
    const first = new LiveShell(path, cwd, true, options.env);
    if (await first.ready(options.startupMs ?? STARTUP_MS)) return first;
    first.close("did not finish starting");
    const second = new LiveShell(path, cwd, false, options.env);
    if (await second.ready(options.startupMs ?? STARTUP_MS)) return second;
    second.close("did not finish starting");
    throw new Error(`${path} did not start: it never answered its first command`);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.gone === undefined;
  }

  /** Whether a command runs in it now. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Told once, when the shell goes, why. */
  whenGone(listener: (why: string) => void): void {
    this.onGone.add(listener);
  }

  /** Run one command, after any already queued. */
  run(command: string, hooks: LiveRunHooks = {}): Promise<LiveRun> {
    const next = this.queue.then(() => this.runNow(command, hooks));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** End the shell and all it started. */
  close(why: string): void {
    if (this.gone !== undefined) return;
    this.ending = why;
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  private async ready(within: number): Promise<boolean> {
    // The profile's own output, and the rc file's, are the startup command's: nobody sees them.
    const started = this.runNow(startupOf(this.kind, this.rc).init, {});
    const timer = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), within).unref?.());
    const outcome = await Promise.race([started, timer]);
    return outcome !== "late" && outcome.ended === undefined;
  }

  private runNow(command: string, hooks: LiveRunHooks): Promise<LiveRun> {
    if (this.gone !== undefined) return Promise.resolve({ exitCode: null, stdout: "", stderr: "", stopped: false, ended: this.gone });
    return new Promise<LiveRun>((finish) => {
      this.running = { stdout: "", stderr: "", outDone: false, stopped: false, hooks, finish };
      const written = this.child.stdin?.write(`eval ${shellQuote(command)}; __jaira_s=$?; ${END_LINE('"$__jaira_s"')}\n`);
      if (written === false && this.child.stdin === null) finish({ exitCode: null, stdout: "", stderr: "", stopped: false, ended: "has no stdin" });
      hooks.onStart?.({
        write: (text) => (this.child.stdin !== null && this.child.stdin.writable ? this.child.stdin.write(text) : false),
        interrupt: () => this.signalRunning("SIGINT"),
        stop: () => this.stopRunning(),
      });
    });
  }

  private heard(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) return;
    const running = this.running;
    if (running === undefined) return;
    if (stream === "stdout") running.stdout += text;
    else running.stderr += text;
    running.hooks.onOutput?.(text);
  }

  private settle(): void {
    const running = this.running;
    if (running === undefined || !running.outDone || running.end === undefined) return;
    this.running = undefined;
    this.lastUsedAt = Date.now();
    running.finish({ exitCode: running.end.exitCode, stdout: running.stdout, stderr: running.stderr, cwd: running.end.cwd, env: running.end.env, stopped: running.stopped });
  }

  /** Signal what the shell started — never the shell. */
  private signalRunning(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.running === undefined) return;
    this.running.stopped = true;
    signalEach(descendantsOf(pid), signal);
  }

  /** Stop: SIGTERM to what runs; still running a moment later, the shell is replaced. */
  private stopRunning(): void {
    const running = this.running;
    if (running === undefined) return;
    this.signalRunning("SIGTERM");
    setTimeout(() => {
      if (this.running === running) this.close("was replaced to stop a command that would not end");
    }, STOP_GRACE_MS).unref?.();
  }
}
