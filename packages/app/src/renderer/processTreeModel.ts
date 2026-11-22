import type { CommandDialect, TerminalSummary } from "@jaira/shared/browser";
import type { Place } from "./splitModel";
import { durationText, isWaiting, terminalTitleOf } from "./terminalModel";

/**
 * The Terminals tab's rows and tree (decision 0032, the view, ruling 2): List is the rows, Tree goes from
 * the session to its processes to what they started. Both are drawn from one shape, {@link ProcessTreeNode}
 * — a row is a node with no children — so the tab draws whatever feeds it: today the window's terminals
 * (`terminalListOf`, `terminalTreeOf`), later the engine's process tree, which fills the same nodes with
 * what only it knows (the pid, the ports, a process's children, the escaped ones).
 *
 * PURE: what the tab draws and which of a row's parts show, from what it is given.
 */

/** The Terminals tab's two ways of drawing (round 1, board 6). */
export const TERMINALS_VIEWS = ["list", "tree"] as const;
export type TerminalsView = (typeof TERMINALS_VIEWS)[number];
/** Where the person's choice of List or Tree is remembered (`uiState.ts`'s modes). */
export const TERMINALS_VIEW_MODE = "terminals.view";

/**
 * A row's state glyph (round 2's `px-st-glyph`): running (an accent dot, ringed), waiting for the person
 * (warn), left running (an outlined dot), escaped (a warn diamond), not JaiRA's (an outlined --p3 dot),
 * ended (a dim dot), failed (a bad dot).
 */
export type ProcessGlyph = "run" | "wait" | "left" | "escaped" | "external" | "end" | "bad";

/** A tag's tone, as round 2's `px-tag`: neutral, accent (`bg`), warn (`esc`), bad, the person's own. */
export type ProcessTagTone = "plain" | "accent" | "warn" | "bad";

/** The terminal a node opens: the card's and the panel entry's (`terminalEntryOf`) facts. */
export interface ProcessTerminalRef {
  taskId: string;
  callId: string;
  command: string;
  dialect: CommandDialect;
}

/**
 * One row of the Terminals tab, in List or Tree. Every node has the row's anatomy: the glyph, the label
 * (data 600), what is said after it dim (`note`), a tag, then at the far end its time — given way, while
 * hovered, to the three places, `…` and Stop.
 */
export interface ProcessTreeNode {
  /** Unique in its tree; what the tab's open and folded sets hold. */
  id: string;
  /** A session (the conversation, a scope), a tool call that started processes, or a process. */
  kind: "session" | "call" | "process";
  label: string;
  /** Said after the label, dim: the rest of its command line, how many it holds. */
  note?: string;
  /** The whole of it, for the tooltip. */
  title?: string;
  tag?: { words: string; tone: ProcessTagTone };
  /** Absent on a session. */
  glyph?: ProcessGlyph;
  /** At the far end: how long it has run, how it ended. */
  time?: string;
  /** The time said in the bad tone (a failure). */
  timeBad?: boolean;
  /** The engine's process id, when the engine says it. */
  pid?: number;
  /** It, or something under it, still runs: offers Stop. */
  running: boolean;
  /** What a press opens in place, and the place buttons place. A node without one folds and unfolds. */
  terminal?: ProcessTerminalRef;
  children: ProcessTreeNode[];
}

/** A terminal as a row: its title for a label, the rest of its line after it, how it is doing. */
export function terminalNodeOf(summary: TerminalSummary, now: number): ProcessTreeNode {
  const waiting = isWaiting(summary);
  const running = summary.endedAt === undefined;
  const label = terminalTitleOf(summary.command, summary.dialect);
  const command = summary.command.trim();
  // PowerShell's titles are lower-cased (`Write-Output` reads `write-output`): the rest is after it either way.
  const rest = command.toLowerCase().startsWith(label.toLowerCase()) ? command.slice(label.length).trim() : command;
  const ended = endOf(summary);
  return {
    id: `terminal:${summary.callId}`,
    kind: "process",
    label,
    ...(rest.length > 0 ? { note: rest } : {}),
    title: summary.command,
    ...(waiting
      ? { tag: { words: "waiting for you", tone: "warn" as const } }
      : summary.by === "you"
        ? { tag: { words: "you", tone: "accent" as const } }
        : summary.tool !== undefined && summary.call === undefined
          ? { tag: { words: summary.tool, tone: "plain" as const } }
          : {}),
    glyph: waiting ? "wait" : running ? "run" : ended.bad ? "bad" : "end",
    time: running ? durationText(now - summary.startedAt) : ended.words,
    ...(ended.bad ? { timeBad: true } : {}),
    running,
    terminal: { taskId: summary.taskId, callId: summary.callId, command: summary.command, dialect: summary.dialect },
    children: [],
  };
}

/** How an ended terminal ended, in a row's few words: its duration when it went well. */
function endOf(summary: TerminalSummary): { words: string; bad: boolean } {
  if (summary.endedAt === undefined) return { words: "", bad: false };
  if (summary.timedOut === true) return { words: "timed out", bad: true };
  if (summary.stopped === true) return { words: "stopped", bad: false };
  if (summary.exitCode === 0) return { words: durationText(summary.endedAt - summary.startedAt), bad: false };
  if (summary.exitCode === null || summary.exitCode === undefined) return { words: summary.signal ? `by ${summary.signal}` : "ended", bad: true };
  return { words: `exit ${String(summary.exitCode)}`, bad: true };
}

