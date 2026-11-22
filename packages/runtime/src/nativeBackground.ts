/**
 * What Claude Code's own `Bash` (or `PowerShell`) starts with `run_in_background` (decision 0032,
 * ruling 6): the session's, found by the walk from the claude process.
 *
 * A permission set that keeps `Bash` native lets Claude start a background command JaiRA never spawns.
 * The translated gate judges it by `shell --run_in_background`; {@link noticeNativeBackground} hears the
 * gate allow it, and {@link attributeNativeBackground}, a moment later, finds what it started and keeps
 * it as the session's (`how: "native"`): listed, waited on and stoppable like any other.
 *
 * **How it is found.** Under the task's live claude processes ({@link AgentProcesses}, recorded as they
 * spawn), by parent pid and start time (`descendantsByStart`), the tops of what started since the gate
 * allowed the call, less what the session already holds. Claude goes straight on to its next call, so
 * a foreground command may have started too: each top's command line is read, and the earliest that
 * runs the call's command is the one kept (Claude Code passes it as written: `bash -c "… eval '<command>'
 * …"`; a later call may name it too, as a grep for it does). Where no command line can be read, a lone
 * top is kept; with several, none is.
 *
 * **Its output** goes to Claude Code's own file (`…\Temp\claude\…\tasks\<id>.output` on Windows, as
 * this machine showed). Where the platform names the top's stdout as a file, the record says so and
 * `read_process` follows that file; otherwise it is unreadable, with why.
 *
 * **Windows and Git Bash.** MSYS `exec` leaves a program under a parent that has already exited, so the
 * walk loses it: `bash -c "sleep 900"` puts `sleep.exe` under a dead pid. Every process that started in
 * the window, under a dead parent, and writes to the same file as the top is the same command's, and is
 * stopped with it.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createLogger } from "@declarative-ai/log";
import type { ToolGate } from "@declarative-ai/permissions";
import { nativeShellDialect } from "@jaira/shared";
import type { ExecObserver } from "./exec";
import type { OutputTargets, ProcessRow } from "./system/types";
import { parseProcStat } from "./containment";
import { descendantsByStart, isAlive, stopLeft, topsOf, type LeftProcess, type ProcessLister } from "./leftRunning";
import type { SessionProcesses, SessionProcessSummary } from "./sessionProcesses";

const log = createLogger("jaira.runtime.nativeBackground");

/** How long after the gate allows a call before what it started is looked for. */
export const NATIVE_SETTLE_MS = 2_500;
/** How many looks, {@link NATIVE_RETRY_MS} apart, before giving up on a call that started nothing found. */
export const NATIVE_TRIES = 3;
export const NATIVE_RETRY_MS = 2_500;
/** A process started this long before the gate's answer still counts: clocks and start times are coarse. */
const WINDOW_SLACK_MS = 1_000;
/** The most processes under a dead parent whose output is looked at, per call. */
const ORPHAN_LOOKS = 10;

/** A native shell call the gate allowed with `run_in_background: true`. */
export interface NativeBackgroundCall {
  /** The native: `Bash` or `PowerShell`. */
  tool: string;
  command: string;
  /** Claude's own description of the call, when it gave one. */
  description?: string;
  /** Epoch ms, when the gate allowed it — the process starts after. */
  at: number;
}

/** Told each time the gate allows a native background start. */
export type NativeBackgroundListener = (call: NativeBackgroundCall) => void;

/**
 * `gate`, telling `listener` when it allows one of the agent's own shells (`Bash`, `PowerShell`) to start
 * a command with `run_in_background: true`. Asked by the native's own name — wrap the gate the agent's
 * callback consults, outside any translation — so JaiRA's `shell`, which keeps its own processes, is
 * never heard here. A listener that throws is logged, never the call's answer.
 */
export function noticeNativeBackground(gate: ToolGate, listener: NativeBackgroundListener | undefined): ToolGate {
  if (listener === undefined) return gate;
  return {
    get profile() {
      return gate.profile;
    },
    modeOf: (tool) => gate.modeOf(tool),
    check: async (tool, input) => {
      const verdict = await gate.check(tool, input);
      if (!verdict.allow || nativeShellDialect(tool.name) === undefined) return verdict;
      const bag = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
      if (bag?.["run_in_background"] !== true || typeof bag["command"] !== "string") return verdict;
      try {
        listener({
          tool: tool.name,
          command: bag["command"],
          ...(typeof bag["description"] === "string" ? { description: bag["description"] } : {}),
          at: Date.now(),
        });
      } catch (error) {
        log.warn("a native background start could not be passed on", { error: error instanceof Error ? error.message : String(error) });
      }
      return verdict;
    },
  };
}

