/**
 * Who answers a CLI run's `ask` — a tool call or a shell line the policy will not decide alone
 * (DESIGN §10.2, decision 0007 §4).
 *
 * The app parks such a question in its inbox. The CLI has a terminal, sometimes: when stdin and
 * stdout are both one, the question is put to the person there, drawn the way the app draws it — the
 * line taken apart into the REQUESTS it is made of, each with its subject, its verdict and what
 * decided it — and answered once, for this run, or not at all. When nobody can be asked, every ask is
 * refused, and the refusal says why nobody was asked and what would let the call run: the flag that
 * asks at a terminal, and the setting or toolset line that allows it without asking. There is
 * deliberately no answer that allows everything: a built-in ask (a push, an install, a credential
 * path) is a question somebody should see, so the way past it is to write the answer down where the
 * project keeps its policy.
 *
 * Both are an {@link ApprovalHub} — the app's own seam — so the request a person sees here carries the
 * same `parts`, and "for this run" remembers the same widths in the same `CommandGrants`.
 */
import type { Approver, ExecPolicy } from "@declarative-ai/permissions";
import { policyAuditRow, type Project } from "@jaira/persistence";
import { ApprovalHub, compileRunPolicy, type ApprovalRequest, type RunPolicyConfig } from "@jaira/runtime";
import { askingParts, INLINE_TOOLSET, type CommandApproval, type CommandPart } from "@jaira/shared";

/** How a run answers an ask: at the terminal, or with a refusal. */
export type ApproveMode = "ask" | "deny";

/** Why nobody is asked — each is a different thing to change. */
export type Unasked =
  /** stdin or stdout is not a terminal (a pipe, a CI job). */
  | "no-terminal"
  /** `--non-interactive`. */
  | "non-interactive"
  /** `--approve deny`. */
  | "flag";

/** One line typed at the terminal, after `question` is shown; `undefined` at end of input or on abort. */
export type AskLine = (question: string, signal?: AbortSignal) => Promise<string | undefined>;

export type CliApprovalOptions =
  | { mode: "ask"; ask: AskLine; write: (text: string) => void; signal?: AbortSignal }
  | { mode: "deny"; unasked: Unasked; write: (text: string) => void };

export interface CliApprovals {
  /** The hub the run's approver parks on. */
  hub: ApprovalHub;
  /** Whether a person answers. */
  asks: boolean;
  /**
   * Whether nobody CHOSE the refusals — no terminal, or `--non-interactive`. `--approve deny` is a
   * standing answer somebody gave, so a run under it is not unattended in `gateCapabilities`' sense.
   */
  unattended: boolean;
}

/**
 * The policy and the approver one CLI run is governed by — the SAME recipe the app's `startRun` uses
 * (`compileRunPolicy`): the project's rules and built-ins, the executor's scope floor, the artifact size
 * above which a payload asks, the part answers remembered for the run, and, where the run has a task
 * to file it under, the `command_log` audit. Only who answers an ask differs: here, `approvals`.
 */
export function governRun(
  config: RunPolicyConfig,
  approvals: CliApprovals,
  where: { workspaceRoot?: string; audit?: { project: Project; taskId: string } } = {},
): { policy: ExecPolicy; approve: Approver } {
  const audit = where.audit;
  // A run with no task still remembers "for this run" answers — under a key of its own.
  const taskId = audit?.taskId ?? "cli";
  // A new run opens the gate, and takes the last run's remembered answers with it.
  approvals.hub.allow(taskId);
  const policy = compileRunPolicy(config, {
    ...(where.workspaceRoot !== undefined ? { workspaceRoot: where.workspaceRoot } : {}),
    onDecision: (entry) => {
      approvals.hub.noteDecision(entry);
      if (audit !== undefined) audit.project.commands.record(policyAuditRow(audit.taskId, entry));
    },
    grants: approvals.hub.grants(taskId),
  });
  return { policy, approve: approvals.hub.approver({ taskId }) };
}

