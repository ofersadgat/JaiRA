/**
 * The calls a task made, read out of its records and judged — what `changeLogOf` (shared) groups into
 * the Changes tab.
 *
 * Main's half because it holds the two things a judgment needs: the project's read-only permission set
 * with the policy around it (`allowsCall`, the same reading `permissionSets:judgeReadOnly` makes for
 * the work summary), and the shell classifier that says what each part of a command line is a request
 * for (`classifyRequest`). A shell line is judged part by part as well as whole, so `git add -A && git
 * commit` is two git steps and `npm install && rm x` an install and a deleted file.
 *
 * A subagent's calls are its own entries in the record, marked with the call that spawned it; they are
 * attributed to that subagent by the spawning call's description. A subtask's are read from its own
 * records by the caller and attributed to it.
 */
import type { JsonValue } from "@declarative-ai/json";
import {
  APPROVAL_PROMPT_FUNCTION,
  RESERVED_MCP_SERVERS,
  TOOL_SPEC_BY_NAME,
  parseMcpSubject,
  takeApart,
  type ChangeAuthor,
  type ChangeCall,
  type ChangeCallPart,
  type CommandDialect,
  type ToolCategoryId,
} from "@jaira/shared";
import { classifyRequest, declaredNative } from "@jaira/runtime";

/** What a call is, as the tool menu files it: its standard tool, and that tool's group. */
export function categoryOf(name: string): { standard?: string; category: ToolCategoryId | "other" } {
  const mcp = parseMcpSubject(name);
  if (mcp !== undefined && !RESERVED_MCP_SERVERS.includes(mcp.server)) return { category: "mcp" };
  const bare = mcp?.tool ?? name;
  const standard = TOOL_SPEC_BY_NAME.has(bare) ? bare : declaredNative(bare);
  if (typeof standard !== "string") return { category: "other" };
  return { standard, category: TOOL_SPEC_BY_NAME.get(standard)?.category ?? "other" };
}

