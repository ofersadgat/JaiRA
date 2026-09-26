/**
 * A PERMISSION FUNCTION's contract — what it is handed and what it may answer (decision 0007,
 * amended 2026-09-22).
 *
 * A permission set line may name a function instead of a mode: `"bash": { "function": "smart" }`. For every
 * call the line answers — every PART of a shell line — the function is handed one
 * {@link PermissionFunctionRequest}, exactly what an approver would be shown, and answers `"allow"`
 * or `"deny"`. Nothing else is an answer: a function that returns anything else, or fails, has not
 * decided, and the part is put to the person with the reason.
 *
 * To ask the person, a function calls the APPROVAL PROMPT — `approve_tool_call(request)`, a function
 * like any gate — and returns what it answered. That is the one way a function reaches a person, so
 * a function can encapsulate the prompt without ever being an approval itself.
 *
 * Pure data, in `shared`, because three sides read it: the runtime builds it, a function receives it,
 * and the renderer draws the approval prompt from it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { CommandPartKind, TextSpan } from "./commandParts";

/** What a permission function answers. Nothing else is an answer. */
export type PermissionAnswer = "allow" | "deny";

export function isPermissionAnswer(value: unknown): value is PermissionAnswer {
  return value === "allow" || value === "deny";
}

/** One part of a shell line, as a function is handed it. */
export interface PermissionRequestPart {
  /** The part as written — `git push origin main`. */
  text: string;
  kind: CommandPartKind;
  /** What it is a request FOR: `git push`, `write_file`, `script`. */
  subject: string;
  /** Where the part sits in {@link PermissionFunctionRequest.line}. */
  span: TextSpan;
  /** The program, for a command: `git`. */
  program?: string;
  /** Its subcommand: `push`. */
  subcommand?: string;
  /** Every non-flag word after the program and subcommand, in order. */
  args?: string[];
  /** Every flag, as written: `--force`, `-m`. */
  flags?: string[];
  /** The paths it is about, as written. */
  paths?: string[];
  /** The url, for a `web_fetch` request. */
  url?: string;
  /** The embedders it was opened out of, outermost first. */
  via?: string[];
}

/** What a permission function is handed — the call, as an approver would be shown it. */
export interface PermissionFunctionRequest {
  /** The tool called — `bash`, `write_file`, or an agent's own built-in by its own name. */
  tool: string;
  /**
   * The permission set line the function answers for — `git push`, `bash` (any other command), `write_file`,
   * `script`, `other`.
   */
  subject: string;
  /** The function being asked, as the permission set names it — so one function serving several lines can tell. */
  function: string;
  /** The tool call's input, as the model produced it. */
  input: Record<string, JsonValue>;
  /** For a shell line: the whole line, as written. */
  line?: string;
  /** For a shell line: the PART being judged. A line with several parts asks once per part. */
  part?: PermissionRequestPart;
  /** The directory the call runs in, when it says. */
  cwd?: string;
  /** The state whose call this is, by id. */
  state?: string;
  /** The task, by id. */
  task?: string;
  /** Which permission set judged the call: the reference its state names it by, or `inline`. */
  permissionSet?: string;
}

/** What the approval prompt answers — `{ decision }`. */
export interface ApprovalPromptAnswer {
  decision: PermissionAnswer;
}