/** The hub a CLI run's `approve` parks on, answered at the terminal or refused with a reason. */
export function cliApprovals(options: CliApprovalOptions): CliApprovals {
  let hub: ApprovalHub;
  if (options.mode === "deny") {
    const { unasked, write } = options;
    hub = new ApprovalHub({
      onRequest: (request) => {
        const why = unattendedRefusal(request, unasked);
        write(`refused: ${describeRequest(request)} — ${why}\n`);
        hub.decide(request.requestId, "deny", "once", undefined, why);
      },
    });
    return { hub, asks: false, unattended: unasked !== "flag" };
  }
  const { ask, write, signal } = options;
  // One question at a time: parallel states and an agent's parallel tool calls ask concurrently, and
  // one terminal can hold one question.
  let queue: Promise<void> = Promise.resolve();
  hub = new ApprovalHub({
    onRequest: (request) => {
      queue = queue.then(() => askAtTerminal(hub, request, ask, write, signal)).catch(() => {
        hub.decide(request.requestId, "deny", "once");
      });
    },
  });
  return { hub, asks: true, unattended: false };
}

async function askAtTerminal(hub: ApprovalHub, request: ApprovalRequest, ask: AskLine, write: (text: string) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    hub.decide(request.requestId, "deny", "once");
    return;
  }
  write(renderApproval(request));
  const choices = choicesFor(request);
  const prompt = `  ${choices.map((choice) => `[${choice.key}] ${choice.label}`).join("  ")}  (default: deny) › `;
  const answer = (await ask(prompt, signal))?.trim();
  const choice = choices.find((c) => c.key === answer) ?? choices.find((c) => c.key === "n")!;
  choice.apply(hub, request.requestId);
  write(`  ${choice.done}\n`);
}

interface Choice {
  key: string;
  label: string;
  /** What is said once it is taken. */
  done: string;
  apply: (hub: ApprovalHub, requestId: string) => void;
}

/**
 * The answers on offer. For a shell line: once, or "for this run" at the narrowest width of each asking
 * part (`git push`), and at its widest where that is wider (every `git` command) — the parts are
 * remembered, never the line (decision 0007 §4). A line nobody could read offers no width, so only
 * once. For any other tool: once, or for this run.
 */
