/**
 * The safety policy (DESIGN §10.1, SPEC §11.2/§11.3).
 *
 * This module decides what a given tool call is allowed to do, and compiles that
 * decision procedure into the `ExecPolicy` the engine and the delegated adapters
 * enforce (`@declarative-ai/permissions`). What a state may do is its PERMISSION_SET (decision
 * 0007); what stands above every permission set is JaiRA's own floor, which a project can turn
 * off and nothing else (`functions.shell.builtins`). There is no project rule list: a
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
 *  3. **`.jaira/**` is denied by path**, because a worktree normally *does* contain
 *     `.jaira/` (§1g item 5) — the deny rule is the real enforcement, not the
 *     directory layout.
 */
import type { ExecPolicy, PermissionBaseline, PermissionMode, PermissionRequest, RefusalWords, RefusedCall, ScopeNarrowing, SmartVerdict } from "@declarative-ai/permissions";
import { DIRECTORY_CHANGERS, describeCommand, nativeShellDialect, powershellParameter, takeApart, type CommandDialect, type ParsedCommand } from "@jaira/shared";
import { callDialectOf } from "./callDialect";
import {
  SHELL_SUBJECT,
  answerOfLines,
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
  type ShellPermissionSet,
} from "./commandParts";
import { dialectFor, type ExecEnv } from "./paths";
import { filePackages, makeRunsOf, scriptRunsOf, shellWord, type PackageReader, type ScriptRun } from "./packageScripts";
import {
  DEFAULT_ASK_ABOVE_BYTES,
  INLINE_PERMISSION_SET,
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
  shellSubjects,
  toolModes,
  placeWidthsOf,
  resolvePlaces,
  SCRIPT_SUBJECT,
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
import { partScopeFor, placeNarrowingFor, scopeNarrowingFor, toolPlaceAnswer } from "./tools";
import { namedPlacesOf } from "./linePlaces";
import { mcpCallOf } from "./mcpServers";
import { deniedEarlier, refusalWords, takeRefusal, type RefusedBy } from "./refusals";

/** What a line comes to — DESIGN §10.1's vocabulary. */
export type PolicyAction = "allow" | "deny" | "require_approval";

/** A matcher over parsed intent (never a regex over the raw string) — how the floor names what it refuses. */
interface FloorMatcher {
  /** Program name, already normalized (`git`, `npm`, `curl`). */
  program?: string;
  /** Subcommand (`push`, `publish`). */
  subcommand?: string;
  /** Any of these flags present is enough. */
  anyFlag?: string[];
}

interface FloorRule {
  match: FloorMatcher;
  reason: string;
}

/**
 * What a project says about JaiRA's own policy: whether the built-in floor stands
 * (`functions.shell.builtins`). Everything else a line is judged by is the permission set.
 *
 * An empty policy is the built-ins on, which is the safe default.
 */
export interface JairaPolicy {
  /** Turn off the SPEC §11.2/§11.3 built-ins (a disposable workspace, and tests). */
  builtins?: boolean;
}

/** The project's policy, read off its configuration. */
export function projectPolicy(config: { functions: { shell: { builtins: boolean } } }): JairaPolicy {
  return config.functions.shell.builtins ? {} : { builtins: false };
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

/** Input keys that carry a filesystem path. */
const PATH_KEYS = ["path", "file", "file_path", "filePath", "target", "directory", "dir"];

// --- SPEC §11.2: destructive git (deny) --------------------------------------

const DESTRUCTIVE: FloorRule[] = [
  { match: { program: "git", subcommand: "push", anyFlag: ["--force", "-f", "--force-with-lease"] }, reason: "force push rewrites published history" },
  { match: { program: "git", subcommand: "push", anyFlag: ["--mirror"] }, reason: "mirror push overwrites every ref" },
  { match: { program: "git", subcommand: "reset", anyFlag: ["--hard"] }, reason: "hard reset discards work" },
  { match: { program: "git", subcommand: "rebase" }, reason: "rebase rewrites history" },
  { match: { program: "git", subcommand: "filter-branch" }, reason: "filter-branch rewrites history" },
  { match: { program: "git", subcommand: "filter-repo" }, reason: "filter-repo rewrites history" },
  { match: { program: "git", subcommand: "gc" }, reason: "gc can drop unreachable objects" },
  { match: { program: "git", subcommand: "prune" }, reason: "prune drops unreachable objects" },
  { match: { program: "git", subcommand: "clean", anyFlag: ["-f", "-fd", "-fdx", "--force"] }, reason: "clean deletes untracked files" },
];

// --- SPEC §11.3: require approval -------------------------------------------

const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "nc", "netcat", "ssh", "scp", "rsync", "ftp", "telnet",
  // PowerShell's, by the cmdlet's own name (`iwr` and Windows PowerShell's `curl` are `invoke-webrequest`).
  "invoke-webrequest", "invoke-restmethod", "start-bitstransfer", "send-mailmessage", "new-pssession", "enter-pssession",
]);
const PUBLISH: Array<[string, string]> = [
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["cargo", "publish"],
  ["gem", "push"],
  ["twine", "upload"],
];
/** PowerShell's publishing and installing cmdlets — the cmdlet is the whole verb. */
const PUBLISH_CMDLETS = new Set(["publish-module", "publish-script", "publish-psresource"]);
const INSTALL_CMDLETS = new Set(["install-module", "install-package", "install-script", "install-psresource", "update-module", "update-script", "update-psresource", "save-module", "save-script"]);
const INSTALLERS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "gem", "cargo", "apt", "apt-get", "brew", "choco", "winget", "scoop"]);
const INSTALL_SUBCOMMANDS = new Set(["install", "add", "i", "ci", "update", "upgrade"]);
/** `Start-Process`'s parameters, for reading them cut short (`-Cred`, `-Verb`). */
const START_PROCESS_PARAMETERS = ["-filepath", "-argumentlist", "-credential", "-verb", "-workingdirectory", "-windowstyle", "-wait", "-passthru", "-nonewwindow", "-loaduserprofile", "-redirectstandardoutput", "-redirectstandarderror", "-redirectstandardinput", "-environment", "-useshellexecute"];
/** `Invoke-Command`'s parameters that run it on another machine. */
const REMOTE_PARAMETERS = ["-computername", "-cn", "-session", "-hostname", "-vmname", "-vmid", "-vmguid", "-containerid", "-connectionuri", "-uri", "-sshconnection"];

