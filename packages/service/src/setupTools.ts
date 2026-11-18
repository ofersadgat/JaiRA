/**
 * The tool installer as a project's setup uses it on this machine (decision 0027): `install` steps are
 * checked and installed through `@jaira/runtime`'s install module — the same code that installs the
 * agents and git, which goes through whatever installed a tool there before.
 */
import { NodeExec, checkTool, ensureTool, nodeInstallDeps, type ExecEnv, type SetupToolPort } from "@jaira/runtime";

/** `install` steps for this machine, where commands run in `execEnv`. */
export function setupToolPort(execEnv: ExecEnv, options: { cwd?: string; abortSignal?: AbortSignal } = {}): SetupToolPort {
  const exec = new NodeExec({ execEnv });
  const deps = nodeInstallDeps();
  return {
    check: (request) => checkTool(request, { exec, execEnv, deps, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) }),
    ensure: (request, onOutput) =>
      ensureTool(request, {
        exec,
        execEnv,
        deps,
        onOutput,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      }),
  };
}