/** The tab's order: running first, those waiting for the person at the top, oldest first; then ended, newest first. */
function ordered(list: readonly TerminalSummary[]): { running: TerminalSummary[]; ended: TerminalSummary[] } {
  const running = list.filter((one) => one.endedAt === undefined).sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)) || a.startedAt - b.startedAt);
  const ended = list.filter((one) => one.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return { running, ended };
}

/** List mode (ruling 2): today's rows, Running (waiting first) then Ended, each a node with no children. */
export function terminalListOf(list: readonly TerminalSummary[], now: number): { running: ProcessTreeNode[]; ended: ProcessTreeNode[] } {
  const { running, ended } = ordered(list);
  return { running: running.map((one) => terminalNodeOf(one, now)), ended: ended.map((one) => terminalNodeOf(one, now)) };
}

/**
 * Tree mode (ruling 2), from what the window has today: the session, then its terminals — a `shell`
 * call's (or the person's) on its own, and the processes another tool call started (`git_push`'s `git
 * push`, a merge request tool's `gh`) under that call, as its children. Ordered as the list is, a call
 * by its liveliest process. The engine's process tree replaces this input later; the nodes stay.
 */
export function terminalTreeOf(session: { id: string; label: string }, list: readonly TerminalSummary[], now: number): ProcessTreeNode {
  const { running, ended } = ordered(list);
  const top: ProcessTreeNode[] = [];
  const calls = new Map<string, ProcessTreeNode>();
  for (const one of [...running, ...ended]) {
    const node = terminalNodeOf(one, now);
    if (one.call === undefined) {
      top.push(node);
      continue;
    }
    let call = calls.get(one.call);
    if (call === undefined) {
      call = { id: `call:${one.call}`, kind: "call", label: one.tool ?? "tool call", running: false, children: [] };
      calls.set(one.call, call);
      top.push(call);
    }
    call.children.push(node);
  }
  for (const call of calls.values()) Object.assign(call, callSummaryOf(call.children, list, now));
  const live = running.length;
  return {
    id: `session:${session.id}`,
    kind: "session",
    label: session.label,
    note: list.length === 0 ? "nothing run yet" : [live > 0 ? `${live} running` : "", ended.length > 0 ? `${ended.length} ended` : ""].filter((s) => s.length > 0).join(" · "),
    running: live > 0,
    children: top,
  };
}

/** A tool call's row: how many it started, the liveliest one's glyph, how long since its first started. */
function callSummaryOf(children: readonly ProcessTreeNode[], list: readonly TerminalSummary[], now: number): Partial<ProcessTreeNode> {
  const running = children.some((one) => one.running);
  const glyph: ProcessGlyph = children.some((one) => one.glyph === "wait") ? "wait" : running ? "run" : children.some((one) => one.glyph === "bad") ? "bad" : "end";
  const ids = new Set(children.map((one) => one.terminal?.callId));
  const mine = list.filter((one) => ids.has(one.callId));
  const started = Math.min(...mine.map((one) => one.startedAt));
  const endedAt = Math.max(...mine.map((one) => one.endedAt ?? now));
  return {
    note: `${children.length} process${children.length === 1 ? "" : "es"}`,
    glyph,
    running,
    time: durationText((running ? now : endedAt) - started),
    ...(glyph === "bad" ? { timeBad: true } : {}),
  };
}

/** The terminals a node's Stop ends: its own while it runs, and every running one under it. */
export function stopTargetsOf(node: ProcessTreeNode): ProcessTerminalRef[] {
  const own = node.terminal !== undefined && node.running ? [node.terminal] : [];
  return [...own, ...node.children.flatMap(stopTargetsOf)];
}

/** One line of the tree as drawn: the node, how deep, whether it is folded, whether it is open as its card. */
export interface ShownNode {
  node: ProcessTreeNode;
  depth: number;
  folded: boolean;
  open: boolean;
}

/**
 * The tree as it is drawn, top to bottom: every node whose parents are unfolded, with its depth. A node
 * in `folded` hides its children; one in `open` is drawn as its card (its children still under it).
 */
export function shownNodesOf(root: ProcessTreeNode, folded: ReadonlySet<string>, open: ReadonlySet<string>): ShownNode[] {
  const out: ShownNode[] = [];
  const walk = (node: ProcessTreeNode, depth: number): void => {
    const shut = folded.has(node.id);
    out.push({ node, depth, folded: shut, open: node.terminal !== undefined && open.has(node.id) });
    if (!shut) for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** A set with `id` in it, or out of it if it was: the rows open in place, the folded nodes. */
export function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * What a press on a row does (ruling 2): one with a terminal opens in place as its card, or folds back
 * to its row; one without (a session, a tool call) folds or unfolds what is under it.
 */
export function pressOf(node: ProcessTreeNode): "open" | "fold" | "none" {
  if (node.terminal !== undefined) return "open";
  return node.children.length > 0 ? "fold" : "none";
}

/**
 * The far end of a row (ruling 2; round 2, boards 2 and 4). At rest: the places it is shown in, each a
 * lit chip (`split`), then its time. Hovered: the time gives way to the three place buttons (that place
 * lit), `…` and Stop while it runs — the buttons and `…` only on a node with a terminal to place.
 */
export function rowEndOf(node: ProcessTreeNode, hovered: boolean, lit: readonly Place[]): { chips: Place[]; time: boolean; places: boolean; more: boolean; stop: boolean } {
  if (!hovered) return { chips: [...lit], time: node.time !== undefined && node.time.length > 0, places: false, more: false, stop: false };
  const placeable = node.terminal !== undefined;
  return { chips: [], time: false, places: placeable, more: placeable, stop: node.running && stopTargetsOf(node).length > 0 };
}
