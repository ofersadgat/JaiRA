/**
 * One shell line, as the REQUESTS it is made of (decision 0007 §4).
 *
 * A `shell` call is not judged as a tool. It is taken apart — at separators, redirects, substitutions
 * and embedders — and each part is a request of its own, for a SUBJECT the permission set holds like any
 * other: a standard tool on a path (`rm foo.txt` → `write_file`), `script`, or a command
 * (`git commit`). This module is the shape that judgement travels in: what the policy produces, what
 * an approval request carries, and what the renderer draws — the line in the colours of its parts,
 * one row per part.
 *
 * Pure data and pure helpers: no parser and no policy here, so the renderer can import it. The parser
 * is `shellCommand.ts`; the verdicts are `@jaira/runtime`'s `policy.ts`.
 */
import type { PermissionMode } from "./operationVocabulary";
import type { PlaceWidth } from "./places";
import type { PlaceKind } from "./toolVocabulary";
import type { WritableLayer } from "./view";

/** Offsets into the ORIGINAL line, `end` exclusive — `line.slice(start, end)` is the text. */
export interface TextSpan {
  start: number;
  end: number;
}

/** What a part is a request for. */
export type CommandPartKind =
  /** A file utility, judged as the standard tool on its path (`cat` → `read_file`). */
  | "tool"
  /** `>`, `>>`, `2>`, `&>`, `<`: `write_file` on the target, `read_file` on the source. */
  | "redirect"
  /** Running a file: `./x.sh`, `bash x.sh`, `npm run build`, `make all`. */
  | "script"
  /** Anything else: the program and its subcommand (`git commit`). */
  | "command"
  /** The line, or a payload inside it, that the parser could not model. Never allowed without asking. */
  | "unparsed"
  /**
   * Not a shell part at all: a call to a tool of an MCP server (`mcp__figma__get_code`), judged by its
   * name — the tool's line, its server's, `other` — and carried in the same shape so that one approval,
   * one "for this run" and one "add to the permission set" serve both. Its line IS the tool's name, and
   * its widths are the tool and its server.
   */
  | "mcp"
  /**
   * A command runner's GATE (`runner:npm`, `runner:*` — `commandRunners.ts`): whether the runner may run
   * at all, and so whether what it runs is looked at. The runner's whole invocation is its span; what
   * it runs is judged in parts of its own beside it.
   */
  | "runner";

/**
 * The answers a part can have. A line runs only if every part is `allowed`.
 *
 * `function` is a part whose permission set entry names a FUNCTION (`"shell": "smart"`) and
 * which has not been put to it yet — `decidedBy.function` says which. It is never what a person is
 * shown: the approver the host hands the engine calls the function for each such part before anybody
 * is asked, and the part is then `allowed` or `denied` by it, or `asks` when the function failed. It
 * ranks between `allowed` and `asks`: a built-in ask is stricter than a function.
 */
export type CommandPartVerdict = "allowed" | "function" | "asks" | "denied";

/** Which layer decided a part, strictest layer named. */
export type CommandPartDecider =
  /** A permission set entry — `entry` names it (`git commit`, `git`, `shell`, `write_file`, `other`). */
  | "permissionSet"
  /** The built-in destructive floor (deny) or a built-in ask (push, install, network, credentials). */
  | "builtin"
  /** `.jaira/` is engine-owned. */
  | "path"
  /** A scope table said so about the part's path or url. */
  | "scope"
  /** An answer a person gave earlier in this run, remembered at a width — `entry` is the width. */
  | "remembered"
  /** Nothing matched — no built-in, and no permission set judging the line: allowed. */
  | "default"
  /** The parser could not model it, or what runs is decided at run time (`$CMD args`). */
  | "parser"
  /**
   * A permission FUNCTION the permission set entry names answered — `entry` is that entry, `function` its
   * reference. When the function could not answer, the part asks and the reason says why.
   */
  | "function";

