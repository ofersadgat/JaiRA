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

/** How a command is actually invoked for an environment (also what tests assert). */
export function resolveInvocation(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): { file: string; argv: string[]; cwd?: string } {
  const execEnv: ExecEnv = options.execEnv ?? "windows";
  if (!isWslEnv(execEnv)) {
    return { file: command, argv: [...args], ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) };
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
  constructor(private readonly defaults: { execEnv?: ExecEnv; env?: Record<string, string> } = {}) {}

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
        // A failure to *start* (ENOENT for a missing git/wsl.exe) is a different
        // kind of problem from a non-zero exit, so it rejects rather than
        // returning a result.
        reject(new Error(`failed to run '${printable}': ${error.message}`));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
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
