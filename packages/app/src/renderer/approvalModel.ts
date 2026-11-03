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
  parseMcpSubject,
  partAnswersDecision,
  type ApprovalScope,
  type ApprovalPermissionSetTarget,
  type CommandApproval,
  type CommandPart,
  type CommandPartVerdict,
  type PartAnswer,
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
export function lineSegments(line: string, parts: ReadonlyArray<Pick<CommandPart, "span" | "matched">>): LineSegment[] {
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
  /** What the part is a request FOR — or the entry that stood in for it (`shell`, `other`). */
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
  /** Who decided it, with its layer and place (decision 0023 §2.7) — also the start of {@link note}'s layer words. */
  who?: string;
}

// `function` is a part not yet put to the function its line names — never on screen: the approver asks
// every function before any person is asked, so a drawn part is allowed, denied or asking by then.
const VERDICT_LABEL: Record<CommandPartVerdict, string> = { allowed: "allowed", function: "to a function", asks: "asks", denied: "denied" };
export const verdictLabel = (verdict: CommandPartVerdict): string => VERDICT_LABEL[verdict];

const FALLBACK_ENTRIES: Record<string, string> = { shell: "any other command", other: "everything no line names" };

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
    // Who decided, with its layer and place, where a layer of the stack did (decision 0023 §2.7).
    const who = provenanceOf(approval, part);
    if (who !== undefined) notes.push(who);
    // The SUBJECT, not the program: a permission set that holds `git commit` does have lines that name git.
    else if (fellThrough(part)) notes.push(`no line names ${part.subject} — ${FALLBACK_ENTRIES[entry!]}`);
    // Beside a permission set's entry the policy keeps the built-in's reason after a dash; it is why the ask matters.
    if (source === "permissionSet" && reason.includes(" — ")) notes.push(reason.slice(reason.indexOf(" — ") + 3));
    // A function's answer is drawn as its name beside the verdict; one that could NOT answer says why
    // once, on the reason line under the rows (`reasonLines`).
    else if (source !== "permissionSet" && source !== "default" && source !== "function") notes.push(reason);
    const by = source === "function" ? part.decidedBy.function : undefined;
    // Under a runner, the same words again would read as the line listed twice: it is what the runner runs.
    const repeats = part.within !== undefined && approval.parts[part.within]?.text === part.text;
    return {
      index,
      hue: hueOf(index),
      pieces: repeats ? [{ text: "what it runs", matched: false }] : partPieces(approval.line, part),
      subject: fellThrough(part) ? entry! : part.subject,
      ...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
      verdict: part.verdict,
      depth,
      ...(by !== undefined ? { by } : {}),
      ...(who !== undefined ? { who } : {}),
    };
  });
}

// --- the reason line ------------------------------------------------------------

export type ReasonLine =
  /** `Permission set <name>: <b>git commit</b> asks` — `permission set` absent when the map has no file. */
  | { kind: "permissionSet"; permissionSet?: string; entries: string[] }
  /** The permission set holds no line for these subjects, and that is why they ask. */
  | { kind: "unheld"; permissionSet?: string; subjects: string[] }
  /**
   * The STACK the line was judged under (decision 0023 §2.6), oldest first — `chat/ask-first +
   * project/build-safe, then this run` — in place of naming the set and its entries: each row says which
   * layer decided it.
   */
  | { kind: "stack"; layers: string[]; thisRun: boolean }
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
  const stack = [...(pending.parts?.stack ?? [])].reverse();
  const files = stack.filter((id) => id !== "runtime" && id !== "tools");
  const byStack = files.length > 0 && (entries.length > 0 || unheld.length > 0);
  return [
    ...(byStack ? [{ kind: "stack" as const, layers: files, thisRun: stack.includes("runtime") }] : []),
    ...(!byStack && entries.length > 0 ? [{ kind: "permissionSet" as const, ...named, entries }] : []),
    ...(!byStack && unheld.length > 0 ? [{ kind: "unheld" as const, ...named, subjects: unheld }] : []),
    ...failed.map((text) => ({ kind: "function" as const, text })),
    ...policy.map((text) => ({ kind: "policy" as const, text })),
  ];
}