export interface CommandPart {
  /** The whole part, in the original line — what the approval TINTS. */
  span: TextSpan;
  /**
   * The words that MATCHED the entry that decided it — what the approval UNDERLINES. `git commit`
   * without its flags; `rm` inside `-exec rm {}`; the redirect operator itself; the program alone
   * when nothing but the shell's own entry matched; the whole invocation for `script`. Several spans
   * when the matched words are not adjacent (`git -C dir commit`).
   */
  matched: TextSpan[];
  /** `line.slice(span.start, span.end)`, so a consumer without the line can still show the part. */
  text: string;
  kind: CommandPartKind;
  /** What it is a request FOR: `write_file`, `script`, `git commit`, `terraform plan`. */
  subject: string;
  /** Every path the request is about, as written (unresolved). */
  paths?: string[];
  /** The url, for a `web_fetch` request. */
  url?: string;
  /**
   * The command the part runs, as parsed — absent on a redirect and on what the parser could not
   * read. What a permission function is handed about the part (`PermissionRequestPart`).
   */
  command?: { program: string; subcommand?: string; args: string[]; flags: string[] };
  verdict: CommandPartVerdict;
  decidedBy: {
    source: CommandPartDecider;
    /** The permission set entry (or remembered width) that decided, when one did. */
    entry?: string;
    /**
     * The FUNCTION the entry names, when it names one — on a part still waiting for it (verdict
     * `function`), and on one it answered (source `function`).
     */
    function?: string;
    /**
     * The PLACE of the entry's line that answered (decision 0023 §3), as the line writes it —
     * `packages/app`, `claude/**`, `github.com` — when a place did, as against the line's own mode.
     * What lets a row say "in packages/app · build-safe allows".
     */
    place?: string;
    /**
     * The LAYER of the stack that set the deciding line — at {@link place} where a place answered
     * (decision 0023 §2.7): a set's id (`chat/ask-first`, `app/build`), `inline` for lines written on
     * a state, `tools` for the conversation's own, `runtime` for an answer given in this task. Absent
     * where no layer decided — the built-ins, `.jaira/`, the parser, the floor — or where the judging
     * set came with no stack.
     */
    layer?: string;
    /** A sentence a person can read. */
    reason: string;
  };
  /**
   * What remembering an answer about this part may store, narrowest first — `["git commit", "git"]`,
   * `["terraform plan", "terraform"]`, `["rm"]`, `["script"]`, `["write_file"]`. Never the line.
   */
  widths: string[];
  /**
   * Where the part acts, as the dialog offers it (decision 0023 §3.8): the kind of place, the place the
   * part is about (the path, the URL, the branch), and the place WIDTHS an answer may be remembered
   * at, narrowest first — a path's file, folder, package, project and anywhere; a URL's page, host,
   * `*.parent` and anywhere; a branch, its `prefix/**` and any branch. Absent when the part names no
   * place that can be read. What "for this run" stores beside a width (`CommandGrants`).
   */
  where?: { kind: PlaceKind; at: string; widths: PlaceWidth[] };
  /** The embedders it was opened out of, outermost first — `["bash"]`, `["find"]`, `["sudo"]`. */
  via?: string[];
  /**
   * Index of the part this one is judged under: the part whose span encloses it (`rm {}` inside its
   * `find`), or the runner whose gate it passed (`script` under `runner:npm`), when there is one.
   */
  within?: number;
}

/** What an approval for a shell line carries beside the line itself. */
export interface CommandApproval {
  /** The line exactly as the agent wrote it — every span indexes into this. */
  line: string;
  /** The language it was read in (`CommandDialect`): the shell that runs it. */
  dialect: "posix" | "powershell" | "cmd";
  /** In source order. Empty only when the whole line was unparsable, which `unparsed` then explains. */
  parts: CommandPart[];
  /** The line's answer: the strictest part. */
  verdict: CommandPartVerdict;
  /** Why the line (or a payload inside it) could not be taken apart. */
  unparsed?: string;
  /**
   * Which permission set judged the line, when one did: the REFERENCE the asking state names it by
   * (`$/permission-sets/feature/implementation/writes-asking`), or {@link INLINE_PERMISSION_SET} when the map is
   * written on the state itself (or on a message) and there is no file behind it. This is what the
   * approval's reason line names, and what "add to the permission set" writes into.
   */
  permissionSet?: string;
  /**
   * The stack the line was judged under (decision 0023 §2.6), as its layers' ids NEWEST first —
   * `runtime` and `tools` among them where they are layers of it — what the dialog's "Add to" lists
   * (§4.4). Which of them a line can be written into is the host's to say (`PendingApproval.layers`).
   * Absent when the judging set came with no stack.
   */
  stack?: string[];
}

/** {@link CommandApproval.permission set} for a permission set with no file of its own. */
export const INLINE_PERMISSION_SET = "inline";

/**
 * The widths to send as `remember`, one per asking part: the chosen one where `chosen` names one of
 * the part's own widths, else its narrowest. Parts that offer no width (a line nobody could read)
 * contribute nothing. Deduplicated, in part order.
 */
export function chosenWidths(approval: CommandApproval, chosen: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const part of askingParts(approval)) {
    const width = part.widths.find((w) => chosen.includes(w)) ?? part.widths[0];
    if (width !== undefined && !out.includes(width)) out.push(width);
  }
  return out;
}

/** The parts a person is actually being asked about. */
export function askingParts(approval: CommandApproval): CommandPart[] {
  return approval.parts.filter((part) => part.verdict === "asks");
}

/**
 * The permission set entries that would stop these parts asking, each at a chosen width.
 *
 * `widthOf(part)` picks one of `part.widths` — by default the narrowest. This is what "add to the
 * permission set" writes (`"git commit": "allow"`), and what "for this run" remembers. A part that did not
 * ask contributes nothing, and neither does a width the part does not offer: it is the asking PARTS
 * that are remembered, never the line.
 */
