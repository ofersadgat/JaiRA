/**
 * What a stretch of work AMOUNTED to — the model behind the summary drawn in place of a row per call
 * (the person's note 6, 2026-09-25, and the tool-summary mockups that followed: B's chips, J's
 * ordered rows, and 5 + 4 — phases with a rolling window — as the one they chose).
 *
 * A stretch is everything between two messages (`WorkBlock`). It is cut into PHASES where the agent
 * stopped to think; a phase is named by what it did, from four fixed names, because Claude withholds
 * most of its reasoning and the names cannot come from text that is not there. Inside a phase the
 * work is counted in CHIPS — one per kind: "3 files", "2 searches", "12 s wait" — and, while the agent
 * is still working, the phase in progress keeps its latest steps as ROWS, in order, with consecutive
 * calls of one kind merged into one row ("Read 3 files in …/renderer").
 *
 * Pure: entries in, a description out. The view (`workSummaryView.tsx`) draws it; this is tested
 * without a window.
 */
import { APPROVAL_PROMPT_FUNCTION, toolDisplayOf } from "@jaira/shared/browser";
import { iconOf, shellLineOf, type ThoughtEntry, type ToolEntry, type WorkEntry, type WorkIconName } from "./transcript";

// --- kinds ---------------------------------------------------------------------------------------

/** What kind of work one entry is — the unit a chip counts. */
export type WorkKind = "think" | "read" | "search" | "write" | "run" | "git" | "web" | "agent" | "tool" | "wait" | "note" | "approval";

/** A rate limit, as the agents word it: a wait the run sat through, not a fact about the work. */
const RATE_LIMIT = /rate[\s_-]?limit/i;

export function kindOf(entry: WorkEntry): WorkKind {
  if (entry.kind === "thought") return "think";
  if (entry.kind === "event") return RATE_LIMIT.test(entry.text) ? "wait" : "note";
  if (isApprovalCall(entry)) return "approval";
  switch (iconOf(entry)) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "write":
      return "write";
    case "terminal":
      return "run";
    // A shell line that runs git is a command of its own kind; a Git TOOL (the forge's) is itself.
    case "git":
      return entry.kind === "tool" && shellLineOf(entry) !== undefined ? "git" : "tool";
    case "web":
      return "web";
    case "agent":
      return "agent";
    default:
      return "tool";
  }
}

/**
 * What a chip counts TOGETHER. Every kind is one chip, except the tools that have no family of their
 * own: "List merge requests" and "Update issue" are not the same thing twice, so each is its title.
 */
export function keyOf(entry: WorkEntry): string {
  const kind = kindOf(entry);
  return kind === "tool" && (entry.kind === "tool" || entry.kind === "writing") ? `tool:${toolDisplayOf(entry.name).title}` : kind;
}

/**
 * Still happening: a call with no answer yet, a call being written, a thought still being thought.
 * Read only on the LAST stretch of a transcript — an unanswered call further up is one that was cut
 * off, not one still running.
 */
export function inFlight(entry: WorkEntry): boolean {
  if (entry.kind === "writing") return true;
  if (entry.kind === "thought") return entry.live === true;
  return entry.kind === "tool" && entry.ok === undefined && entry.result === undefined;
}

/** The file a call is about: its path argument, else the line it was summarised by. */
function pathOf(entry: WorkEntry): string {
  if (entry.kind === "writing") return entry.path ?? "";
  if (entry.kind !== "tool") return "";
  const args = entry.args;
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    for (const key of ["file_path", "path", "file", "notebook_path"]) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return entry.summary;
}

const failed = (entry: WorkEntry): boolean => (entry.kind === "tool" && entry.ok === false) || (entry.kind === "event" && entry.tone === "bad");