/** Whether a command deletes recursively: `rm -r`, PowerShell's `Remove-Item -Recurse` (cut short too), cmd's `rd /s`. */
function deletesRecursively(command: ParsedCommand): boolean {
  if (command.program === "rm") return command.flags.some((f) => /^-[a-z]*[rR]/.test(f));
  if (command.program === "remove-item") return command.flags.some((f) => powershellParameter(f, ["-recurse"]) !== undefined || /^-r$/i.test(f));
  if (["rd", "rmdir", "del", "erase"].includes(command.program)) return commandWords(command).some((w) => /^\/s$/i.test(w));
  return false;
}
const DEPLOY_PROGRAMS = new Set(["kubectl", "helm", "terraform", "vercel", "netlify", "fly", "heroku", "aws", "gcloud", "az", "docker"]);
/** Paths that hold credentials — reading them is an approval, not a free action. */
const SECRET_PATTERNS = [/(^|[\\/])\.env(\.|$)/i, /(^|[\\/])\.ssh([\\/]|$)/i, /(^|[\\/])\.aws([\\/]|$)/i, /(^|[\\/])\.npmrc$/i, /id_rsa/i, /credentials/i, /secrets?\./i];

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

function matches(matcher: FloorMatcher, command: ParsedCommand): boolean {
  if (matcher.program !== undefined && matcher.program !== command.program) return false;
  if (matcher.subcommand !== undefined && matcher.subcommand !== command.subcommand) return false;
  if (matcher.anyFlag !== undefined && !matcher.anyFlag.some((f) => command.flags.includes(f))) return false;
  return true;
}

