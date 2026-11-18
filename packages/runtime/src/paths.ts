/**
 * Windows ↔ WSL path mapping (DESIGN §9.1).
 *
 * All conversion goes through this one module deliberately: DESIGN §16 lists
 * "WSL path mapping edge cases" as a standing risk, and the mitigation is a single
 * mapper with table-driven tests rather than ad-hoc `replace` calls at call sites.
 *
 * Three families of path exist in a WSL project:
 *
 *  - **Windows drive paths** — `C:\work\repo` ↔ `/mnt/c/work/repo`. A drive is
 *    mounted under `/mnt/<lowercase letter>` inside the distro.
 *  - **Distro-internal paths** — `/home/ofer/repo`, which Windows can only reach
 *    through the UNC share `\\wsl.localhost\<distro>\home\ofer\repo` (older builds:
 *    `\\wsl$\<distro>\…`). Both spellings are accepted; the modern one is produced.
 *  - **Everything else** (a bare relative path) is returned untouched, since
 *    guessing would be worse than passing it through.
 */

import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";


/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.paths");
/**
 * The execution environment a project's commands run in (DESIGN §9.1): natively, inside a WSL
 * distro, or (decision 0027) inside a workspace's container.
 *
 * The first two are the MACHINE: git, the agents, their installers and MCP servers run there too. A
 * container is narrower — the workspace is mounted at the same path inside it, so everything that
 * reads files or runs git stays on the machine, and only the commands JaiRA runs (its shell tool, a
 * state's `run_command`, setup steps) go in through `docker exec`. {@link machineEnvOf} is where a
 * thing of the machine's asks which machine that is.
 */
export type ExecEnv = MachineExecEnv | ContainerExecEnv;

/** Where the machine's own programs run: natively, or inside a WSL distro. */
export type MachineExecEnv = "windows" | { wsl: string };

/** A workspace's container (`execEnvironment: { container }`), its commands run through `docker exec`. */
export interface ContainerExecEnv {
  container: string;
  /** `docker exec -u`: a Dev Container's `remoteUser`. */
  user?: string;
  from?: "devcontainer" | "docker";
}

export function isWslEnv(env: ExecEnv): env is { wsl: string } {
  // A merged layer may hold both; a container, named only by a workspace's own layer, is the one meant.
  return typeof env === "object" && typeof (env as { wsl?: unknown }).wsl === "string" && !isContainerEnv(env);
}

export function isContainerEnv(env: ExecEnv | undefined): env is ContainerExecEnv {
  return typeof env === "object" && env !== null && typeof (env as { container?: unknown }).container === "string";
}

/**
 * The machine under `env`: a container's is the machine it runs on (native — containers run on Macs
 * and Linux only), the others are their own. What git, the agent CLIs, their installers and MCP
 * servers run in, whatever the project's commands run in.
 */
export function machineEnvOf(env: ExecEnv): MachineExecEnv {
  return isContainerEnv(env) ? "windows" : env;
}

/** An options bag with its `execEnv` moved to {@link machineEnvOf} — for the code of the machine's own programs. */
export function onMachine<T extends { execEnv?: ExecEnv }>(options: T): T {
  return options.execEnv !== undefined && isContainerEnv(options.execEnv) ? { ...options, execEnv: machineEnvOf(options.execEnv) } : options;
}

/**
 * Why a container cannot run here, or undefined when it can: Docker's containers share the
 * workspace's path only from a Mac or a Linux machine (a Windows path is not a Linux one, and WSL is
 * its own machine).
 */
export function containerRefusal(platform: string = process.platform, machine: ExecEnv = "windows"): string | undefined {
  if (isWindowsHost(platform)) return "A workspace runs in a container on a Mac or a Linux machine only; on Windows, run it on the machine (leave out in: container) or in WSL.";
  if (isWslEnv(machine)) return "A workspace runs in a container from a Mac or a Linux machine only, not from inside WSL; run it on the machine (leave out in: container).";
  return undefined;
}

export function distroOf(env: ExecEnv): string | undefined {
  return isWslEnv(env) ? env.wsl : undefined;
}

/**
 * Is native execution on this host Windows-shaped?
 *
 * `ExecEnv`'s `"windows"` means "not WSL — run natively" (DESIGN §9.1), and JaiRA
 * is a Windows-first app, but the code also runs on Linux (CI, and anyone
 * developing there). Assuming PowerShell for native execution breaks outright when
 * the host has none, so both the command *interpreter* and the policy's parser
 * *dialect* follow the real platform.
 */
export function isWindowsHost(platform: string = process.platform): boolean {
  return platform === "win32";
}

/**
 * The shell dialect a command runs under in `env` — what the policy must parse it
 * as. `platform` is a parameter, not a hidden read of `process.platform`, so both
 * host shapes are testable from either OS.
 */
export function dialectFor(env: ExecEnv, platform: string = process.platform): "posix" | "powershell" {
  if (isWslEnv(env) || isContainerEnv(env)) return "posix";
  return isWindowsHost(platform) ? "powershell" : "posix";
}

