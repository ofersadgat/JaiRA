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
import { resolveProgram, type ProgramDeps } from "@declarative-ai/agents-cli";
import { isWslEnv, toWslPath, type ExecEnv } from "./paths";

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
  /** Overrides for Windows program resolution — injected by tests, never set in production. */
  program?: ProgramDeps;
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
  return {
    platform: process.platform,
    pathDirs: (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0),
    node: process.execPath,
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
): { file: string; argv: string[]; cwd?: string } {
  const execEnv: ExecEnv = options.execEnv ?? "windows";
  if (!isWslEnv(execEnv)) {
    // A WSL command is a LINUX command; only a native one goes through Windows program resolution.
    const { file, prefix } = resolveProgram(command, programDeps(options.program));
    return { file, argv: [...prefix, ...args], ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) };
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
    } = {},
  ) {}

  run(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const merged: ExecOptions = {
      ...options,
      execEnv: options.execEnv ?? this.defaults.execEnv ?? "windows",
      ...(this.defaults.env !== undefined || options.env !== undefined
        ? { env: { ...this.defaults.env, ...options.env } }
        : {}),
    };
    const { file, argv, cwd } = resolveInvocation(command, args, merged);
    const printable = [file, ...argv].join(" ");

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(file, argv, {
        ...(cwd !== undefined ? { cwd } : {}),
        env: merged.env ? { ...process.env, ...merged.env } : process.env,
        windowsHide: true,
        // No shell: arguments stay literal (see the module note).
        shell: false,
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
      } catch {
        token = undefined;
      }
      const observeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        try {
          this.defaults.observer?.onExit(token, { code, signal });
        } catch {
          // As above: a failed record must not change the command's outcome.
        }
      };

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const kill = (): void => {
        if (!child.killed) child.kill();
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

      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

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

      if (merged.stdin !== undefined) child.stdin?.end(merged.stdin);
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