/** The built-in verdict for one command, or undefined when no built-in applies. */
export function builtinVerdict(command: ParsedCommand): { action: PolicyAction; reason: string } | undefined {
  for (const rule of DESTRUCTIVE) {
    if (matches(rule.match, command)) return { action: "deny", reason: rule.reason };
  }
  // `rm -rf .git`, `Remove-Item -Recurse .git`, `rd /s .git` — the non-git ways to destroy history.
  if (deletesRecursively(command) && commandWords(command).some((a) => /(^|[\\/])\.git([\\/]|$)/.test(a))) {
    return { action: "deny", reason: "removing .git destroys the repository" };
  }

  const ask = (reason: string): { action: PolicyAction; reason: string } => ({ action: "require_approval", reason });

  if (command.program === "git") {
    if (command.subcommand === "push") return ask("pushes publish work");
    if (command.subcommand === "merge") return ask("merges change shared history");
    if (command.subcommand === "config" && command.flags.includes("--global")) return ask("global config affects every repository");
    if (command.subcommand === "remote") return ask("changing remotes redirects where work is published");
  }
  if (NETWORK_PROGRAMS.has(command.program)) {
    // Fetching a script and piping it to a shell is the shape worth naming.
    return ask(`${command.program} accesses the network`);
  }
  if (command.program === "invoke-command" && command.flags.some((f) => powershellParameter(f, REMOTE_PARAMETERS) !== undefined)) {
    return ask("invoke-command runs it on another machine");
  }
  if (PUBLISH.some(([program, sub]) => command.program === program && command.subcommand === sub) || PUBLISH_CMDLETS.has(command.program)) {
    return ask("publishing a package is public and irreversible");
  }
  if ((INSTALLERS.has(command.program) && command.subcommand !== undefined && INSTALL_SUBCOMMANDS.has(command.subcommand)) || INSTALL_CMDLETS.has(command.program)) {
    return ask("installing packages runs third-party code");
  }
  if (command.program === "start-process") {
    const words = command.words ?? [];
    const elevated = words.some((w, i) => {
      if (powershellParameter(w.value, START_PROCESS_PARAMETERS) === "-credential") return true;
      return powershellParameter(w.value, START_PROCESS_PARAMETERS) === "-verb" && /^runas/i.test(words[i + 1]?.value ?? "");
    });
    if (elevated) return ask("start-process starts it as another user");
  }
  if (DEPLOY_PROGRAMS.has(command.program)) return ask(`${command.program} can deploy or change infrastructure`);
  if (commandWords(command).some((a) => SECRET_PATTERNS.some((p) => p.test(a)))) return ask("the command touches a credentials path");
  return undefined;
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
 * answer never reaches over the destructive floor, `.jaira/`, a rule's or a permission set's `deny`, or a
 * line the parser could not read. Writing the entry into a permission set FILE is the other reach ("add to
 * the permission set"), and is not done here.
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
 * branches it pushes; a network program's by its URL; `runner:ssh` by the host.
 */
function partPlacesOf(part: ClassifiedPart, here: string | undefined, runDirs: readonly string[] | undefined, placeOptions: PlaceOptions): PartPlaces & { primary(kind: PlaceKind, line: string): string | undefined } {
  const resolve = (path: string): string => (isAbsolutePath(path) || here === undefined ? path : absolutize(path, here));
  const paths = part.paths.filter((path) => path !== "{}").map(resolve);
  const named = part.command !== undefined && part.kind !== "tool" && part.kind !== "redirect" ? commandWords(part.command).filter(looksLikePath).map(resolve) : [];
  const where = here ?? placeOptions.root;
  const dirs = runDirs !== undefined && runDirs.length > 0 ? [...runDirs] : where !== undefined ? [where] : [];
  const byFile = (line: string): boolean => line === SCRIPT_SUBJECT || (TOOL_SPEC_BY_NAME.has(line) && line !== SHELL_SUBJECT);
  const of = (kind: PlaceKind, line: string): string[] => {
    switch (kind) {
      case "path":
        if (byFile(line)) return paths.length > 0 ? paths : dirs;
        return [...new Set([...dirs, ...paths, ...named])];
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
      default:
        return [];
    }
  };
  return {
    of,
    options: placeOptions,
    // The place the dialog offers widths of: a path the part names before the directory it runs in.
    primary: (kind, line) => (kind === "path" ? (paths[0] ?? named[0] ?? dirs[0]) : of(kind, line)[0]),
  };
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

/**
 * Judge one part. `undefined` when it is no request at all (`cd foo`, `echo hi`).
 *
 * The order, and what each layer may do:
 *
 *  1. `.jaira/` anywhere in the part ⇒ denied. Nothing below is consulted.
 *  2. The BUILT-INS (unless `functions.shell.builtins` is off): the destructive floor (deny), else a
 *     built-in ask, else nothing — `default`, which allows.
 *  3. The PERMISSION_SET's answer for the part's subject ({@link lookUp}: the most specific line, the
 *     most specific of its places that matches where the part acts, a place that matches nothing
 *     falling to a less specific line). It composes with (2) as the STRICTER of the two,
 *     with one exception: an entry that NAMES the program (`git push`, `git`) replaces a built-in ask
 *     or the `default` — naming it is the decision those two stand in for. It never replaces the
 *     floor: the floor stays above every permission set. An entry that names a FUNCTION answers `function`,
 *     which ranks between `allowed` and `asks`: the function is asked unless something stricter
 *     already answered — a built-in ask on a push is still a person's to answer, unless the entry
 *     that names the function names the program too.
 *  4. A part the parser cannot vouch for asks at least — never a function: what it cannot read is
 *     never allowed without a person, whatever the permission set hands it to.
 *  5. An answer REMEMBERED for this run settles a part that asks: `allowed`, or `denied` — at its
 *     place, where it was kept at one. It never lifts `denied`, and never what the parser could not
 *     read, and never a part a function decides.
 *  6. The executor's scope FLOOR's answer for the part's place, by the standard tool the part is.
 *     Strictest again, and after (5): a remembered `rm` does not open a place the floor shut.
 */
function judgePart(policy: JairaPolicy, part: ClassifiedPart, options: DecideCommandOptions, here: string | undefined, where: PartPlaces): Composed | undefined {
  // Every word, and the value written into a flag (`--output=.jaira/x`).
  const words = part.command !== undefined ? [...commandWords(part.command), ...part.command.flags.flatMap((f) => (f.includes("=") ? [f.slice(f.indexOf("=") + 1)] : []))] : [];
  if ([...words, ...part.paths].some(isDeniedPath)) {
    return { verdict: "denied", source: "path", reason: ".jaira/ is engine-owned" };
  }

  // (2) the built-ins
  let fromPolicy: Composed | undefined;
  if (policy.builtins !== false) {
    if (part.command !== undefined) {
      const builtin = builtinVerdict(part.command);
      if (builtin !== undefined) fromPolicy = { verdict: VERDICT_OF[builtin.action], source: "builtin", reason: builtin.reason };
      // `shutdown`, `Restart-Computer`, `systemctl reboot`: the power tool, which always asks (decision 0019 §6).
      else if (part.tool === "power") fromPolicy = { verdict: "asks", source: "builtin", reason: "it restarts, shuts down, sleeps or locks the machine" };
    } else if (part.paths.some((p) => SECRET_PATTERNS.some((s) => s.test(p)))) {
      fromPolicy = { verdict: "asks", source: "builtin", reason: "the redirect touches a credentials path" };
    }
  }

  // `cd`, `echo`, `true`: a request only when something above made it one.
  if (part.noRequest === true && (fromPolicy === undefined || fromPolicy.verdict === "allowed")) return undefined;

  let composed: Composed = fromPolicy ?? { verdict: "allowed", source: "default", reason: "no built-in applies" };

  // (3) the permission set
  if (options.permissionSet !== undefined && part.noRequest !== true) {
    const answer = lookUp(options.permissionSet, part, where);
    if (answer.mode !== undefined) {
      const reference = modeFunction(answer.mode);
      const at = answer.place !== undefined ? ` in ${answer.place}` : "";
      const layer = answer.entry !== undefined ? layerOfLine(options.stack, answer.entry, answer.place) : undefined;
      const fromPermissionSet: Composed = {
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
      const builtinAsk = composed.source === "builtin" && composed.verdict === "asks";
      if (answer.specific && (composed.source === "default" || builtinAsk)) composed = fromPermissionSet;
      else if (isStricter(fromPermissionSet.verdict, composed.verdict)) composed = fromPermissionSet;
      else if (fromPermissionSet.verdict === composed.verdict && composed.source === "default") composed = fromPermissionSet;
      // Both ask: the permission set's entry is the one a person can change, and the built-in is why it matters.
      else if (fromPermissionSet.verdict === composed.verdict && builtinAsk) composed = { ...fromPermissionSet, reason: `${fromPermissionSet.reason} — ${composed.reason}` };
    }
  }

  // (4) what the parser cannot vouch for
  if (part.unmodelled !== undefined && composed.verdict !== "denied") {
    composed = { verdict: "asks", source: "parser", reason: part.kind === "unparsed" ? `command could not be parsed (${part.unmodelled})` : part.unmodelled };
  }

  // (5) remembered for this run — at the part's place, where the answer was kept at one. The runtime
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

  // (6) where — the executor's floor
  if (options.scopeOf !== undefined && part.tool !== undefined && composed.verdict !== "denied") {
    const resolved = (path: string): string => (isAbsolutePath(path) || here === undefined ? path : absolutize(path, here));
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
 * Decide a whole command line: take it apart, judge every part, and return the
 * strictest verdict — with the parts, which are what an approval shows.
 *
 * The line runs only if EVERY part may. Any part denied ⇒ the line is refused. Any part asking ⇒
 * one approval, carrying every part, each asking part with the place widths it may be remembered at
 * (`CommandPart.where`).
 */
export function decideCommand(policy: JairaPolicy, line: string, dialect: CommandDialect = "posix", options: DecideCommandOptions = {}): CommandDecision {
  const taken = takeApart(line, dialect);
  const parts: CommandPart[] = [];
  const commands: Array<ParsedCommand | undefined> = [];
  let findRoots: string[] = ["."];
  let here =options.cwd !== undefined ? (isAbsolutePath(options.cwd) || options.root === undefined ? options.cwd : absolutize(options.cwd, options.root)) : options.root;
  // A place is written from the PROJECT, not from the package a script's line runs in.
  const placeOptions: PlaceOptions = options.places ?? (options.root !== undefined ? { root: options.root } : {});
  const packageOf = packageFolderOf(options.packages);
  // Runners whose inside is not looked at: one the gate refused, or one its own command line decided.
  const unlooked: TextSpan[] = [];
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
    const where = partPlacesOf(classified, here, runs?.map((run) => run.dir), placeOptions);
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
        const inner = decideCommand(policy, scriptLine, "posix", { ...options, cwd: run.dir, root: run.dir, places: placeOptions, scriptDepth: (options.scriptDepth ?? 0) + 1 });
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
      here = isAbsolutePath(classified.paths[0]) ? classified.paths[0] : absolutize(classified.paths[0], here);
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
      widths: classified.widths,
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

  const payload = (verdict: CommandPartVerdict): CommandApproval => ({
    line,
    dialect,
    parts,
    verdict,
    ...(taken.reason !== undefined ? { unparsed: taken.reason } : {}),
    ...(options.permissionSet !== undefined && options.permissionSetSource !== undefined ? { permissionSet: options.permissionSetSource } : {}),
    ...(options.permissionSet !== undefined && options.stack !== undefined ? { stack: approvalStackOf(options.stack, options.grants !== undefined) } : {}),
  });

  // The strictest PART names the line's reason — ranked by verdict, so an asking part explains an
  // escalation before a part a function is about to decide does.
  let worst: Omit<CommandDecision, "parts"> | undefined;
  let worstVerdict: CommandPartVerdict | undefined;
  parts.forEach((part, index) => {
    if (worstVerdict === undefined || VERDICT_RANK[part.verdict] >= VERDICT_RANK[worstVerdict]) {
      const command = commands[index];
      worstVerdict = part.verdict;
      worst = { action: ACTION_OF[part.verdict], reason: part.decidedBy.reason, ...(command !== undefined ? { command } : {}) };
    }
  });

  if ((taken.unparsed || line.trim().length === 0) && worstVerdict !== "denied" && worstVerdict !== "asks") {
    // DESIGN §10.1: "Unparsable commands default to require_approval." A deny beside the unreadable
    // piece stands; an allow does not — and neither does a function's: a line with a piece nobody
    // could read asks a PERSON, whatever a function would say about the pieces it can see. An empty
    // line has nothing to judge, and still must not allow. A line that was read and holds no request
    // (`$PSVersionTable`, `x=1`, a comment) runs nothing outside the shell: below, it is allowed.
    const reason = taken.reason !== undefined ? `command could not be parsed (${taken.reason})` : "command could not be parsed";
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
 * True with the built-ins on, because SPEC §11.3's classes are all `require_approval`; with them
 * off nothing the project says asks — what a state's permission set asks is the state's own, and gated
 * with it. This is what capability gating (DESIGN §8.2) checks a runtime against — a policy that
 * cannot ask needs nothing enforced interactively.
 */
export function policyCanEscalate(policy: JairaPolicy): boolean {
  return policy.builtins !== false;
}

/** `.jaira/` is engine-owned: agents are denied it wherever it appears. */
export function isDeniedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(^|\/)\.jaira(\/|$)/.test(normalized);
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

/** Pull a filesystem path out of a tool's inputs, if it has one. */
function pathOf(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export interface CompilePolicyOptions {
  /** Chooses the parser dialect: a WSL project's commands are POSIX. */
  execEnv?: ExecEnv;
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
  const placeOptions: PlaceOptions = {
    ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
    named: namedPlacesOf(options.workspaceRoot, options.worktree),
  };

  const verdictFor = (tool: string, req: PermissionRequest): SmartVerdict => {
    const input = req.input as Record<string, unknown>;

    // A path-taking tool is refused `.jaira/**` outright, whatever else it may do.
    const path = pathOf(input);
    if (path !== undefined && isDeniedPath(path)) {
      audit({ tool, action: "deny", reason: ".jaira/ is engine-owned", sessionId: req.sessionId });
      return "deny";
    }

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
    // hand, which this approver is never given. `.jaira/` is screened inside, part by part.
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
    const cwd = typeof input["cwd"] === "string" && input["cwd"] !== "" ? input["cwd"] : undefined;
    const decideUnder = (judging: { permissionSet: ShellPermissionSet; source: string; stack?: PermissionStackDecl } | undefined): CommandDecision =>
      decideCommand(policy, commandOf(input) ?? "", callDialectOf(input, tool) ?? dialect, {
        permissionSet: judging?.permissionSet,
        permissionSetSource: judging?.source,
        stack: judging?.stack,
        grants: options.grants,
        packages: filePackages,
        scopeOf: partScopeFor(options.scopes, options.workspaceRoot),
        places: placeOptions,
        ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    const decision = decideUnder(permissionSetFor(authored));
    LINE_DECISIONS.set(input, decision);
    return decision;
  };

  /**
   * The line's verdict, as a NARROWING — the one seam that runs whatever mode the tool resolved to.
   *
   * A `deny` always narrows, so the destructive floor, `.jaira/` and a permission set's deny stand above a
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
            builtins: policy.builtins !== false,
            ...(options.grants !== undefined ? { grants: options.grants } : {}),
          })
        : decideMcpCall(tool, judging.permissionSet, judging.source, options.grants, judging.stack);
    if (decision === undefined) return undefined;
    if (input !== null && typeof input === "object") LINE_DECISIONS.set(input, decision);
    audit({ tool, action: decision.action, reason: decision.reason, parts: decision.parts, sessionId: "" });
    if (decision.action === "deny") return "deny";
    return decision.parts.verdict === "allowed" ? undefined : "ask";
  };

  const commandNarrowing: ScopeNarrowing = (tool, input, authored) => {
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
  // What, by the call: the line's own judgement — and a tool that always asks (`power`,
  // `install_software`) asks at least, whatever its line says. Both gates read this one.
  const narrowing: ScopeNarrowing = (tool, input, authored) =>
    policy.builtins !== false && ALWAYS_ASKING_TOOLS.has(tool.name) ? strictestMode(commandNarrowing(tool, input, authored), "ask") : commandNarrowing(tool, input, authored);
  // Where, then what: the floor's answer and the call's own, the stricter kept.
  const scopeOf: ScopeNarrowing = (tool, input, authored) => {
    const where = places?.(tool, input, authored);
    const what = narrowing(tool, input, authored);
    if (where === undefined || what === undefined) return where ?? what;
    return MODE_RANK[where] >= MODE_RANK[what] ? where : what;
  };
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
  return compiled;
}

const MODE_RANK: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };

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

/** The stricter of two modes, either of which may be unsaid. */
const strictestMode = (a: PermissionMode | undefined, b: PermissionMode): PermissionMode => (a !== undefined && MODE_RANK[a] > MODE_RANK[b] ? a : b);

/**
 * The tools a person is always asked about, as a push is: `power` takes the machine away, and
 * `install_software` runs third-party code, which is the install ask the shell's package managers have
 * (decision 0019 §6). The built-ins switch (`functions.shell.builtins`) turns them off with the rest.
 */
export const ALWAYS_ASKING_TOOLS: ReadonlySet<string> = new Set(["power", "install_software"]);

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
    case "smart": {
      const path = pathOf((refused.input ?? {}) as Record<string, unknown>);
      if (path !== undefined && isDeniedPath(path)) return { kind: "rule", rule: "built-in rules", reason: ".jaira/ is engine-owned" };
      return decided?.action === "deny" ? refusedByOfDecision(decided) : (noted ?? { kind: "rule", rule: "built-in rules" });
    }
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
  /** `power` and `install_software` always ask, unless `functions.shell.builtins` is off. */
  builtins?: boolean;
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
  if (judges.builtins === true && ALWAYS_ASKING_TOOLS.has(call.tool) && VERDICT_RANK[composed.verdict] < VERDICT_RANK.asks) {
    composed = { verdict: "asks", source: "builtin", reason: `'${tool}' counts as ${call.tool}, which always asks` };
  }
  const where = judges.scope?.(call.tool, call.input);
  if (where === "deny" && composed.verdict !== "denied") composed = { verdict: "denied", source: "scope", reason: `'${tool}' counts as ${call.tool}, and the scope tables refuse where it would act` };
  else if (where === "ask" && VERDICT_RANK[composed.verdict] < VERDICT_RANK.asks) composed = { verdict: "asks", source: "scope", reason: `'${tool}' counts as ${call.tool}, and the scope tables ask where it would act` };
  if (composed.verdict === "asks") {
    const remembered = judges.grants?.answerFor([call.tool]);
    if (remembered !== undefined && composed.source !== "builtin") composed = { verdict: remembered.decision === "allow" ? "allowed" : "denied", source: "remembered", entry: remembered.width, reason: `'${remembered.width}' was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run` };
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
 * `chat/read-only` does not allow (`workSummary.ts`).
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
      shell: (call) => decideCommand(policy, typeof call["command"] === "string" ? call["command"] : "", dialect, { permissionSet: judgingSetOf(permissionSet), root: where.root, places, packages: where.packages }).parts,
      builtins: policy.builtins !== false,
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
    const placed = entry !== undefined ? toolPlaceAnswer(standard, entry, permissionSet.other, typeof input["file_path"] === "string" && input["path"] === undefined ? { ...input, path: input["file_path"] } : input, places) : undefined;
    return (placed?.mode ?? own(standard) ?? permissionSet.other ?? "ask") === "allow";
  }
  const line = lineOfCall(args);
  if (line === undefined) return false;
  const judging = judgingSetOf(permissionSet);
  const cwd = args !== null && typeof args === "object" && typeof (args as Record<string, unknown>)["cwd"] === "string" ? ((args as Record<string, unknown>)["cwd"] as string) : undefined;
  // An agent's own shell runs its line in its own language: Claude's `Bash` is POSIX, its `PowerShell` PowerShell.
  return decideCommand(policy, line, nativeShellDialect(bare) ?? dialect, { permissionSet: judging, root: where.root, cwd, places, packages: where.packages }).action === "allow";
}

/**
 * A set as the shell reads it for a judge that is handed a set whatever it holds (`allowsCall`): every
 * line's own mode and its places, and `other` — so a line the set has no shell line for still answers
 * to the set's `other`, as against the built-ins alone.
 */
function judgingSetOf(permissionSet: PermissionSet): ShellPermissionSet {
  const places = linePlaces(permissionSet);
  return {
    entries: { ...toolModes(permissionSet), ...shellSubjects(permissionSet) },
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
