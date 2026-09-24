/**
 * The command approval's MODEL (decision 0007 §4): everything the surface draws, worked out as plain
 * data so it can be tested without a DOM — the renderer has no DOM test infrastructure, so what is
 * not here is not tested.
 *
 *  - {@link lineSegments}: the line in the colours of its parts. Each character belongs to the
 *    INNERMOST part whose span covers it, so `rm {}` inside its `find` is the find's colour either
 *    side and its own in the middle; what no part covers is glue (`&&`, `|`, a space) and is dim. A
 *    character is underlined when its owner's `matched` spans cover it — the underline is narrower
 *    than the tint.
 *  - {@link partRows}: one row per part — what was typed, what it is a request FOR, the verdict.
 *  - {@link reasonLines}: the permission set and the subject that asks, from `decidedBy`.
 *  - {@link answerMenu} / {@link approvalAnswerOf}: the split buttons' menu — WHAT the answer covers, then
 *    HOW FAR it reaches — and the request a choice becomes.
 *
 * ## Past four parts
 *
 * The app has four hue tokens (`--p1 --p2 --p3 --p0`). A fifth part takes the first hue again: the
 * rows are in source order, so the nth row of a colour is the nth tint of that colour on the line,
 * and pointing at a row lights its words on the line (the surface's `hot` state) for the case where
 * counting is not good enough.
 *
 * ## Several asking parts
 *
 * The menu's first question is asked once per DISTINCT set of widths among the asking parts, not
 * once per part and not once for the line: two `git commit`s on a line are one choice, a
 * `git commit` beside a `terraform plan` are two, and a part with a single width (`script`, `rm`)
 * is listed with nothing to choose so the menu always shows everything the answer will cover. The
 * reach chosen after it applies to all of them — one answer, one reach.
 */
import {
  INLINE_PERMISSION_SET,
  askingParts,
  chosenWidths,
  describeAddition,
  entriesToRemember,
  type ApprovalScope,
  type ApprovalPermissionSetTarget,
  type CommandApproval,
  type CommandPart,
  type CommandPartVerdict,
  type PendingApproval,
  type TextSpan,
  type PermissionSetAddition,
  type WritableLayer,
} from "@jaira/shared/browser";

/** The four hue tokens a part can take, in the order they are handed out. */
export const PART_HUES = ["--p1", "--p2", "--p3", "--p0"] as const;

/** The CSS value of part `index`'s hue. Cycles past four — see the module header. */
export function hueOf(index: number): string {
  return `var(${PART_HUES[((index % PART_HUES.length) + PART_HUES.length) % PART_HUES.length]})`;
}

/** A stretch of text, underlined or not. */
export interface Piece {
  text: string;
  matched: boolean;
}

export type LineSegment =
  /** What joins the parts: separators, spaces, an embedder's own words when it is no request. */
  | { kind: "glue"; text: string }
  /** A stretch of one part. A part an inner part splits comes back as two of these. */
  | { kind: "part"; part: number; pieces: Piece[] };

const clamp = (span: TextSpan, length: number): TextSpan => ({ start: Math.max(0, Math.min(span.start, length)), end: Math.max(0, Math.min(span.end, length)) });
const covers = (span: TextSpan, at: number): boolean => at >= span.start && at < span.end;

/** The line as tinted stretches and glue. Spans outside the line, empty or reversed, are ignored. */
export function lineSegments(line: string, parts: readonly CommandPart[]): LineSegment[] {
  const spans = parts.map((part) => clamp(part.span, line.length));
  const size = (index: number): number => spans[index]!.end - spans[index]!.start;
  const owner: Array<number | undefined> = [];
  const matched: boolean[] = [];
  for (let at = 0; at < line.length; at++) {
    let own: number | undefined;
    spans.forEach((span, index) => {
      if (!covers(span, at)) return;
      // Innermost wins; of two the same size, the later one — it is the more specific request.
      if (own === undefined || size(index) <= size(own)) own = index;
    });
    owner.push(own);
    matched.push(own !== undefined && parts[own]!.matched.some((m) => covers(clamp(m, line.length), at)));
  }
  const out: LineSegment[] = [];
  for (let at = 0; at < line.length; at++) {
    const own = owner[at];
    const last = out.at(-1);
    const char = line[at]!;
    if (own === undefined) {
      if (last?.kind === "glue") last.text += char;
      else out.push({ kind: "glue", text: char });
      continue;
    }
    if (last?.kind === "part" && last.part === own) {
      const piece = last.pieces.at(-1)!;
      if (piece.matched === matched[at]) piece.text += char;
      else last.pieces.push({ text: char, matched: matched[at]! });
      continue;
    }
    out.push({ kind: "part", part: own, pieces: [{ text: char, matched: matched[at]! }] });
  }
  return out;
}

