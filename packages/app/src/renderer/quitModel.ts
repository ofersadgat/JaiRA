/**
 * What the quit dialog and the waiting strip say (the person, 2026-11-12: "pop up a dialog if there are
 * still running workflows/sessions asking me what I want to do: wait for it to finish and then exit,
 * exit immediately, or cancel"). When they show is main's (`main/quitGuard.ts`); the OS's own box,
 * used when the window cannot draw, says the same words (`nativeQuitWords`).
 *
 * The list is what is working first, then what is parked — on the person, or on an event — which a
 * quit keeps for the next start and "wait" does not wait for. Five rows, then "and N more".
 */
import type { QuitChoice, RunningWork } from "@jaira/shared/browser";
import { projectName } from "./projects";

export const QUIT_ROWS = 5;

export interface QuitRow {
  key: string;
  title: string;
  /** What it is and where: "Workflow run · JaiRA". */
  detail: string;
  /** Working, or parked and on what. */
  status: "running" | "waiting on you" | "waiting on an event";
}

export interface QuitWords {
  title: string;
  note: string;
  rows: QuitRow[];
  /** How many more than the rows. */
  more: number;
  buttons: Array<{ choice: QuitChoice; label: string }>;
}

const working = (work: readonly RunningWork[]): RunningWork[] => work.filter((w) => w.waiting === undefined);
const parked = (work: readonly RunningWork[]): RunningWork[] => work.filter((w) => w.waiting !== undefined);

function rowOf(item: RunningWork): QuitRow {
  const what = item.kind === "run" ? "Workflow run" : "Chat";
  const where = projectName(item.project);
  return {
    key: `${item.project}\u0000${item.taskId}`,
    title: item.title,
    detail: where === "" ? what : `${what} · ${where}`,
    status: item.waiting === "person" ? "waiting on you" : item.waiting === "event" ? "waiting on an event" : "running",
  };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function quitWordsOf(work: readonly RunningWork[]): QuitWords {
  const going = working(work);
  const waits = parked(work);
  const ordered = [...going, ...waits];
  const n = going.length;
  const note = [
    `${n} still running. Quit now stops ${plural(n, "it", "them")} where ${plural(n, "it is", "they are")}.`,
    ...(waits.length > 0
      ? [`${waits.length} waiting on you or an event ${plural(waits.length, "is", "are")} not waited for; ${plural(waits.length, "it picks", "they pick")} up at the next start.`]
      : []),
  ].join(" ");
  return {
    title: "Quit JaiRA?",
    note,
    rows: ordered.slice(0, QUIT_ROWS).map(rowOf),
    more: Math.max(0, ordered.length - QUIT_ROWS),
    buttons: [
      { choice: "wait", label: `Wait for ${plural(n, "it", "them")} to finish, then quit` },
      { choice: "now", label: "Quit now" },
      { choice: "cancel", label: "Cancel" },
    ],
  };
}

/** The strip while waiting: "Quitting when 2 running finish…". */
export function quitWaitingWords(work: readonly RunningWork[]): string {
  const n = working(work).length;
  return `Quitting when ${n} running ${plural(n, "finishes", "finish")}…`;
}

/** The same question for the OS's own box: its message, detail, and buttons in `choices`' order. */
export function nativeQuitWords(work: readonly RunningWork[]): { message: string; detail: string; buttons: string[]; choices: QuitChoice[] } {
  const words = quitWordsOf(work);
  const lines = words.rows.map((row) => `• ${row.title} (${row.detail}${row.status === "running" ? "" : `, ${row.status}`})`);
  if (words.more > 0) lines.push(`and ${words.more} more`);
  return {
    message: words.title,
    detail: `${words.note}\n\n${lines.join("\n")}`,
    buttons: words.buttons.map((b) => b.label),
    choices: words.buttons.map((b) => b.choice),
  };
}