// --- the claude processes -----------------------------------------------------------------------

/** A live agent process: the root of the walk. */
export interface AgentProcess {
  pid: number;
  /** Epoch ms. */
  startedAt: number;
}

/** A task's agent processes, as they spawn and exit — what the walk starts from. */
export class AgentProcesses {
  private readonly live = new Map<number, number>();

  add(pid: number, startedAt = Date.now()): void {
    this.live.set(pid, startedAt);
  }

  remove(pid: number): void {
    this.live.delete(pid);
  }

  /** The ones still running; a pid that died unseen is dropped. */
  list(alive: (pid: number) => boolean = isAlive): AgentProcess[] {
    const out: AgentProcess[] = [];
    for (const [pid, startedAt] of this.live) {
      if (alive(pid)) out.push({ pid, startedAt });
      else this.live.delete(pid);
    }
    return out;
  }

  /** `inner`, recording here each process spawned through it: hand it to the agent adapters only. */
  observing(inner: ExecObserver | undefined): ExecObserver<{ inner: unknown; pid?: number }> {
    return {
      onSpawn: (event) => {
        if (event.pid !== undefined) this.add(event.pid);
        const token = inner?.onSpawn(event);
        return { inner: token, ...(event.pid !== undefined ? { pid: event.pid } : {}) };
      },
      onExit: (token, event) => {
        if (token?.pid !== undefined) this.remove(token.pid);
        inner?.onExit(token?.inner, event);
      },
      onOutput: (token, event) => inner?.onOutput?.(token?.inner, event),
      onError: (error, phase) => inner?.onError?.(error, phase),
    };
  }
}

// --- the matching (pure) ------------------------------------------------------------------------

/**
 * The tops of what the agents started since `at`: under each agent by parent pid and start time, started
 * no earlier than `at` (less a second's slack), neither `known` nor under a known one.
 */
export function nativeCandidates(rows: readonly ProcessRow[], agents: readonly AgentProcess[], at: number, known: ReadonlySet<number>): LeftProcess[] {
  const under: LeftProcess[] = [];
  const seen = new Set<number>();
  for (const agent of agents) {
    for (const p of descendantsByStart(rows, agent.pid, agent.startedAt)) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      under.push(p);
    }
  }
  // What a known process started since is that one's.
  const knownTree = new Set<number>(known);
  for (const pid of known) for (const p of descendantsByStart(rows, pid, 0)) knownTree.add(p.pid);
  const fresh = under.filter((p) => p.started !== undefined && Date.parse(p.started) >= at - WINDOW_SLACK_MS && !knownTree.has(p.pid));
  return topsOf(fresh);
}

/**
 * Whether a process's command line runs `command`: the command as written, once each side's quoting is
 * undone (bash's `'"'"'`, a Windows command line's `\"`) and whitespace collapsed; else every word of
 * it, in any order. A PowerShell `-EncodedCommand` is decoded first.
 */
export function commandLineRuns(line: string, command: string): boolean {
  return commandLineMatch(line, command) !== undefined;
}