/** One part's own words, with the same underline the line gives them. */
export function partPieces(line: string, part: CommandPart): Piece[] {
  const span = clamp(part.span, line.length);
  const text = span.end > span.start ? line.slice(span.start, span.end) : part.text;
  if (text !== part.text && part.text.length > 0) return [{ text: part.text, matched: false }];
  const pieces: Piece[] = [];
  for (let at = 0; at < text.length; at++) {
    const is = part.matched.some((m) => covers(m, span.start + at));
    const last = pieces.at(-1);
    if (last !== undefined && last.matched === is) last.text += text[at]!;
    else pieces.push({ text: text[at]!, matched: is });
  }
  return pieces;
}

export interface PartRow {
  index: number;
  hue: string;
  pieces: Piece[];
  /** What the part is a request FOR — or the entry that stood in for it (`bash`, `other`). */
  subject: string;
  /** The place, where it was opened out of, and what else a person should know. */
  note?: string;
  verdict: CommandPartVerdict;
  /** How many parts this one is written inside (`rm {}` inside its `find` is 1). */
  depth: number;
  /**
   * The FUNCTION that decided this part, when one did (decision 0007, amended 2026-09-22) — drawn as
   * the function's name beside what it answered, so a line whose other parts ask says which of its
   * parts a function already allowed and will not be asked about.
   */
  by?: string;
}

// `function` is a part not yet put to the function its line names — never on screen: the approver asks
// every function before any person is asked, so a drawn part is allowed, denied or asking by then.
const VERDICT_LABEL: Record<CommandPartVerdict, string> = { allowed: "allowed", function: "to a function", asks: "asks", denied: "denied" };
export const verdictLabel = (verdict: CommandPartVerdict): string => VERDICT_LABEL[verdict];

const FALLBACK_ENTRIES: Record<string, string> = { bash: "any other command", other: "everything no line names" };

/** Did the permission set's FALLBACK answer for a command — is there no line that names it? */
function fellThrough(part: CommandPart): boolean {
  const entry = part.decidedBy.entry;
  return part.kind === "command" && part.decidedBy.source === "permissionSet" && entry !== undefined && Object.hasOwn(FALLBACK_ENTRIES, entry);
}

export function partRows(approval: CommandApproval): PartRow[] {
  return approval.parts.map((part, index) => {
    let depth = 0;
    const seen = new Set<number>([index]);
    for (let at = part.within; at !== undefined && !seen.has(at) && approval.parts[at] !== undefined; at = approval.parts[at]!.within) {
      seen.add(at);
      depth++;
    }
    const notes: string[] = [];
    const place = part.url ?? (part.paths !== undefined && part.paths.length > 0 ? part.paths.join(", ") : undefined);
    // `-exec rm {}`: the policy puts the find's roots where `{}` stood, and a bare `.` reads as nothing.
    if (place !== undefined) notes.push(part.via?.at(-1) === "find" ? `whatever find matches under ${place}` : place);
    // Opened out of something that is not itself a row (`bash -c '…'`, `$( … )`): say so in words.
    if (part.within === undefined && part.via !== undefined && part.via.length > 0) notes.push(`inside ${part.via.join(" › ")}`);
    const { source, reason, entry } = part.decidedBy;
    // The SUBJECT, not the program: a permission set that holds `git commit` does have lines that name git.
    if (fellThrough(part)) notes.push(`no line names ${part.subject} — ${FALLBACK_ENTRIES[entry!]}`);
    // Beside a permission set's entry the policy keeps the built-in's reason after a dash; it is why the ask matters.
    if (source === "permissionSet" && reason.includes(" — ")) notes.push(reason.slice(reason.indexOf(" — ") + 3));
    // A function's answer is drawn as its name beside the verdict; one that could NOT answer says why
    // once, on the reason line under the rows (`reasonLines`).
    else if (source !== "permissionSet" && source !== "default" && source !== "function") notes.push(reason);
    const by = source === "function" ? part.decidedBy.function : undefined;
    return {
      index,
      hue: hueOf(index),
      pieces: partPieces(approval.line, part),
      subject: fellThrough(part) ? entry! : part.subject,
      ...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
      verdict: part.verdict,
      depth,
      ...(by !== undefined ? { by } : {}),
    };
  });
}