// --- the approval prompt, called by a function ---------------------------------------

/**
 * A request `approve_tool_call` was handed, as the pending approval it is — for a caller that has the
 * function's inputs rather than the hub's request (the Components gallery). The line is drawn with the
 * ONE part being asked about as its one part (the rest of the line is glue: those parts are some other
 * function's, or no one's, to decide); a tool that is not the shell shows its arguments.
 */
export function pendingOfPrompt(requestId: string, prompt: string | undefined, raw: unknown): PendingApproval {
  const request = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const part = request["part"] !== null && typeof request["part"] === "object" ? (request["part"] as Record<string, unknown>) : undefined;
  const lineText = stringOf(request["line"]);
  const span = part?.["span"] as TextSpan | undefined;
  const tool = stringOf(request["tool"]) ?? "?";
  const subject = stringOf(request["subject"]) ?? stringOf(part?.["subject"]) ?? tool;
  const asker = stringOf(request["function"]);
  const input = (request["input"] ?? {}) as PendingApproval["input"];
  const base: PendingApproval = {
    requestId,
    tool,
    ...(lineText !== undefined ? { command: lineText } : {}),
    ...(prompt !== undefined ? { reason: prompt } : {}),
    input,
    ...(stringOf(request["task"]) !== undefined ? { taskId: stringOf(request["task"])! } : {}),
    ...(asker !== undefined ? { asker } : {}),
    project: "",
    at: 0,
  };
  if (lineText === undefined || part === undefined || span === undefined || typeof span.start !== "number" || typeof span.end !== "number") return base;
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
    decidedBy: { source: "function", ...(asker !== undefined ? { function: asker } : {}), reason: asker !== undefined ? `'${asker}' asks you` : "a function asks you" },
    widths: [],
  };
  const permissionSet = stringOf(request["permissionSet"]);
  return { ...base, parts: { line: lineText, dialect: "posix", parts: [asked], verdict: "asks", ...(permissionSet !== undefined ? { permissionSet } : {}) } };
}

const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

// --- the answer menu --------------------------------------------------------------

