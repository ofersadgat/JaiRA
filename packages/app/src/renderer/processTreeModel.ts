import { processEnded, type CommandDialect, type ProcessSummary, type ProcessTreeNode as EngineNode, type TerminalSummary } from "@jaira/shared/browser";
import { originLabelOf, shortAge } from "./processTaskModel";
import type { Place } from "./splitModel";
import { durationText, isWaiting, terminalTitleOf } from "./terminalModel";

/**
 * The Terminals tab's rows and tree (decision 0032, the view, ruling 2): List is the rows, Tree goes from
 * the session to its processes to what they started. Both are drawn from one shape, {@link ProcessTreeNode}
 * — a row is a node with no children — so the tab draws whatever feeds it: the window's terminals
 * (`terminalListOf`, `terminalTreeOf`), and the engine's processes and process tree (`sessionRowsOf`,
 * `engineTreeOf`, `scopeTreeOf`), which fill the same nodes with what only the engine knows (the pid, the
 * ports, where it came from, a process's children, the escaped ones under the program that started them).
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
  /** The engine's process it is: opened as the process card; one no task keeps (a child, another scope's) is watched first. */
  process?: ProcessSummary;
  /** The ports it listens on, drawn as chips after its tag. */
  ports?: number[];
  /** It waits for the person: the row shows its last lines and `Answer it`. */
  waiting?: boolean;
  children: ProcessTreeNode[];
}

/** A terminal as a row: its title for a label, the rest of its line after it, how it is doing. */
export function terminalNodeOf(summary: TerminalSummary, now: number): ProcessTreeNode {
  const waiting = isWaiting(summary);
  const running = summary.endedAt === undefined;
  const label = terminalTitleOf(summary.command, summary.dialect);
  const command = summary.command.trim();
  // The title keeps the line's case; the rest is after it either way.
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
    out.push({ node, depth, folded: shut, open: (node.terminal !== undefined || node.process !== undefined) && open.has(node.id) });
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
  if (node.terminal !== undefined || node.process !== undefined) return "open";
  return node.children.length > 0 ? "fold" : "none";
}

/**
 * The far end of a row (ruling 2; round 2, boards 2 and 4). At rest: the places it is shown in, each a
 * lit chip (`split`), then its time. Hovered: the time gives way to the three place buttons (that place
 * lit), `…` and Stop while it runs — the buttons and `…` only on a node with a terminal to place.
 */
export function rowEndOf(node: ProcessTreeNode, hovered: boolean, lit: readonly Place[]): { chips: Place[]; time: boolean; places: boolean; more: boolean; stop: boolean } {
  if (!hovered) return { chips: [...lit], time: node.time !== undefined && node.time.length > 0, places: false, more: false, stop: false };
  const placeable = node.terminal !== undefined || node.process !== undefined;
  return { chips: [], time: false, places: placeable, more: placeable, stop: node.running && (stopTargetsOf(node).length > 0 || stopKeysOf(node).length > 0) };
}

// --- the engine's processes ------------------------------------------------------------------------

/** The process keys a node's Stop sends to the engine (`process:stop`): a process's with no terminal to stop through. */
export function stopKeysOf(node: ProcessTreeNode): string[] {
  const own = node.process !== undefined && node.terminal === undefined && node.running ? [node.process.key] : [];
  return [...own, ...node.children.flatMap(stopKeysOf)];
}

/** A row's tag for where a process came from: `background`, `left running`, `escaped · WMI`, `Claude's Bash`, `Mine · watched`. */
export function originTagOf(p: Pick<ProcessSummary, "origin" | "why" | "by">): ProcessTreeNode["tag"] | undefined {
  if (p.origin === undefined) return undefined;
  if (p.origin === "this-turn") return p.by === "you" ? { words: "you", tone: "accent" } : { words: "this turn", tone: "plain" };
  const words = p.origin === "background" ? "background" : originLabelOf({ origin: p.origin, why: p.why });
  return { words, tone: p.origin === "escaped" ? "warn" : p.origin === "background" ? "accent" : "plain" };
}

/** How long it has run, or how it ended, at a row's far end. */
function processTimeOf(p: ProcessSummary, now: number): { time: string; bad: boolean } {
  // A start the machine did not say (a parent read only by its pid) has no age to show.
  if (!processEnded(p.state) && p.startedAt <= 0) return { time: "", bad: false };
  if (!processEnded(p.state)) return { time: p.origin === "this-turn" ? durationText(now - p.startedAt) : shortAge(now - p.startedAt), bad: false };
  if (p.state === "stopped") return { time: "stopped", bad: false };
  if (p.state === "failed") return { time: p.exitCode !== undefined && p.exitCode !== null ? `exit ${p.exitCode}` : (p.signal ?? "failed"), bad: true };
  return { time: durationText((p.endedAt ?? now) - p.startedAt), bad: false };
}