/** A call and its answer, paired from one record's entries — before any judging. */
interface RawCall {
  id: string;
  name: string;
  args: JsonValue;
  ok?: boolean;
  text?: string;
  data?: JsonValue;
  at?: number;
  by?: ChangeAuthor;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const pick = (part: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) if (part[key] !== undefined) return part[key];
  return undefined;
};
/** What a result showed the model: its string, or its text parts joined. */
function shownOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.flatMap((part) => (isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : []));
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Every call in one record's entries, paired with its result by id. Subagent calls are attributed to
 * the subagent the spawning call described (`Task`'s `description`).
 */
export function rawCallsOf(value: JsonValue | undefined): RawCall[] {
  const entries = (value as { value?: { entries?: unknown } } | undefined)?.value?.entries;
  if (!Array.isArray(entries)) return [];
  const calls = new Map<string, RawCall>();
  const described = new Map<string, string>();
  for (const raw of entries) {
    if (!isRecord(raw) || raw["kind"] !== "message" || !Array.isArray(raw["content"])) continue;
    // Read as the provider wrote it — as the transcript reads it — and not through `blocksOf`, which
    // leaves out the result's `data`: the agent's own record of an edit, patch and all.
    const stamp = Date.parse(typeof raw["timestamp"] === "string" ? raw["timestamp"] : "");
    const timing = isRecord(raw["timing"]) ? raw["timing"] : {};
    const at = typeof timing["at"] === "number" ? timing["at"] : Number.isNaN(stamp) ? undefined : stamp;
    const chain = isRecord(raw["sidechain"]) ? (raw["sidechain"] as { id?: string; parentToolUseId?: string }) : undefined;
    for (const part of raw["content"] as unknown[]) {
      if (!isRecord(part) || typeof part["type"] !== "string") continue;
      const type = part["type"];
      const id = pick(part, ["toolCallId", "tool_use_id", "toolUseId", "id"]);
      if (typeof id !== "string") continue;
      if (type === "tool_use" || type === "tool-call") {
        const name = pick(part, ["name", "toolName"]);
        if (typeof name !== "string" || name === APPROVAL_PROMPT_FUNCTION) continue;
        const input = (pick(part, ["input", "args", "arguments"]) ?? null) as JsonValue;
        if (isRecord(input) && typeof input["description"] === "string") described.set(id, input["description"]);
        const spawner = chain?.parentToolUseId;
        calls.set(id, {
          id,
          name,
          args: input,
          ...(at !== undefined ? { at } : {}),
          ...(spawner !== undefined ? { by: { kind: "subagent", call: spawner, name: described.get(spawner) ?? "a subagent" } } : {}),
        });
      } else if (type === "tool_result" || type === "tool-result") {
        const call = calls.get(id);
        if (call === undefined) continue;
        call.ok = pick(part, ["is_error", "isError"]) !== true;
        const shown = shownOf(pick(part, ["content", "output", "result", "text"]));
        if (shown !== undefined) call.text = shown;
        if (part["data"] !== undefined) call.data = part["data"] as JsonValue;
      }
    }
  }
  // A subagent's name is its spawner's description, which may be read after its first calls.
  for (const call of calls.values()) if (call.by?.kind === "subagent" && described.has(call.by.call)) call.by = { ...call.by, name: described.get(call.by.call)! };
  return [...calls.values()];
}

/**
 * The agents' own tools for spawning a subagent. Named, because a subagent whose calls were not
 * captured leaves nothing in the record to recognise its spawner by — and the spawn is not a change
 * either way.
 */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Whether the read-only permission set lets a call through: `false` is a change. */
export type ReadOnlyJudge = (name: string, args: unknown, dialect: CommandDialect) => boolean | undefined;

/** The parts of a shell line, each judged as a line of its own. */
function partsOf(line: string, dialect: CommandDialect, judge: ReadOnlyJudge): ChangeCallPart[] {
  const out: ChangeCallPart[] = [];
  for (const request of takeApart(line, dialect).requests) {
    // A runner that was opened stands for what it runs, which comes after it as parts of its own.
    if (request.kind === "command" && request.opened !== undefined && !request.opened.kept) continue;
    const part = classifyRequest(request, dialect);
    if (part === undefined || part.noRequest === true) continue;
    const text = line.slice(part.span.start, part.span.end);
    out.push({
      text,
      ...(part.command?.program !== undefined ? { program: part.command.program } : {}),
      ...(part.command?.subcommand !== undefined ? { subcommand: part.command.subcommand } : {}),
      ...(part.tool !== undefined ? { tool: part.tool } : {}),
      paths: part.paths,
      ...(request.kind === "redirect" ? { redirect: request.direction } : {}),
      change: judge("bash", { command: text }, dialect) === false,
    });
  }
  return out;
}

/** The line a shell call ran. */
function commandOf(args: JsonValue): string | undefined {
  if (!isRecord(args)) return undefined;
  const command = args["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((word) => typeof word === "string")) return command.join(" ");
  return undefined;
}

/**
 * The calls of every record, judged. `dialect` is what a JaiRA or codex shell runs; Claude's own
 * `Bash` is POSIX wherever it runs.
 */
export function judgedCallsOf(values: ReadonlyArray<JsonValue | undefined>, options: { judge: ReadOnlyJudge; dialect: CommandDialect; by?: ChangeAuthor }): ChangeCall[] {
  const out: ChangeCall[] = [];
  for (const value of values) {
    const calls = rawCallsOf(value);
    // A call that spawned a subagent is not a change of its own: what the subagent did is, and is
    // attributed to it.
    const spawners = new Set(calls.flatMap((call) => (call.by?.kind === "subagent" ? [call.by.call] : [])));
    for (const call of calls) {
      if (spawners.has(call.id) || SUBAGENT_TOOLS.has(call.name)) continue;
      const { standard, category } = categoryOf(call.name);
      const dialect: CommandDialect = call.name === "Bash" ? "posix" : options.dialect;
      const verdict = options.judge(call.name, call.args, dialect);
      const line = standard === "bash" ? commandOf(call.args) : undefined;
      const parts = line !== undefined ? partsOf(line, dialect, options.judge) : undefined;
      out.push({
        ...call,
        ...(standard !== undefined ? { standard } : {}),
        category,
        // A line that changed nothing whole may still hold a part that did not pass alone; either says it changed.
        change: verdict === false || (parts?.some((part) => part.change) ?? false),
        ...(parts !== undefined ? { parts } : {}),
        ...(call.by === undefined && options.by !== undefined ? { by: options.by } : {}),
      });
    }
  }
  return out;
}