/** One thing the menu's first question is asked about: a distinct set of widths among the asking parts. */
export interface WhatChoice {
  /** Stable for the life of the request — the widths themselves. */
  key: string;
  /** The first asking part that offers these widths, for its colour. */
  part: number;
  options: Array<{
    width: string;
    /** The program alone: "every `git` command". */
    program: boolean;
    /** An MCP tool's server, for its wider width: "every `figma` tool". */
    server?: string;
  }>;
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
  /** A line over the menu saying what it answers — Continue's: `Continue answers the 2 rows still asking`. */
  heading?: string;
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
      options: part.widths.map((width, at) => {
        // A call to an MCP tool is one part whose widths are the tool and its server — the server is no
        // program, and reads as every tool of it.
        const server = part.kind === "mcp" && at > 0 ? parseMcpSubject(width)?.server : undefined;
        if (server !== undefined) return { width, program: false, server };
        return { width, program: part.kind !== "mcp" && part.widths.length > 1 && at === part.widths.length - 1 && !/\s/.test(width) };
      }),
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

/**
 * A place too long for its choice, cut in the MIDDLE: both ends of a path are what identify it (the
 * root it lies under, the file it names). At most `max` characters, the `…` among them; a place that
 * fits is returned as it is. The cut keeps more of the end, where the file is.
 */
export function middleOut(text: string, max = 44): string {
  const chars = [...text];
  if (chars.length <= max || max < 5) return text;
  const keep = max - 1;
  const head = Math.floor(keep * 0.4);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
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

// --- who decided a row (decision 0023 §2.7) ------------------------------------------

/** A layer's id as a row names it: a set by its own name (`build-safe`), the three that are no file by what they are. */
export function layerNameOf(id: string): string {
  if (id === INLINE_PERMISSION_SET) return "this state";
  if (id === "tools") return "the tools layer";
  if (id === "runtime") return "this run";
  return id.split("/").at(-1) ?? id;
}

const DECIDES: Record<CommandPartVerdict, string> = { allowed: "allows", function: "asks", asks: "asks", denied: "denies" };

/**
 * Who decided a part, with its layer and place (decision 0023 §2.7, design 4D): `in packages/client ·
 * build-safe allows`, `ask-first asks · no layer above names it`, `ask-first asks · no layer names one
 * build`. The place is the one the deciding line answered at, else where the part runs when it names no
 * path of its own. Absent when no layer decided — a built-in, `.jaira/`, the parser — whose own reason
 * the row keeps.
 */
export function provenanceOf(approval: CommandApproval, part: CommandPart): string | undefined {
  const layer = part.decidedBy.layer;
  if (layer === undefined) return undefined;
  const bits: string[] = [];
  const named = part.url !== undefined || (part.paths !== undefined && part.paths.length > 0);
  // Where it runs as a line would write it — its narrowest width (`packages/app`), not the absolute path it is `at`.
  const place = part.decidedBy.place ?? (named ? undefined : (part.where?.widths[0]?.place ?? part.where?.at));
  if (place !== undefined && place !== "") bits.push(`in ${place}`);
  bits.push(`${layerNameOf(layer)} ${DECIDES[part.verdict]}`);
  if (fellThrough(part)) bits.push(`no layer names ${part.subject}`);
  else if (part.verdict === "asks" || part.verdict === "denied") {
    // A newer layer that wrote nothing for it: the merge is newest-wins per line, so none named it.
    const stack = approval.stack ?? [];
    const at = stack.indexOf(layer);
    if (at > 0 && stack.slice(0, at).some((id) => id !== "runtime")) bits.push("no layer above names it");
  }
  return bits.join(" · ");
}

// --- the rows, answered one by one (decision 0023 ruling 7, §4.4, design 4D) ----------

/** How far one row's answer reaches: this call, this run, or a line written into a layer. */
export type RowReach = PartAnswer["reach"];

/** A row the person answered by hand — what Continue sends for it. */
export type RowAnswer = Omit<PartAnswer, "part">;

/** The rows answered by hand, by part index. */
export type RowAnswers = Readonly<Record<number, RowAnswer>>;

/** The panel's choices, which answer nothing until Deny or Allow is pressed. Absent: the default. */
export interface RowChoice {
  width?: string;
  /** One of the part's place widths' places. */
  place?: string;
  reach?: RowReach;
  /** A {@link LayerOption.key}. */
  layer?: string;
}

/** One place an answer can hold at: `packages/client`, `this project`, `anywhere`. */
export interface WhereOption {
  /** What is sent and written — `undefined` for anywhere, which is the plain line. */
  place: string | undefined;
  label: string;
  /** Its width in words, for a title: `its folder`, `the package`. */
  title: string;
  /** Stable for the life of the request. */
  key: string;
}

/** One file of one layer of the stack "Add to" can write: `build-safe`, this project's copy. */
export interface LayerOption {
  key: string;
  /** The layer's id, as `approval:submit` names it; absent for the set that asked when the call came with no stack. */
  layer?: string;
  addTo: WritableLayer;
  /** `build-safe`, then `, for all projects` where the layer has two files and this is the farther. */
  name: string;
  /** The layer's full id: `project/build-safe`. */
  id: string;
  file: string;
  /** A shipped preset: writing it changes that set for everyone who uses it (§2.8). */
  everyone: boolean;
  target: ApprovalPermissionSetTarget;
}

export interface RowReachItem {
  reach: RowReach;
  name: string;
  hint: HintPiece[];
  /** Why it cannot be chosen, when it cannot. */
  disabled?: string;
}

export interface RowPanel {
  part: number;
  /** `Answer what`: the part's widths — one segment when it has one; absent when it has none. */
  what?: WhatChoice;
  /** `Where`: the part's place widths, narrowest first; absent when it names no place. */
  where?: { options: WhereOption[]; chosen: string };
  reach: RowReachItem[];
  chosenReach: RowReach;
  /** What "Add to" can write into, newest layer first. */
  layers: LayerOption[];
  chosenLayer?: LayerOption;
  /** The line "Add to" would write, before an answer is chosen: `"one build": { "packages": … }`. */
  line?: string;
  notes: string[];
}

const ANYWHERE = "**";
const PLACE_WORDS: Record<string, string> = { this: "this place", folder: "its folder", package: "the package", project: "this project", host: "the host", parent: "its domain", prefix: "the prefix", anywhere: "anywhere" };

function whereOptionsOf(part: CommandPart): WhereOption[] {
  return (part.where?.widths ?? []).map(({ width, place }) => {
    const anywhere = width === "anywhere" || place === ANYWHERE;
    const label = anywhere ? (part.where?.kind === "branch" ? "any branch" : "anywhere") : width === "project" ? "this project" : place;
    return { place: anywhere ? undefined : place, label, title: PLACE_WORDS[width] ?? width, key: place };
  });
}

/** What "Add to" can write: each writable layer's files, newest layer first — or, with no stack, the set that asked. */
export function layerOptionsOf(pending: PendingApproval): LayerOption[] {
  const out: LayerOption[] = [];
  const push = (id: string, layer: string | undefined, targets: readonly ApprovalPermissionSetTarget[], everyone: boolean): void => {
    targets.forEach((target) => {
      out.push({
        key: `${id}|${target.layer}`,
        ...(layer !== undefined ? { layer } : {}),
        addTo: target.layer,
        name: `${layerNameOf(id)}${targets.length > 1 ? `, ${LAYER_WORDS[target.layer]}` : ""}`,
        id,
        file: target.file,
        everyone,
        target,
      });
    });
  };
  if (pending.layers !== undefined) {
    for (const layer of pending.layers) push(layer.id, layer.id, layer.targets, layer.everyone === true);
  } else if (pending.permissionSet !== undefined) {
    push(pending.permissionSet.id ?? "the permission set", undefined, pending.permissionSet.targets, pending.permissionSet.targets.some((t) => t.follows?.startsWith("$SYSTEM/") === true));
  }
  return out;
}

/** Why nothing can be added to a layer, when nothing can. */
function unwritableOf(pending: PendingApproval): string {
  const asked = pending.parts?.permissionSet !== undefined ? permissionSetNameOf(pending) : undefined;
  const layers = pending.layers ?? [];
  // The set that asked says why first; else the oldest layer that is not this run's or the conversation's own.
  const why =
    layers.find((layer) => layer.id === asked)?.unwritable ??
    [...layers].reverse().find((layer) => layer.id !== "runtime" && layer.id !== "tools" && layer.unwritable !== undefined)?.unwritable ??
    pending.permissionSet?.unwritable;
  return why ?? "No layer of this stack can be written.";
}

/** The width segments for one part: its widths, narrowest first, the chosen one on. */
function whatOfPart(part: CommandPart, index: number, chosen: string | undefined): WhatChoice | undefined {
  if (part.widths.length === 0) return undefined;
  const [choice] = whatChoices({ line: "", dialect: "posix", verdict: "asks", parts: [{ ...part, verdict: "asks" }] }, chosen !== undefined ? { [keyOf(part)]: chosen } : {});
  return choice === undefined ? undefined : { ...choice, part: index };
}

/** `"one build"`, `"one build": { "packages": … }` — the line a row's answer would write, its decision not yet chosen. */
function lineOf(width: string, place: string | undefined, decision: string): string {
  return place === undefined ? `${JSON.stringify(width)}: ${decision}` : `${JSON.stringify(width)}: { ${JSON.stringify(place)}: ${decision} }`;
}

/** The panel a row's `asks ⌄` opens: What, Where, How far — and nothing answered until a button is pressed. */
export function rowPanel(pending: PendingApproval, index: number, choice: RowChoice = {}): RowPanel {
  const part = pending.parts?.parts[index];
  if (part === undefined) return { part: index, reach: [], chosenReach: "once", layers: [], notes: [] };
  const what = whatOfPart(part, index, choice.width);
  const options = whereOptionsOf(part);
  const where = options.length > 0 ? { options, chosen: options.find((o) => o.key === choice.place)?.key ?? options[0]!.key } : undefined;
  const width = what?.chosen;
  const place = where !== undefined ? options.find((o) => o.key === where.chosen)!.place : undefined;
  const layers = layerOptionsOf(pending);
  const fallback = layers.find((o) => o.id === pending.defaultLayer) ?? layers[0];
  const chosenLayer = layers.find((o) => o.key === choice.layer) ?? fallback;
  const notes: string[] = [];
  const unreadable = width === undefined;
  if (unreadable) notes.push("This part could not be read well enough to remember an answer about it, so it is asked about every time.");
  const line = width !== undefined ? lineOf(width, place, "…") : undefined;
  const addHint: HintPiece[] = [];
  if (chosenLayer !== undefined && line !== undefined) {
    const { target } = chosenLayer;
    if (target.follows !== undefined) addHint.push(`creates ${shortFile(target.file)} with `, { code: line }, `, following ${target.follows.startsWith("$SYSTEM/") ? "the built-in permission set" : "the shared permission set"}, when you continue`);
    else addHint.push("writes ", { code: line }, ` to ${shortFile(target.file)} when you continue`);
    if (target.shadowed === true) addHint.push(" — this project's own copy still wins here");
    if (chosenLayer.everyone) addHint.push(" — changes that set for everyone who uses it");
  }
  const reach: RowReachItem[] = [
    { reach: "once", name: "Once", hint: ["this call only"] },
    { reach: "run", name: "For this run", hint: ['joins "this run", the top layer; nothing is written'], ...(unreadable ? { disabled: notes[0]! } : {}) },
    {
      reach: "add",
      name: "Add to",
      hint: addHint,
      ...(unreadable ? { disabled: notes[0]! } : chosenLayer === undefined ? { disabled: unwritableOf(pending) } : {}),
    },
  ];
  if (!unreadable && chosenLayer === undefined) notes.push(unwritableOf(pending));
  const wanted = choice.reach ?? "once";
  const chosenReach = reach.find((r) => r.reach === wanted && r.disabled === undefined)?.reach ?? "once";
  return {
    part: index,
    ...(what !== undefined ? { what } : {}),
    ...(where !== undefined ? { where } : {}),
    reach,
    chosenReach,
    layers,
    ...(chosenLayer !== undefined ? { chosenLayer } : {}),
    ...(line !== undefined ? { line } : {}),
    notes,
  };
}

/** The answer pressing Deny or Allow in a row's panel gives that row, at the reach chosen. */
export function rowAnswerOf(pending: PendingApproval, index: number, choice: RowChoice, decision: "allow" | "deny"): RowAnswer {
  const panel = rowPanel(pending, index, choice);
  const width = panel.what?.chosen;
  const place = panel.where !== undefined ? panel.where.options.find((o) => o.key === panel.where!.chosen)?.place : undefined;
  const base: RowAnswer = { decision, reach: panel.chosenReach, ...(width !== undefined ? { width } : {}), ...(place !== undefined ? { place } : {}) };
  if (panel.chosenReach !== "add" || panel.chosenLayer === undefined) return base;
  return { ...base, ...(panel.chosenLayer.layer !== undefined ? { layer: panel.chosenLayer.layer } : {}), addTo: panel.chosenLayer.addTo };
}

/** The panel's choices again, from an answer the row holds — so reopening it shows what was chosen. */
export function choiceOfAnswer(pending: PendingApproval, answer: RowAnswer): RowChoice {
  const layer = answer.reach === "add" ? layerOptionsOf(pending).find((o) => o.addTo === answer.addTo && (o.layer ?? undefined) === answer.layer) : undefined;
  return {
    ...(answer.width !== undefined ? { width: answer.width } : {}),
    place: answer.place ?? ANYWHERE,
    reach: answer.reach,
    ...(layer !== undefined ? { layer: layer.key } : {}),
  };
}

/** What a row answered by hand says in place of who decided it: `you allow every npm command · for this run · in packages`. */
export function answerWordsOf(pending: PendingApproval, index: number, answer: RowAnswer): string {
  const part = pending.parts?.parts[index];
  const choice = part !== undefined && answer.width !== undefined ? whatOfPart(part, index, answer.width)?.options.find((o) => o.width === answer.width) : undefined;
  const what = choice === undefined ? "" : choice.program ? ` every ${choice.width} command` : choice.server !== undefined ? ` every ${choice.server} tool` : ` ${choice.width}`;
  const layer = answer.reach === "add" ? layerOptionsOf(pending).find((o) => o.addTo === answer.addTo && o.layer === answer.layer) : undefined;
  const reach = answer.reach === "once" ? "once" : answer.reach === "run" ? "for this run" : `added to ${layer?.name ?? "the permission set"}`;
  return [`you ${answer.decision}${what}`, reach, ...(answer.place !== undefined ? [`in ${answer.place}`] : [])].join(" · ");
}

/** The bottom pair: the aggregate Allow / Deny until a row is answered by hand, then Continue / Cancel. */
export type BottomAnswers =
  | { mode: "aggregate" }
  | {
      mode: "continue";
      /** The asking parts no hand has answered — what Continue answers with its own choice. */
      rest: number[];
      /** A row was denied: Continue refuses the call, and keeps the other answers. */
      refuses: boolean;
    };

export function bottomOf(pending: PendingApproval, answers: RowAnswers): BottomAnswers {
  const approval = pending.parts;
  if (approval === undefined || Object.keys(answers).length === 0) return { mode: "aggregate" };
  const rest = approval.parts.flatMap((part, index) => (part.verdict === "asks" && answers[index] === undefined ? [index] : []));
  return { mode: "continue", rest, refuses: Object.values(answers).some((a) => a.decision === "deny") };
}

/** The pending approval as Continue's menu sees it: only the rows still asking ask. */
function restOf(pending: PendingApproval, answers: RowAnswers): PendingApproval {
  const approval = pending.parts!;
  return { ...pending, parts: { ...approval, parts: approval.parts.map((part, index) => (answers[index] !== undefined ? { ...part, verdict: answers[index]!.decision === "allow" ? "allowed" : "denied" } : part)) } };
}

/**
 * Continue's own menu: how the rows still asking are allowed — once, for this run, or added to the set
 * that asked — the aggregate menu over just those rows. Absent when every row was answered by hand.
 */
export function continueMenu(pending: PendingApproval, answers: RowAnswers, chosen: ChosenWidths = {}): AnswerMenu | undefined {
  const bottom = bottomOf(pending, answers);
  if (bottom.mode !== "continue" || bottom.rest.length === 0) return undefined;
  const menu = answerMenu(restOf(pending, answers), "allow", chosen);
  const n = bottom.rest.length;
  return { ...menu, heading: `Continue answers the ${n === 1 ? "row" : `${n} rows`} still asking`, whatLabel: "Allow what" };
}

/** What Continue sends: every row answered by hand as it was, and the rest at Continue's own reach (once by default). */
export function continueAnswerOf(pending: PendingApproval, answers: RowAnswers, reach: Reach = "once", chosen: ChosenWidths = {}): { decision: "allow" | "deny"; scope: ApprovalScope; answers: PartAnswer[] } {
  const approval = pending.parts;
  if (approval === undefined) return { decision: "deny", scope: "once", answers: [] };
  const rest = restOf(pending, answers).parts!;
  const widths = whatChoices(rest, chosen).map((c) => c.chosen);
  const out: PartAnswer[] = [];
  approval.parts.forEach((part, index) => {
    if (part.verdict !== "asks") return;
    const mine = answers[index];
    if (mine !== undefined) {
      out.push({ part: index, ...mine });
      return;
    }
    // A part nobody could read is answered for this call alone, whatever Continue reaches.
    const width = part.widths.find((w) => widths.includes(w)) ?? part.widths[0];
    if (reach === "once" || width === undefined) out.push({ part: index, decision: "allow", reach: "once" });
    else if (reach === "run") out.push({ part: index, decision: "allow", reach: "run", width });
    else out.push({ part: index, decision: "allow", reach: "add", width, addTo: reach.slice("add:".length) as WritableLayer });
  });
  return { decision: partAnswersDecision(approval, out), scope: out.some((a) => a.reach !== "once") ? "workflow-run" : "once", answers: out };
}
