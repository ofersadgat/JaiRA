/**
 * The Exec seam (DESIGN §9.1): every child process JaiRA starts — git today,
 * agent runtimes in phase 6 — goes through here.
 *
 * One layer knows about WSL, so WSL support is a *configuration* rather than a
 * fork of the codebase: `execEnv: "windows"` spawns natively, and
 * `{ wsl: "Ubuntu" }` wraps the same command as
 * `wsl.exe -d Ubuntu --cd <linuxCwd> -- <cmd …>`, translating the working
 * directory through the one {@link toWslPath} mapper. A workspace's container
 * (`{ container: "jaira-…" }`, decision 0027) wraps it as
 * `docker exec -i -w <cwd> <container> <cmd …>` — the same path, mounted the same.
 *
 * Arguments are passed as an argv array and never concatenated into a shell
 * string: no shell means no quoting rules to get wrong, and nothing in a task
 * title or branch name can turn into shell syntax.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { hostNode, resolveProgram, type ProgramDeps } from "@declarative-ai/agents-cli";
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import { containerRefusal, isContainerEnv, isWslEnv, toWslPath, type ContainerExecEnv, type ExecEnv } from "./paths";
import { detachedForTree, killTree, type KillTreeOptions } from "./killTree";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.exec");

/** After a person's signal ended an interactive command's shell, how long what it started has to finish before it is killed. */
const INTERRUPT_GRACE_MS = 500;

/**
 * After a command exits, how long its output pipes have to close before it counts as finished anyway.
 *
 * A pipe closes only when every process holding its write end has, and what a command starts in the
 * background inherits those ends: PowerShell's `Start-Process … -RedirectStandardOutput` (measured
 * 2026-11-21: a dev server started that way kept a tool call "running" long after its shell exited),
 * or `cmd &` in sh. Waiting for the pipes waited for the server. What the command wrote before it
 * exited is already in the pipe and is read in this window; what is left running keeps running.
 *
 * Longer than {@link INTERRUPT_GRACE_MS}, so an interrupted command's leftovers are killed (and the
 * pipes close) before this gives up on them.
 */
const OUTPUT_DRAIN_MS = 1_000;

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Where to run: natively, or inside a WSL distro. */
  execEnv?: ExecEnv;
  /** Kill the process when this aborts. */
  abortSignal?: AbortSignal;
  /** Kill after this many ms (0/undefined = no limit). */
  timeoutMs?: number;
  /** Text piped to stdin, then closed. */
  stdin?: string;
  /**
   * Keep stdout as the bytes it was, too ({@link ExecResult.stdoutBytes}) — for output that is not
   * text (an archive a forge's command line downloads). `stdout` is still its UTF-8 reading.
   */
  stdoutBytes?: boolean;
  /**
   * Each chunk of the child's output as it arrives, beside the whole that the result carries — for a
   * command somebody is watching run (an installer, in Settings → Connections). A throw from it is
   * swallowed: watching is not the work.
   */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * A command somebody can type into and stop (decision 0028): called once the process exists, with
   * its stdin kept open and a way to signal its whole tree. The child is spawned in its own process
   * group (`detachedForTree`), so an interrupt or a stop reaches what the shell started, not only the
   * shell. Ignored when `stdin` is given, which closes the pipe.
   */
  interactive?: (io: ExecIo) => void;
  /** Overrides for Windows program resolution — injected by tests, never set in production. */
  program?: ProgramDeps;
}

/** What `ExecOptions.interactive` hands over: the running child's stdin and its tree's signals. */
export interface ExecIo {
  /** Write to the child's stdin; false once the pipe has closed. */
  write(text: string): boolean;
  /** Signal the child and everything it started (`killTree`). */
  signal(signal: NodeJS.Signals): void;
  pid?: number;
}

