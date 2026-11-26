/**
 * The safety policy (DESIGN §10.1, SPEC §11.2/§11.3).
 *
 * This module decides what a given tool call is allowed to do, and compiles that
 * decision procedure into the `ExecPolicy` the engine and the delegated adapters
 * enforce (`@declarative-ai/permissions`). What a state may do is its PERMISSION_SET (decision
 * 0007), and nothing else: there are no built-in rules — what JaiRA once refused or asked about on its
 * own is the shipped security profiles' lines (`permission-sets/security/`), stacked under a set like
 * any layer, and what a line no set judges answers to ({@link JairaPolicy.fallback}). There is no project rule list: a
 * command a project wants answered is a line under the `shell` tool of its permission sets
 * (decision 0007, amended 2026-09-23).
 *
 * The shape of the decision matters:
 *
 *  - **Tool-level modes** (`baseline`) cover "may this agent write files at all".
 *  - **A `smart` approver** covers everything that depends on a command's
 *    *arguments* — `git status` is free, `git push --force` is forbidden. Upstream
 *    provides exactly this hook, so the floor becomes a function over
 *    {@link ParsedCommand}s instead of a second enforcement mechanism.
 *
 * **One shell line is several requests** (decision 0007 §4). A line is taken apart
 * (`shellCommand.ts` in `@jaira/shared`), each part is named as a request for a SUBJECT — a standard tool on a
 * path, `script`, or a command (`commandParts.ts`) — and each is judged here: the
 * destructive floor first, then the permission set, the same subject → mode map every tool
 * answers to. The line runs only if every part may; one that asks produces ONE approval
 * carrying all of them ({@link CommandDecision.parts}).
 *
 * Three properties are deliberate:
 *
 *  1. **Every part of a line is judged**, and the strictest verdict wins — a
 *     denied command cannot be smuggled behind a benign one (`npm test && git
 *     reset --hard`), inside a wrapper, a substitution or a `find -exec`.
 *  2. **Unparsable ⇒ ask.** A command the parser cannot model never resolves to
 *     `allow` (DESIGN §10.1's stated default).
 *  3. **Nothing here knows `.jaira/`.** A worktree normally *does* contain `.jaira/` (§1g item 5),
 *     and what keeps an agent from writing it is a LINE: every permission set JaiRA ships refuses
 *     writes at `$PROJECT/.jaira` and `$WORKTREE/.jaira`, and reads of the machine key, where a person
 *     can change them like any other line (2026-11-17). A line no permission set judges answers to the
 *     built-ins alone.
 */
import type { FunctionInputs } from "@declarative-ai/exec";
import type { AuthoredPermissions, ExecPolicy, PermissionBaseline, PermissionMode, PermissionRequest, RefusalWords, RefusedCall, ScopeNarrowing, SmartVerdict, ToolGate } from "@declarative-ai/permissions";
import { DIRECTORY_CHANGERS, LINES_NO_SET_JUDGES, describeCommand, nativeShellDialect, powershellParameter, takeApart, type CommandDialect, type EnvironmentLookup, type ParsedCommand } from "@jaira/shared";
import { callDialectOf } from "./callDialect";
import { blockNowOf, REVEALS, RESOURCE_JUDGES, type ResourceVerdict } from "./resourceJudges";
import { MachineFactsCache, type MachineFactsSource, type MachineReading } from "./machineFacts";
import {
  SHELL_SUBJECT,
  answerOfLines,
  argumentAnswerOf,
  backgroundAnswerOf,
  untrackedAnswerOf,
  backgroundWidthsOf,
  classifyRequest,
  lookUp,
  makeCallOf,
  matchCommandEntries,
  matchCommandEntry,
  packageScriptOf,
  shellPermissionSetOf,
  shellPermissionSetOfBlock,
  subjectWordSpans,
  type ClassifiedPart,
  type PartPlaces,
  type PermissionSetAnswer,
  type ShellPermissionSet,
} from "./commandParts";
import { dialectFor, type ExecEnv } from "./paths";
import { filePackages, makeRunsOf, scriptRunsOf, shellWord, type PackageReader, type ScriptRun } from "./packageScripts";
import {
  BACKGROUND_LINE,
  flagLineModes,
  DEFAULT_ASK_ABOVE_BYTES,
  INLINE_PERMISSION_SET,
  MODE_WHEN_UNSET,
  callFlagWidthsOf,
  callFlagsOf,
  decisionsOf,
  flagLineMatches,
  flagLinesOf,
  hasFlagLines,
  modeStrictness,
  parseToolFlagSubject,
  OTHER_SUBJECT,
  VERDICT_RANK,
  absolutize,
  entriesToRemember,
  isAbsolutePath,
  isFunctionMode,
  isLoweredPermissionSet,
  isPermissionSetMarkKey,
  gateToolModes,
  isServedTool,
  mappedCallOf,
  mappedToolsOf,
  mcpMappingOf,
  mcpModeOf,
  mcpServerSubject,
  parseMcpSubject,
  permissionSetOfEnvironment,
  modeFunction,
  modeWord,
  permissionSetFunctions,
  permissionsOfPermissionSet,
  isCommandRunner,
  runnerSubject,
  RUNNER_GROUP_SUBJECT,
  linePlaces,
  normalizePath,
  placeKindOf,
  programPlacesOfPids,
  OWNER_ALIAS,
  unknownProgramPlace,
  type ResourcePlaces,
  idsOf,
  inputActionsOf,
  shellSubjects,
  toolModes,
  placeWidthsOf,
  resolvePlaces,
  SCRIPT_SUBJECT,
  UNPARSED_SUBJECT,
  RESERVED_MCP_SERVERS,
  TOOL_SPEC_BY_NAME,
  type PlaceKind,
  type PlaceOptions,
  type CommandApproval,
  type JairaMcpConfig,
  type McpToolMapping,
  type CommandPart,
  type CommandPartDecider,
  type CommandPartVerdict,
  type PermissionsDecl,
  type Scope,
  type TextSpan,
  type ToolMode,
  type PermissionSet,
  type PermissionSetMode,
  type PermissionStackDecl,
  layerOfLine,
  normalizeSubject,
  RUNTIME_LAYER,
  stackIdsNewestFirst,
  TOOLS_LAYER,
} from "@jaira/shared";
// Which standard tool an agent's built-in IS comes from the executors' own declarations (0007 §3).
import { declaredNative, standardOfAnyNative } from "./agentTools";
import { lineResourceAnswer, mayNarrow, partScopeFor, placeNarrowingFor, scopeNarrowingFor, toolPlaceAnswer } from "./tools";
import { namedPlacesOf, placesForCall } from "./linePlaces";
import { mcpCallOf } from "./mcpServers";
import { deniedEarlier, refusalWords, takeRefusal, type RefusedBy } from "./refusals";

/** What a line comes to — DESIGN §10.1's vocabulary. */
export type PolicyAction = "allow" | "deny" | "require_approval";

/**
 * What a line is judged by when no permission set judges it — a state that declares none, a CLI's
 * `run_command`: the set {@link LINES_NO_SET_JUDGES} names. There is no rule in code: every verdict is a
 * set's line (the person, 2026-11-25: "there shouldnt be built in rules. all rules should go through
 * permissions").
 */
export interface JairaPolicy {
  /** The set a line no other set judges answers to. Absent: such a line is allowed. */
  fallback?: PermissionSet;
}

/** The project's policy: what a line no set judges answers to — the shipped `base/allow-all` under `security/standard`. */
export function projectPolicy(_config?: unknown): JairaPolicy {
  return { fallback: LINES_NO_SET_JUDGES };
}

/** Tools whose input is a command line, and therefore parsed rather than trusted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "sh", "powershell", "cmd", "run_command", "execute_command", "terminal"]);

/**
 * Tools judged by the SIZE of what they produce — the `smart` rule, and NOT a default mode.
 *
 * The distinction is the fix. A `smart` verdict is `allow`/`deny`/`ask` with no way to say "no
 * opinion", so a tool made smart IN THE BASELINE resolves through the approver instead of through
 * its mode — and `show_artifact` was in that baseline, so every page an agent produced under the
 * ceiling was waved through while `write_file` beside it stopped and asked. A permission menu that
 * shows a tool set to `ask` and a tool that never asks is a menu that lies, and "it only writes into
 * the artifact directory" is an argument about blast radius, not about consent.
 *
 * So the rule stays and the default goes: these names get a `smart` APPROVER registered, which does
 * nothing until something resolves to `smart`. The opt-in was the project policy's `tools: {
 * show_artifact: "smart" }`, which went with that block (2026-09-23); a permission set cannot write `smart`,
 * so until a permission set can name a size-judging function, nothing resolves here.
 */
const CONTENT_TOOLS = new Set(["show_artifact"]);

/** Input keys a command-running tool might use for the command itself. */
const COMMAND_KEYS = ["command", "cmd", "script", "input", "commandLine"];

/** Input keys that carry a PAYLOAD — the bytes a producing tool is about to keep. */
const CONTENT_KEYS = ["content", "text"];

/**
 * Every non-flag word of a command.
 *
 * `subcommand` is just the *first* such word, so a program that takes no
 * subcommand puts its argument there: `rm -rf .git` parses as
 * `subcommand: ".git", args: []`. Matching on `args` alone would therefore miss
 * exactly the cases policy cares about — paths and URLs.
 */
export function commandWords(command: ParsedCommand): string[] {
  return command.subcommand !== undefined ? [command.subcommand, ...command.args] : [...command.args];
}

// --- decision 0032, ruling 7: what starts a process out of JaiRA's sight (deny) ---------------------

/** What a refused escape says — to the agent, and on the part's row. */
export const ESCAPE_REASON = "JaiRA could not see or stop what this starts; use run_in_background";

/** The class-naming parameters of `Invoke-CimMethod` and `Invoke-WmiMethod`: one given that is not `Win32_Process` names another class. */
const WMI_CLASS_PARAMETERS = ["-classname", "-class", "-path", "-inputobject", "-query", "-cimclass", "-resourceuri"];

/**
 * Does this command have ANOTHER program start a process — so that it is in no tree JaiRA follows, and
 * JaiRA can neither list nor stop it (decision 0032, ruling 7)?
 *
 *  - `Invoke-CimMethod` or `Invoke-WmiMethod` calling `Create` on `Win32_Process` — the class named, or
 *    none named at all (it arrives down a pipe: `Get-CimClass Win32_Process | Invoke-CimMethod -MethodName
 *    Create`); `wmic process call create`. The process's parent is the WMI service;
 *  - `schtasks /create`, `Register-ScheduledTask` and `Register-ScheduledJob`, `at` (but not its list or
 *    removal), `crontab` when it installs a table (not `-l` or `-r`): the scheduler starts it, later;
 *  - `setsid` and `disown`: a session of its own, a job the shell lets go of — out of the call's process
 *    group, which is how POSIX finds what a call started (`leftRunning.ts`). Ruling 7 refuses them
 *    "when the scope above is absent", and no systemd scope holds a session's processes yet;
 *  - `launchctl submit`, and `systemd-run` — every one: JaiRA starts no scope an agent could name.
 *
 * A script file can do any of these where no line shows it; ruling 7's sweep for `escaped` processes is
 * what sees those. This reads only what a line says.
 */