export function entriesToRemember(
  approval: CommandApproval,
  mode: Extract<PermissionMode, "allow" | "deny">,
  widthOf: (part: CommandPart) => string | undefined = (part) => part.widths[0],
): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const part of askingParts(approval)) {
    const width = widthOf(part);
    if (width !== undefined && part.widths.includes(width)) out[width] = mode;
  }
  return out;
}

/**
 * One ROW's answer (decision 0023 ruling 7, §4.4): a person answering one asking part of a shell line
 * on its own — allow or deny, at one of its widths, at one of its places, and how far. What
 * `approval:submit` carries in `answers` when the rows were answered one by one, and what the record
 * keeps of it.
 *
 *  - `once`: this call only.
 *  - `run`: remembered for this task's run, at `width` and `place` (`CommandGrants`).
 *  - `add`: written into a layer of the stack (`layer`, its `addTo` file) as `"{width}": "{decision}"`,
 *    or at `place` as `"{width}": { "{place}": "{decision}" }` — and remembered for the run as well.
 */
export interface PartAnswer {
  /** The part's index in {@link CommandApproval.parts} — one that asks. */
  part: number;
  decision: "allow" | "deny";
  reach: "once" | "run" | "add";
  /** One of the part's {@link CommandPart.widths}; absent, its narrowest. */
  width?: string;
  /** One of the part's {@link CommandPart.where} places; absent, everywhere. */
  place?: string;
  /** For `add`: the layer of the stack, by id (`project/build-safe`); absent, the set that asked. */
  layer?: string;
  /** For `add`: which file of that layer — this project's (`project`) or the shared root's (`base`). */
  addTo?: WritableLayer;
}

/** The approval narrowed to one of its parts — what remembering or writing ONE row's answer works on. */
export function partApproval(approval: CommandApproval, index: number): CommandApproval {
  const part = approval.parts[index];
  if (part === undefined) return { ...approval, parts: [] };
  // Alone, it is judged under nothing: `within` indexed the whole line.
  const alone: CommandPart = { ...part };
  delete alone.within;
  return { ...approval, parts: [alone] };
}

/**
 * What answers given row by row come to for the CALL: it runs only when every part that asks was
 * allowed — a shell call needs every part allowed — so one denied row, or one left unanswered, refuses
 * it (the other rows' answers are still kept).
 */
export function partAnswersDecision(approval: CommandApproval, answers: readonly PartAnswer[]): "allow" | "deny" {
  return approval.parts.every((part, index) => part.verdict !== "asks" || answers.some((a) => a.part === index && a.decision === "allow")) ? "allow" : "deny";
}

/**
 * Why these row answers cannot be taken for this approval, or `undefined` when they can: each names a
 * part that asks, once, with a width and a place that part offers, and a reach it can have (a part with
 * no width — a line nobody could read — is answered for this call alone).
 */
export function partAnswersProblem(approval: CommandApproval, answers: readonly PartAnswer[]): string | undefined {
  const seen = new Set<number>();
  for (const answer of answers) {
    const part = approval.parts[answer.part];
    if (part === undefined || part.verdict !== "asks") return `part ${answer.part} is not a part of this line that asks`;
    if (seen.has(answer.part)) return `part ${answer.part} is answered twice`;
    seen.add(answer.part);
    if (answer.decision !== "allow" && answer.decision !== "deny") return `part ${answer.part}'s answer is neither allow nor deny`;
    if (answer.reach !== "once" && answer.reach !== "run" && answer.reach !== "add") return `part ${answer.part}'s reach '${String(answer.reach)}' is not once, run or add`;
    if (answer.width !== undefined && !part.widths.includes(answer.width)) return `'${answer.width}' is not a width part ${answer.part} offers`;
    if (answer.place !== undefined && !(part.where?.widths ?? []).some((w) => w.place === answer.place)) return `'${answer.place}' is not a place part ${answer.part} offers`;
    if (answer.reach !== "once" && part.widths.length === 0) return `part ${answer.part} could not be read well enough to remember an answer about it`;
    if (answer.reach === "add" && answer.addTo === undefined) return `part ${answer.part} is added to a layer without saying which file of it`;
  }
  return undefined;
}

/** How strict each verdict is: allowed ▸ function ▸ asks ▸ denied. */
export const VERDICT_RANK: Readonly<Record<CommandPartVerdict, number>> = { allowed: 0, function: 1, asks: 2, denied: 3 };

/** Strictest of the verdicts, for folding parts into a line. */
export function strictestVerdict(a: CommandPartVerdict, b: CommandPartVerdict): CommandPartVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/** The parts still waiting for a permission function — see the `function` verdict. */
export function functionParts(approval: CommandApproval): CommandPart[] {
  return approval.parts.filter((part) => part.verdict === "function");
}
