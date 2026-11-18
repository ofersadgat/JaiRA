/**
 * The Exec seam (DESIGN §9.1): every child process JaiRA starts — git today,
 * agent runtimes in phase 6 — goes through here.
 *
 * One layer knows about WSL, so WSL support is a *configuration* rather than a
 * fork of the codebase: `execEnv: "windows"` spawns natively, and
 * `{ wsl: "Ubuntu" }` wraps the same command as
 * `wsl.exe -d Ubuntu --cd <linuxCwd> -- <cmd …>`, translating the working
 * directory through the one {@link toWslPath} mapper.
 *
 * Arguments are passed as an argv array and never concatenated into a shell
 * string: no shell means no quoting rules to get wrong, and nothing in a task
 * title or branch name can turn into shell syntax.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { hostNode, resolveProgram, type ProgramDeps } from "@declarative-ai/agents-cli";
import { isWslEnv, toWslPath, type ExecEnv } from "./paths";
import { detachedForTree, killTree, type KillTreeOptions } from "./killTree";

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

/** How a command is actually invoked for an environment (also what tests assert). */
export function resolveInvocation(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): { file: string; argv: string[]; cwd?: string; env?: Record<string, string> } {
  const execEnv: ExecEnv = options.execEnv ?? "windows";
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
    const { file, argv, cwd, env: needs } = resolveInvocation(command, args, merged);
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
      const kill = (): void => {
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
        const text = chunk.toString("utf8");
        stdout += text;
        observeOutput("stdout", text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
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

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        observeExit(code, signal);
        resolve({ code, signal, stdout, stderr, command: printable, timedOut, aborted });
      });

      if (merged.interactive !== undefined && merged.stdin === undefined) {
        // As below: a program that exits without reading its stdin closes the pipe under a write.
        child.stdin?.on("error", () => undefined);
        try {
          merged.interactive({
            write: (text) => (child.stdin !== null && child.stdin.writable ? child.stdin.write(text) : false),
            signal: (signal) => {
              if (child.exitCode === null && child.signalCode === null) killTree(child, signal, this.defaults.killTree);
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