export function startsUntracked(command: ParsedCommand): boolean {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((word) => word.value.toLowerCase().replace(/^["']|["']$/g, ""));
  switch (command.program) {
    case "invoke-cimmethod":
    case "invoke-wmimethod": {
      if (!words.includes("create")) return false;
      if (words.includes("win32_process")) return true;
      return !words.some((word) => powershellParameter(word, WMI_CLASS_PARAMETERS) !== undefined);
    }
    case "wmic":
      return words.includes("process") && words.includes("call") && words.includes("create");
    case "schtasks":
      return words.some((word) => word === "/create" || word === "-create");
    case "register-scheduledtask":
    case "register-scheduledjob":
    case "setsid":
    case "disown":
    case "systemd-run":
      return true;
    case "at":
      // `at` alone lists (Windows), `-l` lists, `-r`/`-d` and `/delete` remove, `-c` prints a job.
      return words.length > 0 && !words.some((word) => /^-[lrdc]$/.test(word) || word === "/delete");
    case "crontab":
      // `crontab -l` lists, `crontab -r` removes; `-e`, a file, or `-` installs a table.
      return !words.some((word) => /^-[a-z]*[lr]/.test(word) && !/^-[a-z]*e/.test(word));
    case "launchctl":
      return command.subcommand === "submit";
    default:
      return false;
  }
}

/** Strictest wins, so nothing benign on the same line can soften a verdict. */
const RANK: Record<PolicyAction, number> = { allow: 0, require_approval: 1, deny: 2 };

/**
 * A part a FUNCTION decides is, to the line, a part that is not yet allowed: the line is escalated so
 * that the approver — which runs the functions before it asks anybody — gets it.
 */
const ACTION_OF: Record<CommandPartVerdict, PolicyAction> = { allowed: "allow", function: "require_approval", asks: "require_approval", denied: "deny" };
const VERDICT_OF: Record<PolicyAction, CommandPartVerdict> = { allow: "allowed", require_approval: "asks", deny: "denied" };
const VERDICT_OF_WORD: Record<ToolMode, CommandPartVerdict> = { allow: "allowed", ask: "asks", deny: "denied" };
const verdictOfMode = (mode: PermissionSetMode): CommandPartVerdict => (isFunctionMode(mode) ? "function" : VERDICT_OF_WORD[mode]);

export interface CommandDecision {
  action: PolicyAction;
  reason: string;
  /** The command the verdict is about (absent when the line was unparsable, or the part is a redirect). */
  command?: ParsedCommand;
  /** The line as the requests it is made of, each with its own verdict — what an approval draws (decision 0007 §4). */
  parts: CommandApproval;
}

/**
 * Answers a person gave about PARTS, remembered for as long as this object lives — a run.
 *
 * Keyed by a WIDTH (`git commit`, or `git`; `rm`; `script`; `write_file`), never by a line: the same
 * answer then covers the next line that holds the same request, whatever else shares it. An `allow`
 * lifts a part that would have ASKED and nothing else — a denied part stays denied, so a remembered
 * answer never reaches over the destructive floor, a rule's or a permission set's `deny` (the shipped
 * sets' `.jaira/` lines among them), or a line the parser could not read. Writing the entry into a
 * permission set FILE is the other reach ("add to the permission set"), and is not done here.
 *
 * An answer may also be kept at a PLACE (decision 0023 §3.8): `npm run build` allowed "in packages"
 * is (`npm run build`, `packages`), and covers the next `npm run build` only where every place it is
 * about lies in `packages` — judged as a line's place map is (`resolvePlaces`), so `packages` is the
 * folder and all under it and `claude/**` a branch glob. An answer kept at no place covers the width
 * everywhere, as before places. Where both are kept for one width, the placed one that covers the part
 * speaks, and a placeless one answers the rest.
 */
export class CommandGrants {
  /** By width (normalized as subjects are), then by place (`""` for none). */
  private readonly answers = new Map<string, Map<string, "allow" | "deny">>();

  /** Remember one answer at one width, and optionally at one place. Widths are normalized the way permission set subjects are. */
  remember(width: string, decision: "allow" | "deny", place?: string): void {
    const key = width.trim().replace(/\s+/g, " ").toLowerCase();
    if (key.length === 0) return;
    const at = this.answers.get(key) ?? new Map<string, "allow" | "deny">();
    at.set(place?.trim() ?? "", decision);
    this.answers.set(key, at);
  }

  /**
   * Remember an approval's answer for the PARTS that asked, each at a chosen width.
   *
   * `widths` names the chosen ones (`["git"]` to widen `git commit` to the program); a part none of
   * them fits is remembered at its narrowest. A width no ASKING part offers is dropped, which is what
   * keeps this from ever storing a line, a part that was already allowed, or one that was denied.
   * `place`, when given, is where the answer holds (one of the asking parts' `where.widths`): each
   * width is kept at it. Returns what was stored.
   */
  rememberParts(approval: CommandApproval, decision: "allow" | "deny", widths?: readonly string[], place?: string): string[] {
    const chosen = Object.keys(entriesToRemember(approval, decision, (part) => part.widths.find((w) => widths?.includes(w) === true) ?? part.widths[0]));
    for (const width of chosen) this.remember(width, decision, place);
    return chosen;
  }

  /**
   * The narrowest remembered answer among a part's widths — at a width kept at a place only where
   * `placesOf` says the part is about places all of which lie there. `placesOf(kind, width)` is what
   * the part is about for a line of that width (`PartPlaces.of`); absent, a placed answer covers nothing.
   */
  answerFor(
    widths: readonly string[],
    placesOf?: ((kind: PlaceKind, width: string) => readonly string[]) | undefined,
    options: PlaceOptions = {},
  ): { width: string; decision: "allow" | "deny"; place?: string } | undefined {
    for (const width of widths) {
      const kept = this.answers.get(width.trim().replace(/\s+/g, " ").toLowerCase());
      if (kept === undefined) continue;
      const placed = Object.fromEntries([...kept].filter(([place]) => place !== ""));
      const kind = placeKindOf(width);
      const about = kind !== undefined && placesOf !== undefined ? placesOf(kind, width) : [];
      if (kind !== undefined && about.length > 0 && Object.keys(placed).length > 0) {
        const resolved = resolvePlaces(placed, kind, about, options);
        // A refusal kept at one of its places refuses the part, whatever its other places are; an
        // allowance holds only where it covers all of them.
        if (resolved.decision !== undefined && (resolved.unmatched.length === 0 || resolved.decision === "deny")) {
          const deciding = resolved.matches.find((match) => match.decision === resolved.decision) ?? resolved.matches[0]!;
          return { width, decision: resolved.decision, place: deciding.place };
        }
      }
      const anywhere = kept.get("");
      if (anywhere !== undefined) return { width, decision: anywhere };
    }
    return undefined;
  }

  /** What is kept, by width — and `width @ place` for an answer kept at a place. */
  list(): Record<string, "allow" | "deny"> {
    const out: Record<string, "allow" | "deny"> = {};
    for (const [width, kept] of this.answers) for (const [place, decision] of kept) out[place === "" ? width : `${width} @ ${place}`] = decision;
    return out;
  }

  clear(): void {
    this.answers.clear();
  }

  /**
   * Let go of answers by the keys {@link list} names them by — `width`, or `width @ place` — what the
   * Tools card's run marks let go of one at a time (decision 0023 §4.1). A key that names nothing
   * kept is no error.
   */
  forget(keys: readonly string[]): void {
    for (const key of keys) {
      const at = key.indexOf(" @ ");
      const width = (at < 0 ? key : key.slice(0, at)).trim().replace(/\s+/g, " ").toLowerCase();
      const place = at < 0 ? "" : key.slice(at + 3).trim();
      const kept = this.answers.get(width);
      if (kept === undefined) continue;
      kept.delete(place);
      if (kept.size === 0) this.answers.delete(width);
    }
  }
}

export interface DecideCommandOptions {
  /**
   * The permission set the line is judged against, as the shell reads it. Absent ⇒ the line answers to the
   * built-ins alone: the floor refuses, a built-in asks, and anything else is allowed.
   */
  permissionSet?: ShellPermissionSet | undefined;
  /**
   * Where {@link permission set} came from: the reference a state names it by, or `inline`. Carried onto
   * the approval untouched; nothing here reads it.
   */
  permissionSetSource?: string | undefined;
  /** Answers remembered for this run, by part width — and by place, where one was chosen. */
  grants?: CommandGrants | undefined;
  /**
   * The stack {@link permissionSet} was composed from (decision 0023 §2.6) and who set each line —
   * what a part's row names as its layer (`decidedBy.layer`, §2.7), and what the approval lists for
   * "Add to", newest first. Absent: no part names a layer.
   */
  stack?: PermissionStackDecl | undefined;
  /**
   * What the executor's scope FLOOR says about one part's place, by the STANDARD TOOL the part is — so
   * a path scope written for `write_file` binds `rm` and `>` exactly as it binds the tool.
   */
  scopeOf?: ((tool: string, place: { path?: string; url?: string }) => PermissionMode | undefined) | undefined;
  /** What a relative place resolves against for {@link scopeOf}: the workspace, then the call's own `cwd`, then each `cd` on the line. */
  root?: string | undefined;
  cwd?: string | undefined;
  /**
   * What a line's PLACES (decision 0023 §3) are resolved against: the project root a relative place is
   * written from, and where `$PROJECT`, `$WORKTREE`, `$TEMP` and `~` are on this machine. Absent, the
   * project root is {@link root}. Unlike {@link root} it is not moved for a package script's lines:
   * `packages/app` means the project's `packages/app` however deep the line is.
   */
  places?: PlaceOptions | undefined;
  /**
   * How a line's packages are read — so `npm run lint`, `npm -w app test` are judged by the lines
   * their scripts run ({@link scriptRunsOf}; `filePackages` in the app). Absent, or with no directory
   * to start from, a named script is `script`.
   */
  packages?: PackageReader | undefined;
  /** How many scripts deep this line is (`npm test` running `npm run build`); past {@link MAX_SCRIPT_DEPTH} a script is `script` again. */
  scriptDepth?: number | undefined;
  /**
   * A word as the shell would expand its `~` and `$NAME` (decision 0030, ruling 7), applied to every path
   * a part names and every `cd` before it is resolved. Absent, words are taken as written.
   */
  expand?: ((word: string) => string) | undefined;
  /**
   * The environment the line runs in (decision 0007 §4, amended 2026-11-25): what a variable the line
   * does not set itself is read through — `& $env:X …`, `"$HOME/x"`, `%TEMP%` — so its parts are judged
   * on what runs. Absent, only the line's own assignments are read through.
   */
  env?: EnvironmentLookup | undefined;
  /**
   * The line is started to KEEP RUNNING (decision 0032, ruling 1): the call says `run_in_background:
   * true` — JaiRA's `shell`, or Claude's own `Bash` (the person's ruling 6, "same line"). Beside its
   * parts, judged as any line's, the line is one more part, the whole of it, answered by the `shell
   * --run_in_background` lines: narrowed by what it runs (`shell --run_in_background npm run dev` before
   * `… npm` before the bare line), strictest wins — so a backgrounded line runs only if it may run AND
   * may keep running.
   */
  background?: boolean | undefined;
}

const MAX_SCRIPT_DEPTH = 4;

/** The packages a part runs a script in, and the lines it runs in each, when it names a package script that can be read. */
function scriptRunsFor(part: ClassifiedPart, here: string | undefined, options: DecideCommandOptions): ScriptRun[] | undefined {
  if (options.packages === undefined || here === undefined || part.command === undefined || part.unmodelled !== undefined) return undefined;
  if ((options.scriptDepth ?? 0) >= MAX_SCRIPT_DEPTH) return undefined;
  const make = makeCallOf(part.command);
  if (make !== undefined) return makeRunsOf(options.packages, part.command.program, make, here);
  const call = packageScriptOf(part.command);
  return call === undefined ? undefined : scriptRunsOf(options.packages, call, here);
}

/** Does a command line that names this part have places — so whether it decides depends on where the part runs? */
function namedWithPlaces(set: ShellPermissionSet | undefined, command: ParsedCommand): boolean {
  if (set === undefined) return false;
  return matchCommandEntries(set, command).some((match) => set.places !== undefined && Object.hasOwn(set.places, match.entry.key));
}

/**
 * A stack's layer ids NEWEST first, as an approval lists them (decision 0023 §4.4) — with `runtime`
 * in its place under the tools layer (§2.6 step 4) when this task's answers are kept.
 */
export function approvalStackOf(stack: PermissionStackDecl, withRuntime: boolean): string[] {
  const ids = stackIdsNewestFirst(stack);
  if (!withRuntime) return ids;
  const at = ids[0] === TOOLS_LAYER ? 1 : 0;
  return [...ids.slice(0, at), RUNTIME_LAYER, ...ids.slice(at)];
}

/** Whether `span` lies within `outer`, and is not `outer` itself. */
const inside = (span: TextSpan, outer: TextSpan): boolean => span.start >= outer.start && span.end <= outer.end && !(span.start === outer.start && span.end === outer.end);

/** The ssh options that take a value — what is skipped to find the host a line reaches. */
const SSH_VALUED = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"]);

/** The host an `ssh` line reaches (`user@host`, `host:22` → `host`), when it can be read. */
function sshHostOf(command: ParsedCommand): string | undefined {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") continue;
    if (word.startsWith("-")) {
      if (SSH_VALUED.has(word)) i++;
      continue;
    }
    const host = word.includes("@") ? word.slice(word.lastIndexOf("@") + 1) : word;
    return host.replace(/^ssh:\/\//i, "").replace(/:\d+$/, "");
  }
  return undefined;
}

/**
 * The branches a `git push` line pushes to, as a branch place reads them (`origin:main`, or `main`
 * where no remote is named): each refspec's destination, `refs/heads/` taken off. Empty when the line
 * names no refspec — the current branch, which is git's to know — so its places say nothing and the
 * line below answers (decision 0023 §3.4).
 */
export function pushedBranchesOf(command: ParsedCommand): string[] {
  if (command.program !== "git" || command.subcommand !== "push") return [];
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  const at = words.indexOf("push");
  const operands: string[] = [];
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") continue;
    if (word.startsWith("-")) {
      // The options that take a value as the next word (`-o ci.skip`, `--repo x`, `--receive-pack x`).
      if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(word)) i++;
      continue;
    }
    operands.push(word);
  }
  const [remote, ...refspecs] = operands;
  const out: string[] = [];
  for (const refspec of refspecs) {
    const bare = refspec.replace(/^\+/, "");
    const colon = bare.indexOf(":");
    const destination = (colon === -1 ? bare : bare.slice(colon + 1) || bare.slice(0, colon)).replace(/^refs\/heads\//, "");
    if (destination === "" || destination === "HEAD" || destination.startsWith("refs/")) continue;
    out.push(remote !== undefined ? `${remote}:${destination}` : destination);
  }
  return out;
}

/**
 * A word on a command line that names a place on the disk: one with a separator, or an absolute one — `commandSubjects`' reading.
 * A scoped package name (`@jaira/app`, `@types/node`) is none: `npm -w @jaira/app run build` is about
 * the workspace it picks, which is where it runs, not about a folder `@jaira` under the project.
 */
const looksLikePath = (word: string): boolean =>
  !word.startsWith("-") && (word.includes("/") || word.includes("\\") || isAbsolutePath(word)) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(word) && !SCOPED_PACKAGE.test(word);
const SCOPED_PACKAGE = /^@[a-z0-9][\w.-]*\/[\w.-]+(@[^/\\\s]*)?$/i;

/**
 * What one part is about, for the places of each line it may answer to (decision 0023 §3.1): a FILE
 * tool's line, and `script`'s, by the paths the part names (the file run, the file written) — else the
 * directory it runs in; any other path line (a command line, `shell`, `runner:*`) by the directory it
 * runs in — the package's, for a package script — and every path it names; `git push`'s by the
 * branches it pushes; a network program's by its URL; `runner:ssh` by the host. A path written into a
 * flag (`--output=dist/x`, `cp --target-directory=.jaira/x`) is one the part names, for every path line.
 */
function partPlacesOf(part: ClassifiedPart, here: string | undefined, runDirs: readonly string[] | undefined, placeOptions: PlaceOptions, expand: (word: string) => string = (word) => word): PartPlaces & { primary(kind: PlaceKind, line: string): string | undefined } {
  // `~/.ssh` is where `~` is, as a place's `~` is; anything else relative is where the part acts.
  const home = placeOptions.named?.["~"];
  const at = (path: string): string =>
    /^~([\\/]|$)/.test(path) ? (home !== undefined ? `${home}${path.slice(1)}` : path) : isAbsolutePath(path) || here === undefined ? path : absolutize(path, here);
  const resolve = (path: string): string => at(expand(path));
  const paths = part.paths.filter((path) => path !== "{}").map(resolve);
  const named = part.command !== undefined && part.kind !== "tool" && part.kind !== "redirect" ? commandWords(part.command).map(expand).filter(looksLikePath).map(at) : [];
  const flagged = part.command !== undefined ? part.command.flags.flatMap((f) => (f.includes("=") ? [f.slice(f.indexOf("=") + 1)] : [])).map(expand).filter(looksLikePath).map(at) : [];
  const where = here ?? placeOptions.root;
  const dirs = runDirs !== undefined && runDirs.length > 0 ? [...runDirs] : where !== undefined ? [where] : [];
  const byFile = (line: string): boolean => line === SCRIPT_SUBJECT || (TOOL_SPEC_BY_NAME.has(line) && line !== SHELL_SUBJECT);
  const files = [...new Set([...paths, ...flagged])];
  const of = (kind: PlaceKind, line: string): string[] => {
    switch (kind) {
      case "path":
        if (byFile(line)) return files.length > 0 ? files : dirs;
        return [...new Set([...dirs, ...paths, ...named, ...flagged])];
      case "branch":
        return part.command !== undefined ? pushedBranchesOf(part.command) : [];
      case "site": {
        const url = part.url ?? (part.command !== undefined ? commandWords(part.command).find((w) => /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) : undefined);
        return url !== undefined ? [url] : [];
      }
      case "host": {
        const host = part.command !== undefined ? sshHostOf(part.command) : undefined;
        return host !== undefined ? [host] : [];
      }
      case "program":
        // A process command's programs, and the programs its pids are, read off the machine only now
        // that a line with program places asks (`processTargets.ts`).
        return part.processes !== undefined ? [...part.processes.programs, ...programPlacesOfPids(part.processes.pids, placeOptions)] : [];
      default:
        return [];
    }
  };
  return {
    of,
    words: () =>
      part.command === undefined
        ? []
        : [...commandWords(part.command), ...part.command.flags.flatMap((f) => (f.includes("=") ? [f.slice(f.indexOf("=") + 1)] : []))]
            .map((word) => word.replace(/^@/, ""))
            .filter((word) => word.length > 0 && !word.includes("://"))
            .map(resolve),
    options: placeOptions,
    resource: (line) => partResourceOf(part, line, placeOptions),
    // The place the dialog offers widths of: a path the part names before the directory it runs in.
    primary: (kind, line) => (kind === "path" ? (paths[0] ?? named[0] ?? dirs[0]) : of(kind, line)[0]),
  };
}

/**
 * The places of every kind a part that is a System tool is about (decision 0023 §3.1, amended
 * 2026-11-23), for its tool's line: the machine it runs on; for a process command, the programs it names
 * and the programs and owners its pids are (read off the machine), what it does to them, and — where it
 * names a program but no pid (`pgrep node`) — an owner nobody could read, since it reaches anyone's;
 * a command that names no process at all (`ps aux`, `tasklist`) reaches every one, and nothing filters
 * what it prints, so every kind is a place nobody could read and takes the strictest answer. Any other
 * System command, what its reader read (`ClassifiedPart.resource`).
 */
function partResourceOf(part: ClassifiedPart, line: string, placeOptions: PlaceOptions): ResourcePlaces | undefined {
  const tool = parseToolFlagSubject(line)?.tool ?? line;
  if (part.kind !== "tool" || part.tool !== tool) return undefined;
  const machineName = placeOptions.facts?.machine?.() ?? unknownProgramPlace("machine");
  const processes = part.processes;
  if (processes === undefined) {
    // A kind its reader did not read is one nobody could, never one the part is not about — save a file
    // or a link, which a part that opens none is not about.
    const spec = TOOL_SPEC_BY_NAME.get(tool);
    const out: ResourcePlaces = { ...(part.resource ?? {}), machine: [machineName] };
    for (const kind of [spec?.scope, ...(spec?.dimensions ?? [])]) if (kind !== undefined && kind !== "path" && kind !== "site" && out[kind] === undefined) out[kind] = [unknownProgramPlace(kind)];
    return out;
  }
  const facts = processes.pids.map((pid) => ({ pid, facts: placeOptions.facts?.process?.(pid) }));
  let program = [...processes.programs, ...programPlacesOfPids(processes.pids, placeOptions)];
  let owner = facts.map(({ pid, facts: f }) => (f?.owner !== undefined && f.owner.length > 0 ? f.owner.join(OWNER_ALIAS) : unknownProgramPlace(pid)));
  if (processes.programs.length > 0) owner.push(unknownProgramPlace("anyone's"));
  if (program.length === 0) {
    program = [unknownProgramPlace("every process")];
    owner = [unknownProgramPlace("anyone's")];
  }
  return { program, owner, machine: [machineName], ...(processes.actions !== undefined ? { action: processes.actions } : {}) };
}

/** The folder of the nearest `package.json` at or above a path, read through a package reader — the dialog's "the package" width. */
export function packageFolderOf(packages: PackageReader | undefined): ((path: string) => string | undefined) | undefined {
  if (packages === undefined) return undefined;
  return (path) => {
    let dir = normalizePath(path);
    for (let depth = 0; depth < 64; depth++) {
      try {
        if (packages.at(dir) !== undefined) return dir;
      } catch {
        return undefined;
      }
      const slash = dir.lastIndexOf("/");
      if (slash <= 0 || /^[a-zA-Z]:$/.test(dir.slice(0, slash))) return undefined;
      dir = dir.slice(0, slash);
    }
    return undefined;
  };
}

/**
 * The gate a part's command runner answers to (`commandRunners.ts`): `"named"` when a command line
 * names the program (`npm`, `npm run build`) and decides it here, which decides it outright; its own
 * `runner:` line or the group's — the most specific of their places that matches where it runs, else
 * the line's own mode, else the group's (decision 0023 §3.4); `undefined` when it is no runner, or no
 * runner line says anything here — then nothing gates it.
 */
function runnerGateFor(part: ClassifiedPart, options: DecideCommandOptions, where: PartPlaces): "named" | { mode: PermissionSetMode; line: string; place?: string } | undefined {
  const set = options.permissionSet;
  const command = part.command;
  if (set === undefined || command === undefined || part.kind === "unparsed" || !isCommandRunner(command.program)) return undefined;
  const lines = [runnerSubject(command.program), RUNNER_GROUP_SUBJECT];
  const answer = answerOfLines(set, lines, where);
  if (answer === undefined && !lines.some((line) => Object.hasOwn(set.entries, line) || (set.places !== undefined && Object.hasOwn(set.places, line)))) return undefined;
  if (part.unmodelled === undefined && matchCommandEntry(set, command) !== undefined && lookUp(set, part, where).specific) return "named";
  if (answer === undefined || answer.mode === undefined || answer.entry === undefined) return undefined;
  return { mode: answer.mode, line: answer.entry, ...(answer.place !== undefined ? { place: answer.place } : {}) };
}

/** A runner's gate as a part of the line: its whole invocation, its program underlined, answered by its line — or by what was remembered for the run. */
function runnerPart(part: ClassifiedPart, gate: { mode: PermissionSetMode; line: string; place?: string }, options: DecideCommandOptions, line: string, where: PartPlaces): CommandPart {
  const command = part.command!;
  const subject = runnerSubject(command.program);
  const widths = [subject, RUNNER_GROUP_SUBJECT];
  const reference = modeFunction(gate.mode);
  let verdict = verdictOfMode(gate.mode);
  const at = gate.place !== undefined ? ` in ${gate.place}` : "";
  const layer = layerOfLine(options.stack, gate.line, gate.place);
  let decidedBy: CommandPart["decidedBy"] = {
    source: "permissionSet",
    entry: gate.line,
    ...(reference !== undefined ? { function: reference } : {}),
    ...(gate.place !== undefined ? { place: gate.place } : {}),
    ...(layer !== undefined ? { layer } : {}),
    reason: reference !== undefined ? `the permission set's '${gate.line}'${at} is decided by the function '${reference}'` : `the permission set's '${gate.line}'${at} is ${modeWord(gate.mode)}`,
  };
  if (verdict === "asks") {
    const remembered = options.grants?.answerFor(widths, where.of, where.options);
    if (remembered !== undefined) {
      verdict = remembered.decision === "allow" ? "allowed" : "denied";
      decidedBy = { source: "remembered", entry: remembered.width, layer: RUNTIME_LAYER, ...(remembered.place !== undefined ? { place: remembered.place } : {}), reason: rememberedReason(remembered) };
    }
  }
  const program = command.words?.[command.programIndex ?? 0];
  return {
    span: part.span,
    matched: program !== undefined ? [{ ...program.span }] : part.matched,
    text: line.slice(part.span.start, part.span.end),
    kind: "runner",
    subject,
    ...(verdict === "function"
      ? { command: { program: command.program, ...(command.subcommand !== undefined ? { subcommand: command.subcommand } : {}), args: [...command.args], flags: [...command.flags] } }
      : {}),
    verdict,
    decidedBy,
    widths,
    ...(part.via !== undefined ? { via: part.via } : {}),
  };
}

/**
 * Does a refusal kept "for this run" at `width` stand over what a part's set allowed (decision 0023
 * §2.6: runtime is newer than every layer but the tools layer)? Over nothing decided — no built-in, no
 * set — yes. Over a set's line: not one the TOOLS layer set, which is newer still; and, line against
 * line, the more specific wins (§2.2) — a part's widths are its lines narrowest first, so the kept
 * width stands where it is at least as narrow as the deciding line, and over any line that is no width
 * of the part (`shell`, `other`, the standard tool a utility is), which is less specific than all.
 */
function runtimeOutranks(composed: Composed, width: string, widths: readonly string[]): boolean {
  if (composed.source === "default") return true;
  if (composed.source !== "permissionSet" || composed.layer === TOOLS_LAYER) return false;
  const norm = (subject: string): string => normalizeSubject(subject).toLowerCase();
  const all = widths.map(norm);
  const line = composed.entry !== undefined ? all.indexOf(norm(composed.entry)) : -1;
  return line < 0 || all.indexOf(norm(width)) <= line;
}

/** What a person reads for an answer remembered for this run — at its place, where it was kept at one. */
function rememberedReason(remembered: { width: string; decision: "allow" | "deny"; place?: string }): string {
  return `'${remembered.width}'${remembered.place !== undefined ? ` in ${remembered.place}` : ""} was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run`;
}

/**
 * What answers a piece of a line that could not be read ({@link UNPARSED_SUBJECT}): the set's own
 * `unparsed` line when it allows or refuses — its place never, since nothing is known of where such a
 * piece acts, and never a function — else an answer remembered for this run at that width, else the
 * line's `ask`. `undefined` when nothing speaks: the piece asks as the parser says.
 */
function unreadableAnswerOf(judging: ShellPermissionSet | undefined, options: DecideCommandOptions, why: string): Composed | undefined {
  const line = judging !== undefined ? answerOfLines(judging, [UNPARSED_SUBJECT]) : undefined;
  const mode = line?.mode !== undefined && modeFunction(line.mode) === undefined ? line.mode : undefined;
  const verdict = mode !== undefined ? verdictOfMode(mode) : undefined;
  const fromLine = (): Composed => {
    const layer = layerOfLine(options.stack, UNPARSED_SUBJECT, undefined);
    return { verdict: verdict!, source: "permissionSet", entry: UNPARSED_SUBJECT, ...(layer !== undefined ? { layer } : {}), reason: `${why} — the permission set's '${UNPARSED_SUBJECT}' is ${modeWord(mode!)}` };
  };
  if (verdict === "allowed" || verdict === "denied") return fromLine();
  const remembered = options.grants?.answerFor([UNPARSED_SUBJECT]);
  if (remembered !== undefined) {
    return { verdict: remembered.decision === "allow" ? "allowed" : "denied", source: "remembered", entry: remembered.width, layer: RUNTIME_LAYER, reason: `${why} — ${rememberedReason(remembered)}` };
  }
  return verdict === "asks" ? fromLine() : undefined;
}

/** A part's answer while it is being composed: the layer that gave it is kept beside it. */
interface Composed {
  verdict: CommandPartVerdict;
  source: CommandPartDecider;
  reason: string;
  entry?: string;
  /** The function the permission set entry names, when the verdict is `function`. */
  function?: string;
  /** The words a permission set entry matched, when one decided. */
  matched?: TextSpan[];
  /** The place of the entry's line that decided, when a place did. */
  place?: string;
  /** The layer of the stack that set the deciding line (decision 0023 §2.7) — `runtime` for an answer given in this task. */
  layer?: string;
}

const isStricter = (a: CommandPartVerdict, b: CommandPartVerdict): boolean => VERDICT_RANK[a] > VERDICT_RANK[b];

/** The fallback set as a shell line reads it, made once per set. */
const SHELL_FALLBACKS = new WeakMap<PermissionSet, ShellPermissionSet | undefined>();
function fallbackJudging(policy: JairaPolicy): ShellPermissionSet | undefined {
  const set = policy.fallback;
  if (set === undefined) return undefined;
  if (!SHELL_FALLBACKS.has(set)) SHELL_FALLBACKS.set(set, shellPermissionSetOf(set));
  return SHELL_FALLBACKS.get(set);
}

/** A line's answer as a part's verdict, naming the line, its place and the layer that wrote it. */
function composedOf(answer: PermissionSetAnswer & { mode: PermissionSetMode }, part: ClassifiedPart, stack: PermissionStackDecl | undefined): Composed {
  const reference = modeFunction(answer.mode);
  const at = answer.place !== undefined ? ` in ${answer.place}` : "";
  const layer = answer.entry !== undefined ? layerOfLine(stack, answer.entry, answer.place) : undefined;
  return {
    verdict: verdictOfMode(answer.mode),
    source: "permissionSet",
    ...(answer.entry !== undefined ? { entry: answer.entry } : {}),
    ...(layer !== undefined ? { layer } : {}),
    ...(reference !== undefined ? { function: reference } : {}),
    ...(answer.place !== undefined ? { place: answer.place } : {}),
    reason:
      answer.entry === undefined
        ? `the permission set does not hold '${part.subject}'`
        : reference !== undefined
          ? `the permission set's '${answer.entry}'${at} is decided by the function '${reference}'`
          : `the permission set's '${answer.entry}'${at} is ${modeWord(answer.mode)}`,
    ...(answer.matched !== undefined ? { matched: answer.matched } : {}),
  };
}

/**
 * Judge one part. `undefined` when it is no request at all (`cd foo`, `echo hi`).
 *
 * The order, and what each layer may do. Nothing here is a rule of its own: every verdict is a LINE of
 * the set judging the part — the state's, the conversation's, or, where none judges it, the policy's
 * fallback ({@link JairaPolicy.fallback}: `base/allow-all` under `security/standard`). What a security
 * profile refuses or asks about (force pushes, the network, credentials) is its lines, read here like
 * any other (the person, 2026-11-25: "all rules should go through permissions").
 *
 *  1. A part that starts a process out of every tree JaiRA follows ({@link startsUntracked}) answers
 *     first to the `shell --untracked` lines ({@link untrackedAnswerOf}) — then, where none speaks, to
 *     its own lines as any command.
 *  2. The set's answer for the part's subject ({@link lookUp}: the most specific line, the most specific
 *     of its places that matches where the part acts, a place that matches nothing falling to a less
 *     specific line); then the `shell` line's PLACES at the words the part is handed
 *     ({@link argumentAnswerOf}), the stricter of the two — a place on `shell` is about what any command
 *     may touch there. An entry that names a FUNCTION answers `function`, which ranks between `allowed`
 *     and `asks`.
 *  3. A part the parser cannot vouch for asks at least — never a function: what it cannot read is
 *     never allowed by what the permission set says about commands it could read (`shell`, `other`,
 *     its program's lines). Only the line written for what could not be read, `unparsed`, answers it
 *     — or an answer a person gave for this run at that width ({@link unreadableAnswerOf}).
 *  4. An answer REMEMBERED for this run settles a part that asks: `allowed`, or `denied` — at its
 *     place, where it was kept at one. It never lifts `denied`, and never a part a function decides; what
 *     the parser could not read was answered at (3).
 *  5. The executor's scope FLOOR's answer for the part's place, by the standard tool the part is.
 *     Strictest again, and after (4): a remembered `rm` does not open a place the floor shut.
 */
function judgePart(policy: JairaPolicy, part: ClassifiedPart, options: DecideCommandOptions, here: string | undefined, where: PartPlaces): Composed | undefined {
  // `cd`, `echo`, `true`: no request at all.
  if (part.noRequest === true) return undefined;
  const judging = options.permissionSet;

  // With no set at all, a variable still asks (decision 0007 §4) and anything else is allowed.
  let composed: Composed =
    part.kind === "env"
      ? { verdict: "asks", source: "default", reason: `it sets ${part.subject.slice(part.subject.indexOf(" ") + 1)}, which can change what runs after it` }
      : { verdict: "allowed", source: "default", reason: "no permission set judges it" };

  if (judging !== undefined) {
    // (1) a start JaiRA could not follow, then (2) the part's own lines.
    const escape = part.command !== undefined && startsUntracked(part.command) ? untrackedAnswerOf(judging, part.command, where) : undefined;
    const answer = escape?.mode !== undefined ? escape : lookUp(judging, part, where);
    if (answer.mode !== undefined) {
      composed = composedOf({ ...answer, mode: answer.mode }, part, options.stack);
      // What a refused escape can do instead, said to the agent.
      if (escape?.mode !== undefined && composed.verdict === "denied") composed = { ...composed, reason: `${composed.reason} — ${ESCAPE_REASON}` };
    }
    const touched = argumentAnswerOf(judging, part, where);
    if (touched?.mode !== undefined) {
      const fromPlaces = composedOf({ ...touched, mode: touched.mode }, part, options.stack);
      if (isStricter(fromPlaces.verdict, composed.verdict)) composed = fromPlaces;
    }
  }

  // (3) what the parser cannot vouch for asks — unless a line it does match refuses it: `git -c x reset
  // --hard` is still `git reset --hard`, and a flag the parser cannot model must not soften a refusal to a question.
  if (part.unmodelled !== undefined && part.kind !== "unparsed" && part.command !== undefined && judging !== undefined && composed.verdict !== "denied") {
    const read = lookUp(judging, { ...part, unmodelled: undefined }, where);
    if (read.mode === "deny") composed = composedOf({ ...read, mode: read.mode }, part, options.stack);
  }
  if (part.unmodelled !== undefined && composed.verdict !== "denied") {
    const why = part.kind === "unparsed" ? `command could not be parsed (${part.unmodelled})` : part.unmodelled;
    composed = unreadableAnswerOf(judging, options, why) ?? { verdict: "asks", source: "parser", reason: why };
  }

  // (4) remembered for this run — at the part's place, where the answer was kept at one. The runtime
  // layer stands over every set below it (decision 0023 §2.6 step 4), so a refusal kept "for this
  // run" also refuses what a layer below ALLOWS at a line no more specific than the width it was kept
  // at; an allowance only settles what asks — it never lifts a refusal (invariant 28).
  if (part.unmodelled === undefined && composed.verdict !== "denied") {
    const remembered = options.grants?.answerFor(part.widths, where.of, where.options);
    if (remembered !== undefined && (composed.verdict === "asks" || (remembered.decision === "deny" && runtimeOutranks(composed, remembered.width, part.widths)))) {
      composed = {
        verdict: remembered.decision === "allow" ? "allowed" : "denied",
        source: "remembered",
        entry: remembered.width,
        layer: RUNTIME_LAYER,
        ...(remembered.place !== undefined ? { place: remembered.place } : {}),
        reason: rememberedReason(remembered),
      };
    }
  }

  // (5) where — the executor's floor
  if (options.scopeOf !== undefined && part.tool !== undefined && composed.verdict !== "denied") {
    const resolved = (written: string): string => {
      const path = options.expand?.(written) ?? written;
      return isAbsolutePath(path) || here === undefined ? path : absolutize(path, here);
    };
    const places: Array<{ path?: string; url?: string }> = [...part.paths.map((path) => ({ path: resolved(path) })), ...(part.url !== undefined ? [{ url: part.url }] : [])];
    for (const place of places) {
      const mode = options.scopeOf(part.tool, place);
      // A scope table says a fixed word; upstream's `smart` is not one a table can hold.
      if (mode === undefined || mode === "allow" || mode === "smart") continue;
      if (isStricter(VERDICT_OF_WORD[mode], composed.verdict)) {
        composed = { verdict: VERDICT_OF_WORD[mode], source: "scope", reason: `${part.tool} is ${mode === "deny" ? "denied" : "asked about"} at ${place.path ?? place.url}` };
      }
    }
  }
  return composed;
}

/**
 * A backgrounded line's own part (decision 0032, ruling 1): the whole line, answered by the `shell
 * --run_in_background` lines for each thing it starts ({@link backgroundAnswerOf}, narrowed by what each
 * request runs), the strictest kept — `npm run build && npm run dev` may keep running only if both may.
 * An answer this run kept settles one that asks, as it settles any part; its widths are the background
 * lines a person may keep the answer at (`shell --run_in_background npm run dev`, … `npm`, the bare line),
 * which is also what "add to the permission set" writes.
 *
 * With no `shell --run_in_background` line at all — a set written before the line existed, or no set
 * judging the line — it ASKS: not `other`, which answers for tools nobody named, and not the shell's
 * own line, which says what may RUN. Starting what outlives the call is its own permission, and a set
 * that never said so has not granted it (the ruled default for every shipped set but `full` is ask).
 */
function backgroundPart(started: ReadonlyArray<{ command?: ParsedCommand; where: PartPlaces }>, options: DecideCommandOptions, line: string): { part: CommandPart; command?: ParsedCommand } {
  const asked = started.length > 0 ? started : [{ where: { of: () => [] } as PartPlaces }];
  let worst: { composed: Composed; widths: string[]; command?: ParsedCommand } | undefined;
  for (const start of asked) {
    const widths = backgroundWidthsOf(start.command);
    const answer = options.permissionSet !== undefined ? backgroundAnswerOf(options.permissionSet, start.command, start.where) : undefined;
    let composed: Composed;
    if (answer?.mode !== undefined && answer.entry !== undefined) {
      const reference = modeFunction(answer.mode);
      const at = answer.place !== undefined ? ` in ${answer.place}` : "";
      const layer = layerOfLine(options.stack, answer.entry, answer.place);
      composed = {
        verdict: verdictOfMode(answer.mode),
        source: "permissionSet",
        entry: answer.entry,
        ...(layer !== undefined ? { layer } : {}),
        ...(reference !== undefined ? { function: reference } : {}),
        ...(answer.place !== undefined ? { place: answer.place } : {}),
        reason:
          reference !== undefined
            ? `the permission set's '${answer.entry}'${at} is decided by the function '${reference}'`
            : `the permission set's '${answer.entry}'${at} is ${modeWord(answer.mode)} — this line is started to keep running`,
      };
    } else {
      composed = {
        verdict: "asks",
        source: "default",
        reason: options.permissionSet === undefined ? "no permission set judges a start that keeps running, so it asks" : `the permission set has no '${BACKGROUND_LINE}' line, and a start that keeps running asks`,
      };
    }
    if (composed.verdict === "asks") {
      const remembered = options.grants?.answerFor(widths);
      if (remembered !== undefined) {
        composed = { verdict: remembered.decision === "allow" ? "allowed" : "denied", source: "remembered", entry: remembered.width, layer: RUNTIME_LAYER, reason: rememberedReason(remembered) };
      }
    }
    if (worst === undefined || VERDICT_RANK[composed.verdict] > VERDICT_RANK[worst.composed.verdict]) worst = { composed, widths, ...(start.command !== undefined ? { command: start.command } : {}) };
  }
  const { composed, widths, command } = worst!;
  const span: TextSpan = { start: 0, end: line.length };
  return {
    part: {
      span,
      matched: [{ ...span }],
      text: line,
      kind: "command",
      subject: composed.source === "permissionSet" && composed.entry !== undefined ? composed.entry : widths[0]!,
      ...(composed.verdict === "function" && command !== undefined
        ? { command: { program: command.program, ...(command.subcommand !== undefined ? { subcommand: command.subcommand } : {}), args: [...command.args], flags: [...command.flags] } }
        : {}),
      verdict: composed.verdict,
      decidedBy: {
        source: composed.source,
        ...(composed.entry !== undefined ? { entry: composed.entry } : {}),
        ...(composed.verdict === "function" && composed.function !== undefined ? { function: composed.function } : {}),
        ...(composed.place !== undefined ? { place: composed.place } : {}),
        ...(composed.layer !== undefined ? { layer: composed.layer } : {}),
        reason: composed.reason,
      },
      widths,
    },
    ...(command !== undefined ? { command } : {}),
  };
}

/**
 * Decide a whole command line: take it apart, judge every part, and return the
 * strictest verdict — with the parts, which are what an approval shows.
 *
 * The line runs only if EVERY part may. Any part denied ⇒ the line is refused. Any part asking ⇒
 * one approval, carrying every part, each asking part with the place widths it may be remembered at
 * (`CommandPart.where`).
 */
export function decideCommand(policy: JairaPolicy, line: string, dialect: CommandDialect = "posix", given: DecideCommandOptions = {}): CommandDecision {
  // A line no set judges answers to the policy's fallback set, in every step that reads one.
  const fallback = given.permissionSet === undefined ? fallbackJudging(policy) : undefined;
  const options: DecideCommandOptions = fallback !== undefined ? { ...given, permissionSet: fallback } : given;
  const taken = takeApart(line, dialect, [], options.env !== undefined ? { env: options.env } : {});
  const parts: CommandPart[] = [];
  const commands: Array<ParsedCommand | undefined> = [];
  let findRoots: string[] = ["."];
  let here =options.cwd !== undefined ? (isAbsolutePath(options.cwd) || options.root === undefined ? options.cwd : absolutize(options.cwd, options.root)) : options.root;
  // A place is written from the PROJECT, not from the package a script's line runs in.
  const placeOptions: PlaceOptions = options.places ?? (options.root !== undefined ? { root: options.root } : {});
  const packageOf = packageFolderOf(options.packages);
  // Runners whose inside is not looked at: one the gate refused, or one its own command line decided.
  const unlooked: TextSpan[] = [];
  // What a backgrounded line starts (decision 0032): each request, with where it acts.
  const started: Array<{ command?: ParsedCommand; where: PartPlaces }> = [];
  for (const request of taken.requests) {
    if (unlooked.some((span) => inside(request.span, span))) continue;
    const classified = classifyRequest(request, dialect);
    if (classified === undefined) continue;
    const opened = request.kind === "command" ? request.opened : undefined;
    // `npm run lint` is what its script runs: read where — and, unless a command line naming it
    // decides it here, what — before it is judged.
    const named = options.permissionSet !== undefined && classified.command !== undefined && matchCommandEntry(options.permissionSet, classified.command) !== undefined;
    const runs = !named || namedWithPlaces(options.permissionSet, classified.command!) ? scriptRunsFor(classified, here, options) : undefined;
    // `find docs -exec rm {} +` removes under `docs`: `{}` stands for the places the find walks.
    if (classified.command?.program === "find" && classified.via?.at(-1) !== "find") findRoots = classified.paths.length > 0 ? classified.paths : ["."];
    else if (classified.via?.at(-1) === "find" && classified.paths.includes("{}")) classified.paths = classified.paths.flatMap((p) => (p === "{}" ? findRoots : [p]));
    const where = partPlacesOf(classified, here, runs?.map((run) => run.dir), placeOptions, options.expand);
    // What a backgrounded line starts, for its `shell --run_in_background` part below: every request but a
    // runner that opens what it runs (that comes next, as requests of its own) and what is no request.
    if (options.background === true && opened === undefined && classified.noRequest !== true && classified.kind !== "env") {
      started.push({ ...(classified.unmodelled === undefined && classified.kind !== "unparsed" && classified.command !== undefined ? { command: classified.command } : {}), where });
    }
    const gate = runnerGateFor(classified, options, where);
    // The runner's row, when it has one: what it runs is judged under it.
    let runner: number | undefined;
    if (gate === "named") {
      // A command line naming the runner (`npm`, `sudo`) decides it outright: nothing inside is looked at.
      if (opened !== undefined) unlooked.push(classified.span);
    } else if (gate !== undefined) {
      const part = runnerPart(classified, gate, options, line, where);
      parts.push(part);
      commands.push(classified.command);
      if (part.verdict === "denied") {
        unlooked.push(classified.span);
        continue;
      }
      // What an opened runner runs follows, as requests of its own.
      if (opened !== undefined) continue;
      runner = parts.length - 1;
    } else if (opened !== undefined && !opened.kept) continue;
    // A command line naming it decides it outright when it answers here — and then its script is not read.
    const decidedByName = named && options.permissionSet !== undefined && lookUp(options.permissionSet, classified, where).specific;
    if (runs !== undefined && !decidedByName) {
      const through = line.slice(classified.span.start, classified.span.end);
      for (const run of runs) for (const scriptLine of run.lines) {
        // What the script runs is judged as lines; whether it may keep running is the outer line's
        // question, asked of what the line names (`npm run dev`), not of what the script holds.
        const inner = decideCommand(policy, scriptLine, "posix", { ...options, cwd: run.dir, root: run.dir, places: placeOptions, scriptDepth: (options.scriptDepth ?? 0) + 1, background: false });
        const base = parts.length;
        for (const part of inner.parts.parts) {
          const { within, ...rest } = part;
          const under = within !== undefined ? within + base : runner;
          parts.push({ ...rest, span: classified.span, matched: classified.matched, via: [...(classified.via ?? []), through, ...(part.via ?? [])], ...(under !== undefined ? { within: under } : {}) });
          commands.push(classified.command);
        }
      }
      continue;
    }
    const judged = judgePart(policy, classified, options, here, where);
    // `cd infra && rm x` is about `infra/x`: the directory moves for what follows it on the line.
    if (classified.noRequest === true && DIRECTORY_CHANGERS.includes(classified.command?.program ?? "") && classified.paths[0] !== undefined && here !== undefined) {
      const target = options.expand?.(classified.paths[0]) ?? classified.paths[0];
      here = isAbsolutePath(target) ? target : absolutize(target, here);
    }
    if (judged === undefined) continue;
    // A command is named by the entry that decided it (`git commit`, or `git`), unless that entry is a fallback.
    const byEntry = judged.source === "permissionSet" && judged.matched !== undefined && judged.entry !== undefined;
    // What is underlined: the words of the entry that decided; for the floor, a built-in ask or a
    // remembered width, the words of the command's own subject; else the part's own default — the
    // program alone, the redirect's operator, a script's whole invocation.
    const byName = classified.kind === "command" && classified.command !== undefined && classified.unmodelled === undefined;
    const underlined =
      judged.matched ??
      (byName && judged.source === "remembered" && judged.entry !== undefined
        ? subjectWordSpans(classified.command!, judged.entry)
        : byName && judged.source === "builtin"
          ? subjectWordSpans(classified.command!, classified.subject)
          : classified.matched);
    // Where an asking part acts, and the widths "for this run" may keep its answer at (§3.8).
    const placeLine = classified.widths[0] ?? classified.subject;
    const placeKind = placeKindOf(placeLine);
    const at = judged.verdict === "asks" && placeKind !== undefined ? where.primary(placeKind, placeLine) : undefined;
    parts.push({
      span: classified.span,
      matched: underlined,
      text: line.slice(classified.span.start, classified.span.end),
      kind: classified.kind,
      subject: byEntry && classified.kind === "command" ? judged.entry! : classified.subject,
      ...(classified.paths.length > 0 && classified.noRequest !== true ? { paths: classified.paths } : {}),
      ...(classified.url !== undefined ? { url: classified.url } : {}),
      // What the function a part is put to is handed about it — the command, parsed.
      ...(judged.verdict === "function" && classified.command !== undefined
        ? {
            command: {
              program: classified.command.program,
              ...(classified.command.subcommand !== undefined ? { subcommand: classified.command.subcommand } : {}),
              args: [...classified.command.args],
              flags: [...classified.command.flags],
            },
          }
        : {}),
      verdict: judged.verdict,
      decidedBy: {
        source: judged.source,
        ...(judged.entry !== undefined ? { entry: judged.entry } : {}),
        ...(judged.verdict === "function" && judged.function !== undefined ? { function: judged.function } : {}),
        ...(judged.place !== undefined ? { place: judged.place } : {}),
        ...(judged.layer !== undefined ? { layer: judged.layer } : {}),
        reason: judged.reason,
      },
      // What could not be read is remembered as such: its own widths were never what judged it (step 3).
      widths: classified.unmodelled !== undefined ? [UNPARSED_SUBJECT] : classified.widths,
      ...(at !== undefined && placeKind !== undefined ? { where: { kind: placeKind, at, widths: placeWidthsOf(placeKind, at, { ...placeOptions, ...(packageOf !== undefined ? { packageOf } : {}) }) } } : {}),
      ...(classified.via !== undefined ? { via: classified.via } : {}),
      ...(runner !== undefined ? { within: runner } : {}),
    });
    commands.push(classified.command);
  }
  // A part written inside another: `rm {}` inside its `find`, `$( … )` inside the command it feeds.
  parts.forEach((part, index) => {
    // What a runner runs is under the runner already, whatever else encloses them both.
    if (part.within !== undefined) return;
    let within: number | undefined;
    parts.forEach((other, at) => {
      if (at === index || other.span.start > part.span.start || other.span.end < part.span.end) return;
      if (other.span.start === part.span.start && other.span.end === part.span.end) return;
      const size = (p: CommandPart): number => p.span.end - p.span.start;
      if (within === undefined || size(parts[within]!) > size(other)) within = at;
    });
    if (within !== undefined) part.within = within;
  });
  // The line started to keep running is one more part, the whole line — after the parts it holds, and
  // added once they know what encloses them, since it encloses them all and judges none of them.
  if (options.background === true) {
    const kept = backgroundPart(started, options, line);
    parts.push(kept.part);
    commands.push(kept.command);
  }

  const payload = (verdict: CommandPartVerdict): CommandApproval => ({
    line,
    dialect,
    parts,
    verdict,
    ...(taken.reason !== undefined ? { unparsed: taken.reason } : {}),
    // What the parts were read through: the dialog draws each row with the values in place.
    ...(taken.variables !== undefined ? { variables: taken.variables } : {}),
    ...(options.permissionSet !== undefined && options.permissionSetSource !== undefined ? { permissionSet: options.permissionSetSource } : {}),
    ...(options.permissionSet !== undefined && options.stack !== undefined ? { stack: approvalStackOf(options.stack, options.grants !== undefined) } : {}),
  });

  // The strictest PART names the line's reason — ranked by verdict, so an asking part explains an
  // escalation before a part a function is about to decide does.
  const unreadReason = taken.reason !== undefined ? `command could not be parsed (${taken.reason})` : "command could not be parsed";
  // A piece of the line nobody could read, with no part of its own: the whole line stands for it, and
  // is answered as any unreadable piece is — by the `unparsed` line, or for this run, or by a person.
  if (taken.unparsed && line.trim().length > 0 && !parts.some((part) => part.kind === "unparsed")) {
    const answer = unreadableAnswerOf(options.permissionSet, options, unreadReason);
    parts.push({
      span: { start: 0, end: line.length },
      matched: [{ start: 0, end: line.length }],
      text: line,
      kind: "unparsed",
      subject: SHELL_SUBJECT,
      verdict: answer?.verdict ?? "asks",
      decidedBy:
        answer !== undefined
          ? { source: answer.source, ...(answer.entry !== undefined ? { entry: answer.entry } : {}), ...(answer.layer !== undefined ? { layer: answer.layer } : {}), reason: answer.reason }
          : { source: "parser", reason: unreadReason },
      widths: [UNPARSED_SUBJECT],
    });
    commands.push(undefined);
  }
  // Every unreadable piece was ALLOWED by a line or an answer naming it as such (`unparsed`): it no
  // longer holds the line to a person.
  const unread = parts.filter((part) => part.kind === "unparsed");
  const unreadSettled = taken.unparsed && unread.length > 0 && unread.every((part) => part.verdict === "allowed");

  let worst: Omit<CommandDecision, "parts"> | undefined;
  let worstVerdict: CommandPartVerdict | undefined;
  parts.forEach((part, index) => {
    if (worstVerdict === undefined || VERDICT_RANK[part.verdict] >= VERDICT_RANK[worstVerdict]) {
      const command = commands[index];
      worstVerdict = part.verdict;
      worst = { action: ACTION_OF[part.verdict], reason: part.decidedBy.reason, ...(command !== undefined ? { command } : {}) };
    }
  });

  if (((taken.unparsed && !unreadSettled) || line.trim().length === 0) && worstVerdict !== "denied" && worstVerdict !== "asks") {
    // DESIGN §10.1: "Unparsable commands default to require_approval." A deny beside the unreadable
    // piece stands; an allow does not — and neither does a function's: a line with a piece nobody
    // could read asks a PERSON, whatever a function would say about the pieces it can see. An empty
    // line has nothing to judge, and still must not allow. A line that was read and holds no request
    // (`$PSVersionTable`, `x=1`, a comment) runs nothing outside the shell: below, it is allowed.
    // An unreadable piece reaches here only still asking; an empty line has nothing to remember.
    const reason = unreadReason;
    if (!parts.some((part) => part.kind === "unparsed")) {
      parts.push({
        span: { start: 0, end: line.length },
        matched: [{ start: 0, end: line.length }],
        text: line,
        kind: "unparsed",
        subject: SHELL_SUBJECT,
        verdict: "asks",
        decidedBy: { source: "parser", reason },
        widths: [],
      });
    }
    return { action: "require_approval", reason, parts: payload("asks") };
  }
  if (worst === undefined) {
    // Every part was no request at all (`cd foo && echo done`): nothing to refuse and nothing to ask.
    return { action: "allow", reason: "nothing on the line is a request", parts: payload("allowed") };
  }
  return { ...worst, parts: payload(worstVerdict ?? VERDICT_OF[worst.action]) };
}

/**
 * Whether the project's policy can ever escalate a call to a human.
 *
 * True wherever a line no set judges answers to a set ({@link JairaPolicy.fallback}) — `security/standard`
 * asks — and what a state's own permission set asks is the state's own, and gated with it. This is what
 * capability gating (DESIGN §8.2) checks a runtime against — a policy that cannot ask needs nothing
 * enforced interactively.
 */
export function policyCanEscalate(policy: JairaPolicy): boolean {
  return policy.fallback !== undefined;
}

/** Pull a command string out of a tool's inputs, if it has one. */
function commandOf(input: Record<string, unknown>): string | undefined {
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Pull a payload out of a tool's inputs, if it carries one. */
function contentOf(input: Record<string, unknown>): string | undefined {
  for (const key of CONTENT_KEYS) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** A size a person can judge at a glance — what the approval prompt says. */
function describeBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export interface CompilePolicyOptions {
  /** Chooses the parser dialect: a WSL project's commands are POSIX. */
  execEnv?: ExecEnv;
  /**
   * The task's shell, read as each `shell` call is judged (decision 0030, ruling 7): the directory a line
   * starts in when the call names none, and how a word's `~` and `$VARS` expand there.
   */
  shellAt?: () => { cwd?: string | undefined; expand?: ((word: string) => string) | undefined; env?: EnvironmentLookup | undefined } | undefined;
  /**
   * The environment an agent's OWN shell tool (Claude's `Bash`, `PowerShell`) runs its lines in — what a
   * variable such a line does not set is read through (decision 0007 §4, amended 2026-11-25). Absent, or
   * `undefined` where the values are not this engine's (WSL, a container), only the line's own are.
   */
  agentEnv?: () => EnvironmentLookup | undefined;
  /**
   * The configured MCP servers — what each server's tools COUNT AS among the standard tools (decision
   * 0019, ruling 5), so a mapped tool's call is judged by that tool's line too. Absent ⇒ none is mapped.
   */
  mcp?: JairaMcpConfig;
  /** Called for every decision — the audit trail (DESIGN §10.2's `command_log`). */
  onDecision?: (entry: PolicyAuditEntry) => void;
  /**
   * Told every call a RULE refused without anybody being asked — the permission set, the built-in
   * rules, the scopes, an earlier answer, the profile — so a host can draw that refusal as a step under
   * the call, the way a function's verdict and the person's answer are drawn (decision 0007, amended
   * 2026-10-24). Calls a function or a person refused are not told: their own steps already say so.
   */
  onRefused?: (refused: RuleRefusal) => void;
  /**
   * WHERE anything under this policy may act — the executor's scope floor.
   *
   * Compiled onto `ExecPolicy.scopeOf`, which the engine hands to every gate and every wrapped tool,
   * and which a host tool may read off `ctx.policy` to filter what it ENUMERATES. Absent ⇒ no
   * narrowing at all, and a project that has authored no scopes pays nothing.
   */
  scopes?: readonly Scope[];
  /** What a relative glob and a relative call path resolve against — and a relative PLACE on a line, and `$PROJECT`. */
  workspaceRoot?: string;
  /**
   * The task's worktree, when it runs in one — what `$WORKTREE` on a line names (decision 0023 §3.2).
   * Absent, `$WORKTREE` is {@link workspaceRoot}.
   */
  worktree?: string;
  /**
   * Above this many bytes, a tool that produces content asks instead of just keeping it.
   *
   * `config.artifacts.askAboveBytes`, threaded here because the decision belongs to the policy even
   * though the number belongs to the artifact configuration — this is the only place that can turn a
   * size into an escalation. `0` turns it off; absent takes the shared default.
   */
  askAboveBytes?: number;
  /**
   * The permission set of the ONE call this policy is compiled for — a conversation turn's, whose modes
   * were picked in the composer or inherited from the state it continues (decision 0007).
   *
   * Its per-tool modes are folded into `baseline.tools`, over the command tools' `smart`. The fold
   * is for a DELEGATED agent, which builds its deny floor — the tools it is never even offered — from
   * `ctx.policy.baseline.tools`, and would otherwise be handed a tool the message had set to `deny`.
   *
   * Only TOOL entries fold. `other` does not: the baseline has no such field, and the gate reads it
   * off the authored block. Command subjects and `script` do not fold either — they are not tools —
   * and are what a shell line's PARTS are judged against (decision 0007 §4, {@link decideCommand}).
   *
   * A run does not pass one: the engine hands each state's own block to the gate at the moment of
   * decision, so a run's policy is the built-ins alone — and the state's command subjects arrive the
   * same way, on the lowered block's `subjects`, read by the narrowing.
   */
  permissionSet?: PermissionSet;
  /**
   * The stack {@link permissionSet} was composed from (decision 0023 §2.6) — a turn's, read through
   * `resolveChatPermissionStack` — so a part's row names the layer that decided it (§2.7) and the
   * approval lists the stack for "Add to". A state's own block carries its own (`PermissionsDecl.stack`).
   */
  stack?: PermissionStackDecl;
  /**
   * Answers remembered about the PARTS of shell lines, for as long as the caller keeps this object —
   * a run. A part that would ask and was allowed at one of its widths no longer asks.
   */
  grants?: CommandGrants;
  /**
   * What the machine knows about the processes and windows a call is about, and its own name — the
   * places a System tool's resources have beside what the call names (decision 0023 §3.1, amended
   * 2026-11-23): a process's program and owner, a window's, the window that has the keyboard, the
   * windows on the screen. Read before the narrowing is asked (`ScopeNarrowing.prepare`), and only
   * where the set judging a call decides by places on a line of a tool that reaches them. Absent, this
   * machine's (`MachineFactsCache`, with no session of its own); `null`, none, and every such place is
   * one nobody could read.
   */
  machine?: MachineFactsSource | null;
}

export interface PolicyAuditEntry {
  tool: string;
  /** The raw command line, when the tool takes one. */
  command?: string;
  /** The parsed command the verdict is about. */
  parsed?: ParsedCommand;
  action: PolicyAction;
  reason: string;
  /** The line as its parts, each with its own verdict — present whenever a command line was judged. */
  parts?: CommandApproval;
  /** Empty when the NARROWING decided (a deny, or a permission set's ask): upstream gives it no session. */
  sessionId: string;
}

/**
 * Compile a JaiRA policy into the `ExecPolicy` the engine enforces.
 *
 * Command-running tools get `smart` mode, so their verdict depends on the parsed
 * command; everything else resolves through the permission set's modes, or upstream's own
 * default (`ask`) where nothing names the tool. The `smart` approver returns
 * `allow`/`deny` directly and escalates to `ask` only for `require_approval`, which is
 * what routes a decision to the human gate.
 */
export function compilePolicy(policy: JairaPolicy, options: CompilePolicyOptions = {}): ExecPolicy {
  // Same rule as the interpreter that will actually run the command (see
  // `interpreterFor`): WSL is POSIX, and native follows the host platform.
  const dialect: CommandDialect = dialectFor(options.execEnv ?? "windows");
  const audit = (entry: PolicyAuditEntry): void => options.onDecision?.(entry);
  // What a line's PLACES are resolved against (decision 0023 §3.2): the workspace a relative place is
  // written from, and where the named places are on this machine.
  // What the machine knows about the processes and windows a call reaches (`machineFacts.ts`).
  const machine = options.machine === null ? undefined : (options.machine ?? new MachineFactsCache());
  const placeOptions: PlaceOptions = {
    ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
    named: namedPlacesOf(options.workspaceRoot, options.worktree),
    ...(machine !== undefined ? { facts: machine.facts } : {}),
  };
  // A shell line's pids are those of where it runs: this machine's natively, and nothing this engine can
  // read inside WSL or a container — there, a pid is about no one program.
  const native = options.execEnv === undefined || options.execEnv === "windows";
  const linePlaceOptions: PlaceOptions = native
    ? placeOptions
    : { ...placeOptions, facts: { machine: () => (typeof options.execEnv === "object" && "wsl" in options.execEnv ? `wsl:${options.execEnv.wsl}` : "container") } };

  const verdictFor = (tool: string, req: PermissionRequest): SmartVerdict => {
    const input = req.input as Record<string, unknown>;
    const line = commandOf(input);
    if (line === undefined) {
      // Not a command, but there may still be something here to judge: a PAYLOAD, whose size is the
      // one question worth asking about content nobody is going to execute. There is no ceiling —
      // a run that genuinely produced a 90 MB report should keep it — so the guard is a question.
      const content = contentOf(input);
      if (content !== undefined) {
        const bytes = Buffer.byteLength(content, "utf8");
        const ceiling = options.askAboveBytes ?? DEFAULT_ASK_ABOVE_BYTES;
        if (ceiling > 0 && bytes > ceiling) {
          const reason = `${describeBytes(bytes)} is larger than this project keeps without asking`;
          audit({ tool, action: "require_approval", reason, sessionId: req.sessionId });
          return "ask";
        }
        audit({ tool, action: "allow", reason: `${describeBytes(bytes)} of content`, sessionId: req.sessionId });
        return "allow";
      }
      // Nothing to judge at all, so escalate rather than assume.
      audit({ tool, action: "require_approval", reason: "no command found in the tool input", sessionId: req.sessionId });
      return "ask";
    }
    // The narrowing below has usually judged this very call already — with the STATE's permission set in
    // hand, which this approver is never given.
    const decision = lineDecisionFor(input, undefined, tool);
    auditLine(tool, line, decision, req.sessionId);
    return decision.action === "allow" ? "allow" : decision.action === "deny" ? "deny" : "ask";
  };

  const auditLine = (tool: string, line: string, decision: CommandDecision, sessionId: string): void =>
    audit({
      tool,
      command: line,
      ...(decision.command !== undefined ? { parsed: decision.command } : {}),
      action: decision.action,
      reason: decision.reason,
      parts: decision.parts,
      sessionId,
    });

  /**
   * One shell line, decided ONCE per call and found again by the call's own input.
   *
   * Upstream hands the state's `permissions` block to `scopeOf` and to nothing else — not to the
   * `smart` approver, not to `approve`. So the narrowing is where a line meets its permission set; the
   * decision is kept against the input object, which upstream passes unchanged to the approver and to
   * the human gate, and both read it back ({@link commandDecisionOf}) instead of judging again
   * without the permission set.
   */
  /** The state's own block first — it is the nearer statement — then the permission set this policy was compiled for. */
  const compiledFor = options.permissionSet !== undefined ? shellPermissionSetOf(options.permissionSet) : undefined;
  /**
   * The map the line is judged against. The state's own block says where its subjects came from, on
   * `subjects` and `source`, in a conversation and in a run. A permission set this policy was compiled for is
   * a message's, which has no file behind it.
   */
  const permissionSetFor = (authored: PermissionsDecl | undefined): { permissionSet: ShellPermissionSet; source: string; stack?: PermissionStackDecl } | undefined => {
    const own = shellPermissionSetOfBlock(authored);
    if (own !== undefined) return { permissionSet: own.permissionSet, source: own.source ?? INLINE_PERMISSION_SET, ...(authored?.stack !== undefined ? { stack: authored.stack } : {}) };
    return compiledFor !== undefined ? { permissionSet: compiledFor, source: INLINE_PERMISSION_SET, ...(options.stack !== undefined ? { stack: options.stack } : {}) } : undefined;
  };

  /** `tool` is the name the gate was asked about: an agent's `PowerShell` reads its line as PowerShell wherever the project runs. */
  const lineDecisionFor = (input: Record<string, unknown>, authored: PermissionsDecl | undefined, tool: string): CommandDecision => {
    const known = LINE_DECISIONS.get(input);
    if (known !== undefined) return known;
    // A line starts where the task's shell stands (decision 0030), unless the call names its own `cwd`;
    // its `~` and `$VARS` expand as that shell would expand them.
    const shell = tool === SHELL_SUBJECT || tool.endsWith("__shell") ? options.shellAt?.() : undefined;
    const own = typeof input["cwd"] === "string" && input["cwd"] !== "" ? input["cwd"] : undefined;
    const cwd = own ?? shell?.cwd;
    // What a variable the line does not set is read through: for an agent's own shell tool (its dialect
    // noted against the call), the environment the agent was started with; else the task shell's.
    const env = callDialectOf(input, tool) !== undefined ? options.agentEnv?.() : shell?.env;
    const decideUnder = (judging: { permissionSet: ShellPermissionSet; source: string; stack?: PermissionStackDecl } | undefined): CommandDecision =>
      decideCommand(policy, commandOf(input) ?? "", callDialectOf(input, tool) ?? dialect, {
        ...(shell?.expand !== undefined ? { expand: shell.expand } : {}),
        ...(env !== undefined ? { env } : {}),
        permissionSet: judging?.permissionSet,
        permissionSetSource: judging?.source,
        stack: judging?.stack,
        grants: options.grants,
        packages: filePackages,
        scopeOf: partScopeFor(options.scopes, options.workspaceRoot),
        // `$AGENT_WORKSPACE` is the calling agent's folder.
        places: placesForCall(linePlaceOptions, input),
        ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        // Started to keep running: our `shell`, or Claude's own `Bash`, whose raw input reaches here as
        // the agent wrote it (`translatedGate` asks about it as `shell`) — one line for both (decision 0032).
        ...(input["run_in_background"] === true ? { background: true } : {}),
      });
    const decision = decideUnder(permissionSetFor(authored));
    LINE_DECISIONS.set(input, decision);
    return decision;
  };

  /**
   * The line's verdict, as a NARROWING — the one seam that runs whatever mode the tool resolved to.
   *
   * A `deny` always narrows, so the destructive floor and a permission set's deny stand above a
   * state that authored `shell: "allow"` and above an "allow for this run" remembered against the
   * whole tool. An `ask` narrows when a permission set is judging the line: a remembered `shell: allow` would
   * otherwise wave through the next line's asking parts, and it is parts that are remembered, never
   * lines. Without a permission set an ask is left to the `smart` approver, as it always was.
   */
  /**
   * The lines a FUNCTION answers for, by subject: the state's own block's (every lowered map carries
   * `functions`), else the permission set this policy was compiled for.
   */
  const functionsFor = (block: PermissionsDecl | undefined): Record<string, string> | undefined =>
    block?.functions ?? (options.permissionSet !== undefined ? permissionSetFunctions(options.permissionSet) : undefined);

  /**
   * A direct call to a tool whose line has PLACES, brought down to its own answer (`placeNarrowingFor`)
   * — off the state's own block, else the permission set this policy was compiled for, lowered.
   */
  const placeNarrowing = placeNarrowingFor({
    ...placeOptions,
    ...(options.permissionSet !== undefined ? { fallback: permissionsOfPermissionSet(options.permissionSet, undefined, options.stack) } : {}),
    ...(options.grants !== undefined ? { grants: options.grants } : {}),
    ...(options.workspaceRoot !== undefined ? { packages: filePackages } : {}),
  });

  /**
   * A call to a tool of an MCP server, judged by NAME against the permission set the line would be: the
   * state's own block when it is a lowered map, else the one this policy was compiled for. The decision
   * is kept against the call's input like a shell line's, so the approver lets an allowed call through,
   * refuses a denied one, runs a function a line names, and puts the rest to a person as one part whose
   * widths are the tool and its server — see {@link decideMcpCall}.
   */
  const mcpNarrowing = (tool: string, input: unknown, block: PermissionsDecl | undefined): PermissionMode | undefined => {
    const judging = isLoweredPermissionSet(block)
      ? { permissionSet: permissionSetOfEnvironment([], block), source: block?.source ?? INLINE_PERMISSION_SET, stack: block?.stack }
      : options.permissionSet !== undefined
        ? { permissionSet: options.permissionSet, source: INLINE_PERMISSION_SET, stack: options.stack }
        : undefined;
    if (judging === undefined) return undefined;
    const mapping = mcpMappingOf(options.mcp, tool);
    const decision =
      mapping !== undefined
        ? decideMappedMcpCall(tool, input, mapping, judging.permissionSet, judging.source, {
            shell: (call) => lineDecisionFor(call, block, SHELL_SUBJECT).parts,
            scope: (name, call) => places?.({ name } as never, call as never, block as never),
            ...(options.grants !== undefined ? { grants: options.grants } : {}),
          })
        : decideMcpCall(tool, judging.permissionSet, judging.source, options.grants, judging.stack);
    if (decision === undefined) return undefined;
    if (input !== null && typeof input === "object") LINE_DECISIONS.set(input, decision);
    audit({ tool, action: decision.action, reason: decision.reason, parts: decision.parts, sessionId: "" });
    if (decision.action === "deny") return "deny";
    return decision.parts.verdict === "allowed" ? undefined : "ask";
  };

  /**
   * The set a direct call's FLAG lines are read off: the state's own block when it is a lowered map, else
   * the permission set this policy was compiled for — as an MCP call's lines are.
   */
  const flagJudgingOf = (block: PermissionsDecl | undefined): { permissionSet: PermissionSet; source: string; stack?: PermissionStackDecl } | undefined =>
    isLoweredPermissionSet(block)
      ? { permissionSet: permissionSetOfEnvironment(undefined, block), source: block?.source ?? INLINE_PERMISSION_SET, ...(block?.stack !== undefined ? { stack: block.stack } : {}) }
      : options.permissionSet !== undefined
        ? { permissionSet: options.permissionSet, source: INLINE_PERMISSION_SET, ...(options.stack !== undefined ? { stack: options.stack } : {}) }
        : undefined;

  /** May a call of `tool` be tightened by a flag line? Read with no call in hand, off the block's keys where there is one. */
  const flagNarrows = (tool: string, block: PermissionsDecl | undefined): boolean => {
    // The shell's flag line is judged with its line, by `decideCommand` (`DecideCommandOptions.background`).
    if (tool === SHELL_SUBJECT || TOOL_SPEC_BY_NAME.get(tool)?.flags === undefined) return false;
    if (isLoweredPermissionSet(block)) return Object.keys(block?.tools ?? {}).some((key) => parseToolFlagSubject(key)?.tool === tool);
    return options.permissionSet !== undefined && hasFlagLines(options.permissionSet, tool);
  };

  /**
   * A direct call to a tool refined by FLAG lines, brought down to the answer of the line its arguments
   * match ({@link flagLineAnswer}) — the gate was handed the loosest of them all (`gateToolModes`), so
   * this only tightens. `null` for a tool no flag line refines, which the rest of the narrowing judges.
   *
   * An answer that asks is put to the person as one part whose widths are the call's own flags spelled
   * as lines ({@link flagCallDecision}) — so "for this run" and "add to the permission set" keep
   * `list_processes --scope=user`, not the whole tool — and is settled first by an answer this run kept.
   * A function is noted for the approver, as a line's or a place's is; a refusal names its line.
   */
  const flagNarrowing = (name: string, input: unknown, block: PermissionsDecl | undefined): PermissionMode | undefined | null => {
    if (!flagNarrows(name, block)) return null;
    const judging = flagJudgingOf(block);
    if (judging === undefined || !hasFlagLines(judging.permissionSet, name)) return null;
    const answer = flagLineAnswer(name, input, judging.permissionSet, placesForCall(placeOptions, input));
    if (answer === undefined) return null;
    if (isFunctionMode(answer.mode)) {
      noteFunctionCall(input, {
        tool: name,
        subject: answer.subject,
        function: answer.mode.function,
        ...(answer.place !== undefined ? { place: answer.place } : {}),
        permissionSet: judging.source,
      });
      return "ask";
    }
    if (answer.mode === "ask") {
      const decided = flagCallDecision(name, input, answer, judging.source, judging.stack, options.grants);
      setCommandDecision(input, decided);
      audit({ tool: name, action: decided.action, reason: decided.reason, parts: decided.parts, sessionId: "" });
      if (decided.action === "deny") return "deny";
      return decided.action === "allow" ? undefined : "ask";
    }
    if (answer.mode === "deny") {
      notePlaceAnswer(input, { subject: answer.subject, mode: answer.mode, ...(answer.place !== undefined ? { place: answer.place } : {}) });
      return "deny";
    }
    return undefined;
  };

  const judgeCall: ScopeNarrowing = (tool, input, authored) => {
    // A list's rows the set asks about, put to the person once (`askToShow`).
    const reveal = input !== null && typeof input === "object" ? REVEALS.get(input) : undefined;
    if (reveal !== undefined) {
      setCommandDecision(input, revealDecision(reveal));
      return "ask";
    }
    // A block pinned under the old place tables refuses every call that names a place (see
    // {@link staleScopesDecision}) — before anything else reads it, since nothing else reads `scopes`.
    const stale = staleScopesDecision(tool.name, input, authored as PermissionsDecl | undefined);
    if (stale !== undefined) {
      if (input !== null && typeof input === "object") LINE_DECISIONS.set(input, stale);
      audit({ tool: tool.name, action: "deny", reason: stale.reason, parts: stale.parts, sessionId: "" });
      return "deny";
    }
    // The MCP tool the call really is, when the gate was asked about it by its server's name.
    const mcpTool = mcpCallOf(input) ?? tool.name;
    if (parseMcpSubject(mcpTool)?.tool !== undefined) return mcpNarrowing(mcpTool, input, authored as PermissionsDecl | undefined);
    const name = COMMAND_TOOLS.has(tool.name) ? tool.name : (standardOfAnyNative(tool.name) ?? tool.name);
    const args = (input ?? {}) as Record<string, unknown>;
    const block = authored as PermissionsDecl | undefined;
    const line = COMMAND_TOOLS.has(name) ? commandOf(args) : undefined;
    if (line === undefined) {
      // Not a shell line. A tool whose line has PLACES is brought down to this call's own answer — the
      // gate was handed the line's loosest (decision 0023 §3.10) — and a place, or the line's `**`, that
      // names a function is noted for the approver there (`placeNarrowingFor`).
      // A tool whose line is refined by FLAG lines (decision 0032, ruling 1a) is brought down to the line
      // its arguments match — its places read there too — before any place of its bare line is.
      const flagged = flagNarrowing(name, input, block);
      if (flagged !== null) return flagged;
      const placed = placeNarrowing(tool, input, authored);
      if (placed !== undefined) return placed;
      // A tool whose line names a FUNCTION is decided by it, per call. The gate
      // was told `ask` for it; which function, and for which line, is kept against the call's input,
      // where the approver finds it before anybody is asked (`withPermissionFunctions`).
      const functions = functionsFor(block);
      if (functions !== undefined && input !== null && typeof input === "object") {
        const held = block?.tools !== undefined && Object.hasOwn(block.tools, name) && !isPermissionSetMarkKey(name);
        const subject = Object.hasOwn(functions, name) ? name : !held && Object.hasOwn(functions, OTHER_SUBJECT) ? OTHER_SUBJECT : undefined;
        if (subject !== undefined) {
          FUNCTION_CALLS.set(input, { tool: name, subject, function: functions[subject]!, ...(block?.source !== undefined ? { permissionSet: block.source } : {}) });
        }
      }
      return undefined;
    }
    const decision = lineDecisionFor(args, block, tool.name);
    const judged = permissionSetFor(block) !== undefined;
    // A line a permission set judges is written down HERE, whatever it came to: the gate asks the approver
    // for a permission set's shell, not the `smart` rule, so nothing after this sees an allowed line again.
    if (judged || decision.action === "deny") auditLine(name, line, decision, "");
    if (decision.action === "allow" || (decision.action === "require_approval" && !judged)) return undefined;
    return decision.action === "deny" ? "deny" : "ask";
  };
  // What may be tightened, read with no call in hand: a shell line, an MCP tool, any tool under a block
  // pinned to the old place tables — and a tool whose line has places. A tool whose line names a
  // function is `ask` at the gate already.
  /**
   * Reads what the machine knows about the processes and windows a call names (decision 0023 §3.1, amended 2026-11-23)
   * before the narrowing reads them — a process tool's `pid`, a shell line's `kill 4242`, a screenshot's
   * `window_id` — where reading one is slow (Windows' `tasklist`, a listing of the desktop's windows),
   * and only where the set judging the call has program places on the line of a tool that reads them:
   * every other call, and every other set, pays nothing.
   */
  const preparePrograms = async (tool: { name: string; readOnly?: boolean }, input: FunctionInputs, authored: Parameters<ScopeNarrowing>[2]): Promise<void> => {
    if (machine === undefined || !machinePlacesIn(authored as PermissionsDecl | undefined, options.permissionSet)) return;
    const reading = readingOf(tool.name, input, dialect, native);
    if (reading !== undefined) await machine.read(reading);
  };

  const commandNarrowing: ScopeNarrowing = Object.assign(judgeCall, {
    narrows: (tool: { name: string; readOnly?: boolean }, authored?: Parameters<ScopeNarrowing>[2]) =>
      COMMAND_TOOLS.has(tool.name) ||
      parseMcpSubject(tool.name)?.tool !== undefined ||
      (authored !== undefined && Object.hasOwn(authored, "scopes")) ||
      mayNarrow(placeNarrowing, tool, authored) ||
      flagNarrows(standardOfAnyNative(tool.name) ?? tool.name, authored as PermissionsDecl | undefined),
  });

  const baseline: PermissionBaseline = {
    tools: {
      // Command tools are decided per call by the smart approver. A command line is not a thing a
      // person can meaningfully consent to once — `git status` and `git push --force` arrive through
      // one name — so the argument IS the decision, and that is what earns a baseline mode here.
      //
      // {@link CONTENT_TOOLS} deliberately does NOT get one: producing a file is a thing consent is
      // about, and its size is a reason to ask harder rather than a reason to stop asking.
      ...Object.fromEntries([...COMMAND_TOOLS].map((tool) => [tool, "smart" as PermissionMode])),
      // `gateToolModes`: the shell's entry folds as `ask` whatever it says, because its mode is the
      // answer for "any other command" on a line that is taken apart — not a mode for the tool.
      ...(options.permissionSet !== undefined ? gateToolModes(options.permissionSet) : {}),
    },
  };

  const smart: Record<string, (req: PermissionRequest) => SmartVerdict> = {};
  for (const tool of COMMAND_TOOLS) smart[tool] = (req) => verdictFor(tool, req);
  for (const tool of CONTENT_TOOLS) smart[tool] = (req) => verdictFor(tool, req);

  // The executor's scope floor, as the callback every consumer of a policy already knows how to read.
  // A state's say about where is on its set's lines, and the narrowing below reads it.
  const places = scopeNarrowingFor(options.scopes, options.workspaceRoot, options.execEnv);
  // What, by the call: the line's own judgement. Both gates read this one. (`power` and
  // `install_program` ask where a set's line says so — `security/standard` does — never by a rule here.)
  const narrowing: ScopeNarrowing = Object.assign(
    (tool: { name: string; readOnly?: boolean }, input: FunctionInputs, authored: Parameters<ScopeNarrowing>[2]) => commandNarrowing(tool, input, authored),
    {
      narrows: (tool: { name: string; readOnly?: boolean }, authored?: Parameters<ScopeNarrowing>[2]) => mayNarrow(commandNarrowing, tool, authored),
      prepare: preparePrograms,
    },
  );
  // Where, then what: the floor's answer and the call's own, the stricter kept.
  const scopeOf: ScopeNarrowing = Object.assign(
    (tool: { name: string; readOnly?: boolean }, input: FunctionInputs, authored: Parameters<ScopeNarrowing>[2]) => {
      const where = places?.(tool, input, authored);
      const what = narrowing(tool, input, authored);
      if (where === undefined || what === undefined) return where ?? what;
      return MODE_RANK[where] >= MODE_RANK[what] ? where : what;
    },
    {
      narrows: (tool: { name: string; readOnly?: boolean }, authored?: Parameters<ScopeNarrowing>[2]) => mayNarrow(places, tool, authored) || mayNarrow(narrowing, tool, authored),
      prepare: preparePrograms,
    },
  );
  /**
   * What the agent reads for a refused call: who refused it, from what upstream says of WHICH step did
   * and what the deciders wrote down on the way (`refusals.ts`).
   */
  const refusal: RefusalWords = (refused) => {
    const by = refusedByOfCall(refused);
    if (by.kind === "rule") options.onRefused?.({ tool: refused.tool, input: refused.input, by });
    return refusalWords(by, COMMAND_TOOLS.has(refused.tool) ? SHELL_SUBJECT : (standardOfAnyNative(refused.tool) ?? refused.tool));
  };
  const compiled: ExecPolicy = { baseline, smart, scopeOf, refusal };
  COMMAND_NARROWINGS.set(compiled, narrowing);
  // What a foreground call left running is judged here too (decision 0032, ruling 5) — by the same set a
  // backgrounded line would be. Keyed by `scopeOf`, which a copy of the policy keeps (`withAgentPermissionSet`
  // spreads it with a new baseline).
  RESOURCE_JUDGES.set(scopeOf, (block, tool, resources) => {
    // The state's own block where it is a lowered map, else the set this policy was compiled for.
    const judging = isLoweredPermissionSet(block) ? block : options.permissionSet !== undefined ? permissionsOfPermissionSet(options.permissionSet, undefined, options.stack) : undefined;
    const map = judging?.places !== undefined && Object.hasOwn(judging.places, tool) ? judging.places[tool] : undefined;
    if (judging === undefined || map === undefined || Object.keys(map).length === 0) return undefined;
    const read = permissionSetOfEnvironment(undefined, { places: { [tool]: map }, ...(judging.functions !== undefined ? { functions: judging.functions } : {}), ...(judging.other !== undefined ? { other: judging.other } : {}) });
    const line = read.entries[tool];
    if (line === undefined) return undefined;
    const machineName = placeOptions.facts?.machine?.();
    const verdicts = resources.map((resource): ResourceVerdict => {
      const answer = lineResourceAnswer(tool, { mode: line.mode, places: line.places }, read.other, machineName !== undefined && resource.machine === undefined ? { ...resource, machine: [machineName] } : resource, placeOptions);
      return { mode: answer.mode === "allow" ? "allow" : answer.mode === "deny" ? "deny" : "ask", ...(answer.place !== undefined ? { place: answer.place } : {}) };
    });
    const modes = [line.mode, ...Object.values(line.places ?? {})].filter((mode): mode is PermissionSetMode => mode !== undefined);
    return { verdicts, answeredByGate: modes.length > 0 && modes.every((mode) => modeStrictness(mode) >= modeStrictness("ask")) };
  });
  LEFT_RUNNING_JUDGES.set(scopeOf, (authored, left) =>
    leftRunningVerdict(permissionSetFor(authored)?.permissionSet, left, {
      dialect,
      ...(options.grants !== undefined ? { grants: options.grants } : {}),
      ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
      places: linePlaceOptions,
    }),
  );
  return compiled;
}

const MODE_RANK: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };

/**
 * The tools whose program places are read off the machine: the process tools (a pid, and a shell
 * command's pids — `ps -p` is `list_processes`), and the tools that name a window (`ToolSpec.windowArgs`).
 */
const MACHINE_PROGRAM_TOOLS: ReadonlySet<string> = new Set(["list_processes", "stop_process", "read_process", "wait_process", "screenshot", "open_app", "control_input"]);

/** Whether a set has places on such a tool's line, bare or refined by a flag — read off the block where it is a lowered map, else off the set. */
function machinePlacesIn(block: PermissionsDecl | undefined, permissionSet: PermissionSet | undefined): boolean {
  const keys = isLoweredPermissionSet(block) ? Object.keys(block?.places ?? {}) : permissionSet !== undefined ? Object.keys(linePlaces(permissionSet)) : [];
  return keys.some((key) => MACHINE_PROGRAM_TOOLS.has(parseToolFlagSubject(key)?.tool ?? key));
}

/**
 * What a call needs read off the machine before its narrowing is asked: the pids it names (a process
 * tool's, a shell line's `kill 4242`), the windows it names, the window that has the keyboard where it
 * types, and the windows on the screen where it points or pictures a whole display. `undefined` when it
 * reaches nothing on the machine.
 */
export function readingOf(tool: string, input: unknown, dialect: CommandDialect, native = true): MachineReading | undefined {
  const name = standardOfAnyNative(tool) ?? tool;
  const spec = TOOL_SPEC_BY_NAME.get(name);
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const pids = pidsNamedBy(tool, input, dialect, native);
  const windows = idsOf(args, spec?.windowArgs);
  const steps = (spec?.inputArgs ?? []).map((arg) => inputActionsOf(args[arg]));
  const focus = steps.some((s) => s.keys);
  const onScreen = steps.some((s) => s.pointer) || (name === "screenshot" && windows.length === 0);
  if (pids.length === 0 && windows.length === 0 && !focus && !onScreen) return undefined;
  return { ...(pids.length > 0 ? { pids } : {}), ...(windows.length > 0 ? { windows } : {}), ...(focus ? { focus } : {}), ...(onScreen ? { onScreen } : {}) };
}

/**
 * The pids one call names: a process tool's (`ToolSpec.pidArgs`), and those a shell line's process
 * commands name (`kill 4242`, `Stop-Process -Id 4242`) — where the line runs on this machine.
 */
export function pidsNamedBy(tool: string, input: unknown, dialect: CommandDialect, native = true): number[] {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (COMMAND_TOOLS.has(tool)) {
    const line = commandOf(args);
    if (line === undefined || !native) return [];
    const spoken = callDialectOf(args, tool) ?? dialect;
    const pids = takeApart(line, spoken).requests.flatMap((request) => classifyRequest(request, spoken)?.processes?.pids ?? []);
    return [...new Set(pids)];
  }
  return idsOf(args, TOOL_SPEC_BY_NAME.get(standardOfAnyNative(tool) ?? tool)?.pidArgs);
}

/** What a call pinned under the old place tables is refused with — the agent reads it, and so does the row. */
export const STALE_SCOPES_REASON =
  "this task was pinned before 2026-11-02, under the old place tables (a state's `permissions.scopes`), which nothing reads any more — so where it may act cannot be known; start the task again to run it under its set's places";

/**
 * FAIL CLOSED for a block pinned under the old place tables (decision 0023 §3.7).
 *
 * A state's `permissions.scopes` moved onto its set's lines as place maps, and the key's reader was
 * deleted. A task PINNED before that still holds a snapshot whose block says `scopes` — and, unread,
 * its table would bound nothing: the state would act anywhere its lines allow, a silent widening of
 * what its author wrote. So such a block is not read for where at all: every call to a tool that takes
 * a place (`placeKindOf`), and every shell line, is refused, saying the task must be started again.
 * Not a reader of the old meaning — the key is only ever a reason to refuse. A call to a tool that
 * names no place (`web_search`, a task tool's list) is not about where, and is judged as before.
 *
 * `undefined` for every block without the key, which is every block lowered since.
 */
export function staleScopesDecision(tool: string, input: unknown, block: PermissionsDecl | undefined): CommandDecision | undefined {
  if (block === undefined || !Object.hasOwn(block, "scopes")) return undefined;
  const name = COMMAND_TOOLS.has(tool) ? SHELL_SUBJECT : (standardOfAnyNative(tool) ?? tool);
  if (name !== SHELL_SUBJECT && placeKindOf(name) === undefined) return undefined;
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = name === SHELL_SUBJECT ? (commandOf(args) ?? tool) : tool;
  const span: TextSpan = { start: 0, end: text.length };
  const part: CommandPart = {
    span,
    matched: [span],
    text,
    kind: name === SHELL_SUBJECT ? "unparsed" : "tool",
    subject: name,
    verdict: "denied",
    decidedBy: { source: "builtin", reason: STALE_SCOPES_REASON },
    widths: [],
  };
  return { action: "deny", reason: STALE_SCOPES_REASON, parts: { line: text, dialect: "posix", parts: [part], verdict: "denied" } };
}

// --- a tool's line refined by its arguments (decision 0032, ruling 1a) -------------------------------

/** What a tool's flag lines answer for one direct call, and which line said it. */
export interface FlagLineAnswer {
  mode: PermissionSetMode;
  /** The line that answered: a flag line (`list_processes --scope=user`), the tool's bare line, or `other`. */
  subject: string;
  /** The place of that line that answered, when one did. */
  place?: string;
}

/** How strict a line can be, for picking between two equally specific ones: the strictest of its own mode and its places. */
const lineStrictness = (entry: { mode?: PermissionSetMode; places?: Record<string, PermissionSetMode> }): number =>
  decisionsOf(entry).reduce((worst, mode) => Math.max(worst, modeStrictness(mode)), -1);

/**
 * What a set says about one direct call to a tool its FLAG lines refine (decision 0032, ruling 1a):
 * every flag line the call's arguments match (`callFlagsOf` — a `scope` left out is its default,
 * `session`), the most specific first — the one naming the most flags — and among equally specific ones
 * the strictest; then the tool's bare line, which covers any call no flag line matches; then `other`.
 * A line's places are read as a direct call's are (`toolPlaceAnswer`): a place none matches passes on
 * to the next line where the line has no `**`.
 *
 * `undefined` when no flag line refines the tool, and the call is judged as it always was.
 */
export function flagLineAnswer(tool: string, input: unknown, permissionSet: PermissionSet, options: PlaceOptions = {}): FlagLineAnswer | undefined {
  const lines = flagLinesOf(permissionSet, tool);
  if (lines.length === 0) return undefined;
  const call = callFlagsOf(tool, input);
  const matching = lines
    .map(([subject, entry], at) => ({ subject, entry, parsed: parseToolFlagSubject(subject)!, at }))
    .filter((line) => flagLineMatches(line.parsed, call))
    .sort((a, b) => b.parsed.flags.length - a.parsed.flags.length || lineStrictness(b.entry) - lineStrictness(a.entry) || a.at - b.at);
  const bare = Object.hasOwn(permissionSet.entries, tool) ? permissionSet.entries[tool] : undefined;
  const chain = [
    ...matching.map((line) => ({ subject: line.subject, mode: line.entry.mode, places: line.entry.places })),
    ...(bare !== undefined && bare.kind === "tool" && bare.unavailable !== true ? [{ subject: tool, mode: bare.mode, places: bare.places }] : []),
  ];
  const walk = (at: number): FlagLineAnswer => {
    const line = chain[at];
    if (line === undefined) return permissionSet.other !== undefined ? { mode: permissionSet.other, subject: OTHER_SUBJECT } : { mode: MODE_WHEN_UNSET, subject: tool };
    if (line.places === undefined || Object.keys(line.places).length === 0) return line.mode !== undefined ? { mode: line.mode, subject: line.subject } : walk(at + 1);
    // A line with no `**` speaks only at its places; elsewhere the next line answers.
    const rest = line.mode === undefined ? walk(at + 1) : undefined;
    const placed = toolPlaceAnswer(tool, { mode: line.mode, places: line.places }, rest?.mode, input, options);
    if (placed === undefined) return line.mode !== undefined ? { mode: line.mode, subject: line.subject } : rest!;
    if (placed.subject === OTHER_SUBJECT && rest !== undefined) return rest;
    return { mode: placed.mode, subject: line.subject, ...(placed.place !== undefined ? { place: placed.place } : {}) };
  };
  return walk(0);
}

/**
 * One direct call a flag line ASKS about, as the one-part decision a shell line's parts are: its line is
 * the call's flags spelled as a line (`list_processes --scope=user`), and its widths those spellings
 * narrowest first, then the bare tool ({@link callFlagWidthsOf}) — what "for this run" keeps and "add to
 * the permission set" writes. An answer this run kept at one of them settles it first.
 */
export function flagCallDecision(tool: string, input: unknown, answer: FlagLineAnswer, source: string, stack?: PermissionStackDecl, grants?: CommandGrants): CommandDecision {
  const widths = callFlagWidthsOf(tool, input);
  const text = widths[0]!;
  const span: TextSpan = { start: 0, end: text.length };
  const remembered = grants?.answerFor(widths);
  const verdict: CommandPartVerdict = remembered === undefined ? "asks" : remembered.decision === "allow" ? "allowed" : "denied";
  const layer = layerOfLine(stack, answer.subject, answer.place);
  const at = answer.place !== undefined ? ` in ${answer.place}` : "";
  const part: CommandPart = {
    span,
    matched: [{ ...span }],
    text,
    kind: "tool",
    subject: text,
    verdict,
    decidedBy:
      remembered !== undefined
        ? { source: "remembered", entry: remembered.width, layer: RUNTIME_LAYER, reason: rememberedReason(remembered) }
        : { source: "permissionSet", entry: answer.subject, ...(answer.place !== undefined ? { place: answer.place } : {}), ...(layer !== undefined ? { layer } : {}), reason: `the permission set's '${answer.subject}'${at} asks` },
    widths,
  };
  return {
    action: verdict === "denied" ? "deny" : verdict === "allowed" ? "allow" : "require_approval",
    reason: part.decidedBy.reason,
    parts: { line: text, dialect: "posix", parts: [part], verdict, permissionSet: source, ...(stack !== undefined ? { stack: approvalStackOf(stack, grants !== undefined) } : {}) },
  };
}

// --- what a foreground call left running (decision 0032, ruling 5) -----------------------------------

/** Whether a session may keep what a foreground call left running. */
export type LeftRunningVerdict = "allow" | "ask" | "deny";

/** What a foreground call left running: the line it ran, and the programs still alive under it (`node`, `cmd` — no `.exe`). */
export interface LeftRunning {
  command: string;
  programs: readonly string[];
}

const VERDICT_WORD: Record<CommandPartVerdict, LeftRunningVerdict> = { allowed: "allow", function: "ask", asks: "ask", denied: "deny" };

/**
 * Whether a session may keep what a foreground call left running (decision 0032, ruling 5): that is an
 * implicit background start, judged by the `shell --run_in_background` lines as a backgrounded line is.
 * For each program left running, a line NAMING it (`shell --run_in_background node`) answers; where none
 * does, the line the call ran answers, as if it had been started in the background
 * (`shell --run_in_background npm run dev`, then … `npm`, then the bare line). The strictest program
 * decides. A line that names a function is `ask`: there is no call to hand it any more. An answer this
 * run kept at one of those lines counts.
 *
 * With no set judging the shell, or no `shell --run_in_background` line in it, the answer is `ask` —
 * the ruled default, as for a backgrounded line.
 */
export function leftRunningVerdict(
  permissionSet: ShellPermissionSet | undefined,
  left: LeftRunning,
  options: { dialect?: CommandDialect; grants?: CommandGrants; root?: string; places?: PlaceOptions } = {},
): LeftRunningVerdict {
  if (permissionSet === undefined) return "ask";
  const judged = decideCommand({}, left.command, options.dialect ?? "posix", {
    permissionSet,
    background: true,
    ...(options.grants !== undefined ? { grants: options.grants } : {}),
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.places !== undefined ? { places: options.places } : {}),
  });
  const byLine = VERDICT_WORD[judged.parts.parts.at(-1)?.verdict ?? "asks"];
  let worst: LeftRunningVerdict = left.programs.length === 0 ? byLine : "allow";
  const rank: Record<LeftRunningVerdict, number> = { allow: 0, ask: 1, deny: 2 };
  for (const program of left.programs) {
    const command = takeApart(program.toLowerCase(), "posix").requests.find((request) => request.kind === "command");
    const named = command?.kind === "command" ? backgroundAnswerOf(permissionSet, command.command) : undefined;
    let verdict = byLine;
    if (named?.specific === true && named.mode !== undefined) {
      verdict = isFunctionMode(named.mode) ? "ask" : VERDICT_WORD[verdictOfMode(named.mode)];
      if (verdict === "ask") {
        const remembered = options.grants?.answerFor(backgroundWidthsOf(command?.kind === "command" ? command.command : undefined));
        if (remembered !== undefined) verdict = remembered.decision;
      }
    }
    if (rank[verdict] > rank[worst]) worst = verdict;
  }
  return worst;
}

/** Each compiled policy's own judge of a call's leftovers, by its `scopeOf` — see `compilePolicy`. */
const LEFT_RUNNING_JUDGES = new WeakMap<object, (authored: PermissionsDecl | undefined, left: LeftRunning) => LeftRunningVerdict>();

/**
 * Whether the session may keep what a foreground `shell` call left running — what the engine wires as
 * `ToolOptions.leftRunning.decide`: `(left, ctx) => decideLeftRunning(ctx?.policy, ctx?.authored, left, ctx?.scope)`.
 *
 * `policy` is the call's compiled policy (`ExecServices.policy`): it knows the permission set a
 * conversation turn was compiled for, the run's remembered answers, the project's dialect and root.
 * `authored` is the operation's own lowered block (`ExecServices.authored`), the nearer statement where
 * there is one — a run's state, a turn's. A policy this module did not compile judges by the block
 * alone; nothing to judge by at all is `ask`.
 *
 * `scope` is the call's dispatch site (`ExecServices.scope`). With it, the block is the one the gate
 * decides the call under: the host's word on the operation NOW (`ExecPolicy.permissionsOf`), else the
 * state's. A conversation is one run, and `authored` is the block its root was entered with: the set the
 * person picks in the composer afterwards reaches the gate only through `permissionsOf`. Read from
 * `authored` alone, a chat that had moved to `full` judged a `Start-Process` dev server by the set it
 * opened with, which had no `shell --run_in_background` line, so the server was stopped as `ask` where
 * the same start through `run_in_background` was allowed.
 */
/** The decision a request to show asked-about rows is put to the person as. */
function revealDecision(reveal: { tool: string; shown: readonly string[]; noun: string }): CommandDecision {
  const named = reveal.shown.slice(0, 8).join(", ") + (reveal.shown.length > 8 ? `, and ${reveal.shown.length - 8} more` : "");
  const reason = `the permission set asks about ${reveal.shown.length} more ${reveal.noun}: ${named}`;
  const span: TextSpan = { start: 0, end: reveal.tool.length };
  const part: CommandPart = {
    span,
    matched: [{ ...span }],
    text: reveal.tool,
    kind: "tool",
    subject: reveal.tool,
    verdict: "asks",
    decidedBy: { source: "permissionSet", entry: reveal.tool, reason },
    widths: [],
  };
  return { action: "require_approval", reason, parts: { line: reveal.tool, dialect: "posix", parts: [part], verdict: "asks" } };
}

export function decideLeftRunning(policy: ExecPolicy | undefined, authored: unknown, left: LeftRunning, scope?: { instanceId: string }): LeftRunningVerdict {
  const block = blockNowOf(policy, authored, scope);
  const judge = policy?.scopeOf !== undefined ? LEFT_RUNNING_JUDGES.get(policy.scopeOf) : undefined;
  if (judge !== undefined) return judge(block, left);
  return leftRunningVerdict(shellPermissionSetOfBlock(block)?.permissionSet, left);
}

/** The stricter of two modes, either of which may be unsaid. */
const strictestMode = (a: PermissionMode | undefined, b: PermissionMode): PermissionMode => (a !== undefined && MODE_RANK[a] > MODE_RANK[b] ? a : b);


/** A call a rule refused, as `CompilePolicyOptions.onRefused` is told it. */
export interface RuleRefusal {
  /** The tool as the gate was asked about it. */
  tool: string;
  /** The call's own input — what the call it is about is found by. */
  input: unknown;
  by: Extract<RefusedBy, { kind: "rule" }>;
}

/**
 * Who refused a call, from which step of the one decision did (`RefusalCause`) and what the deciders
 * wrote down: a line's or an MCP call's decision, kept against its input, names its rule; the approver
 * wrote down who answered it; a mode's `deny` is the permission set — or the person, who denied the
 * tool for longer than one call.
 */
export function refusedByOfCall(refused: RefusedCall): RefusedBy {
  const noted = takeRefusal(refused.input);
  const decided = commandDecisionOf(refused.input);
  switch (refused.cause) {
    case "profile":
      return { kind: "rule", rule: "profile", ...(refused.profile !== undefined ? { profile: refused.profile } : {}) };
    case "mode":
      return { kind: "rule", rule: deniedEarlier(refused.sessionId, refused.tool) ? "earlier answer" : "permission set" };
    case "narrowed": {
      // The line's own judgement refused it; or a line's PLACE did, for a direct call; or — when
      // neither did — the executor's scope floor.
      if (decided?.action === "deny") return refusedByOfDecision(decided);
      const placed = placeAnswerOf(refused.input);
      if (placed !== undefined && placed.mode === "deny") {
        return { kind: "rule", rule: "permission set", reason: placed.place !== undefined ? `'${placed.subject}' in ${placed.place}` : `'${placed.subject}' where this call acts` };
      }
      return { kind: "rule", rule: "scopes" };
    }
    case "smart":
      return decided?.action === "deny" ? refusedByOfDecision(decided) : (noted ?? { kind: "rule", rule: "built-in rules" });
    case "approver":
      return noted ?? { kind: "approver" };
  }
}

/**
 * The rule behind a refused line or MCP call: its denied part's decider. A part a FUNCTION denied is the
 * function's; a part denied by an answer remembered for this run is the person's earlier answer.
 */
export function refusedByOfDecision(decision: CommandDecision): RefusedBy {
  const part = decision.parts.parts.find((p) => p.verdict === "denied");
  const decider = part?.decidedBy;
  if (decider?.source === "function" && decider.function !== undefined) {
    return { kind: "function", function: decider.function, ...(part !== undefined ? { reason: part.text } : {}) };
  }
  const rule = decider?.source === "permissionSet" ? "permission set" : decider?.source === "scope" ? "scopes" : decider?.source === "remembered" ? "earlier answer" : "built-in rules";
  // The part itself is what a permission set's line or an earlier answer denied; a built-in or a scope
  // says why in its own sentence.
  const reason = rule === "permission set" || rule === "earlier answer" ? part?.text : (decider?.reason ?? decision.reason);
  return { kind: "rule", rule, ...(reason !== undefined && reason.length > 0 ? { reason } : {}) };
}

/** What a line's places answered for a direct call, by the call's input — see {@link notePlaceAnswer}. */
const PLACE_ANSWERS = new WeakMap<object, { subject: string; mode: PermissionSetMode; place?: string }>();

/**
 * Keep, against a direct call's input, what a line's PLACES answered for it (`placeNarrowingFor`) — so
 * a refusal can say it was the permission set's line at that place, not the executor's floor.
 */
export function notePlaceAnswer(input: unknown, answer: { subject: string; mode: PermissionSetMode; place?: string }): void {
  if (input !== null && typeof input === "object") PLACE_ANSWERS.set(input, answer);
}

/** What {@link notePlaceAnswer} kept for a call, if anything. */
export function placeAnswerOf(input: unknown): { subject: string; mode: PermissionSetMode; place?: string } | undefined {
  return input !== null && typeof input === "object" ? PLACE_ANSWERS.get(input) : undefined;
}

/** Line decisions by the input object of the call they are about — see `lineDecisionFor`. */
const LINE_DECISIONS = new WeakMap<object, CommandDecision>();
const COMMAND_NARROWINGS = new WeakMap<ExecPolicy, ScopeNarrowing>();

/**
 * What the policy decided about a shell call, found by the call's own input.
 *
 * For whoever is handed the same `PermissionRequest.input` next — the approval hub, which puts the
 * decision's {@link CommandDecision.parts} on the request a person answers.
 */
export function commandDecisionOf(input: unknown): CommandDecision | undefined {
  return input !== null && typeof input === "object" ? LINE_DECISIONS.get(input) : undefined;
}

/**
 * Replace what is kept against a call's input — the decision once the functions its parts named have
 * answered, so the approval hub puts the ANSWERED parts on the request a person sees.
 */
export function setCommandDecision(input: unknown, decision: CommandDecision): void {
  if (input !== null && typeof input === "object") LINE_DECISIONS.set(input, decision);
}

/** A tool call (not a shell line) whose permission set line names a FUNCTION — found by the call's input. */
export interface FunctionCall {
  /** The tool, by its standard name where it has one. */
  tool: string;
  /** The line that answers for it: the tool's own, or `other`. */
  subject: string;
  /** The function's reference. */
  function: string;
  /** Which permission set judged it, when the block says. */
  permissionSet?: string;
  /** The PLACE of the line whose decision names the function, when a place did (decision 0023 §3). */
  place?: string;
}

const FUNCTION_CALLS = new WeakMap<object, FunctionCall>();

/**
 * Keep, against a call's input, the function a line — or one of its places — hands the call to: what
 * the narrowing does for a direct call whose answer is a function, and what the approver reads back
 * ({@link functionCallOf}) before anybody is asked.
 */
export function noteFunctionCall(input: unknown, call: FunctionCall): void {
  if (input !== null && typeof input === "object") FUNCTION_CALLS.set(input, call);
}

/** Why an approval is being asked when a function could not decide — found by the call's input. */
const APPROVAL_REASONS = new WeakMap<object, string>();

/** Leave the person a reason, against the call's input, for the approval hub to put on the request. */
export function noteApprovalReason(input: unknown, reason: string): void {
  if (input !== null && typeof input === "object") APPROVAL_REASONS.set(input, reason);
}

/** The reason {@link noteApprovalReason} left, if any. */
export function approvalReasonOf(input: unknown): string | undefined {
  return input !== null && typeof input === "object" ? APPROVAL_REASONS.get(input) : undefined;
}

/**
 * Let go of everything the narrowing kept against a call's input — its line's decision, its places'
 * answer, the function it was handed to, the reason left for the person — so the call is decided
 * afresh (`rejudgeCall`): what was kept is the old stack's word.
 */
export function forgetCallDecisions(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  LINE_DECISIONS.delete(input);
  PLACE_ANSWERS.delete(input);
  FUNCTION_CALLS.delete(input);
  APPROVAL_REASONS.delete(input);
}

/** The function a call is decided by, kept by the narrowing against the call's own input. */
export function functionCallOf(input: unknown): FunctionCall | undefined {
  return input !== null && typeof input === "object" ? FUNCTION_CALLS.get(input) : undefined;
}

/**
 * The shell half of a compiled policy's narrowing, without its scope table — for a gate that builds
 * its own table narrowing (`gateTools`) and still has to take a line apart.
 */
export function commandNarrowingOf(policy: ExecPolicy | undefined): ScopeNarrowing | undefined {
  return policy !== undefined ? COMMAND_NARROWINGS.get(policy) : undefined;
}

/**
 * One call to a tool of an MCP server, judged by name — the tool's line, then its server's, then
 * `other` ({@link mcpModeOf}) — as a decision of ONE part, so everything a shell line's parts get, it
 * gets: allowed and denied without a person, a function asked first, the rest put to a person with
 * the line that asked, an answer remembered "for this run" at the tool or the whole server, and "add to
 * the permission set" writing the tool's line by default.
 *
 * `undefined` for a name that is no MCP tool, and when the permission set writes nothing that answers
 * — no line, and no `other` — which leaves the call to the gate, as any name nobody declared is.
 */
export function decideMcpCall(tool: string, permissionSet: PermissionSet, source: string, grants?: CommandGrants, stack?: PermissionStackDecl): CommandDecision | undefined {
  const parsed = parseMcpSubject(tool);
  if (parsed?.tool === undefined) return undefined;
  const answer = mcpModeOf(permissionSet, tool);
  if (answer === undefined) return undefined;
  const server = mcpServerSubject(parsed.server);
  const widths = [tool, server];
  const reference = modeFunction(answer.mode);
  const layer = layerOfLine(stack, answer.line);
  let composed: Composed = {
    verdict: verdictOfMode(answer.mode),
    source: "permissionSet",
    entry: answer.line,
    ...(reference !== undefined ? { function: reference } : {}),
    ...(layer !== undefined ? { layer } : {}),
    reason:
      answer.line === OTHER_SUBJECT
        ? `the permission set has no line for '${tool}' or its server, so 'other' answers: ${modeWord(answer.mode)}`
        : reference !== undefined
          ? `the permission set's '${answer.line}' is decided by the function '${reference}'`
          : `the permission set's '${answer.line}' is ${modeWord(answer.mode)}`,
  };
  // Remembered for this run: settles a call that asks, as it settles a shell part — never a denied one,
  // never one a function decides.
  if (composed.verdict === "asks") {
    const remembered = grants?.answerFor(widths);
    if (remembered !== undefined) {
      composed = {
        verdict: remembered.decision === "allow" ? "allowed" : "denied",
        source: "remembered",
        entry: remembered.width,
        layer: RUNTIME_LAYER,
        reason: `'${remembered.width}' was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run`,
      };
    }
  }
  const span: TextSpan = { start: 0, end: tool.length };
  // The words that matched: the whole name for its own line, the server's part of it for the server's.
  const matched: TextSpan[] = answer.line === server ? [{ start: 0, end: server.length }] : [span];
  const part: CommandPart = {
    span,
    matched,
    text: tool,
    kind: "mcp",
    subject: tool,
    verdict: composed.verdict,
    decidedBy: {
      source: composed.source,
      ...(composed.entry !== undefined ? { entry: composed.entry } : {}),
      ...(composed.function !== undefined ? { function: composed.function } : {}),
      ...(composed.layer !== undefined ? { layer: composed.layer } : {}),
      reason: composed.reason,
    },
    widths,
  };
  return {
    action: composed.verdict === "denied" ? "deny" : composed.verdict === "allowed" ? "allow" : "require_approval",
    reason: composed.reason,
    parts: { line: tool, dialect: "posix", parts: [part], verdict: composed.verdict, permissionSet: source, ...(stack !== undefined ? { stack: approvalStackOf(stack, grants !== undefined) } : {}) },
  };
}

/** How a mapped call's standard half is judged: its shell line, its places, the built-in asks, what this run remembers. */
export interface MappedCallJudges {
  /** A shell line, judged part by part — for a tool that counts as `shell`. */
  shell?: (input: Record<string, unknown>) => CommandApproval;
  /** What the scope tables say about the call's place, for a tool that takes one. */
  scope?: (tool: string, input: Record<string, unknown>) => PermissionMode | undefined;
  grants?: CommandGrants;
}

/**
 * One call to a server's tool that COUNTS AS a standard tool (decision 0019, ruling 5), judged twice and
 * the stricter kept: by the tool's own line (or its server's) where the set writes one, and as the
 * standard tool it counts as — that tool's line or `other`, its places under the scope tables, a shell
 * line part by part, the built-in asks. With no line for the tool or its server the standard tool alone
 * answers: a set that allows `screenshot` allows every way to the screen.
 *
 * And JaiRA's own tool is preferred, as it is over an agent's built-in: where the set holds JaiRA's own
 * implementation of what the tool counts as, the server's tool is WITHHELD — refused, saying which of
 * JaiRA's to call — unless that line picks `native`.
 *
 * The approval's line is the tool's name — or, for one that counts as `shell`, the name and the line it
 * runs (`mcp__x__run: npm test`), so the line's parts are drawn where they are.
 */
export function decideMappedMcpCall(tool: string, input: unknown, mapping: McpToolMapping, permissionSet: PermissionSet, source: string, judges: MappedCallJudges = {}): CommandDecision {
  const parsed = parseMcpSubject(tool);
  const server = parsed !== undefined ? mcpServerSubject(parsed.server) : tool;
  const entry = (name: string) => (Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined);
  const call = mappedCallOf(mapping, input);
  const head: TextSpan = { start: 0, end: tool.length };
  const decided = (parts: CommandPart[], line: string): CommandDecision => {
    const verdict = parts.reduce<CommandPartVerdict>((worst, part) => (VERDICT_RANK[part.verdict] > VERDICT_RANK[worst] ? part.verdict : worst), "allowed");
    const deciding = parts.find((part) => part.verdict === verdict) ?? parts[0]!;
    return {
      action: verdict === "denied" ? "deny" : verdict === "allowed" ? "allow" : "require_approval",
      reason: deciding.decidedBy.reason,
      parts: { line, dialect: "posix", parts, verdict, permissionSet: source },
    };
  };
  const part = (verdict: CommandPartVerdict, subject: string, kind: CommandPart["kind"], decidedBy: CommandPart["decidedBy"], widths: string[], extra: Partial<CommandPart> = {}): CommandPart => ({
    span: head,
    matched: [head],
    text: tool,
    kind,
    subject,
    verdict,
    decidedBy,
    widths,
    ...extra,
  });

  // Withheld: the set holds JaiRA's own of what this tool counts as.
  const ours = mappedToolsOf(mapping);
  if (ours.every((name) => entry(name)?.kind === "tool" && entry(name)!.implementation !== "native" && isServedTool(name))) {
    const which = ours.join(" and ");
    return decided(
      [part("denied", tool, "mcp", { source: "permissionSet", entry: ours[0]!, reason: `'${tool}' counts as ${mapping.as}, and this permission set uses JaiRA's own ${which} — call that instead; the server's is withheld while it does` }, [tool, server])],
      tool,
    );
  }

  // The tool's own line, or its server's, where the set writes one — never `other`.
  const parts: CommandPart[] = [];
  const own = mcpModeOf(permissionSet, tool);
  if (own !== undefined && own.line !== OTHER_SUBJECT) {
    const reference = modeFunction(own.mode);
    let composed: Composed = {
      verdict: verdictOfMode(own.mode),
      source: "permissionSet",
      entry: own.line,
      ...(reference !== undefined ? { function: reference } : {}),
      reason: reference !== undefined ? `the permission set's '${own.line}' is decided by the function '${reference}'` : `the permission set's '${own.line}' is ${modeWord(own.mode)}`,
    };
    if (composed.verdict === "asks") {
      const remembered = judges.grants?.answerFor([tool, server]);
      if (remembered !== undefined) composed = { verdict: remembered.decision === "allow" ? "allowed" : "denied", source: "remembered", entry: remembered.width, reason: `'${remembered.width}' was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run` };
    }
    parts.push(
      part(composed.verdict, tool, "mcp", { source: composed.source, ...(composed.entry !== undefined ? { entry: composed.entry } : {}), ...(composed.function !== undefined ? { function: composed.function } : {}), reason: composed.reason }, [tool, server], {
        matched: own.line === server ? [{ start: 0, end: server.length }] : [head],
      }),
    );
  }

  // As the standard tool: a shell line part by part, the parts moved past the tool's name.
  if (call.tool === SHELL_SUBJECT && judges.shell !== undefined && typeof call.input["command"] === "string") {
    const prefix = `${tool}: `;
    const approval = judges.shell(call.input);
    const shift = (span: TextSpan): TextSpan => ({ start: span.start + prefix.length, end: span.end + prefix.length });
    for (const shellPart of approval.parts) parts.push({ ...shellPart, span: shift(shellPart.span), matched: shellPart.matched.map(shift) });
    if (approval.parts.length === 0) parts.push(part(approval.verdict, SHELL_SUBJECT, "unparsed", { source: "parser", reason: approval.unparsed ?? "the line holds no request" }, [SHELL_SUBJECT]));
    return decided(parts, `${prefix}${call.input["command"] as string}`);
  }

  // As any other standard tool: its line, else `other`; its place under the scope tables; the built-in asks.
  const mode = entry(call.tool)?.mode ?? permissionSet.other;
  const reference = mode !== undefined ? modeFunction(mode) : undefined;
  let composed: Composed =
    mode === undefined
      ? { verdict: "asks", source: "default", reason: `'${tool}' counts as ${call.tool}, and the permission set says nothing of it` }
      : {
          verdict: verdictOfMode(mode),
          source: "permissionSet",
          entry: entry(call.tool)?.mode !== undefined ? call.tool : OTHER_SUBJECT,
          ...(reference !== undefined ? { function: reference } : {}),
          reason: `'${tool}' counts as ${call.tool}: ${reference !== undefined ? `decided by the function '${reference}'` : modeWord(mode)}`,
        };
  const where = judges.scope?.(call.tool, call.input);
  if (where === "deny" && composed.verdict !== "denied") composed = { verdict: "denied", source: "scope", reason: `'${tool}' counts as ${call.tool}, and the scope tables refuse where it would act` };
  else if (where === "ask" && VERDICT_RANK[composed.verdict] < VERDICT_RANK.asks) composed = { verdict: "asks", source: "scope", reason: `'${tool}' counts as ${call.tool}, and the scope tables ask where it would act` };
  if (composed.verdict === "asks") {
    const remembered = judges.grants?.answerFor([call.tool]);
    if (remembered !== undefined) composed = { verdict: remembered.decision === "allow" ? "allowed" : "denied", source: "remembered", entry: remembered.width, reason: `'${remembered.width}' was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run` };
  }
  const spec = TOOL_SPEC_BY_NAME.get(call.tool);
  const paths = (spec?.pathArgs ?? []).flatMap((arg) => (typeof call.input[arg] === "string" ? [call.input[arg] as string] : []));
  const url = (spec?.urlArgs ?? []).map((arg) => call.input[arg]).find((value): value is string => typeof value === "string");
  parts.push(
    part(composed.verdict, call.tool, "tool", { source: composed.source, ...(composed.entry !== undefined ? { entry: composed.entry } : {}), ...(composed.function !== undefined ? { function: composed.function } : {}), reason: composed.reason }, [call.tool], {
      ...(paths.length > 0 ? { paths } : {}),
      ...(url !== undefined ? { url } : {}),
    }),
  );
  return decided(parts, tool);
}

/** A human-readable line for an approval prompt. */
export function describeDecision(decision: CommandDecision): string {
  const what = decision.command !== undefined ? describeCommand(decision.command) : "an unparsable command";
  return `${what} — ${decision.reason}`;
}

// --- would a permission set let this call through? -------------------------------------------------

/**
 * Whether `permissionSet` lets a call run with nobody asked — `true` only for `allow`, so a line that
 * asks, a function it is put to, and a refusal are all `false`. `undefined` for a call no map holds at
 * all: an agent's own bookkeeping (`TodoWrite`, `ToolSearch`), which runs under any of them.
 *
 * The call is judged as the gate would judge it: a standard tool by its line, an agent's built-in as
 * the standard tool it is (`Read` is `read_file`; `Task` and `Agent` have none and are `other`), a
 * tool of an MCP server by its server's lines, and a shell line taken apart and every part judged
 * with the project's built-ins (`decideCommand`) — a package script by the line it runs, where `where`
 * says which directory the call ran in and how to read a `package.json`. What the work summary calls a CHANGE is a call
 * `read-only` does not allow (`workSummary.ts`).
 */
export function allowsCall(
  policy: JairaPolicy,
  permissionSet: PermissionSet,
  name: string,
  args: unknown,
  dialect: CommandDialect,
  where: { root?: string | undefined; packages?: PackageReader | undefined; mcp?: JairaMcpConfig | undefined } = {},
): boolean | undefined {
  const places: PlaceOptions = { ...(where.root !== undefined ? { root: where.root } : {}), named: namedPlacesOf(where.root) };
  const mcp = parseMcpSubject(name);
  if (mcp !== undefined && !RESERVED_MCP_SERVERS.includes(mcp.server)) {
    const mapping = mcpMappingOf(where.mcp, name);
    if (mapping === undefined) return mcpModeOf(permissionSet, name)?.mode === "allow";
    return decideMappedMcpCall(name, args, mapping, permissionSet, INLINE_PERMISSION_SET, {
      shell: (call) =>
        decideCommand(policy, typeof call["command"] === "string" ? call["command"] : "", dialect, {
          permissionSet: judgingSetOf(permissionSet),
          root: where.root,
          places,
          packages: where.packages,
          ...(call["run_in_background"] === true ? { background: true } : {}),
        }).parts,
    }).action === "allow";
  }
  const bare = mcp?.tool ?? name;
  const standard = TOOL_SPEC_BY_NAME.has(bare) ? bare : declaredNative(bare);
  if (standard === undefined) return undefined;
  const own = (subject: string): PermissionSetMode | undefined => (Object.hasOwn(permissionSet.entries, subject) ? permissionSet.entries[subject]!.mode : undefined);
  if (standard === null) return (permissionSet.other ?? "ask") === "allow";
  if (standard !== SHELL_SUBJECT) {
    // A line with places answers at the call's place (decision 0023 §3.4); a native's `file_path` is its place.
    const entry = Object.hasOwn(permissionSet.entries, standard) ? permissionSet.entries[standard] : undefined;
    const input = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    // A tool refined by flag lines answers at the line its arguments match (decision 0032, ruling 1a).
    const flagged = flagLineAnswer(standard, input, permissionSet, places);
    if (flagged !== undefined) return flagged.mode === "allow";
    const placed = entry !== undefined ? toolPlaceAnswer(standard, entry, permissionSet.other, typeof input["file_path"] === "string" && input["path"] === undefined ? { ...input, path: input["file_path"] } : input, places) : undefined;
    return (placed?.mode ?? own(standard) ?? permissionSet.other ?? "ask") === "allow";
  }
  const line = lineOfCall(args);
  if (line === undefined) return false;
  const judging = judgingSetOf(permissionSet);
  const cwd = args !== null && typeof args === "object" && typeof (args as Record<string, unknown>)["cwd"] === "string" ? ((args as Record<string, unknown>)["cwd"] as string) : undefined;
  // An agent's own shell runs its line in its own language: Claude's `Bash` is POSIX, its `PowerShell` PowerShell.
  // Started to keep running — our `shell`, or Claude's `Bash` — it answers to `shell --run_in_background` too (decision 0032).
  const background = args !== null && typeof args === "object" && (args as Record<string, unknown>)["run_in_background"] === true;
  return decideCommand(policy, line, nativeShellDialect(bare) ?? dialect, { permissionSet: judging, root: where.root, cwd, places, packages: where.packages, ...(background ? { background } : {}) }).action === "allow";
}

/**
 * A set as the shell reads it for a judge that is handed a set whatever it holds (`allowsCall`): every
 * line's own mode and its places, and `other` — so a line the set has no shell line for still answers
 * to the set's `other`, as against the built-ins alone.
 */
function judgingSetOf(permissionSet: PermissionSet): ShellPermissionSet {
  const places = linePlaces(permissionSet);
  return {
    entries: { ...toolModes(permissionSet), ...shellSubjects(permissionSet), ...flagLineModes(permissionSet) },
    ...(Object.keys(places).length > 0 ? { places } : {}),
    ...(permissionSet.other !== undefined ? { other: permissionSet.other } : {}),
  };
}

/** The line a shell call runs: its command string, or an argv (codex's `shell`) joined as a shell would read it. */
function lineOfCall(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const input = args as Record<string, unknown>;
  const line = commandOf(input);
  if (line !== undefined) return line;
  const argv = input["command"];
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((word): word is string => typeof word === "string")) return undefined;
  return argv.map(shellWord).join(" ");
}
