/**
 * A machine for the tool installer's tests (`install/`): a file system as a table — a path is a file,
 * or a link to another path — and an Exec that answers by a function and records what it ran.
 */
import { posix, win32 } from "node:path";
import type { Exec, ExecOptions, ExecResult } from "../src/exec";
import type { InstallDeps } from "../src/install";

export type Files = Record<string, "file" | { link: string }>;

/** A file system as a table: a path is a file, or a link to another path (which may be gone). Folders are what paths are under. */
export function fakeFs(options: { platform?: NodeJS.Platform; home?: string; path: string[]; files: Files; env?: Record<string, string>; root?: boolean; arch?: string }): InstallDeps {
  const platform = options.platform ?? "darwin";
  const path = platform === "win32" ? win32 : posix;
  const resolve = (p: string, depth = 0): string | undefined => {
    const entry = options.files[p];
    if (entry === undefined || depth > 20) return undefined;
    return entry === "file" ? p : resolve(path.resolve(path.dirname(p), entry.link), depth + 1);
  };
  return {
    platform,
    home: options.home ?? (platform === "win32" ? "C:\\Users\\me" : "/Users/me"),
    pathDirs: options.path,
    env: options.env ?? {},
    lexists: (p) => options.files[p] !== undefined,
    realpath: (p) => resolve(p),
    readlink: (p) => {
      const entry = options.files[p];
      return entry !== undefined && entry !== "file" ? entry.link : undefined;
    },
    isFile: (p) => resolve(p) !== undefined,
    readDir: (dir) => {
      const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
      const names = new Set<string>();
      for (const one of Object.keys(options.files)) if (one.startsWith(prefix)) names.add(one.slice(prefix.length).split(path.sep)[0]!);
      return names.size > 0 ? [...names] : undefined;
    },
    ...(options.root === true ? { root: true } : {}),
    ...(options.arch !== undefined ? { arch: options.arch } : {}),
  };
}

export interface Call {
  file: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  execEnv?: ExecOptions["execEnv"];
}

/**
 * An Exec that answers by `answer` (undefined: the program is not there), records every call, and
 * streams `prints` of an answer to whoever watches.
 */
export function machineExec(answer: (file: string, args: readonly string[], options?: ExecOptions) => (Partial<ExecResult> & { prints?: Array<["stdout" | "stderr", string]> }) | undefined): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push({
        file,
        args,
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      });
      const given = answer(file, args, options);
      if (given === undefined) return Promise.reject(new Error(`spawn ${file} ENOENT`));
      const { prints, ...result } = given;
      for (const [stream, chunk] of prints ?? []) options?.onOutput?.(stream, chunk);
      return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", command: file, timedOut: false, aborted: false, ...result } as ExecResult);
    },
  };
}

/** The usual Mac: curl and bash where the system keeps them. */
export const MAC_SYSTEM: Files = { "/usr/bin/curl": "file", "/bin/bash": "file", "/usr/bin/xcode-select": "file", "/usr/bin/sudo": "file" };
export const MAC_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** A Debian or Ubuntu: apt-get and sudo. */
export const DEBIAN: Files = { "/usr/bin/curl": "file", "/usr/bin/bash": "file", "/usr/bin/apt-get": "file", "/usr/bin/sudo": "file" };
/** A Fedora: dnf and sudo. */
export const FEDORA: Files = { "/usr/bin/curl": "file", "/usr/bin/bash": "file", "/usr/bin/dnf": "file", "/usr/bin/sudo": "file" };
export const LINUX_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
export const LINUX_HOME = "/home/me";