/**
 * A process as a row: its short name, its pid, the rest of its command dim (for one the machine names,
 * what its command says past the name), its origin tag — `told Claude` once the agent was told it ended,
 * `waiting for you` while it waits — and its ports; the card it opens, through its terminal when it has
 * one (`terminal`, the window's copy of it).
 */
export function processNodeOf(p: ProcessSummary, now: number, terminal?: TerminalSummary): ProcessTreeNode {
  const ended = processEnded(p.state);
  const waiting = p.state === "waiting";
  const { time, bad } = processTimeOf(p, now);
  const kept = p.origin !== undefined;
  const rest = kept ? undefined : restOf(p.command, p.name);
  const tag = waiting ? ({ words: "waiting for you", tone: "warn" } as const) : ended && p.told === true ? ({ words: "told Claude", tone: "bad" } as const) : originTagOf(p);
  const glyph: ProcessGlyph = waiting ? "wait" : ended ? (p.state === "failed" ? "bad" : "end") : p.origin === "escaped" ? "escaped" : p.origin === "left" ? "left" : p.origin === "watched" || (!kept && p.startedBy !== "session") ? "external" : "run";
  const ref = p.terminal !== undefined && p.taskId !== undefined ? { taskId: p.taskId, callId: p.terminal, command: terminal?.command ?? p.command, dialect: terminal?.dialect ?? dialectGuess(p.command) } : undefined;
  return {
    id: `process:${p.key}`,
    kind: "process",
    label: p.name,
    ...(rest !== undefined && rest.length > 0 ? { note: rest } : {}),
    title: `${p.command} · pid ${p.pid}${p.why !== undefined ? ` · ${p.why}` : ""}`,
    ...(tag !== undefined ? { tag } : {}),
    glyph,
    ...(time.length > 0 ? { time } : {}),
    ...(bad ? { timeBad: true } : {}),
    pid: p.pid,
    running: !ended,
    ...(ref !== undefined ? { terminal: ref } : {}),
    process: p,
    ...(p.ports.length > 0 ? { ports: [...p.ports] } : {}),
    ...(waiting ? { waiting: true } : {}),
    children: [],
  };
}

/** What a command line says past the name it is shown by: `/c npx one dev` after `cmd.exe`; nothing when it is only the name. */
function restOf(command: string, name: string): string | undefined {
  const line = command.trim();
  if (line.length === 0 || line === name) return undefined;
  const words = line.match(/"[^"]*"|\S+/g) ?? [];
  const first = (words[0] ?? "").replace(/^"|"$/g, "");
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.toLowerCase() === name.toLowerCase() || base.toLowerCase() === `${name.toLowerCase()}.exe` ? words.slice(1).join(" ") : line;
}

function dialectGuess(command: string): CommandDialect {
  return /^\s*(?:pwsh|powershell)|\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/.test(command) ? "powershell" : "posix";
}

type Dated = ProcessTreeNode & { started: number; ended?: number };

/** Live first (those waiting for the person at the top, then the oldest), then the ended, newest first. */
function byLiveliness(a: Dated, b: Dated): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (a.running) return Number(b.waiting === true) - Number(a.waiting === true) || a.started - b.started;
  return (b.ended ?? 0) - (a.ended ?? 0);
}

function dated(node: ProcessTreeNode, started: number, ended: number | undefined): Dated {
  return { ...node, started, ...(ended !== undefined ? { ended } : {}) };
}

function undated({ started: _started, ended: _ended, ...node }: Dated): ProcessTreeNode {
  return node;
}

/**
 * List mode, with the engine's processes (ruling 2; round 2, board 2): the conversation's processes —
 * each with its pid, ports and origin tag — and its terminals that are no process (a quick command, a
 * tool's), one row each. Live ones under "This conversation"; then "Ended", newest first.
 */
export function sessionRowsOf(list: readonly TerminalSummary[], processes: readonly ProcessSummary[], now: number): { live: ProcessTreeNode[]; ended: ProcessTreeNode[] } {
  const terminals = new Map(list.map((one) => [one.callId, one] as const));
  const covered = new Set(processes.flatMap((p) => (p.terminal !== undefined ? [p.terminal] : [])));
  const rows = [
    ...processes.map((p) => dated(processNodeOf(p, now, p.terminal !== undefined ? terminals.get(p.terminal) : undefined), p.startedAt, p.endedAt)),
    ...list.filter((one) => !covered.has(one.callId)).map((one) => dated({ ...terminalNodeOf(one, now), ...(isWaiting(one) ? { waiting: true } : {}) }, one.startedAt, one.endedAt)),
  ].sort(byLiveliness);
  return { live: rows.filter((r) => r.running).map(undated), ended: rows.filter((r) => !r.running).map(undated) };
}