// --- the reason line ------------------------------------------------------------

export type ReasonLine =
  /** `Permission set <name>: <b>git commit</b> asks` — `permission set` absent when the map has no file. */
  | { kind: "permissionSet"; permissionSet?: string; entries: string[] }
  /** The permission set holds no line for these subjects, and that is why they ask. */
  | { kind: "unheld"; permissionSet?: string; subjects: string[] }
  /** A function a line names could not decide, so the person is asked — its own sentence. */
  | { kind: "function"; text: string }
  | { kind: "policy"; text: string };

/** The permission set's name as a person reads it: `feature/implementation/writes-asking`. */
export function permissionSetNameOf(pending: PendingApproval): string | undefined {
  if (pending.permissionSet?.id !== undefined) return pending.permissionSet.id;
  const reference = pending.parts?.permissionSet;
  return reference === undefined || reference === INLINE_PERMISSION_SET ? undefined : reference;
}

export function reasonLines(pending: PendingApproval): ReasonLine[] {
  const asking = pending.parts !== undefined ? askingParts(pending.parts) : [];
  if (asking.length === 0) return pending.reason !== undefined ? [{ kind: "policy", text: pending.reason }] : [];
  const permissionSet = permissionSetNameOf(pending);
  const named = permissionSet !== undefined ? { permissionSet } : {};
  const entries: string[] = [];
  const unheld: string[] = [];
  const policy: string[] = [];
  const failed: string[] = [];
  const add = (list: string[], value: string): void => void (list.includes(value) ? undefined : list.push(value));
  for (const part of asking) {
    if (part.decidedBy.source === "function") add(failed, part.decidedBy.reason);
    else if (part.decidedBy.source !== "permissionSet") add(policy, part.decidedBy.reason);
    else if (part.decidedBy.entry !== undefined) add(entries, part.decidedBy.entry);
    else add(unheld, part.subject);
  }
  return [
    ...(entries.length > 0 ? [{ kind: "permissionSet" as const, ...named, entries }] : []),
    ...(unheld.length > 0 ? [{ kind: "unheld" as const, ...named, subjects: unheld }] : []),
    ...failed.map((text) => ({ kind: "function" as const, text })),
    ...policy.map((text) => ({ kind: "policy" as const, text })),
  ];
}

// --- the approval prompt, called by a function ---------------------------------------

/**
 * What `approve_tool_call` draws — the request a permission function was handed, read back: the line
 * with the ONE part being asked about tinted (the rest of the line is glue: those parts are some other
 * function's, or no one's, to decide), or the call's arguments for a tool that is not the shell.
 */
export interface ApprovalRequestView {
  tool: string;
  subject: string;
  function?: string;
  permissionSet?: string;
  state?: string;
  task?: string;
  cwd?: string;
  /** The shell line and the part being asked about, as the line's one part. */
  line?: { text: string; parts: CommandPart[] };
  /** What the call would do, for a tool with no line. */
  input: unknown;
}

const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

