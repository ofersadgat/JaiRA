/**
 * One shell line, as the REQUESTS it is made of (decision 0007 §4).
 *
 * A `bash` call is not judged as a tool. It is taken apart — at separators, redirects, substitutions
 * and embedders — and each part is a request of its own, for a SUBJECT the toolset holds like any
 * other: a standard tool on a path (`rm foo.txt` → `write_file`), `script`, or a command
 * (`git commit`). This module is the shape that judgement travels in: what the policy produces, what
 * an approval request carries, and what the renderer draws — the line in the colours of its parts,
 * one row per part.
 *
 * Pure data and pure helpers: no parser and no policy here, so the renderer can import it. The parser
 * is `@jaira/runtime`'s `command.ts`; the verdicts are its `policy.ts`.
 */
import type { PermissionMode } from "./operationVocabulary";

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
  | "unparsed";

/** The three answers a part can have. A line runs only if every part is `allowed`. */
export type CommandPartVerdict = "allowed" | "asks" | "denied";

/** Which layer decided a part, strictest layer named. */
export type CommandPartDecider =
  /** A toolset entry — `entry` names it (`git commit`, `git`, `bash`, `write_file`, `other`). */
  | "toolset"
  /** An authored `policy.rules` rule in settings. */
  | "rule"
  /** The built-in destructive floor (deny) or a built-in ask (push, install, network, credentials). */
  | "builtin"
  /** `.jaira/` is engine-owned. */
  | "path"
  /** A scope table said so about the part's path or url. */
  | "scope"
  /** An answer a person gave earlier in this run, remembered at a width — `entry` is the width. */
  | "remembered"
  /** Nothing matched: the policy's `default`. */
  | "default"
  /** The parser could not model it, or what runs is decided at run time (`$CMD args`). */
  | "parser";

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
  verdict: CommandPartVerdict;
  decidedBy: {
    source: CommandPartDecider;
    /** The toolset entry (or remembered width) that decided, when one did. */
    entry?: string;
    /** A sentence a person can read. */
    reason: string;
  };
  /**
   * What remembering an answer about this part may store, narrowest first — `["git commit", "git"]`,
   * `["terraform plan", "terraform"]`, `["rm"]`, `["script"]`, `["write_file"]`. Never the line.
   */
  widths: string[];
  /** The embedders it was opened out of, outermost first — `["bash"]`, `["find"]`, `["sudo"]`. */
  via?: string[];
  /** Index of the part whose span encloses this one (`rm {}` inside its `find`), when there is one. */
  within?: number;
}

/** What an approval for a shell line carries beside the line itself. */
export interface CommandApproval {
  /** The line exactly as the agent wrote it — every span indexes into this. */
  line: string;
  dialect: "posix" | "powershell";
  /** In source order. Empty only when the whole line was unparsable, which `unparsed` then explains. */
  parts: CommandPart[];
  /** The line's answer: the strictest part. */
  verdict: CommandPartVerdict;
  /** Why the line (or a payload inside it) could not be taken apart. */
  unparsed?: string;
}

/** The parts a person is actually being asked about. */
export function askingParts(approval: CommandApproval): CommandPart[] {
  return approval.parts.filter((part) => part.verdict === "asks");
}

/**
 * The toolset entries that would stop these parts asking, each at a chosen width.
 *
 * `widthOf(part)` picks one of `part.widths` — by default the narrowest. This is what "add to the
 * toolset" writes (`"git commit": "allow"`), and what "for this run" remembers. A part that did not
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

/** Strictest of the three, for folding parts into a line. */
export function strictestVerdict(a: CommandPartVerdict, b: CommandPartVerdict): CommandPartVerdict {
  const rank: Record<CommandPartVerdict, number> = { allowed: 0, asks: 1, denied: 2 };
  return rank[a] >= rank[b] ? a : b;
}
