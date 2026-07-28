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

/** The execution environment a project's commands run in (DESIGN §9.1). */
export type ExecEnv = "windows" | { wsl: string };

export function isWslEnv(env: ExecEnv): env is { wsl: string } {
  return typeof env === "object" && typeof env.wsl === "string";
}

export function distroOf(env: ExecEnv): string | undefined {
  return isWslEnv(env) ? env.wsl : undefined;
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
      throw new Error(`cannot map distro path '${wslPath}' to Windows without a distro name`);
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
 * paths; WSL execution needs the distro's view.
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