/**
 * The interpreter that runs a model-supplied command line in `env`, as
 * `[command, ...prefixArgs]`. Naming it explicitly keeps it consistent with
 * {@link dialectFor} — judging one language and executing another would be a real
 * safety hole, not just an inconsistency.
 */
export function interpreterFor(env: ExecEnv, platform: string = process.platform): [string, ...string[]] {
  if (isWslEnv(env)) return ["bash", "-lc"];
  // An image need not have bash; every one with a shell has `sh`. A login shell, so the image's
  // profile (a version manager's PATH) is read as it is in WSL.
  if (isContainerEnv(env)) return ["sh", "-lc"];
  return isWindowsHost(platform)
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
    : ["/bin/sh", "-c"];
}

const DRIVE = /^([A-Za-z]):[\\/](.*)$/;
/**
 * A drive with no path after it. `C:\` is the root; bare `C:` is *drive-relative*
 * in Windows ("the current directory on C:"), which has no WSL equivalent — it is
 * mapped to the root too, because emitting `C:` into a Linux command line would be
 * strictly worse than a defensible approximation.
 */
const DRIVE_ROOT = /^([A-Za-z]):[\\/]?$/;
const MNT = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;
/** `\\wsl.localhost\Ubuntu\…` or the legacy `\\wsl$\Ubuntu\…`. */
const UNC = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/;

const toSlash = (p: string): string => p.replace(/\\/g, "/");
const toBackslash = (p: string): string => p.replace(/\//g, "\\");

/** Strip a single trailing separator, but never turn a root into an empty string. */
function trimTrailing(path: string, sep: "/" | "\\"): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/**
 * A Windows path as the given distro sees it. Distro-internal UNC paths become
 * absolute Linux paths; drive paths become `/mnt/<letter>/…`.
 */
export function toWslPath(windowsPath: string, distro?: string): string {
  const unc = UNC.exec(windowsPath);
  if (unc) {
    // `\\wsl.localhost\Ubuntu\home\ofer` → `/home/ofer` (the distro name is the
    // share, not part of the path). A different distro's share is still its own
    // absolute path — the caller decides whether that makes sense.
    const rest = unc[2] ?? "";
    return trimTrailing("/" + toSlash(rest).replace(/^\/+/, ""), "/");
  }
  const driveRoot = DRIVE_ROOT.exec(windowsPath);
  if (driveRoot) return `/mnt/${driveRoot[1]!.toLowerCase()}`;
  const drive = DRIVE.exec(windowsPath);
  if (drive) {
    const rest = toSlash(drive[2]!).replace(/^\/+/, "");
    const mapped = `/mnt/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ""}`;
    return trimTrailing(mapped, "/");
  }
  // Already POSIX-shaped, or relative: pass through with normalized separators.
  void distro;
  return trimTrailing(toSlash(windowsPath), "/");
}

/**
 * A distro path as Windows sees it. `/mnt/c/…` becomes `C:\…`; any other absolute
 * path becomes the distro's UNC share, which is what lets the app *display* files
 * from a WSL-hosted project (DESIGN §9.1) without running commands on that share.
 */
export function toWindowsPath(wslPath: string, distro?: string): string {
  const mnt = MNT.exec(wslPath);
  if (mnt) {
    const rest = mnt[2] ?? "";
    const drive = `${mnt[1]!.toUpperCase()}:\\`;
    return rest ? drive + toBackslash(rest.replace(/\/+$/, "")) : drive;
  }
  if (wslPath.startsWith("/")) {
    if (distro === undefined) {
      throw refusal(log, `cannot map distro path '${wslPath}' to Windows without a distro name`);
    }
    const rest = toBackslash(wslPath.replace(/^\/+/, "").replace(/\/+$/, ""));
    return `\\\\wsl.localhost\\${distro}${rest ? `\\${rest}` : ""}`;
  }
  // Relative path: only separators differ.
  return toBackslash(wslPath);
}

/**
 * A key for comparing two spellings of the same path.
 *
 * Needed because different tools spell paths differently: git reports
 * `C:/work/repo` (forward slashes) while Node's `path.join` produces
 * `C:\work\repo`, and Windows is case-insensitive. Comparing raw strings silently
 * fails to match — e.g. joining `git worktree list` output against JaiRA's
 * recorded worktree paths.
 */
export function samePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when two paths name the same location, ignoring separator and case. */
export function samePath(a: string, b: string): boolean {
  return samePathKey(a) === samePathKey(b);
}

/**
 * The path to hand a command running in `env`. Windows execution keeps Windows
 * paths; WSL execution needs the distro's view. A container's workspace is mounted at the same path
 * inside as outside (decision 0027), so its paths are the machine's.
 */
export function pathFor(env: ExecEnv, windowsPath: string): string {
  return isWslEnv(env) ? toWslPath(windowsPath, env.wsl) : windowsPath;
}

/**
 * The path to hand Node's own `fs` for a path produced inside `env`. This is the
 * direction that makes a WSL project browsable from the app: the distro's
 * `/home/...` becomes `\\wsl.localhost\<distro>\home\...`.
 */
export function hostPathFor(env: ExecEnv, envPath: string): string {
  return isWslEnv(env) ? toWindowsPath(envPath, env.wsl) : envPath;
}
