/**
 * A PERMISSION FUNCTION's contract — what it is handed and what it may answer (decision 0007,
 * amended 2026-09-22).
 *
 * A toolset line may name a function instead of a mode: `"bash": { "function": "smart" }`. For every
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
   * The toolset line the function answers for — `git push`, `bash` (any other command), `write_file`,
   * `script`, `other`.
   */
  subject: string;
  /** The function being asked, as the toolset names it — so one function serving several lines can tell. */
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
  /** Which toolset judged the call: the reference its state names it by, or `inline`. */
  toolset?: string;
}

/**
 * What the approval prompt answers — `{ decision }`, and, for a prompt answered after the process
 * that asked it was gone, `about`: WHICH request it answered ({@link approvalRequestKey}). A resumed
 * run re-asks what it was in the middle of asking, and a seeded answer must never answer a different
 * call — so the prompt compares, and asks again when they differ.
 */
export interface ApprovalPromptAnswer {
  decision: PermissionAnswer;
  about?: string;
}

/**
 * A request, as a key: the same call, the same part, the same place — and nothing that could differ
 * between two askings of one call (the function, the toolset's name). Canonical JSON, keys sorted.
 */
export function approvalRequestKey(request: unknown): string {
  const record = request !== null && typeof request === "object" && !Array.isArray(request) ? (request as Record<string, unknown>) : {};
  const about = { tool: record["tool"], subject: record["subject"], input: record["input"], part: record["part"], cwd: record["cwd"], state: record["state"], task: record["task"] };
  return canonical(about);
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
