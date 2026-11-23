/**
 * The program a running process IS, by its pid, read off this machine as the call naming it is judged
 * (decision 0023 §3.1, amended 2026-11-23) — so `stop_process`, `read_process`, `wait_process` and a
 * shell's `kill 4242` answer at the program places of their lines (`{ "node": "allow", "**": "ask" }`).
 *
 * The permission gate's narrowing is SYNCHRONOUS, so {@link programOfPidOnMachine} must answer at once:
 *  - on Linux it reads `/proc` (the executable's path, else the kernel's name for it);
 *  - on macOS and the other POSIX systems it runs one `ps`, a few milliseconds;
 *  - on Windows the only reader, `tasklist`, takes a second, which would stop every conversation the
 *    engine runs for that second. So there it answers from what {@link warmProgramsOfPids} read
 *    beforehand — the narrowing's `prepare`, which the gate awaits before asking it — and a pid that was
 *    not read is not named.
 *
 * Spelled as `programName` spells a command (`C:\…\node.exe` is `node`), the spelling a line's places
 * are written in. `undefined` when the machine cannot name the process — it has ended, the account
 * cannot see it, or it was not read in time — and the call is then about no one program
 * (`unknownProgramPlace`), which only `**` answers.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { programName } from "@jaira/shared";

/** How long one lookup may take before the pid is left unnamed. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** How long a pid's program, read on Windows, is trusted: long enough to reach the gate, short enough that a reused pid is not named for the program it was. */
const FRESH_MS = 15_000;

/** Windows' readings: each pid's program, and when it was read. */
const READ: Map<number, { program: string | undefined; at: number }> = new Map();
/** The listing under way, which every caller waiting on one shares: whether it read the machine. */
let listing: Promise<boolean> | undefined;

/** The program running as `pid` on this machine, or `undefined`. See the module header. */
export function programOfPidOnMachine(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const read = READ.get(pid);
      return read !== undefined && Date.now() - read.at <= FRESH_MS ? read.program : undefined;
    }
    return spelled(process.platform === "linux" ? linuxImage(pid) : posixImage(pid));
  } catch {
    return undefined;
  }
}

/**
 * Reads the programs of `pids` ahead of a synchronous {@link programOfPidOnMachine} — on Windows one
 * `tasklist` listing of every process, shared by every call that waits on one; elsewhere nothing, as
 * the synchronous read is quick there. Never throws: a pid it could not read stays unnamed.
 */
export async function warmProgramsOfPids(pids: readonly number[]): Promise<void> {
  if (process.platform !== "win32") return;
  const stale = (): boolean => pids.some((pid) => Number.isInteger(pid) && pid > 0 && !(Date.now() - (READ.get(pid)?.at ?? 0) <= FRESH_MS));
  if (!stale()) return;
  listing ??= listWindows().finally(() => {
    listing = undefined;
  });
  // A listing that failed (it timed out, the machine is busy) names nothing, and the next call lists again.
  if (!(await listing)) return;
  // A pid a listing did not find is read as nobody's, so the next call does not list again for it.
  const at = Date.now();
  for (const pid of pids) if (Number.isInteger(pid) && pid > 0 && !(at - (READ.get(pid)?.at ?? 0) <= FRESH_MS)) READ.set(pid, { program: undefined, at });
}

/** One `tasklist` of every process: each pid's image name, kept against the time it was read. */
function listWindows(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
      if (error === null) {
        const at = Date.now();
        for (const line of out.split(/\r?\n/)) {
          const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
          if (match !== null) READ.set(Number(match[2]), { program: spelled(match[1]), at });
        }
      }
      resolve(error === null);
    });
  });
}

/** A path or image name as a line's places spell a program. */
function spelled(raw: string | undefined): string | undefined {
  const name = raw === undefined ? undefined : programName(raw.trim());
  return name !== undefined && name !== "" ? name : undefined;
}

/** Linux: the executable's path, else the kernel's (fifteen-character) name for it. */
function linuxImage(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8");
    } catch {
      return undefined;
    }
  }
}

/** macOS and the other POSIX systems: `ps`'s command name. */
function posixImage(pid: number): string | undefined {
  const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS });
  return out.trim() === "" ? undefined : out.trim();
}