/** How a command line runs `command`: as written (`exact`), by its words (`words`), or not at all. */
function commandLineMatch(line: string, command: string): "exact" | "words" | undefined {
  const norm = (text: string): string =>
    text
      .replace(/'"'"'/g, "'")
      .replace(/'\\''/g, "'")
      .replace(/\\(["'\\$`])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  const said = norm(`${line} ${decodedCommand(line) ?? ""}`);
  const wanted = norm(command);
  if (wanted.length === 0) return undefined;
  if (said.includes(wanted)) return "exact";
  const words = wanted.split(/[\s'"`;&|()<>{}]+/).filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => said.includes(w)) ? "words" : undefined;
}

/** A PowerShell command line's `-EncodedCommand` (UTF-16LE base64), decoded. */
function decodedCommand(line: string): string | undefined {
  const m = line.match(/\s-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+([A-Za-z0-9+/=]{4,})/i);
  if (m === null) return undefined;
  try {
    return Buffer.from(m[1]!, "base64").toString("utf16le");
  } catch {
    return undefined;
  }
}

/**
 * Which candidate runs the call — one call starts one process under claude: of those whose command line
 * runs `command`, one that has it as written before one that has its words, and the earliest started
 * (a later call may name the command too: `ps | grep "npm run dev"`). With no command line read for
 * any, a lone candidate; with lines read and none running it, nothing — the process may not have
 * started yet, or what started is another call's.
 */
export function pickNative(candidates: readonly LeftProcess[], command: string, lines: ReadonlyMap<number, string>): LeftProcess[] {
  const read = candidates.filter((c) => lines.has(c.pid));
  const start = (p: LeftProcess): number => (p.started !== undefined ? Date.parse(p.started) : Number.POSITIVE_INFINITY);
  const ranked = read
    .map((c) => ({ c, how: commandLineMatch(lines.get(c.pid)!, command) }))
    .filter((m) => m.how !== undefined)
    .sort((a, b) => Number(a.how === "words") - Number(b.how === "words") || start(a.c) - start(b.c));
  if (ranked.length > 0) return [ranked[0]!.c];
  if (read.length === 0 && candidates.length === 1) return [...candidates];
  return [];
}

/**
 * The processes the walk lost to a dead parent (Windows, MSYS `exec`) that are `top`'s: started in the
 * window, their parent gone from `rows`, not known, and writing to `file` as `top` does.
 */
export async function orphansWritingTo(
  rows: readonly ProcessRow[],
  at: number,
  file: string,
  exclude: ReadonlySet<number>,
  targets: (pid: number) => Promise<OutputTargets>,
): Promise<LeftProcess[]> {
  const pids = new Set(rows.map((r) => r.pid));
  const looks = rows
    .filter((r) => !exclude.has(r.pid) && r.parent_pid !== undefined && !pids.has(r.parent_pid) && r.started !== undefined && Date.parse(r.started) >= at - WINDOW_SLACK_MS)
    .slice(0, ORPHAN_LOOKS);
  const out: LeftProcess[] = [];
  for (const row of looks) {
    const t = await targets(row.pid).catch(() => undefined);
    if (t?.stdout.kind === "file" && t.stdout.path !== undefined && samePath(t.stdout.path, file)) {
      out.push({ pid: row.pid, name: row.name, ...(row.parent_pid !== undefined ? { parent: row.parent_pid } : {}), ...(row.started !== undefined ? { started: row.started } : {}) });
    }
  }
  return out;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// --- the attribution ----------------------------------------------------------------------------

export interface AttributeNativeOptions {
  /** The task's live agent processes. */
  agents: () => readonly AgentProcess[];
  /** The machine's processes, with parents and start times. */
  lister: ProcessLister;
  /** Each pid's command line, where it can be read. Default: {@link commandLinesOf}. */
  commandLines?: (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;
  /** Where a process writes (the System backends' `outputTargets`, Linux's `/proc`). Absent: unreadable. */
  outputTargets?: (pid: number) => Promise<OutputTargets>;
  /** The session's processes: what is known, and where what is found is kept. */
  processes: SessionProcesses;
  /** Pids an earlier call was answered with, so two calls do not claim one process. Added to. */
  claimed?: Set<number>;
  settleMs?: number;
  tries?: number;
  retryMs?: number;
  platform?: NodeJS.Platform;
  /** Stops a found process and what is with it. Default: {@link stopLeft}. */
  stop?: (top: LeftProcess, all: readonly LeftProcess[], signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
}

/**
 * Find what a native background call started and keep it as the session's (see the module note).
 * Answers what was kept; nothing when the call's process could not be told from the rest or has ended.
 */
export async function attributeNativeBackground(call: NativeBackgroundCall, options: AttributeNativeOptions): Promise<SessionProcessSummary[]> {
  const platform = options.platform ?? process.platform;
  const alive = options.alive ?? isAlive;
  const claimed = options.claimed ?? new Set<number>();
  const readLines = options.commandLines ?? ((pids: readonly number[]) => commandLinesOf(pids, platform));
  const tries = Math.max(1, options.tries ?? NATIVE_TRIES);
  await pause(options.settleMs ?? NATIVE_SETTLE_MS);
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await pause(options.retryMs ?? NATIVE_RETRY_MS);
    const agents = options.agents();
    if (agents.length === 0) return [];
    const rows = await options.lister();
    const known = new Set<number>([...options.processes.list().map((p) => p.pid), ...claimed]);
    const candidates = nativeCandidates(rows, agents, call.at, known);
    if (candidates.length === 0) continue;
    const lines = await readLines(candidates.map((c) => c.pid)).catch(() => new Map<number, string>());
    const picked = pickNative(candidates, call.command, lines);
    if (picked.length === 0) continue;
    const kept: SessionProcessSummary[] = [];
    for (const top of picked) {
      const tree = descendantsByStart(rows, top.pid, top.started !== undefined ? Date.parse(top.started) : call.at);
      const targets = options.outputTargets !== undefined ? await options.outputTargets(top.pid).catch(() => undefined) : undefined;
      const file = targets?.stdout.kind === "file" ? targets.stdout.path : undefined;
      const mine = new Set<number>([top.pid, ...tree.map((p) => p.pid)]);
      const orphans =
        platform === "win32" && file !== undefined && options.outputTargets !== undefined
          ? await orphansWritingTo(rows, call.at, file, new Set([...known, ...mine]), options.outputTargets)
          : [];
      const all = [top, ...tree, ...orphans];
      for (const p of all) claimed.add(p.pid);
      const stop = options.stop ?? ((t: LeftProcess, every: readonly LeftProcess[], signal: NodeJS.Signals) => stopLeft(t.pid, every, signal, platform));
      kept.push(
        options.processes.adopt({
          pid: top.pid,
          command: call.command,
          how: "native",
          ...(file !== undefined
            ? { outputFile: file }
            : {
                unreadableWhy:
                  targets === undefined
                    ? "Claude Code started it with its own run_in_background, and where it writes could not be read on this machine"
                    : `Claude Code started it with its own run_in_background, and it writes to ${targets.stdout.kind === "pipe" ? "a pipe Claude Code holds" : `a ${targets.stdout.kind}`}, not a file`,
              }),
          stop: (signal) => stop(top, all, signal),
          // The top may go before what it ran (an MSYS launcher); the record ends with the last of them.
          alive: () => alive(top.pid) || orphans.some((o) => alive(o.pid)),
        }),
      );
    }
    return kept;
  }
  return [];
}

function pause(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

// --- the platform -------------------------------------------------------------------------------

/**
 * Each pid's command line, where it can be read: Windows' `Win32_Process` (one PowerShell start), Linux's
 * `/proc/<pid>/cmdline`, `ps` elsewhere. A pid that has gone is left out.
 */
export async function commandLinesOf(pids: readonly number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (wanted.length === 0) return out;
  if (platform === "linux") {
    for (const pid of wanted) {
      try {
        const text = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s.length > 0).join(" ");
        if (text.length > 0) out.set(pid, text);
      } catch {
        // Gone, or not ours to read.
      }
    }
    return out;
  }
  if (platform === "win32") {
    const filter = wanted.map((p) => `ProcessId=${p}`).join(" OR ");
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`;
    const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
    if (text.trim().length === 0) return out;
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list as Array<{ ProcessId?: unknown; CommandLine?: unknown }>) {
        if (typeof item?.ProcessId === "number" && typeof item.CommandLine === "string") out.set(item.ProcessId, item.CommandLine);
      }
    } catch {
      // Nothing to say: the caller treats it as no line read.
    }
    return out;
  }
  const text = await run("ps", ["-ww", "-o", "pid=,command=", "-p", wanted.join(",")], 5_000);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m !== null) out.set(Number(m[1]), m[2]!);
  }
  return out;
}

/** Linux's processes from `/proc`, as the System backends list them (there is no Linux backend). */
export function procRows(procRoot = "/proc"): ProcessRow[] {
  let boot: number | undefined;
  try {
    const match = readFileSync(`${procRoot}/stat`, "utf8").match(/^btime\s+(\d+)/m);
    boot = match !== null ? Number(match[1]) * 1000 : undefined;
  } catch {
    boot = undefined;
  }
  const rows: ProcessRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return rows;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const p = parseProcStat(readFileSync(`${procRoot}/${entry}/stat`, "utf8"), boot);
      if (p === undefined) continue;
      rows.push({
        pid: p.pid,
        name: p.name,
        ...(p.parent !== undefined ? { parent_pid: p.parent } : {}),
        ...(p.startedAt !== undefined ? { started: new Date(p.startedAt).toISOString() } : {}),
      });
    } catch {
      // Gone between the listing and the read.
    }
  }
  return rows;
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error === null ? stdout : (stdout ?? "")));
  });
}
