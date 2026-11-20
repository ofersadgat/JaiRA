/**
 * The tool installer as a project's setup uses it on this machine (decision 0027): `install` steps are
 * checked and installed through `@jaira/runtime`'s install module — the same code that installs the
 * agents and git, which goes through whatever installed a tool there before.
 */
import { NodeExec, checkTool, ensureTool, machineInstallDeps, type ExecEnv, type SetupToolPort } from "@jaira/runtime";

/** `install` steps for this machine, where commands run in `execEnv`. */
export function setupToolPort(execEnv: ExecEnv, options: { cwd?: string; abortSignal?: AbortSignal } = {}): SetupToolPort {
  const exec = new NodeExec({ execEnv });
  // As the person's terminal sees this machine: a version manager their profile sets up is found.
  const machine = (): ReturnType<typeof machineInstallDeps> => machineInstallDeps(new NodeExec());
  return {
    check: async (request) => checkTool(request, { exec, execEnv, deps: await machine(), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) }),
    ensure: async (request, onOutput) =>
      ensureTool(request, {
        exec,
        execEnv,
        deps: await machine(),
        onOutput,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      }),
  };
}