export function approvalRequestView(raw: unknown): ApprovalRequestView {
  const request = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const part = request["part"] !== null && typeof request["part"] === "object" ? (request["part"] as Record<string, unknown>) : undefined;
  const lineText = stringOf(request["line"]);
  const span = part?.["span"] as TextSpan | undefined;
  const subject = stringOf(request["subject"]) ?? stringOf(part?.["subject"]) ?? stringOf(request["tool"]) ?? "?";
  const fields = {
    tool: stringOf(request["tool"]) ?? "?",
    subject,
    ...(stringOf(request["function"]) !== undefined ? { function: stringOf(request["function"])! } : {}),
    ...(stringOf(request["permissionSet"]) !== undefined ? { permissionSet: stringOf(request["permissionSet"])! } : {}),
    ...(stringOf(request["state"]) !== undefined ? { state: stringOf(request["state"])! } : {}),
    ...(stringOf(request["task"]) !== undefined ? { task: stringOf(request["task"])! } : {}),
    ...(stringOf(request["cwd"]) !== undefined ? { cwd: stringOf(request["cwd"])! } : {}),
    input: request["input"] ?? {},
  };
  if (lineText === undefined || part === undefined || span === undefined || typeof span.start !== "number" || typeof span.end !== "number") return fields;
  // The program and its subcommand are what a person reads first: underlined, as a matched entry is.
  const text = stringOf(part["text"]) ?? lineText.slice(span.start, span.end);
  const program = stringOf(part["program"]);
  const sub = stringOf(part["subcommand"]);
  const head = program !== undefined ? text.indexOf(program) : -1;
  const headEnd = head >= 0 && sub !== undefined && text.indexOf(sub, head + program!.length) >= 0 ? text.indexOf(sub, head + program!.length) + sub.length : head >= 0 ? head + program!.length : -1;
  const asked: CommandPart = {
    span: { start: span.start, end: span.end },
    matched: head >= 0 ? [{ start: span.start + head, end: span.start + headEnd }] : [],
    text,
    kind: (stringOf(part["kind"]) ?? "command") as CommandPart["kind"],
    subject: stringOf(part["subject"]) ?? subject,
    verdict: "asks",
    decidedBy: {
      source: "function",
      ...(fields.function !== undefined ? { function: fields.function } : {}),
      reason: fields.function !== undefined ? `'${fields.function}' asks you` : "a function asks you",
    },
    widths: [],
  };
  return { ...fields, line: { text: lineText, parts: [asked] } };
}

// --- the answer menu --------------------------------------------------------------

/** One thing the menu's first question is asked about: a distinct set of widths among the asking parts. */
export interface WhatChoice {
  /** Stable for the life of the request — the widths themselves. */
  key: string;
  /** The first asking part that offers these widths, for its colour. */
  part: number;
  options: Array<{ width: string; /** The program alone: "every `git` command". */ program: boolean }>;
  chosen: string;
}

/** A hint is words, with the text that will be WRITTEN set apart so the surface can set it in the data face. */
export type HintPiece = string | { code: string };

export type Reach = "once" | "run" | `add:${WritableLayer}`;

export interface ReachItem {
  reach: Reach;
  name: string;
  hint: HintPiece[];
  /** The button itself does this one, so the menu ticks it. */
  isDefault: boolean;
}

export interface AnswerMenu {
  what: WhatChoice[];
  /** `Allow what` / `Deny what`. */
  whatLabel: string;
  reach: ReachItem[];
  /** Why something a person might look for is not offered. */
  notes: string[];
}

/** The person's width choices, by {@link WhatChoice.key}. Absent ⇒ the narrowest. */
export type ChosenWidths = Readonly<Record<string, string>>;

const keyOf = (part: CommandPart): string => part.widths.join(" | ");

export function whatChoices(approval: CommandApproval, chosen: ChosenWidths = {}): WhatChoice[] {
  const out: WhatChoice[] = [];
  approval.parts.forEach((part, index) => {
    if (part.verdict !== "asks" || part.widths.length === 0) return;
    const key = keyOf(part);
    if (out.some((choice) => choice.key === key)) return;
    const picked = chosen[key];
    out.push({
      key,
      part: index,
      options: part.widths.map((width, at) => ({ width, program: part.widths.length > 1 && at === part.widths.length - 1 && !/\s/.test(width) })),
      chosen: picked !== undefined && part.widths.includes(picked) ? picked : part.widths[0]!,
    });
  });
  return out;
}

/** The widths the answer covers, as `remember` takes them. */
export function widthsOf(approval: CommandApproval, chosen: ChosenWidths = {}): string[] {
  return chosenWidths(approval, whatChoices(approval, chosen).map((choice) => choice.chosen));
}

