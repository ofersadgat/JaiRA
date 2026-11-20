/**
 * The environment a person's own new terminal would have — which a Mac app opened from the Finder, or
 * a Windows app started before an installer changed the PATH, does not. nvm is found by `NVM_DIR`, fnm
 * by `FNM_DIR` and the PATH its profile line adds, Volta, mise, pyenv and the rest by theirs; all of
 * them are set by the person's shell profile (on Windows, the user's and the machine's environment in
 * the registry), so an app that reads only its own environment misses a version manager that is
 * installed and working in every terminal.
 *
 * Read once per process — a login, interactive shell's `env` (`$SHELL -ilc`), or on Windows the
 * registry's — and only the variables the installers are found by. A profile that hangs or fails
 * costs a few seconds once and leaves nothing: the lookups go on with the app's own environment.
 */
import type { Exec } from "../exec";

/** The variables the installers and version managers are found by. */
export const SHELL_VARS = [
  "PATH",
  "NVM_DIR",
  "NVM_HOME",
  "NVM_SYMLINK",
  "FNM_DIR",
  "VOLTA_HOME",
  "MISE_DATA_DIR",
  "ASDF_DATA_DIR",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "PNPM_HOME",
  "BUN_INSTALL",
  "UV_PYTHON_INSTALL_DIR",
] as const;

/** What a person's own terminal would have: its variables, and its PATH's folders. */
export interface ShellEnv {
  vars: Readonly<Record<string, string>>;
  pathDirs: readonly string[];
}

const MARK = "__JAIRA_SHELL_ENV__";
const SHELL_ENV_TIMEOUT_MS = 5_000;

/** Read a login shell's `env` after the mark — what its profile set, whatever it printed before. */
export function parseShellEnv(stdout: string, platform: NodeJS.Platform): ShellEnv {
  const at = stdout.lastIndexOf(MARK);
  const vars: Record<string, string> = {};
  if (at >= 0) {
    for (const line of stdout.slice(at + MARK.length).split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const name = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      // Windows' names are any case (`Path`); the registry's two PATHs come as `PATH_USER` and `PATH_MACHINE`.
      const known = SHELL_VARS.find((one) => one === name || (platform === "win32" && one.toLowerCase() === name.toLowerCase()));
      if (known !== undefined && value.length > 0) vars[known] = value;
      else if (platform === "win32" && (name === "PATH_USER" || name === "PATH_MACHINE") && value.length > 0) vars["PATH"] = [vars["PATH"], value].filter((one) => one !== undefined).join(";");
    }
  }
  const sep = platform === "win32" ? ";" : ":";
  const pathDirs = (vars["PATH"] ?? "").split(sep).filter((dir) => dir.length > 0);
  return { vars, pathDirs: [...new Set(pathDirs)] };
}

/**
 * What it takes to ask: on Windows, PowerShell reading the user's and the machine's variables from the
 * registry (where an installer writes them, and a new terminal reads them); elsewhere the person's
 * login shell, interactive, so both its login profile and its rc file run — `NVM_DIR` is set in
 * `.zshrc` and `.bashrc`.
 */
export function shellEnvCommand(platform: NodeJS.Platform, shell: string | undefined): { file: string; args: string[] } {
  if (platform === "win32") {
    const names = SHELL_VARS.filter((name) => name !== "PATH");
    const script = [
      `Write-Output '${MARK}'`,
      `foreach ($n in @(${names.map((name) => `'${name}'`).join(",")})) { $v = [Environment]::GetEnvironmentVariable($n, 'User'); if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine') }; if ($v) { Write-Output "$n=$([Environment]::ExpandEnvironmentVariables($v))" } }`,
      `Write-Output "PATH_USER=$([Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'User')))"`,
      `Write-Output "PATH_MACHINE=$([Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine')))"`,
    ].join("; ");
    return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  // `env` is a program, so the same words work in sh, bash, zsh and fish.
  return { file: shell !== undefined && shell.startsWith("/") ? shell : "/bin/sh", args: ["-ilc", `echo ${MARK}; /usr/bin/env`] };
}

let cached: Promise<ShellEnv> | undefined;
let known: ShellEnv | undefined;

/**
 * The environment a person's new terminal would have, asked once per process and kept: later calls
 * answer from the first. Nothing (no variables) when the shell could not be asked in time.
 */
export function loginShellEnv(exec: Exec, platform: NodeJS.Platform = process.platform, shell: string | undefined = process.env["SHELL"]): Promise<ShellEnv> {
  cached ??= (async () => {
    const { file, args } = shellEnvCommand(platform, shell);
    try {
      const result = await exec.run(file, args, { timeoutMs: SHELL_ENV_TIMEOUT_MS, stdin: "" });
      if (result.timedOut || result.aborted) return { vars: {}, pathDirs: [] };
      return parseShellEnv(result.stdout, platform);
    } catch {
      return { vars: {}, pathDirs: [] };
    }
  })().then((env) => {
    known = env;
    return env;
  });
  return cached;
}

/** What {@link loginShellEnv} found, once it has answered — for a lookup that cannot wait. */
export function knownShellEnv(): ShellEnv | undefined {
  return known;
}

/** Forget what was asked: a test's next machine is another. */
export function resetShellEnv(): void {
  cached = undefined;
  known = undefined;
}
