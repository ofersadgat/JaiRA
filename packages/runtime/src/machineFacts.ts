/**
 * What this machine knows about the processes and windows a call is about, and the machine itself —
 * the places of their kinds a permission line decides by (decision 0023 §3.1, amended 2026-11-23): a
 * process's program (`node`) and owner (`session`, `jaira`, `user`, `system`, `account:<name>`), a
 * window's (its process's), the window that has the keyboard, the windows on the screen, and this
 * machine's name.
 *
 * The permission gate's narrowing is SYNCHRONOUS, so {@link MachineFactsCache.facts} answers at once,
 * from what {@link MachineFactsCache.read} read beforehand — the narrowing's `prepare`, which the gate
 * awaits (declarative-ai `ScopeNarrowing.prepare`). On Windows and macOS that is the System backend's
 * listing of the processes, placed as `list_processes` places them (`placedProcesses`), and of the
 * windows; on Linux a process is read off `/proc` when it is asked about. What was not read, or could
 * not be, is not answered, and the call is then about a place nobody could read, which takes the
 * strictest answer of its kind.
 *
 * One cache per task (`compileRunPolicy`'s `machine`), so `session` is that task's processes.
 */
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { programName, type MachineFacts, type ProcessFacts } from "@jaira/shared";
import type { SessionProcesses } from "./sessionProcesses";
import type { SystemBackend } from "./system/types";
import { placedProcesses, systemBackendFor } from "./systemTools";

/** How long what was read is trusted: long enough to reach the gate, short enough that a reused pid is not named for the program it was. */
const FRESH_MS = 15_000;

/** What a call needs read before its narrowing is asked. */
export interface MachineReading {
  pids?: readonly number[];
  windows?: readonly number[];
  /** The window that has the keyboard (keys typed). */
  focus?: boolean;
  /** The windows on the screen (a picture of a display, a pointer). */
  onScreen?: boolean;
}

/** Facts answered at once, and how to read them beforehand. */
export interface MachineFactsSource {
  readonly facts: MachineFacts;
  read(what: MachineReading): Promise<void>;
}

export interface MachineFactsOptions {
  /** The machine. Default: this one's (`systemBackendFor`); `null` ⇒ none, and only Linux's `/proc` is read. */
  backend?: SystemBackend | null;
  /** The task's own processes — what `session` is. */
  processes?: SessionProcesses;
  /** The engine's pid — what JaiRA's own tree hangs from. Default: this process. */
  enginePid?: number;
  /** This machine's name, as Settings → Machines shows it. Default: its host name. */
  name?: string;
}

type Stamped<T> = { value: T; at: number };
const fresh = <T>(stamped: Stamped<T> | undefined): T | undefined => (stamped !== undefined && Date.now() - stamped.at <= FRESH_MS ? stamped.value : undefined);

/** An account as an OWNER place: `DESKTOP\\Ofer` is `account:ofer`. */
function accountPlace(user: string): string {
  return `account:${(user.split(/[\\/]/).pop() ?? user).toLowerCase()}`;
}

/** See the module header. */
export class MachineFactsCache implements MachineFactsSource {
  private readonly backend: SystemBackend | undefined;
  private readonly processes = new Map<number, Stamped<ProcessFacts>>();
  private readonly windows = new Map<number, Stamped<number>>();
  private focusedWindow: Stamped<number | undefined> | undefined;
  private screen: Stamped<number[]> | undefined;
  private processListing: Promise<boolean> | undefined;
  private windowListing: Promise<boolean> | undefined;
  readonly facts: MachineFacts;

  constructor(private readonly options: MachineFactsOptions = {}) {
    this.backend = options.backend === null ? undefined : (options.backend ?? systemBackendFor());
    this.facts = {
      machine: () => options.name ?? hostname(),
      process: (pid) => this.processFacts(pid),
      window: (id) => {
        const pid = fresh(this.windows.get(id));
        return pid === undefined ? undefined : (this.processFacts(pid) ?? {});
      },
      focused: () => fresh(this.focusedWindow),
      onScreen: () => fresh(this.screen),
    };
  }

