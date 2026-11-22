/**
 * A shell command as a terminal (decision 0028): what the engine keeps of each command JaiRA's `shell`
 * runs — and each one the person runs in a conversation's workspace — so a window can watch it run,
 * type into it and stop it.
 *
 * The engine keeps them in memory, per task, the last {@link TERMINALS_KEPT}; each keeps the last
 * {@link TERMINAL_OUTPUT_KEEP} characters of what it printed. The output is RAW: escapes and carriage
 * returns as the program wrote them, stdout and stderr in the order they arrived, and what the person
 * typed set between {@link YOU_OPEN} and {@link YOU_CLOSE} (a pipe does not echo, so the engine writes
 * it in for the screen).
 */
import type { CommandDialect } from "./shellCommand";

/** Who ran a terminal's command: an agent's `shell` call, or the person (decision 0028, ruling 8). */
export type TerminalBy = "agent" | "you";

export interface TerminalSummary {
  taskId: string;
  project?: string;
  /** The call's id — the transcript's `tool_use` id — or `you-<n>` for a command the person ran. */
  callId: string;
  command: string;
  /** The language the line is read in, as the policy read it. */
  dialect: CommandDialect;
  /** Where it ran, absolute. */
  cwd?: string;
  /** The shell it ran in (decision 0030): `emulated`, or a live shell's kind (`zsh`, `bash`, `sh`). */
  shell?: string;
  by: TerminalBy;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; absent while it runs. */
  endedAt?: number;
  /** The exit code; null when a signal ended it. */
  exitCode?: number | null;
  signal?: string | null;
  /** The time limit ended it. */
  timedOut?: boolean;
  /** A person (Stop, Ctrl-C) or a stopped turn ended it. */
  stopped?: boolean;
  /** How many characters of output there have been, including any dropped from the head. */
  length: number;
  /** How many of those were dropped from the head to keep the last {@link TERMINAL_OUTPUT_KEEP}. */
  dropped: number;
  /** When output last arrived, epoch ms. */
  lastOutputAt?: number;
  /**
   * While it runs: its output ends mid-line and has been still for {@link WAITING_AFTER_MS} — a prompt
   * waiting for an answer, as far as a pipe can tell (decision 0028, ruling 6).
   */
  waiting?: boolean;
  /** While it runs under a time limit: when that ends, epoch ms. Typing restarts it. */
  endsAt?: number;
  /** Every line the person typed into it, in order (each without its newline). */
  input: string[];
  /**
   * Set when this is not a `shell` call but a process another tool call started (`git_push` running
   * `git push`, a merge request tool running `gh`): the tool's name. Such a process has no stdin to
   * type into — it can be watched and stopped, never answered — and is never `waiting`.
   */
  tool?: string;
  /** With {@link tool}: the id of the call that started it — the transcript's `tool_use` id. One call can start several. */
  call?: string;
}

/** One terminal whole: its facts and what it has printed (from `summary.dropped` on). */
export interface TerminalRead {
  summary: TerminalSummary;
  output: string;
}

/** The person's input is written into the output between these, for the screen to mark as theirs. */
export const YOU_OPEN = "\u001b]7700;you\u0007";
export const YOU_CLOSE = "\u001b]7700;\u0007";

/** How long a running command's output, ending mid-line, has to be still to count as waiting for input. */
export const WAITING_AFTER_MS = 1_200;

/**
 * Whether raw output ends mid-line: its last printed character, past any trailing escapes (a prompt
 * often resets its colour after itself), is not a newline.
 */
export function endsMidLine(output: string): boolean {
  // eslint-disable-next-line no-control-regex
  const bare = output.replace(/(?:\u001b\[[0-9;:?]*[@-~]|\u001b\][^\u0007]*\u0007)+$/, "");
  return bare.length > 0 && !bare.endsWith("\n");
}

/** How many terminals the engine keeps per task. */
export const TERMINALS_KEPT = 40;
/** How much of a terminal's output the engine keeps, from the end. */
export const TERMINAL_OUTPUT_KEEP = 1_000_000;

/** How an interrupt or a stop is asked for: Ctrl-C, or end it. */
export type TerminalSignal = "interrupt" | "stop";
