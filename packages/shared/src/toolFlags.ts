/**
 * A tool's line, refined by its arguments (decision 0032, ruling 1a) — what a FLAG LINE is, and how a
 * call is matched to one.
 *
 * Decision 0007 §4 refines a command by its subcommand and flag: `git push` and `git push --force` are
 * lines of their own. A tool's line is refined the same way, by the arguments its {@link ToolSpec.flags}
 * names:
 *
 *  - `tool --name` matches a call whose boolean argument `name` is true: `shell --run_in_background`;
 *  - `tool --name=value` matches a call whose argument `name` has that value — or, left out, whose
 *    default is that value: `list_processes --scope=user`, and `list_processes --scope=session` for a
 *    call that passes no scope at all;
 *  - several on one line match a call that has every one of them: `stop_process --scope=group --group=docker`;
 *  - the shell's line may go on to name a COMMAND, the flag written first: `shell --run_in_background
 *    npm run dev`. That one is not matched here, against a call's arguments — it is a command line, under
 *    the flag, and the shell's judge reads it as one (`@jaira/runtime`'s `decideCommand`).
 *
 * A call is judged by every flag line it matches: the most specific decides — the one naming the most
 * flags, as `git push --force` decides over `git push` — and between equally specific ones the strictest
 * wins. The tool's bare line covers any call no flag line matches.
 *
 * Pure, and over the vocabulary alone, so the renderer, the linter and the policy read one spelling.
 */
import { TOOL_SPEC_BY_NAME, type ToolFlagSpec } from "./toolVocabulary";

/** One flag as a line writes it: `--run_in_background` (no value), `--scope=user`. */
export interface WrittenFlag {
  name: string;
  /** Absent for a boolean flag written bare. */
  value?: string;
}

/** A flag line taken apart: the tool, the flags in the order written, and — on the shell's — the command after them. */
export interface ToolFlagSubject {
  tool: string;
  flags: WrittenFlag[];
  /** What follows the flags, as written (`npm run dev`). Absent when the line names no command. */
  command?: string;
}

/** Does a program's name look like this — lowercase, no underscore (`git`, `apt-get`)? The same reading `subjectKindOf` gives a command. */
const PROGRAM_LIKE = /^[a-z][a-z0-9.+-]*$/;

/**
 * A subject read as a FLAG LINE, by its shape alone — `undefined` when it is none.
 *
 * It is one when its first word is a standard tool and its second starts with `--`, and the tool is
 * one a line can refine ({@link ToolSpec.flags}) or a name no program has (`read_file --x`, which no
 * command could mean). So `grep --include` stays a command of the program `grep`, as it always was,
 * while `shell --background` IS a flag line — of a flag the shell does not have, which
 * {@link toolFlagProblem} names. What it says is not checked here.
 */
export function parseToolFlagSubject(subject: string): ToolFlagSubject | undefined {
  const words = subject.trim().split(/\s+/);
  const tool = words[0] ?? "";
  const spec = TOOL_SPEC_BY_NAME.get(tool);
  if (spec === undefined || words.length < 2 || !words[1]!.startsWith("--")) return undefined;
  if (spec.flags === undefined && PROGRAM_LIKE.test(tool)) return undefined;
  const flags: WrittenFlag[] = [];
  let at = 1;
  for (; at < words.length && words[at]!.startsWith("--"); at++) {
    const word = words[at]!.slice(2);
    const eq = word.indexOf("=");
    flags.push(eq < 0 ? { name: word } : { name: word.slice(0, eq), value: word.slice(eq + 1) });
  }
  const rest = words.slice(at).join(" ");
  return { tool, flags, ...(rest.length > 0 ? { command: rest } : {}) };
}

/** Every flag a tool offers, as a line would write it — what a refusal says the tool offers instead. */
export function offeredFlagsOf(tool: string): string[] {
  const flags = TOOL_SPEC_BY_NAME.get(tool)?.flags ?? {};
  return Object.entries(flags).map(([name, spec]) => spellingOf(name, spec));
}

function spellingOf(name: string, spec: ToolFlagSpec): string {
  if (spec.type === "boolean") return `--${name}`;
  if (spec.type === "choice") return `--${name}=${spec.values.join("|")}`;
  return `--${name}=<${name}>`;
}