/** An engine node and what it started, as rows. */
function engineNodeOf(node: EngineNode, now: number, terminals: ReadonlyMap<string, TerminalSummary>): ProcessTreeNode {
  const p = node.process;
  return { ...processNodeOf(p, now, p.terminal !== undefined ? terminals.get(p.terminal) : undefined), children: node.children.map((child) => engineNodeOf(child, now, terminals)) };
}

/**
 * Tree mode, fed by the engine's `process:tree` for the session (ruling 2; round 2, board 3): the session,
 * then each of its processes and what it started (`cmd.exe` → `node.exe` → `esbuild.exe`, `conhost.exe`),
 * the escaped ones under "escaped · outside this tree", each under the program that really started it
 * (`WmiPrvSE.exe`). The conversation's terminals that are no process follow, as `terminalTreeOf` draws them.
 */
export function engineTreeOf(session: { id: string; label: string }, nodes: readonly EngineNode[], list: readonly TerminalSummary[], now: number): ProcessTreeNode {
  const terminals = new Map(list.map((one) => [one.callId, one] as const));
  const covered = new Set<string>();
  const walk = (all: readonly EngineNode[]): void => {
    for (const n of all) {
      if (n.process.terminal !== undefined) covered.add(n.process.terminal);
      walk(n.children);
    }
  };
  walk(nodes);
  const mine = nodes.filter((n) => n.process.origin !== undefined).map((n) => dated(engineNodeOf(n, now, terminals), n.process.startedAt, n.process.endedAt));
  const outside = nodes.filter((n) => n.process.origin === undefined).map((n) => engineNodeOf(n, now, terminals));
  mine.sort(byLiveliness);
  const rest = terminalTreeOf(session, list.filter((one) => !covered.has(one.callId)), now).children;
  const escapedKept = outside.flatMap((n) => n.children);
  const escaped: ProcessTreeNode[] =
    outside.length > 0 ? [{ id: `escaped:${session.id}`, kind: "call", label: "escaped", note: "outside this tree", glyph: "escaped", running: outside.some((n) => n.running), children: outside }] : [];
  const children = [...mine.filter((n) => n.running).map(undated), ...escaped, ...mine.filter((n) => !n.running).map(undated), ...rest];
  const kept = [...mine, ...escapedKept];
  const live = kept.filter((n) => n.running).length + rest.filter((n) => n.running).length;
  const escapes = escapedKept.length + mine.filter((n) => n.process?.origin === "escaped").length;
  const ended = kept.length + rest.length - live;
  return {
    id: `session:${session.id}`,
    kind: "session",
    label: session.label,
    note: kept.length + rest.length === 0 ? "nothing run yet" : [live > 0 ? `${live} running` : "", escapes > 0 ? `${escapes} escaped` : "", ended > 0 ? `${ended} ended` : ""].filter((s) => s.length > 0).join(" · "),
    running: live > 0,
    children,
  };
}

/** The other scopes, folded below the conversation's (ruling 2), and how each is said. */
export const OTHER_SCOPES = [
  { scope: "user", label: "Mine", note: "not started by JaiRA" },
  { scope: "jaira", label: "JaiRA", note: "its sessions' and its own" },
  { scope: "system", label: "System", note: "services and other accounts" },
] as const;
export type OtherScope = (typeof OTHER_SCOPES)[number];

/**
 * Another scope, as a node under the conversation's, folded until opened: then its processes as the
 * machine has them, each under what started it (`process:tree` with that scope), counted; unread, only
 * what it holds. `said` is what the engine added (how many it could not place, or why it refused).
 */
export function scopeTreeOf(scope: OtherScope, nodes: readonly EngineNode[] | undefined, now: number, said?: string): ProcessTreeNode {
  const count = (all: readonly EngineNode[]): number => all.reduce((n, one) => n + 1 + count(one.children), 0);
  const children = (nodes ?? []).map((n) => engineNodeOf(n, now, new Map()));
  const note = [scope.note, ...(nodes !== undefined ? [String(count(nodes))] : []), ...(said !== undefined ? [said] : [])].join(" · ");
  return { id: `scope:${scope.scope}`, kind: "session", label: scope.label, note, running: false, children };
}