export function choicesFor(request: ApprovalRequest): Choice[] {
  const once: Choice = { key: "y", label: "allow once", done: "allowed once", apply: (hub, id) => hub.decide(id, "allow", "once") };
  const deny: Choice = { key: "n", label: "deny", done: "denied", apply: (hub, id) => hub.decide(id, "deny", "once") };
  const parts = request.parts;
  if (parts === undefined) {
    if (request.command !== undefined) return [once, deny];
    return [once, { key: "r", label: `allow ${request.tool} for this run`, done: `allowed ${request.tool} for this run`, apply: (hub, id) => hub.decide(id, "allow", "workflow-run") }, deny];
  }
  const asking = askingParts(parts).filter((part) => part.widths.length > 0);
  if (asking.length === 0) return [once, deny];
  const narrow = unique(asking.map((part) => part.widths[0]!));
  const wide = unique(asking.map((part) => part.widths.at(-1)!));
  const choices: Choice[] = [
    once,
    { key: "r", label: `allow ${narrow.join(", ")} for this run`, done: `allowed ${narrow.join(", ")} for this run`, apply: (hub, id) => hub.decide(id, "allow", "once", narrow) },
  ];
  if (wide.join("\0") !== narrow.join("\0")) {
    choices.push({ key: "w", label: `allow every ${wide.join(", ")} command for this run`, done: `allowed every ${wide.join(", ")} command for this run`, apply: (hub, id) => hub.decide(id, "allow", "once", wide) });
  }
  choices.push(deny);
  return choices;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// --- drawing a request ---------------------------------------------------------

/** `bash: git push origin main` — the request in one line. */
export function describeRequest(request: ApprovalRequest): string {
  return request.command !== undefined ? `${request.tool}: ${request.command}` : request.tool;
}

/**
 * The approval as the terminal shows it: what asks and why, and — for a shell line — the line with
 * each part's characters numbered underneath, the words that matched its rule marked `^`, and one row
 * per part: its text, what it is a request FOR, its verdict and what decided it. The app draws the
 * same payload in colour; a terminal numbers instead.
 */
export function renderApproval(request: ApprovalRequest): string {
  const lines: string[] = [`\napproval · ${request.tool}${request.reason !== undefined && request.parts !== undefined ? ` — ${request.reason}` : ""}`];
  const parts = request.parts;
  if (parts === undefined) {
    if (request.command !== undefined) lines.push(`    $ ${request.command}`);
    else {
      const place = placeOf(request.input);
      if (place !== undefined) lines.push(`    ${place}`);
    }
    if (request.reason !== undefined) lines.push(`    why: ${request.reason}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(...lineRows(parts));
  const rows = parts.parts.map((part, index) => partColumns(part, index));
  const width = (column: number): number => Math.max(...rows.map((row) => row[column]!.length));
  for (const row of rows) {
    lines.push(`    ${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(width(column)))).join("  ")}`.trimEnd());
  }
  if (parts.unparsed !== undefined) lines.push(`    could not be read: ${parts.unparsed}`);
  if (parts.toolset !== undefined) lines.push(`    toolset: ${parts.toolset === INLINE_TOOLSET ? "the one written on the state" : parts.toolset}`);
  return `${lines.join("\n")}\n`;
}

/** The line, and under it which part owns each character and which characters matched its rule. */
function lineRows(approval: CommandApproval): string[] {
  const { line, parts } = approval;
  const out = [`    $ ${line}`];
  // Spans index the line character by character; a line over several rows cannot be marked that way.
  if (line.includes("\n") || parts.length === 0) return out;
  let owners = "";
  let carets = "";
  for (let at = 0; at < line.length; at++) {
    let own: number | undefined;
    parts.forEach((part, index) => {
      if (at < part.span.start || at >= part.span.end) return;
      const size = (i: number): number => parts[i]!.span.end - parts[i]!.span.start;
      // Innermost wins: `rm {}` inside its `find` is its own part in the middle.
      if (own === undefined || size(index) <= size(own)) own = index;
    });
    owners += own === undefined ? " " : labelOf(own);
    carets += own !== undefined && parts[own]!.matched.some((m) => at >= m.start && at < m.end) ? "^" : " ";
  }
  out.push(`      ${owners}`.trimEnd());
  if (carets.trim() !== "") out.push(`      ${carets}`.trimEnd());
  return out;
}

/** `1`…`9`, then `a`…: a label per part that fits one character column. */
function labelOf(index: number): string {
  return index < 9 ? String(index + 1) : String.fromCharCode(97 + ((index - 9) % 26));
}

const VERDICT: Record<CommandPart["verdict"], string> = { allowed: "allowed", asks: "ASKS", denied: "DENIED" };

function partColumns(part: CommandPart, index: number): string[] {
  const place = part.url ?? (part.paths !== undefined && part.paths.length > 0 ? part.paths.join(", ") : undefined);
  const via = part.via !== undefined && part.via.length > 0 && part.within === undefined ? `inside ${part.via.join(" › ")}` : undefined;
  const decided = deciderOf(part);
  return [labelOf(index), part.text, part.subject, VERDICT[part.verdict], [decided, place, via].filter((s) => s !== undefined).join(" · ")];
}

function deciderOf(part: CommandPart): string {
  const { source, entry, reason } = part.decidedBy;
  switch (source) {
    case "toolset":
      return entry !== undefined ? `toolset "${entry}"${reason.includes(" — ") ? ` — ${reason.slice(reason.indexOf(" — ") + 3)}` : ""}` : `toolset: ${reason}`;
    case "remembered":
      return `answered earlier this run${entry !== undefined ? ` (${entry})` : ""}`;
    case "builtin":
      return `built-in: ${reason}`;
    case "rule":
      return `policy rule: ${reason}`;
    case "default":
      return `policy default: ${reason}`;
    default:
      return `${source}: ${reason}`;
  }
}

function placeOf(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "url", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return `${key}: ${value}`;
  }
  return undefined;
}

// --- refusing without asking ------------------------------------------------------

const HOW_TO_BE_ASKED: Record<Unasked, string> = {
  "no-terminal": "this jaira run has no terminal (stdin and stdout must both be one); run it at a terminal to be asked",
  "non-interactive": "--non-interactive refuses every approval; drop it at a terminal to be asked",
  flag: "--approve deny refuses every approval; pass --approve ask at a terminal to be asked",
};

/**
 * Why a call was refused without asking anybody, and what would let it run: the flag that asks, and
 * per asking part the setting or toolset line that answers it for good. What to write depends on what
 * asked — a toolset's entry is answered in the toolset, because a policy rule cannot loosen a toolset
 * (the stricter of the two is kept); a built-in ask or the policy's default is answered by a
 * `policy.rules` entry, or by naming the program in the toolset, which replaces them.
 */
export function unattendedRefusal(request: ApprovalRequest, unasked: Unasked): string {
  const how = `nobody was asked: ${HOW_TO_BE_ASKED[unasked]}`;
  const allow = allowAdvice(request);
  return allow.length > 0 ? `${how}. To let it run without asking, write ${allow.join("; and ")}` : `${how}.`;
}

function allowAdvice(request: ApprovalRequest): string[] {
  const parts = request.parts;
  if (parts === undefined) {
    if (request.command !== undefined) return [];
    return [`a "${request.tool}": "allow" line in the state's toolset, or "policy": { "tools": { "${request.tool}": "allow" } } in .jaira/settings.json`];
  }
  // A toolset line is advice only where a toolset judged the line. `run_command` has none in reach —
  // its line answers to the policy alone — and neither has a state that declares no toolset.
  const toolset = parts.toolset === undefined ? undefined : parts.toolset === INLINE_TOOLSET ? "the toolset written on the state" : `the toolset ${parts.toolset}`;
  const out: string[] = [];
  for (const part of askingParts(parts)) {
    const width = part.widths[0];
    const { source } = part.decidedBy;
    let advice: string | undefined;
    if (source === "parser" || width === undefined) advice = `nothing lets "${part.text}" run unasked: a line the parser cannot read always asks`;
    else if (source === "toolset") advice = `a "${width}": "allow" line in ${toolset ?? "the state's toolset"}`;
    else if (source === "builtin" || source === "default")
      advice = `a policy.rules entry ${JSON.stringify({ match: matcherOf(part), action: "allow" })} in .jaira/settings.json${toolset !== undefined ? `, or a "${width}": "allow" line in ${toolset}` : ""}`;
    else if (source === "rule") advice = `a change to the policy.rules entry in .jaira/settings.json that asks about "${width}"`;
    else if (source === "scope") advice = `a scope that allows ${part.paths?.join(", ") ?? part.url ?? "the place"} for ${part.subject}`;
    if (advice !== undefined && !out.includes(advice)) out.push(advice);
  }
  if (parts.parts.length === 0 && parts.unparsed !== undefined) out.push("nothing lets it run unasked: a line the parser cannot read always asks");
  return out;
}

/**
 * A `policy.rules` matcher for one part. A command's widths are its subject and its program
 * (`git push`, `git`); any other part — a file utility judged as `read_file`, a fetch as `web_fetch` —
 * is matched by the program it runs, the first word its rule matched.
 */
function matcherOf(part: CommandPart): { program: string; subcommand?: string } {
  if (part.kind === "command") {
    const program = part.widths.at(-1) ?? part.subject.split(" ")[0]!;
    const words = (part.widths[0] ?? "").split(" ");
    return words.length > 1 && words[0] === program ? { program, subcommand: words[1]! } : { program };
  }
  const first = part.matched[0];
  const matched = first !== undefined ? part.text.slice(first.start - part.span.start, first.end - part.span.start) : part.text;
  return { program: (matched.trim().split(/\s+/)[0] || part.text.trim().split(/\s+/)[0]) ?? part.subject };
}