/**
 * What is wrong with a flag line, as the set's refusal says it — or `undefined` for a line that is
 * right: a flag the tool does not have, a value its argument cannot take, a boolean given a value or a
 * valued flag none, a flag named twice, a command after the flags of a tool whose calls run none.
 * Each names the spelling the tool offers, as a misspelled tool's name does.
 */
export function toolFlagProblem(subject: ToolFlagSubject): string | undefined {
  const spec = TOOL_SPEC_BY_NAME.get(subject.tool);
  const offered = offeredFlagsOf(subject.tool);
  const offers = offered.length > 0 ? `'${subject.tool}' takes ${offered.join(", ")}` : `'${subject.tool}' takes no flag — a line for it is '${subject.tool}' alone`;
  const seen = new Set<string>();
  for (const flag of subject.flags) {
    const own = spec?.flags !== undefined && Object.hasOwn(spec.flags, flag.name) ? spec.flags[flag.name] : undefined;
    if (own === undefined) return `'--${flag.name}' is not a flag of ${subject.tool} — ${offers}`;
    if (seen.has(flag.name)) return `'--${flag.name}' is named twice — a line names each flag once`;
    seen.add(flag.name);
    if (own.type === "boolean" && flag.value !== undefined) return `'--${flag.name}' takes no value — write '--${flag.name}' alone`;
    if (own.type !== "boolean" && (flag.value === undefined || flag.value.length === 0)) return `'--${flag.name}' takes a value — ${spellingOf(flag.name, own)}`;
    if (own.type === "choice" && !own.values.includes(flag.value!.toLowerCase())) {
      return `'${flag.value}' is not a ${flag.name} — '--${flag.name}' is one of ${own.values.join(", ")}`;
    }
  }
  if (subject.command !== undefined && subject.tool !== "shell") {
    return `'${subject.command}' follows the flags, and only the shell's line names a command after them — ${offers}`;
  }
  return undefined;
}

/**
 * A call's arguments, as the flags a line can name: each boolean argument passed `true`, and each
 * valued one passed — or, left out, at its default. A call to a tool with no flags has none.
 */
export function callFlagsOf(tool: string, input: unknown): Map<string, string | true> {
  const out = new Map<string, string | true>();
  const flags = TOOL_SPEC_BY_NAME.get(tool)?.flags;
  if (flags === undefined) return out;
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const [name, spec] of Object.entries(flags)) {
    const given = args[name];
    if (spec.type === "boolean") {
      if (given === true) out.set(name, true);
    } else if (typeof given === "string" && given.length > 0) out.set(name, given);
    else if (spec.type === "choice" && spec.default !== undefined) out.set(name, spec.default);
  }
  return out;
}

/** Does a flag line name only flags the call has, each at the call's value? Its command, if it names one, is not looked at. */
export function flagLineMatches(line: ToolFlagSubject, call: ReadonlyMap<string, string | true>): boolean {
  return line.flags.every((flag) => {
    const given = call.get(flag.name);
    if (given === undefined) return false;
    if (flag.value === undefined) return given === true;
    return typeof given === "string" && given.toLowerCase() === flag.value.toLowerCase();
  });
}

/**
 * The lines a call's answer may be kept at, narrowest first (decision 0023 §3.8): the call's flags
 * spelled as a line, then the first of them alone where it named several, then the tool's bare line —
 * `["stop_process --scope=group --group=docker", "stop_process --scope=group", "stop_process"]`. A
 * value with whitespace in it cannot be a line's, and is left off.
 */
export function callFlagWidthsOf(tool: string, input: unknown): string[] {
  const words: string[] = [];
  for (const [name, value] of callFlagsOf(tool, input)) {
    if (value !== true && /\s/.test(value)) continue;
    words.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  const out: string[] = [];
  if (words.length > 0) out.push(`${tool} ${words.join(" ")}`);
  if (words.length > 1) out.push(`${tool} ${words[0]}`);
  out.push(tool);
  return out;
}

/** The shell's own flag line for a start that keeps running (decision 0032, ruling 1). */
export const BACKGROUND_LINE = "shell --run_in_background";