/** How long one entry took, where the record says: a thought's own timing; a wait parsed from its line. */
function tookOf(entry: WorkEntry): number {
  if (entry.kind === "thought") return entry.durationMs ?? 0;
  if (entry.kind === "event" && RATE_LIMIT.test(entry.text)) {
    const said = /(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i.exec(entry.text);
    if (said === null) return 0;
    const n = Number(said[1]);
    const unit = said[2]!.toLowerCase();
    return unit === "ms" ? n : unit.startsWith("m") && unit !== "ms" ? n * 60_000 : n * 1000;
  }
  return 0;
}

// --- the approval prompt, as a step ----------------------------------------------------------------

/** `approve_tool_call` — a call a tool made to put itself to the person (`hostCalls.ts`). */
export function isApprovalCall(entry: WorkEntry): boolean {
  return entry.kind === "tool" && entry.name === APPROVAL_PROMPT_FUNCTION;
}

/** How it was answered — its result's `data` — or `undefined` while it waits. */
export function approvalAnswerOf(entry: ToolEntry): { decision: "allow" | "deny"; scope: string; by: "person" | "stopped" | "closed"; waitedMs: number } | undefined {
  const data = entry.detail as { decision?: unknown; scope?: unknown; by?: unknown; waitedMs?: unknown } | undefined;
  if (data === undefined || data === null || typeof data !== "object") return undefined;
  if (data.decision !== "allow" && data.decision !== "deny") return undefined;
  return {
    decision: data.decision,
    scope: typeof data.scope === "string" ? data.scope : "once",
    by: data.by === "stopped" || data.by === "closed" ? data.by : "person",
    waitedMs: typeof data.waitedMs === "number" ? data.waitedMs : 0,
  };
}

/** The line it was about, and who asked, off its arguments. */
export function approvalAboutOf(entry: ToolEntry): { command?: string; tool?: string; asker?: string } {
  const args = entry.args as { command?: unknown; tool?: unknown; asker?: unknown } | undefined;
  return {
    ...(typeof args?.command === "string" ? { command: args.command } : {}),
    ...(typeof args?.tool === "string" ? { tool: args.tool } : {}),
    ...(typeof args?.asker === "string" ? { asker: args.asker } : {}),
  };
}

/** How far an answer reached, in a person's words. */
const REACH: Record<string, string> = { once: "once", run: "for this run", session: "for this session", always: "always" };

/**
 * An approval as a row reads it (the person, 2026-09-26, round 1's option A): its verdict as the name —
 * Approve while it waits, then Approved, Denied or Not answered — and who, how far and after how long as
 * the rest of the line.
 */
export function approvalWordsOf(entry: ToolEntry): { name: string; preview: string; tone: "plain" | "warn" | "bad"; mark?: "ok" | "bad" | "waiting" } {
  const answer = approvalAnswerOf(entry);
  const about = approvalAboutOf(entry);
  if (answer === undefined) return { name: "Approve", preview: about.command ?? about.tool ?? "", tone: "plain", mark: "waiting" };
  const after = answer.waitedMs >= 1000 ? ` · after ${secondsOf(answer.waitedMs)}` : "";
  if (answer.by !== "person") {
    return { name: "Not answered", preview: `${answer.by === "closed" ? "the app closed" : "the run stopped"} while it waited${after}`, tone: "warn", mark: "bad" };
  }
  const who = about.asker !== undefined ? `by you, for ${about.asker}` : "by you";
  const reach = REACH[answer.scope] ?? answer.scope;
  return answer.decision === "allow"
    ? { name: "Approved", preview: `${who} · ${reach}${after}`, tone: "plain", mark: "ok" }
    : { name: "Denied", preview: `${who} · ${reach}${after}`, tone: "bad", mark: "bad" };
}

// --- words ---------------------------------------------------------------------------------------

export function secondsOf(ms: number): string {
  // Under a second is not "0 s": something happened, and it took less than the unit can say.
  if (ms < 1000) return "<1 s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  // Past an hour the seconds are noise, and "872 min" is a sum left for the reader.
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
const base = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
function commonDir(paths: readonly string[]): string {
  const parts = paths.map((p) => p.split(/[\\/]/).slice(0, -1));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = parts[0]?.[i];
    if (seg === undefined || !parts.every((p) => p[i] === seg)) break;
    out.push(seg);
  }
  const segs = out.filter(Boolean);
  return segs.length === 0 ? "" : segs.length <= 2 ? segs.join("/") : `…/${segs.slice(-2).join("/")}`;
}
const unique = <T,>(list: readonly T[]): T[] => [...new Set(list)];

// --- chips (B) -----------------------------------------------------------------------------------

export interface WorkChip {
  key: string;
  kind: WorkKind;
  icon: WorkIconName;
  /** "3 files", "12 s wait", "List merge requests". */
  label: string;
  /** The entries it counts, by index into the stretch. */
  indices: number[];
  /** How many of them failed. */
  failed: number;
  /** One of them is still running. */
  live: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One chip per kind of work, in the order each kind first happened. */
export function chipsOf(entries: readonly WorkEntry[], indices: readonly number[], live?: number): WorkChip[] {
  const order: string[] = [];
  const by = new Map<string, number[]>();
  for (const i of indices) {
    const key = keyOf(entries[i]!);
    if (!by.has(key)) {
      by.set(key, []);
      order.push(key);
    }
    by.get(key)!.push(i);
  }
  return order.map((key) => {
    const at = by.get(key)!;
    const items = at.map((i) => entries[i]!);
    const kind = kindOf(items[0]!);
    const files = unique(items.map(pathOf)).length;
    const n = items.length;
    const took = items.reduce((sum, e) => sum + tookOf(e), 0);
    const label = (() => {
      switch (kind) {
        case "think":
          return took > 0 ? secondsOf(took) : "thinking";
        case "read":
          return plural(files, "file", "files");
        case "write":
          return `${files} edited`;
        case "search":
          return plural(n, "search", "searches");
        case "run":
          return plural(n, "command", "commands");
        case "git":
          return plural(n, "git command", "git commands");
        case "web":
          return plural(n, "page", "pages");
        case "agent":
          return plural(n, "subagent", "subagents");
        case "wait":
          return took > 0 ? `${secondsOf(took)} wait` : plural(n, "rate limit", "rate limits");
        case "note":
          return plural(n, "note", "notes");
        case "approval":
          return plural(n, "approval", "approvals");
        case "tool": {
          const title = key.slice("tool:".length);
          return n > 1 ? `${title} ×${n}` : title;
        }
      }
    })();
    return { key, kind, icon: iconOf(items[0]!), label, indices: at, failed: items.filter(failed).length, live: live !== undefined && at.includes(live) };
  });
}

// --- rows (J) ------------------------------------------------------------------------------------

/**
 * Consecutive calls of one kind — one row. A thought rides on the row after it (it is why that row
 * happened) and a system note on the row before it (it is what that row caused); neither is a step.
 */
export interface WorkRun {
  key: string;
  kind: WorkKind;
  /** The calls, in order. */
  rows: number[];
  /** The thinking that led to it. */
  thoughts: number[];
  /** Notes that followed it. */
  notes: number[];
}

export function runsOf(entries: readonly WorkEntry[], indices: readonly number[]): WorkRun[] {
  const runs: WorkRun[] = [];
  let thoughts: number[] = [];
  for (const i of indices) {
    const entry = entries[i]!;
    const key = keyOf(entry);
    if (key === "think") {
      thoughts.push(i);
      continue;
    }
    const last = runs[runs.length - 1];
    if (key === "note" && last !== undefined) {
      last.notes.push(i);
      continue;
    }
    if (last !== undefined && last.key === key && thoughts.length === 0) last.rows.push(i);
    else {
      runs.push({ key, kind: kindOf(entry), rows: [i], thoughts, notes: [] });
      thoughts = [];
    }
  }
  if (thoughts.length > 0) runs.push({ key: "think", kind: "think", rows: thoughts, thoughts: [], notes: [] });
  return runs;
}

/** Every entry a run stands for, in order. */
export function allOf(run: WorkRun): number[] {
  return [...run.thoughts, ...run.rows, ...run.notes].sort((a, b) => a - b);
}

/** A piece of a row's sentence: words, or a name set as code — `shell` when it is a command line. */
export type Said = { text: string } | { code: string; shell?: boolean };

/**
 * What a run amounted to, in words — or, for the run still going, what it did and what it is doing
 * NOW: "Read `styles.css`, then **Reading `index.html`**". `now` marks where the present begins.
 */
export function sentenceOf(entries: readonly WorkEntry[], run: WorkRun, live?: number): { said: Said[]; now?: Said[] } {
  const items = run.rows.map((i) => entries[i]!);
  const running = live !== undefined && run.rows.includes(live) ? entries[live]! : undefined;
  const done = running === undefined ? items : items.filter((e) => e !== running);
  const say = (list: WorkEntry[]): Said[] => {
    if (list.length === 0) return [];
    const files = unique(list.map(pathOf));
    const where = commonDir(files);
    switch (run.kind) {
      case "read":
        return files.length === 1 ? [{ text: "Read " }, { code: base(files[0]!) }] : [{ text: `Read ${files.length} files` }, ...(where ? [{ text: " in " }, { code: where }] : [])];
      case "write":
        return files.length === 1 ? [{ text: "Edited " }, { code: base(files[0]!) }] : [{ text: `Edited ${files.length} files` }, ...(where ? [{ text: " in " }, { code: where }] : [])];
      case "search":
        return list.length === 1 ? [{ text: "Searched for " }, { code: summaryOf(list[0]!) }] : [{ text: `Searched for ${list.length} patterns` }];
      case "run":
      case "git":
        // A command still waiting on what it called — the approval that is the turn's live edge — has
        // not run yet: it is running, held, not ran.
        if (live !== undefined && list.length === 1 && inFlight(list[0]!)) return [{ text: "Running " }, shellOf(list[0]!)];
        return list.length === 1 ? [{ text: "Ran " }, shellOf(list[0]!)] : [{ text: `Ran ${list.length} ${run.kind === "git" ? "git commands" : "commands"}` }];
      case "web":
        return list.length === 1 ? [{ text: "Fetched " }, { code: summaryOf(list[0]!) }] : [{ text: `Fetched ${list.length} pages` }];
      case "agent":
        return [{ text: list.length === 1 ? `Ran a subagent` : `Ran ${list.length} subagents` }];
      case "wait":
        return [{ text: `Rate-limited${list.reduce((s, e) => s + tookOf(e), 0) > 0 ? ` ${secondsOf(list.reduce((s, e) => s + tookOf(e), 0))}` : ""}` }];
      case "think":
        return [{ text: `Thought${list.reduce((s, e) => s + tookOf(e), 0) > 0 ? ` for ${secondsOf(list.reduce((s, e) => s + tookOf(e), 0))}` : ""}` }];
      case "note":
        return [{ text: plural(list.length, "note", "notes") }];
      case "approval": {
        if (list.length > 1) return [{ text: `${list.length} approvals` }];
        const words = approvalWordsOf(list[0] as ToolEntry);
        const command = approvalAboutOf(list[0] as ToolEntry).command;
        return [{ text: `${words.name} ` }, ...(command !== undefined ? [{ code: command, shell: true }] : [])];
      }
      case "tool": {
        const title = run.key.slice("tool:".length);
        return [{ text: list.length > 1 ? `${title} ×${list.length}` : title }, ...(list.length === 1 && summaryOf(list[0]!) ? [{ text: " " }, { code: summaryOf(list[0]!) }] : [])];
      }
    }
  };
  const said = say(done);
  if (running === undefined) return { said };
  const doing = ((): Said[] => {
    switch (run.kind) {
      case "read":
        return [{ text: "Reading " }, { code: base(pathOf(running)) }];
      case "write":
        return [{ text: "Editing " }, { code: base(pathOf(running)) }];
      case "search":
        return [{ text: "Searching for " }, { code: summaryOf(running) }];
      case "run":
      case "git":
        return [{ text: "Running " }, shellOf(running)];
      case "web":
        return [{ text: "Fetching " }, { code: summaryOf(running) }];
      case "think":
        return [{ text: "Thinking" }];
      case "approval": {
        const command = approvalAboutOf(running as ToolEntry).command;
        return [{ text: "Waiting for you to approve " }, ...(command !== undefined ? [{ code: command, shell: true }] : [])];
      }
      default:
        return [{ text: running.kind === "tool" || running.kind === "writing" ? toolDisplayOf(running.name).title : "Working" }];
    }
  })();
  return { said: said.length > 0 ? [...said, { text: ", then " }] : [], now: doing };
}
/** A command, as the line it ran — drawn in the colours of its parts, as an approval draws it. */
function shellOf(entry: WorkEntry): Said {
  const line = entry.kind === "tool" ? shellLineOf(entry) : undefined;
  return line !== undefined ? { code: line, shell: true } : { code: summaryOf(entry) };
}
function summaryOf(entry: WorkEntry): string {
  if (entry.kind === "tool") return entry.summary;
  if (entry.kind === "writing") return entry.path ?? "";
  return "";
}

// --- what a call did -------------------------------------------------------------------------------

/**
 * What the project's read-only permission set says of a call (`permissionSets:judgeReadOnly`): `true`
 * it lets it through, `false` it does not, `null` no permission set holds it at all (an agent's
 * bookkeeping — `TodoWrite`). `undefined` while the answer has not come, or where nothing asks.
 */
export type ReadOnlyVerdicts = (entry: ToolEntry) => boolean | null | undefined;

/** What a verdict is asked and kept under: the call's name and input — two identical calls are one question. */
export function verdictKeyOf(entry: ToolEntry): string {
  return `${entry.name}\u0000${JSON.stringify(entry.args ?? null)}`;
}

/**
 * A CHANGE: a call the read-only permission set does not let through — an edit, a command that is not
 * one of the reading ones, a sub-agent. Until the set has answered, a call that edits is one and
 * nothing else is.
 */
export function isChange(entry: WorkEntry, verdicts?: ReadOnlyVerdicts): boolean {
  if (entry.kind === "writing") return kindOf(entry) === "write";
  if (entry.kind !== "tool" || isApprovalCall(entry)) return false;
  const said = verdicts?.(entry);
  return said === undefined ? kindOf(entry) === "write" : said === false;
}

/** The line a command call ran, or the line it was summarised by. */
const commandLineOf = (entry: ToolEntry): string => shellLineOf(entry) ?? entry.summary;

/**
 * The ACTION a call is, for "has it done this before": the file a read reads (another part of it is
 * still the same file), the line a command runs, else the tool and its whole input.
 */
export function actionOf(entry: ToolEntry): string {
  const kind = kindOf(entry);
  if (kind === "read") return `read\u0000${pathOf(entry)}`;
  if (kind === "run" || kind === "git") return `run\u0000${commandLineOf(entry).replace(/\s+/g, " ").trim()}`;
  return `${entry.name}\u0000${JSON.stringify(entry.args ?? null)}`;
}

// --- phases (5) ----------------------------------------------------------------------------------

/** What a phase did — four fixed names; the reasoning that would say more is usually withheld. */
export type PhaseName = "Explored" | "Changed" | "Checked" | "Fixed";

/** A phase still going says what it is DOING: "Fixing", not "Fixed". */
export const ACTIVE_NAME: Record<PhaseName, string> = { Explored: "Exploring", Changed: "Changing", Checked: "Checking", Fixed: "Fixing" };

export interface WorkPhase {
  name: PhaseName;
  /** Its entries, by index into the stretch, in order. */
  indices: number[];
}

/**
 * The stretch cut at each thought, and each piece named by the first rule that fits:
 *  - Fixed: it did again, and this time it went through, an action that had failed earlier in the
 *    stretch — the tests that failed now pass. Whatever made the difference is not traced: a script
 *    can fix as well as an edit can;
 *  - Changed: a CHANGE — a call the read-only permission set does not let through ({@link isChange});
 *  - Checked: of its calls that change nothing, at least as many repeat an earlier action as are new
 *    ({@link actionOf}) — a file read again, the tests run again;
 *  - Explored: anything else — reading, searching, running what changes nothing for the first time.
 * A call no permission set holds (`null` — an agent's bookkeeping) counts toward none of them. While
 * a call is still running it is not yet through, so a phase re-running what failed reads Checking or
 * Changing until the answer comes, and Fixed after.
 *
 * With `dropIdle`, a piece whose only lines are rate limits and system notes is left out — it did no
 * work anybody asked for, and its lines are still in "Every step". Even when it is the only piece:
 * then there is no phase at all, only the foot.
 *
 * `merge` says when neighbours that got the same name become one — the thinking line is the only
 * thing that would tell them apart:
 *  - "all": always — the line is off;
 *  - "withheld": where the later one has no line to draw — the provider withheld its reasoning — so
 *    a withheld thought groups as it would with the line off. The earlier one's line, if any, heads
 *    them both;
 *  - "none": never.
 * After dropping, so a dropped piece between two of one name does not keep them apart.
 */
export function phasesOf(
  entries: readonly WorkEntry[],
  options: { merge: "all" | "withheld" | "none"; dropIdle: boolean; verdicts?: ReadOnlyVerdicts | undefined },
): WorkPhase[] {
  const cut: number[][] = [];
  entries.forEach((entry, i) => {
    if (entry.kind === "thought" || cut.length === 0) cut.push([]);
    cut[cut.length - 1]!.push(i);
  });
  // Every action done so far in the stretch, and those whose latest run failed.
  const done = new Set<string>();
  const failing = new Set<string>();
  const named = cut.map((indices): WorkPhase => {
    let fixed = false;
    let changed = false;
    let again = 0;
    let fresh = 0;
    for (const i of indices) {
      const entry = entries[i]!;
      if (entry.kind === "writing") changed ||= isChange(entry, options.verdicts);
      if (entry.kind !== "tool") continue;
      // The approval prompt changes nothing and checks nothing: it is the person being asked.
      if (isApprovalCall(entry)) continue;
      const action = actionOf(entry);
      if (failing.has(action) && entry.ok === true) fixed = true;
      if (isChange(entry, options.verdicts)) changed = true;
      else if (options.verdicts?.(entry) !== null) {
        if (done.has(action)) again++;
        else fresh++;
      }
      done.add(action);
      if (entry.ok === false) failing.add(action);
      else if (entry.ok === true) failing.delete(action);
    }
    const name: PhaseName = fixed ? "Fixed" : changed ? "Changed" : again > 0 && again >= fresh ? "Checked" : "Explored";
    return { name, indices };
  });
  const shown = options.dropIdle ? named.filter((phase) => !isIdle(entries, phase.indices)) : named;
  if (options.merge === "none") return shown;
  return shown.reduce<WorkPhase[]>((out, phase) => {
    const last = out[out.length - 1];
    const joins = options.merge === "all" || thoughtLineOf(entries, phase.indices) === undefined;
    if (last !== undefined && last.name === phase.name && joins) last.indices = [...last.indices, ...phase.indices];
    else out.push({ name: phase.name, indices: [...phase.indices] });
    return out;
  }, []);
}

/** A rate limit or a system note: a line about the run, not a step of the work. */
export function isQuiet(entry: WorkEntry): boolean {
  const kind = kindOf(entry);
  return kind === "wait" || kind === "note";
}

/** Lines with nothing but rate limits and notes among them — thinking aside — and at least one of those. */
export function isIdle(entries: readonly WorkEntry[], indices: readonly number[]): boolean {
  const work = indices.map((i) => entries[i]!).filter((entry) => entry.kind !== "thought");
  return work.length > 0 && work.every(isQuiet);
}

/**
 * The window (4) over the phase in progress: its last `rows` runs stay rows; everything before them
 * is counted in the phase's chips.
 */
export function windowOf(entries: readonly WorkEntry[], indices: readonly number[], rows: number): { rolled: number[]; shown: WorkRun[] } {
  const runs = runsOf(entries, indices).filter((run) => run.key !== "think");
  const shown = rows > 0 ? runs.slice(-rows) : [];
  const kept = new Set(shown.flatMap(allOf));
  return { rolled: indices.filter((i) => !kept.has(i)), shown };
}

// --- thinking, as a line ---------------------------------------------------------------------------

/** What the provider says in place of reasoning it would not hand over (`messagePartsOf`). */
export const WITHHELD = "(withheld by the provider)";

/** A phase's reasoning where it was kept: its first sentence for the line, all of it for the card. */
export function thoughtLineOf(entries: readonly WorkEntry[], indices: readonly number[]): { first: string; full: string } | undefined {
  const kept = indices
    .map((i) => entries[i]!)
    .filter((e): e is ThoughtEntry => e.kind === "thought" && e.text.trim().length > 0 && e.text.trim() !== WITHHELD);
  if (kept.length === 0) return undefined;
  const text = kept[0]!.text.replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?;:])(\s|$)/.exec(text)?.[1] ?? text;
  return { first, full: kept.map((e) => e.text.trim()).join("\n\n") };
}

