/**
 * The process card's words (decision 0032, "The view", ruling 1; round 1, board 7; round 2, boards 1–5
 * and 8): what its status says after its name, its ports as links, why a process with no terminal shows
 * no screen, and where "Tell Claude when it prints…" stands.
 *
 * Pure: the card (`ProcessCard.tsx`, and `TerminalView` given a process) draws what this says.
 */
import { processEnded, type ProcessSummary } from "@jaira/shared/browser";
import { shortAge } from "./processTaskModel";
import { durationText } from "./terminalModel";

export type CardTone = "accent" | "warn" | "ok" | "bad" | "dim";

/**
 * The status after the card's name: `running in background · 4m`, `left running · 9m`, `escaped · 13m`,
 * `following the log · 4m` (another scope's, watched), `running · 12.4s` (a command of this turn),
 * `waiting for input · 2m`; ended, `exited 0 · 3m 2s`, `exit 1 after 3m 12s`, `stopped · 9m 0s`.
 */
export function processStatusOf(p: Pick<ProcessSummary, "state" | "origin" | "startedAt" | "endedAt" | "exitCode" | "signal" | "output">, now: number): { text: string; tone: CardTone } {
  if (processEnded(p.state)) {
    const took = durationText((p.endedAt ?? now) - p.startedAt);
    if (p.state === "stopped") return { text: `stopped · ${took}`, tone: "dim" };
    if (p.state === "failed") return { text: p.exitCode !== undefined && p.exitCode !== null ? `exit ${p.exitCode} after ${took}` : `ended by ${p.signal ?? "a signal"} after ${took}`, tone: "bad" };
    return { text: `exited ${p.exitCode ?? 0} · ${took}`, tone: "ok" };
  }
  const age = p.origin === "this-turn" ? durationText(now - p.startedAt) : shortAge(now - p.startedAt);
  if (p.state === "waiting") return { text: `waiting for input · ${age}`, tone: "warn" };
  if (p.state === "starting") return { text: `starting · ${age}`, tone: "accent" };
  switch (p.origin) {
    case "background":
    case "native":
      return { text: `running in background · ${age}`, tone: "accent" };
    case "left":
      return { text: `left running · ${age}`, tone: "dim" };
    case "escaped":
      return { text: `escaped · ${age}`, tone: "warn" };
    case "watched":
      return { text: `${p.output.source === "file" ? "following the log" : p.output.source === "console" ? "following its console" : "watched"} · ${age}`, tone: "accent" };
    default:
      return { text: `running · ${age}`, tone: "accent" };
  }
}

/** The ports as the stats line draws them: each a chip, the first also a link to open (`localhost:8145 ↗`). */
export function portLinksOf(ports: readonly number[]): Array<{ port: number; url: string; link: boolean }> {
  return ports.map((port, i) => ({ port, url: `http://localhost:${port}/`, link: i === 0 }));
}

/**
 * Why a process with no terminal shows what it shows, in a line: how it got out (`started through WMI
 * by …`), then where its output is — its file, its console, or not kept.
 */
export function outputNoteOf(p: Pick<ProcessSummary, "origin" | "why" | "output">): string {
  const where =
    p.output.source === "file"
      ? `its log file${p.output.path !== undefined ? ` ${p.output.path.split(/[\\/]/).pop()}` : ""}: history, then followed`
      : p.output.source === "console"
        ? "it has a console of its own: followed from when you opened it"
        : p.output.source === "spawned"
          ? "its output, kept from its start"
          : `output not kept${p.output.why !== undefined ? `: ${p.output.why}` : ""}`;
  return p.why !== undefined && (p.origin === "escaped" || p.origin === "left") ? `${p.why} · ${where}` : where;
}

/** A watched process's foot: it is not JaiRA's, and what it is followed from. */
export function notOursOf(p: Pick<ProcessSummary, "origin" | "output">): string | undefined {
  if (p.origin !== "watched" && p.origin !== undefined) return undefined;
  if (p.output.source === "file") return "Not JaiRA's: its log file, followed from when you opened it.";
  if (p.output.source === "console") return "Not JaiRA's: its console, followed from when you opened it. It can't be typed into.";
  return "Not JaiRA's: what it prints goes elsewhere, so only its readings show.";
}

/** "Tell Claude when it prints…": whether it is offered, the pattern armed, the line it was told of last. */
export interface TellState {
  offered: boolean;
  /** Why it is not offered, for the tooltip. */
  why?: string;
  armed?: string;
  told?: { pattern: string; line: string; at: number };
}

export function tellOf(p: Pick<ProcessSummary, "taskId" | "origin" | "state" | "tellWhen" | "toldWhen">): TellState {
  const told = p.toldWhen !== undefined ? { told: { ...p.toldWhen } } : {};
  if (p.tellWhen !== undefined) return { offered: true, armed: p.tellWhen.pattern, ...told };
  if (p.taskId === undefined) return { offered: false, why: "it is no conversation's process: there is no one to tell", ...told };
  if (processEnded(p.state)) return { offered: false, why: "it has ended", ...told };
  if (p.origin === "this-turn") return { offered: false, why: "a command of this turn: its result reaches Claude when it ends", ...told };
  return { offered: true, ...told };
}

/** Below this width the card's status drops under its name, beside the readings, and is not squeezed out. */
export const NARROW_CARD = 520;

/** Whether the status goes on the card's second line: opened in place in a row, or the card is narrow. */
export function statusBelow(width: number | undefined, inPlace: boolean): boolean {
  return inPlace || (width !== undefined && width < NARROW_CARD);
}