/** What "add to the permission set" would write for this answer. */
export function additionOf(approval: CommandApproval, decision: "allow" | "deny", chosen: ChosenWidths = {}): PermissionSetAddition {
  const widths = widthsOf(approval, chosen);
  return entriesToRemember(approval, decision, (part) => part.widths.find((w) => widths.includes(w))) as PermissionSetAddition;
}

/** `.jaira/permission-sets/feature/implementation/x.json` → `.jaira/permission-sets/…/x.json`: the ends are what identify it. */
export function shortFile(file: string): string {
  const match = /^(.*?\/permission-sets)\/(?:.+)\/([^/]+)$/.exec(file);
  return match === null ? file : `${match[1]}/…/${match[2]}`;
}

const LAYER_WORDS: Record<WritableLayer, string> = { project: "in this project", base: "for all projects" };

function addHint(target: ApprovalPermissionSetTarget, written: string): HintPiece[] {
  const hint: HintPiece[] =
    target.follows !== undefined
      ? [`creates ${shortFile(target.file)} with `, { code: written }, `, following ${target.follows.startsWith("$SYSTEM/") ? "the built-in permission set" : "the shared permission set"}`]
      : ["writes ", { code: written }, ` to ${shortFile(target.file)}`];
  if (target.shadowed === true) hint.push(" — this project's own copy still wins here");
  return hint;
}

export function answerMenu(pending: PendingApproval, decision: "allow" | "deny", chosen: ChosenWidths = {}): AnswerMenu {
  const verb = decision === "allow" ? "Allow" : "Deny";
  const once: ReachItem = { reach: "once", name: `${verb} once`, hint: ["this call only"], isDefault: true };
  const run: ReachItem = { reach: "run", name: `${verb} for this run`, hint: ["until this task ends; nothing is written"], isDefault: false };
  const approval = pending.parts;
  // A tool with no command line: the answer is about the tool, and the ledger upstream keeps it.
  if (approval === undefined) return { what: [], whatLabel: `${verb} what`, reach: [once, run], notes: [] };

  const what = whatChoices(approval, chosen);
  const unreadable = askingParts(approval).some((part) => part.widths.length === 0);
  const notes: string[] = [];
  if (what.length === 0) {
    notes.push("This line could not be read well enough to remember an answer about it, so it is asked about every time.");
    return { what, whatLabel: `${verb} what`, reach: [once], notes };
  }
  if (unreadable) notes.push("Part of this line could not be read; that part is asked about every time.");

  const reach: ReachItem[] = [once, run];
  const written = describeAddition(additionOf(approval, decision, chosen));
  const name = pending.permissionSet?.id?.split("/").at(-1);
  for (const target of pending.permissionSet?.targets ?? []) {
    reach.push({ reach: `add:${target.layer}`, name: `Add to ${name ?? "the permission set"}, ${LAYER_WORDS[target.layer]}`, hint: addHint(target, written), isDefault: false });
  }
  if ((pending.permissionSet?.targets.length ?? 0) === 0 && pending.permissionSet?.unwritable !== undefined) notes.push(pending.permissionSet.unwritable);
  return { what, whatLabel: `${verb} what`, reach, notes };
}

/** What a choice becomes on the wire. */
export interface ApprovalAnswer {
  scope: ApprovalScope;
  remember?: string[];
  addTo?: WritableLayer;
}

export function approvalAnswerOf(pending: PendingApproval, reach: Reach, chosen: ChosenWidths = {}): ApprovalAnswer {
  if (reach === "once") return { scope: "once" };
  const widths = pending.parts !== undefined ? widthsOf(pending.parts, chosen) : [];
  // `workflow-run` rides along for the request the hub cannot remember by part (no parts, or no
  // task): it is what "for this run" meant before parts, and the hub drops it when it remembers.
  if (reach === "run" || widths.length === 0) return { scope: "workflow-run", ...(widths.length > 0 ? { remember: widths } : {}) };
  return { scope: "workflow-run", remember: widths, addTo: reach.slice("add:".length) as WritableLayer };
}