// --- spans -----------------------------------------------------------------------------------------

/**
 * When a set of entries began and ended, where the record timed them. `end` is open while it runs.
 *
 * System notes are not timed: a note says something about the run, not a step of the work, and the
 * journal's are stamped when a TURN began — so a stretch holding nothing but the "went to" lines of
 * two turns, the second one fourteen hours after the first, measured the gap between them as fourteen
 * hours of work. A rate limit is still timed: that wait is time the work took.
 */
export function spanOf(entries: readonly WorkEntry[], indices: readonly number[]): { start?: number; end?: number } {
  const timed = indices.map((i) => entries[i]!).filter((e) => e.at !== undefined && kindOf(e) !== "note");
  if (timed.length === 0) return {};
  const first = timed[0]!;
  const last = timed[timed.length - 1]!;
  const lastTook = last.kind === "thought" ? (last.durationMs ?? 0) : tookOf(last);
  return { start: first.at!, end: last.at! + lastTook };
}

/** Steps, as the count reads them: calls and thoughts, not the notes about them. */
export function stepsOf(entries: readonly WorkEntry[]): number {
  return entries.filter((e) => e.kind !== "event").length;
}

/** What the foot counts: its steps — or, for a stretch of nothing but notes, the notes ("0 steps" is not a count of anything). */
export function countOf(entries: readonly WorkEntry[]): string {
  const steps = stepsOf(entries);
  if (steps > 0) return plural(steps, "step", "steps");
  return plural(entries.length, "note", "notes");
}