export interface ExecResult {
  code: number | null;
  /** Set when the process was killed by a signal (or by us, on abort/timeout). */
  signal: NodeJS.Signals | null;
  stdout: string;
  /** stdout as bytes, when {@link ExecOptions.stdoutBytes} asked for them. */
  stdoutBytes?: Uint8Array;
  stderr: string;
  /** The command as invoked, for error messages and audit. */
  command: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface Exec {
  run(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * A hook that sees every child process JaiRA starts (DESIGN §4.2a).
 *
 * It exists because child processes were tracked nowhere: an agent or a long
 * command outlived a crashed app, kept running, and kept spending money with no
 * record that it ever existed. Every child already funnels through this one seam,
 * so recording them is a hook here rather than a change at each call site.
 *
 * It is a callback rather than a direct write because of package layering:
 * `@jaira/runtime` must not import `@jaira/persistence` (the dependency runs the
 * other way), so the app and CLI supply an observer backed by the `jobs` table.
 *
 * `onSpawn` returns an opaque token handed back to `onExit`, so an implementation
 * can carry a row id without this module knowing what one is.
 */
export interface ExecObserver<T = unknown> {
  onSpawn(event: { command: string; argv: readonly string[]; pid?: number; cwd?: string }): T | undefined;
  onExit(token: T | undefined, event: { code: number | null; signal: NodeJS.Signals | null }): void;
  /**
   * A chunk of the child's output, as it arrives.
   *
   * OPTIONAL, so an observer that only counts processes — which is what every existing one does —
   * keeps compiling. What it is for is diagnostics: an agent that fails prints why on stderr, and
   * JaiRA discarded that stream entirely, so "the agent exited 1" was the whole story.
   *
   * This is deliberately NOT where a conversation comes from. An agent's stdout is its protocol
   * stream and its meaning is stored as a session (`SqliteSessionStore`); capturing it here as raw
   * text would be megabytes of noise answering a question already answered.
   */
  onOutput?(token: T | undefined, event: { stream: "stdout" | "stderr"; chunk: string }): void;
  /**
   * Reporting itself failed.
   *
   * The calls above are wrapped in `try/catch` so that a broken observer cannot change a command's
   * outcome — which is right, and which meant a broken observer was completely silent. This is the
   * channel that was missing.
   */
  onError?(error: Error, phase: "spawn" | "exit" | "output"): void;
}

/**
 * Windows program resolution, as this process sees it.
 *
 * The rule and its reasoning live upstream ({@link resolveProgram}), because the agent adapters need
 * it in their own default spawn and one copy of "how do you launch a CLI on Windows without a shell"
 * is enough. What belongs HERE is only the environment it is asked about.
 *
 * Why it exists at all: Node cannot spawn a `.cmd` with `shell: false`, this layer never passes
 * `shell: true` (see the module note — no shell means nothing in a task title can become shell
 * syntax), and an npm-installed CLI on Windows *is* a `.cmd` shim. `codex` is one.
 */
function programDeps(overrides: Partial<ProgramDeps> = {}): ProgramDeps {
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0);
  return {
    platform: process.platform,
    pathDirs,
    // A real node.exe inside the app, not Electron — or `codex` pops a terminal window (see `hostNode`).
    ...hostNode(pathDirs, existsSync),
    exists: existsSync,
    readText: (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
    ...overrides,
  };
}

/**
 * How a command is actually invoked. `stop`, for a command that runs somewhere killing its client does
 * not reach (a container), is what ends it there: run once, on a timeout or an abort.
 */
export interface Invocation {
  file: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stop?: { file: string; argv: string[] };
}

/** How a command is actually invoked for an environment (also what tests assert). */
export function resolveInvocation(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Invocation {
  const execEnv: ExecEnv = options.execEnv ?? "windows";
  if (isContainerEnv(execEnv)) return containerInvocation(execEnv, command, args, options);
  if (!isWslEnv(execEnv)) {
    // A WSL command is a LINUX command; only a native one goes through Windows program resolution.
    const { file, prefix, env } = resolveProgram(command, programDeps(options.program));
    return { file, argv: [...prefix, ...args], ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(env !== undefined ? { env } : {}) };
  }
  // `--cd` sets the working directory inside the distro, so the Windows cwd is
  // never handed to a Linux process. `--` ends wsl.exe's own option parsing, which
  // is what keeps a leading-dash argument from being eaten.
  const argv = ["-d", execEnv.wsl];
  if (options.cwd !== undefined) argv.push("--cd", toWslPath(options.cwd, execEnv.wsl));
  argv.push("--", command, ...args);
  // wsl.exe itself runs on Windows, so it gets no cwd — the distro-side directory
  // is `--cd`, and passing a Windows cwd that may not exist would fail the spawn.
  return { file: "wsl.exe", argv };
}

/**
 * What runs inside the container around a command: its own process group, its id written to a file
 * named for this run, its exit code handed back. The command is started under `setsid`, so it and
 * everything it starts are one group the stop can signal; an image without `setsid` runs it as it is,
 * and the stop signals the command alone. Without job control a backgrounded command's stdin is
 * /dev/null, so stdin is carried on fd 3 and given back to it.
 */
export const CONTAINER_RUN =
  'f=$1; shift; exec 3<&0; if command -v setsid >/dev/null 2>&1; then setsid "$@" <&3 3<&- & else "$@" <&3 3<&- & fi; ' +
  'p=$!; exec 3<&-; echo "$p" > "$f"; wait "$p"; c=$?; rm -f "$f"; exit "$c"';

/**
 * The stop: TERM to the run's group (or to the command, where it has none), KILL two seconds later to
 * what is left. Nothing to do once the run has ended and taken its file with it.
 *
 * `kill -s SIG -- -<group>`, not `kill -SIG -- -<group>`: dash, Debian's `sh`, reads the `--` after
 * `-TERM` as a number and fails ("Illegal number: -"), so the stop fell back to the leader alone and
 * what it had started kept running (GitLab's Linux runner, 2026-11-20).
 */
export const CONTAINER_STOP =
  'f=$1; [ -f "$f" ] || exit 0; p=$(cat "$f"); kill -s TERM -- "-$p" 2>/dev/null || kill -s TERM "$p" 2>/dev/null; ' +
  'sleep 2; kill -s KILL -- "-$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null; rm -f "$f"; exit 0';

/**
 * A command run inside a workspace's container (decision 0027):
 * `docker exec -i [-u <user>] [-w <cwd>] [-e NAME …] <container> sh -c <run> jaira <pid file> <command> <args…>`.
 *
 * Ending `docker exec` does not end what it started: Docker keeps the process running in the container.
 * So the command runs in a group of its own whose id is kept in `/tmp/.jaira-exec-<token>.pid`, and the
 * invocation's `stop` — `docker exec <container> sh -c <stop> …`, as the same user — signals that group.
 *
 * The cwd is handed over as it is — the workspace is mounted at the same path inside as outside.
 * Each variable is passed by NAME only: `docker exec -e NAME` takes the value from docker's own
 * environment, which is this process's with the command's laid over it (`NodeExec` spawns docker with
 * it), so a credential is never on a command line — where every process listing, and the jobs table
 * that records each child's argv, would show it. `-i` keeps stdin, so a command handed text gets it
 * and its end.
 */
export function containerInvocation(
  execEnv: ContainerExecEnv,
  command: string,
  args: readonly string[],
  options: Pick<ExecOptions, "cwd" | "env"> = {},
  platform: string = process.platform,
  token: string = randomBytes(6).toString("hex"),
): Invocation & { stop: { file: string; argv: string[] } } {
  const refused = containerRefusal(platform);
  if (refused !== undefined) throw refusal(log, refused);
  const pidFile = `/tmp/.jaira-exec-${token}.pid`;
  const user = execEnv.user !== undefined ? ["-u", execEnv.user] : [];
  const argv = ["exec", "-i", ...user];
  if (options.cwd !== undefined) argv.push("-w", options.cwd);
  for (const name of Object.keys(options.env ?? {})) argv.push("-e", name);
  argv.push(execEnv.container, "sh", "-c", CONTAINER_RUN, "jaira", pidFile, command, ...args);
  // docker itself runs here, with no cwd of its own: the container's is `-w`.
  return { file: "docker", argv, stop: { file: "docker", argv: ["exec", ...user, execEnv.container, "sh", "-c", CONTAINER_STOP, "jaira", pidFile] } };
}

export class NodeExec implements Exec {
  constructor(
    private readonly defaults: {
      execEnv?: ExecEnv;
      env?: Record<string, string>;
      /** Records every child this Exec starts (DESIGN §4.2a). */
      observer?: ExecObserver;
      /** The Windows kill helpers, replaceable for a test of the one that never exits (see `killTree`). */
      killTree?: KillTreeOptions;
    } = {},
  ) {}

  /**
   * Run a command's stop, not waited for: the command it ends settles its own promise. A stop that
   * cannot run (Docker gone, the container gone) is logged — the command's client is killed regardless.
   */
  private stopInside(stop: { file: string; argv: string[] }, env: Record<string, string> | undefined): void {
    try {
      const child = spawn(stop.file, stop.argv, { env: env !== undefined ? { ...process.env, ...env } : process.env, windowsHide: true, shell: false, stdio: "ignore" });
      child.on("error", (error) => log.warn("could not stop a command in its container", { error: error.message }));
      child.on("exit", (code) => {
        if (code !== 0) log.warn("stopping a command in its container failed", { code });
      });
    } catch (error) {
      log.warn("could not stop a command in its container", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Report a failure in the observer itself — never rethrow, because it is not the command's fault. */
  private reportObserverError(error: unknown, phase: "spawn" | "exit" | "output"): void {
    try {
      this.defaults.observer?.onError?.(error instanceof Error ? error : new Error(String(error)), phase);
    } catch {
      // An error channel that throws has nowhere left to go. Swallowed, and only here.
    }
  }

  run(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const report = (error: unknown, phase: "spawn" | "exit" | "output"): void => this.reportObserverError(error, phase);
    const merged: ExecOptions = {
      ...options,
      execEnv: options.execEnv ?? this.defaults.execEnv ?? "windows",
      ...(this.defaults.env !== undefined || options.env !== undefined
        ? { env: { ...this.defaults.env, ...options.env } }
        : {}),
    };
    const { file, argv, cwd, env: needs, stop } = resolveInvocation(command, args, merged);
    const printable = [file, ...argv].join(" ");

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(file, argv, {
        ...(cwd !== undefined ? { cwd } : {}),
        env: merged.env || needs ? { ...process.env, ...merged.env, ...needs } : process.env,
        windowsHide: true,
        // No shell: arguments stay literal (see the module note).
        shell: false,
        // A command somebody may interrupt is its own group, so the interrupt reaches its children.
        ...(merged.interactive !== undefined && merged.stdin === undefined ? detachedForTree : {}),
      });

      // Observed after spawn, so `pid` is real. A throwing observer must not take
      // the command down with it — recording is bookkeeping, not the work.
      let token: unknown;
      try {
        token = this.defaults.observer?.onSpawn({
          command: file,
          argv,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        });
      } catch (e) {
        token = undefined;
        report(e, "spawn");
      }
      const observeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        try {
          this.defaults.observer?.onExit(token, { code, signal });
        } catch (e) {
          // As above: a failed record must not change the command's outcome — but it is no longer
          // silent about it.
          report(e, "exit");
        }
      };
      const observeOutput = (stream: "stdout" | "stderr", chunk: string): void => {
        try {
          this.defaults.observer?.onOutput?.(token, { stream, chunk });
        } catch (e) {
          report(e, "output");
        }
        try {
          merged.onOutput?.(stream, chunk);
        } catch {
          // The caller's own watcher; the command goes on without it.
        }
      };

      let stdout = "";
      const stdoutChunks: Buffer[] | undefined = merged.stdoutBytes === true ? [] : undefined;
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;

      // A timeout or an abort ends the COMMAND, which on Windows is routinely a launcher with the
      // real program underneath it. The guard stays: `killTree` spawns a `taskkill` there, and asking
      // twice for the same tree costs a process for nothing.
      //
      // The children here are not spawned detached (short-lived commands should still die with the
      // shell that started them), so on POSIX this is the single-process kill it always was.
      //
      // A command in a container is not reached that way — Docker keeps it running when its `docker
      // exec` ends — so its stop runs first (once): it signals the command's group in the container.
      let stopped = false;
      const kill = (): void => {
        if (stop !== undefined && !stopped) {
          stopped = true;
          this.stopInside(stop, merged.env);
        }
        if (!child.killed) killTree(child, "SIGTERM", this.defaults.killTree);
      };
      const timer =
        merged.timeoutMs !== undefined && merged.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              kill();
            }, merged.timeoutMs)
          : undefined;
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      if (merged.abortSignal?.aborted) onAbort();
      else merged.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        merged.abortSignal?.removeEventListener("abort", onAbort);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        // Output after the result — from what the command left running — belongs to nobody.
        if (settled) return;
        stdoutChunks?.push(chunk);
        const text = chunk.toString("utf8");
        stdout += text;
        observeOutput("stdout", text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        const text = chunk.toString("utf8");
        stderr += text;
        observeOutput("stderr", text);
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        observeExit(null, null);
        // A failure to *start* (ENOENT for a missing git/wsl.exe) is a different
        // kind of problem from a non-zero exit, so it rejects rather than
        // returning a result.
        reject(new Error(`failed to run '${printable}': ${error.message}`));
      });

      let drain: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        if (drain !== undefined) clearTimeout(drain);
        cleanup();
        observeExit(code, signal);
        resolve({ code, signal, stdout, ...(stdoutChunks !== undefined ? { stdoutBytes: new Uint8Array(Buffer.concat(stdoutChunks)) } : {}), stderr, command: printable, timedOut, aborted });
      };

      // Normally the pipes close a moment after the exit, and the command ends there with all it wrote.
      child.on("close", (code, signal) => finish(code, signal));

      // A command whose pipes are held open by what it started ends at its exit, after a moment to
      // drain (OUTPUT_DRAIN_MS). The pipes are left open — closing them would break the writes of a
      // server the command meant to leave running — but no longer hold this process alive.
      child.on("exit", (code, signal) => {
        drain = setTimeout(() => {
          if (settled) return;
          for (const stream of [child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
          finish(code, signal);
        }, OUTPUT_DRAIN_MS);
      });

      if (merged.interactive !== undefined && merged.stdin === undefined) {
        // As below: a program that exits without reading its stdin closes the pipe under a write.
        child.stdin?.on("error", () => undefined);
        // A signal that ended the shell but not all it started: a group member that missed it (measured
        // 2026-11-18: SIGINT landing as `sh` forks `sleep` kills the shell, and `sleep` lives on, holding
        // the output open, so the command never closes) is ended once the shell has gone — after a
        // moment, for what is still finishing its last write.
        let signalled = false;
        child.on("exit", () => {
          if (!signalled) return;
          setTimeout(() => {
            if (!settled) killTree(child, "SIGKILL", this.defaults.killTree);
          }, INTERRUPT_GRACE_MS).unref?.();
        });
        try {
          merged.interactive({
            write: (text) => (child.stdin !== null && child.stdin.writable ? child.stdin.write(text) : false),
            signal: (signal) => {
              if (child.exitCode !== null || child.signalCode !== null) return;
              signalled = true;
              // A command in a container is reached only by its stop (above): Ctrl-C ends it there.
              if (stop !== undefined) return kill();
              killTree(child, signal, this.defaults.killTree);
              // The same race the other way round (measured 2026-11-20, GitLab's Linux runner): dash
              // run with -c catches SIGINT and waits out the job it is running before it acts on it, so
              // a `sleep` forked just after the signal reached the group keeps the shell alive for its
              // 30 s. Still running after a moment, the group gets the signal again — a second Ctrl-C.
              setTimeout(() => {
                if (!settled && child.exitCode === null && child.signalCode === null) killTree(child, signal, this.defaults.killTree);
              }, INTERRUPT_GRACE_MS).unref?.();
            },
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
          });
        } catch {
          // The watcher's own failure; the command goes on without it.
        }
      }

      if (merged.stdin !== undefined) {
        // A program that exits without reading its stdin (`git --version`, an installer that fails at
        // once) closes the pipe under the write, which raises EPIPE on the stream. That is not the
        // command failing — its exit says how it went — and with no listener it would be an uncaught
        // exception in whatever process runs this.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(merged.stdin);
      }
    });
  }
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/** Trimmed stdout, or an {@link ExecError} carrying stderr, for a command expected to succeed. */
export async function execOk(
  exec: Exec,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<string> {
  const result = await exec.run(command, args, options);
  if (result.code !== 0) {
    const why = result.timedOut ? "timed out" : result.aborted ? "was canceled" : `exited ${result.code}`;
    const detail = (result.stderr || result.stdout).trim();
    throw new ExecError(`'${result.command}' ${why}${detail ? `: ${detail}` : ""}`, result);
  }
  return result.stdout.trim();
}