  /** A process's facts: what was read, else — for one of the task's own, or on Linux — what can be read now. */
  private processFacts(pid: number): ProcessFacts | undefined {
    const read = fresh(this.processes.get(pid));
    if (read !== undefined) return read;
    const mine = this.options.processes?.get(pid);
    if (mine !== undefined && mine.running) return { owner: ["session"], ...(process.platform === "linux" ? { program: linuxProgram(pid) } : {}) };
    if (process.platform !== "linux" || this.backend !== undefined) return undefined;
    const program = linuxProgram(pid);
    if (program === undefined) return undefined;
    const enginePid = this.options.enginePid ?? process.pid;
    const uid = linuxUid(pid);
    const owner = pid === enginePid ? ["jaira"] : uid === undefined ? [] : uid === process.getuid?.() ? ["user"] : ["system"];
    return { program, owner };
  }

  async read(what: MachineReading): Promise<void> {
    const pids = new Set(what.pids ?? []);
    const windows = what.windows ?? [];
    const staleWindows = windows.some((id) => fresh(this.windows.get(id)) === undefined);
    if (this.backend !== undefined && (staleWindows || what.focus === true || what.onScreen === true)) {
      // Focus moves too often to trust an older listing.
      await this.listWindows(what.focus === true);
      for (const id of windows) {
        const pid = fresh(this.windows.get(id));
        if (pid !== undefined) pids.add(pid);
      }
      const focused = fresh(this.focusedWindow);
      if (what.focus === true && focused !== undefined) pids.add(fresh(this.windows.get(focused)) ?? -1);
      if (what.onScreen === true) for (const id of fresh(this.screen) ?? []) pids.add(fresh(this.windows.get(id)) ?? -1);
    }
    pids.delete(-1);
    const stale = [...pids].filter((pid) => fresh(this.processes.get(pid)) === undefined);
    if (stale.length > 0 && this.backend !== undefined && (await this.listProcesses())) {
      const at = Date.now();
      // A pid the listing did not find is nobody's that can be named, until it is fresh no longer.
      for (const pid of stale) if (fresh(this.processes.get(pid)) === undefined) this.processes.set(pid, { value: {}, at });
    }
  }

  /** One listing of the machine's processes, placed as `list_processes` places them, shared by every caller waiting on one. */
  private listProcesses(): Promise<boolean> {
    this.processListing ??= placedProcesses(this.backend!, "all", { enginePid: this.options.enginePid ?? process.pid, session: this.options.processes?.list() ?? [] })
      .then(({ rows }) => {
        const at = Date.now();
        for (const row of rows) {
          const user = (row as { user?: string }).user;
          this.processes.set(row.pid, { value: { program: programName(row.name), owner: [row.started_by, ...(user !== undefined ? [accountPlace(user)] : [])] }, at });
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.processListing = undefined;
      });
    return this.processListing;
  }

  /** One listing of the desktop's windows: each one's process, the one with the keyboard, the ones on the screen. */
  private listWindows(always: boolean): Promise<boolean> {
    if (always) this.focusedWindow = undefined;
    this.windowListing ??= this.backend!.windows()
      .then((rows) => {
        const at = Date.now();
        for (const row of rows) this.windows.set(row.window_id, { value: row.pid, at });
        this.focusedWindow = { value: rows.find((row) => row.focused)?.window_id, at };
        this.screen = { value: rows.filter((row) => !row.minimized).map((row) => row.window_id), at };
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.windowListing = undefined;
      });
    return this.windowListing;
  }
}

/** Linux: the executable's name, else the kernel's (fifteen-character) name for it. */
function linuxProgram(pid: number): string | undefined {
  try {
    return programName(readlinkSync(`/proc/${pid}/exe`));
  } catch {
    try {
      return programName(readFileSync(`/proc/${pid}/comm`, "utf8").trim());
    } catch {
      return undefined;
    }
  }
}

/** Linux: the real user id a process runs as. */
function linuxUid(pid: number): number | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((l) => l.startsWith("Uid:"));
    const uid = line === undefined ? undefined : Number(line.split(/\s+/)[1]);
    return uid !== undefined && Number.isInteger(uid) ? uid : undefined;
  } catch {
    return undefined;
  }
}
