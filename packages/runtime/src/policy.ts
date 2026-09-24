/**
 * The safety policy (DESIGN §10.1, SPEC §11.2/§11.3).
 *
 * This module decides what a given tool call is allowed to do, and compiles that
 * decision procedure into the `ExecPolicy` the engine and the delegated adapters
 * enforce (`@declarative-ai/permissions`). What a state may do is its PERMISSION_SET (decision
 * 0007); what stands above every permission set is JaiRA's own floor, which a project can turn
 * off and nothing else (`functions.bash.builtins`). There is no project rule list: a
 * command a project wants answered is a line under the `bash` tool of its permission sets
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
 * (`command.ts`), each part is named as a request for a SUBJECT — a standard tool on a
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
import type { ExecPolicy, PermissionBaseline, PermissionMode, PermissionRequest, ScopeNarrowing, SmartVerdict } from "@declarative-ai/permissions";
import { describeCommand, takeApart, type CommandDialect, type ParsedCommand } from "./command";
import { SHELL_SUBJECT, classifyRequest, lookUp, shellPermissionSetOf, shellPermissionSetOfBlock, subjectWordSpans, type ClassifiedPart, type ShellPermissionSet } from "./commandParts";
import { dialectFor, type ExecEnv } from "./paths";
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
  mcpModeOf,
  mcpServerSubject,
  parseMcpSubject,
  permissionSetOfEnvironment,
  modeFunction,
  modeWord,
  permissionSetFunctions,
  type CommandApproval,
  type CommandPart,
  type CommandPartDecider,
  type CommandPartVerdict,
  type PermissionsDecl,
  type Scope,
  type TextSpan,
  type ToolMode,
  type PermissionSet,
  type PermissionSetMode,
} from "@jaira/shared";
// Which standard tool an agent's built-in IS comes from the executors' own declarations (0007 §3).
import { standardOfAnyNative } from "./agentTools";
import { partScopeFor, scopeNarrowingFor } from "./tools";
import { mcpCallOf } from "./mcpServers";

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
 * (`functions.bash.builtins`). Everything else a line is judged by is the permission set.
 *
 * An empty policy is the built-ins on, which is the safe default.
 */
export interface JairaPolicy {
  /** Turn off the SPEC §11.2/§11.3 built-ins (a disposable workspace, and tests). */
  builtins?: boolean;
}

/** The project's policy, read off its configuration. */
export function projectPolicy(config: { functions: { bash: { builtins: boolean } } }): JairaPolicy {
  return config.functions.bash.builtins ? {} : { builtins: false };
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

const NETWORK_PROGRAMS = new Set(["curl", "wget", "nc", "netcat", "ssh", "scp", "rsync", "ftp", "telnet"]);
const PUBLISH: Array<[string, string]> = [
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["cargo", "publish"],
  ["gem", "push"],
  ["twine", "upload"],
];
const INSTALLERS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "gem", "cargo", "apt", "apt-get", "brew", "choco", "winget"]);
const INSTALL_SUBCOMMANDS = new Set(["install", "add", "i", "ci", "update", "upgrade"]);
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
  // `rm -rf .git` — the non-git way to destroy history.
  if (command.program === "rm" && command.flags.some((f) => /^-[a-z]*[rR]/.test(f)) && commandWords(command).some((a) => /(^|[\\/])\.git([\\/]|$)/.test(a))) {
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
  if (PUBLISH.some(([program, sub]) => command.program === program && command.subcommand === sub)) {
    return ask("publishing a package is public and irreversible");
  }
  if (INSTALLERS.has(command.program) && command.subcommand !== undefined && INSTALL_SUBCOMMANDS.has(command.subcommand)) {
    return ask("installing packages runs third-party code");
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
 */
export class CommandGrants {
  private readonly answers = new Map<string, "allow" | "deny">();

  /** Remember one answer at one width. Widths are normalized the way permission set subjects are. */
  remember(width: string, decision: "allow" | "deny"): void {
    const key = width.trim().replace(/\s+/g, " ").toLowerCase();
    if (key.length > 0) this.answers.set(key, decision);
  }

  /**
   * Remember an approval's answer for the PARTS that asked, each at a chosen width.
   *
   * `widths` names the chosen ones (`["git"]` to widen `git commit` to the program); a part none of
   * them fits is remembered at its narrowest. A width no ASKING part offers is dropped, which is what
   * keeps this from ever storing a line, a part that was already allowed, or one that was denied.
   * Returns what was stored.
   */
  rememberParts(approval: CommandApproval, decision: "allow" | "deny", widths?: readonly string[]): string[] {
    const chosen = Object.keys(entriesToRemember(approval, decision, (part) => part.widths.find((w) => widths?.includes(w) === true) ?? part.widths[0]));
    for (const width of chosen) this.remember(width, decision);
    return chosen;
  }

  /** The narrowest remembered answer among a part's widths. */
  answerFor(widths: readonly string[]): { width: string; decision: "allow" | "deny" } | undefined {
    for (const width of widths) {
      const decision = this.answers.get(width.toLowerCase());
      if (decision !== undefined) return { width, decision };
    }
    return undefined;
  }

  list(): Record<string, "allow" | "deny"> {
    return Object.fromEntries(this.answers);
  }

  clear(): void {
    this.answers.clear();
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
  /** Answers remembered for this run, by part width. */
  grants?: CommandGrants | undefined;
  /**
   * What a scope table says about one part's place, by the STANDARD TOOL the part is — so a path
   * scope written for `write_file` binds `rm` and `>` exactly as it binds the tool.
   */
  scopeOf?: ((tool: string, place: { path?: string; url?: string }) => PermissionMode | undefined) | undefined;
  /** What a relative place resolves against for {@link scopeOf}: the workspace, then the call's own `cwd`, then each `cd` on the line. */
  root?: string | undefined;
  cwd?: string | undefined;
}

/** Programs that move the directory the REST of the line runs in. */
const DIRECTORY_CHANGERS = new Set(["cd", "chdir", "pushd", "sl", "set-location", "push-location"]);

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
}

const isStricter = (a: CommandPartVerdict, b: CommandPartVerdict): boolean => VERDICT_RANK[a] > VERDICT_RANK[b];

/**
 * Judge one part. `undefined` when it is no request at all (`cd foo`, `echo hi`).
 *
 * The order, and what each layer may do:
 *
 *  1. `.jaira/` anywhere in the part ⇒ denied. Nothing below is consulted.
 *  2. The BUILT-INS (unless `functions.bash.builtins` is off): the destructive floor (deny), else a
 *     built-in ask, else nothing — `default`, which allows.
 *  3. The PERMISSION_SET's answer for the part's subject. It composes with (2) as the STRICTER of the two,
 *     with one exception: an entry that NAMES the program (`git push`, `git`) replaces a built-in ask
 *     or the `default` — naming it is the decision those two stand in for. It never replaces the
 *     floor: the floor stays above every permission set. An entry that names a FUNCTION answers `function`,
 *     which ranks between `allowed` and `asks`: the function is asked unless something stricter
 *     already answered — a built-in ask on a push is still a person's to answer, unless the entry
 *     that names the function names the program too.
 *  4. A part the parser cannot vouch for asks at least — never a function: what it cannot read is
 *     never allowed without a person, whatever the permission set hands it to.
 *  5. An answer REMEMBERED for this run settles a part that asks: `allowed`, or `denied`. It never
 *     lifts `denied`, and never what the parser could not read, and never a part a function decides.
 *  6. A SCOPE table's answer for the part's place, by the standard tool the part is. Strictest again,
 *     and after (5): a remembered `rm` does not open a place the table shut.
 */
function judgePart(policy: JairaPolicy, part: ClassifiedPart, options: DecideCommandOptions, here: string | undefined): Composed | undefined {
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
    } else if (part.paths.some((p) => SECRET_PATTERNS.some((s) => s.test(p)))) {
      fromPolicy = { verdict: "asks", source: "builtin", reason: "the redirect touches a credentials path" };
    }
  }

  // `cd`, `echo`, `true`: a request only when something above made it one.
  if (part.noRequest === true && (fromPolicy === undefined || fromPolicy.verdict === "allowed")) return undefined;

  let composed: Composed = fromPolicy ?? { verdict: "allowed", source: "default", reason: "no built-in applies" };

  // (3) the permission set
  if (options.permissionSet !== undefined && part.noRequest !== true) {
    const answer = lookUp(options.permissionSet, part);
    if (answer.mode !== undefined) {
      const reference = modeFunction(answer.mode);
      const fromPermissionSet: Composed = {
        verdict: verdictOfMode(answer.mode),
        source: "permissionSet",
        ...(answer.entry !== undefined ? { entry: answer.entry } : {}),
        ...(reference !== undefined ? { function: reference } : {}),
        reason:
          answer.entry === undefined
            ? `the permission set does not hold '${part.subject}'`
            : reference !== undefined
              ? `the permission set's '${answer.entry}' is decided by the function '${reference}'`
              : `the permission set's '${answer.entry}' is ${modeWord(answer.mode)}`,
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

  // (5) remembered for this run
  if (composed.verdict === "asks" && part.unmodelled === undefined) {
    const remembered = options.grants?.answerFor(part.widths);
    if (remembered !== undefined) {
      composed = {
        verdict: remembered.decision === "allow" ? "allowed" : "denied",
        source: "remembered",
        entry: remembered.width,
        reason: `'${remembered.width}' was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run`,
      };
    }
  }

  // (6) where
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
 * one approval, carrying every part.
 */
export function decideCommand(policy: JairaPolicy, line: string, dialect: CommandDialect = "posix", options: DecideCommandOptions = {}): CommandDecision {
  const taken = takeApart(line, dialect);
  const parts: CommandPart[] = [];
  const commands: Array<ParsedCommand | undefined> = [];
  let findRoots: string[] = ["."];
  let here =options.cwd !== undefined ? (isAbsolutePath(options.cwd) || options.root === undefined ? options.cwd : absolutize(options.cwd, options.root)) : options.root;
  for (const request of taken.requests) {
    const classified = classifyRequest(request, dialect);
    if (classified === undefined) continue;
    // `find docs -exec rm {} +` removes under `docs`: `{}` stands for the places the find walks.
    if (classified.command?.program === "find" && classified.via?.at(-1) !== "find") findRoots = classified.paths.length > 0 ? classified.paths : ["."];
    else if (classified.via?.at(-1) === "find" && classified.paths.includes("{}")) classified.paths = classified.paths.flatMap((p) => (p === "{}" ? findRoots : [p]));
    const judged = judgePart(policy, classified, options, here);
    // `cd infra && rm x` is about `infra/x`: the directory moves for what follows it on the line.
    if (classified.noRequest === true && DIRECTORY_CHANGERS.has(classified.command?.program ?? "") && classified.paths[0] !== undefined && here !== undefined) {
      here = isAbsolutePath(classified.paths[0]) ? classified.paths[0] : absolutize(classified.paths[0], here);
    }
    if (judged === undefined) continue;
    // A command is named by the entry that decided it (`git commit`, or `git`), unless that entry is a fallback.
    const named = judged.source === "permissionSet" && judged.matched !== undefined && judged.entry !== undefined;
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
    parts.push({
      span: classified.span,
      matched: underlined,
      text: line.slice(classified.span.start, classified.span.end),
      kind: classified.kind,
      subject: named && classified.kind === "command" ? judged.entry! : classified.subject,
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
        reason: judged.reason,
      },
      widths: classified.widths,
      ...(classified.via !== undefined ? { via: classified.via } : {}),
    });
    commands.push(classified.command);
  }
  // A part written inside another: `rm {}` inside its `find`, `$( … )` inside the command it feeds.
  parts.forEach((part, index) => {
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

  if ((taken.unparsed || taken.requests.length === 0) && worstVerdict !== "denied" && worstVerdict !== "asks") {
    // DESIGN §10.1: "Unparsable commands default to require_approval." A deny beside the unreadable
    // piece stands; an allow does not — and neither does a function's: a line with a piece nobody
    // could read asks a PERSON, whatever a function would say about the pieces it can see. An empty
    // line has nothing to judge, and still must not allow.
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
  /** Called for every decision — the audit trail (DESIGN §10.2's `command_log`). */
  onDecision?: (entry: PolicyAuditEntry) => void;
  /**
   * WHERE anything under this policy may act — the executor's scope floor.
   *
   * Compiled onto `ExecPolicy.scopeOf`, which the engine hands to every gate and every wrapped tool,
   * and which a host tool may read off `ctx.policy` to filter what it ENUMERATES. Absent ⇒ no
   * narrowing at all, and a project that has authored no scopes pays nothing.
   */
  scopes?: readonly Scope[];
  /** What a relative glob and a relative call path resolve against. */
  workspaceRoot?: string;
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
    const decision = lineDecisionFor(input, undefined);
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
  const permissionSetFor = (authored: PermissionsDecl | undefined): { permissionSet: ShellPermissionSet; source: string } | undefined => {
    const own = shellPermissionSetOfBlock(authored);
    if (own !== undefined) return { permissionSet: own.permissionSet, source: own.source ?? INLINE_PERMISSION_SET };
    return compiledFor !== undefined ? { permissionSet: compiledFor, source: INLINE_PERMISSION_SET } : undefined;
  };

  const lineDecisionFor = (input: Record<string, unknown>, authored: PermissionsDecl | undefined): CommandDecision => {
    const known = LINE_DECISIONS.get(input);
    if (known !== undefined) return known;
    const cwd = typeof input["cwd"] === "string" && input["cwd"] !== "" ? input["cwd"] : undefined;
    const decideUnder = (judging: { permissionSet: ShellPermissionSet; source: string } | undefined): CommandDecision =>
      decideCommand(policy, commandOf(input) ?? "", dialect, {
        permissionSet: judging?.permissionSet,
        permissionSetSource: judging?.source,
        grants: options.grants,
        scopeOf: partScopeFor(authored?.scopes, options.workspaceRoot, options.scopes),
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
   * state that authored `bash: "allow"` and above an "allow for this run" remembered against the
   * whole tool. An `ask` narrows when a permission set is judging the line: a remembered `bash: allow` would
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
   * A call to a tool of an MCP server, judged by NAME against the permission set the line would be: the
   * state's own block when it is a lowered map, else the one this policy was compiled for. The decision
   * is kept against the call's input like a shell line's, so the approver lets an allowed call through,
   * refuses a denied one, runs a function a line names, and puts the rest to a person as one part whose
   * widths are the tool and its server — see {@link decideMcpCall}.
   */
  const mcpNarrowing = (tool: string, input: unknown, block: PermissionsDecl | undefined): PermissionMode | undefined => {
    const judging = isLoweredPermissionSet(block)
      ? { permissionSet: permissionSetOfEnvironment([], block), source: block?.source ?? INLINE_PERMISSION_SET }
      : options.permissionSet !== undefined
        ? { permissionSet: options.permissionSet, source: INLINE_PERMISSION_SET }
        : undefined;
    if (judging === undefined) return undefined;
    const decision = decideMcpCall(tool, judging.permissionSet, judging.source, options.grants);
    if (decision === undefined) return undefined;
    if (input !== null && typeof input === "object") LINE_DECISIONS.set(input, decision);
    audit({ tool, action: decision.action, reason: decision.reason, parts: decision.parts, sessionId: "" });
    if (decision.action === "deny") return "deny";
    return decision.parts.verdict === "allowed" ? undefined : "ask";
  };

  const commandNarrowing: ScopeNarrowing = (tool, input, authored) => {
    // The MCP tool the call really is, when the gate was asked about it by its server's name.
    const mcpTool = mcpCallOf(input) ?? tool.name;
    if (parseMcpSubject(mcpTool)?.tool !== undefined) return mcpNarrowing(mcpTool, input, authored as PermissionsDecl | undefined);
    const name = COMMAND_TOOLS.has(tool.name) ? tool.name : (standardOfAnyNative(tool.name) ?? tool.name);
    const args = (input ?? {}) as Record<string, unknown>;
    const block = authored as PermissionsDecl | undefined;
    const line = COMMAND_TOOLS.has(name) ? commandOf(args) : undefined;
    if (line === undefined) {
      // Not a shell line — but a tool whose line names a FUNCTION is decided by it, per call. The gate
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
    const decision = lineDecisionFor(args, block);
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

  // The scope floor, as the callback every consumer of a policy already knows how to read.
  // `perCall`: built even with no floor, because a STATE may author `permissions.scopes` and the
  // engine hands that block to this callback at the moment of decision.
  const places = scopeNarrowingFor(undefined, options.workspaceRoot, options.execEnv, options.scopes, true);
  // Where, then what: the scope table's answer and the line's own, the stricter kept.
  const scopeOf: ScopeNarrowing = (tool, input, authored) => {
    const where = places?.(tool, input, authored);
    const what = commandNarrowing(tool, input, authored);
    if (where === undefined || what === undefined) return where ?? what;
    return MODE_RANK[where] >= MODE_RANK[what] ? where : what;
  };
  const compiled: ExecPolicy = { baseline, smart, scopeOf };
  COMMAND_NARROWINGS.set(compiled, commandNarrowing);
  return compiled;
}

const MODE_RANK: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };

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
}

const FUNCTION_CALLS = new WeakMap<object, FunctionCall>();

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
export function decideMcpCall(tool: string, permissionSet: PermissionSet, source: string, grants?: CommandGrants): CommandDecision | undefined {
  const parsed = parseMcpSubject(tool);
  if (parsed?.tool === undefined) return undefined;
  const answer = mcpModeOf(permissionSet, tool);
  if (answer === undefined) return undefined;
  const server = mcpServerSubject(parsed.server);
  const widths = [tool, server];
  const reference = modeFunction(answer.mode);
  let composed: Composed = {
    verdict: verdictOfMode(answer.mode),
    source: "permissionSet",
    entry: answer.line,
    ...(reference !== undefined ? { function: reference } : {}),
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
      reason: composed.reason,
    },
    widths,
  };
  return {
    action: composed.verdict === "denied" ? "deny" : composed.verdict === "allowed" ? "allow" : "require_approval",
    reason: composed.reason,
    parts: { line: tool, dialect: "posix", parts: [part], verdict: composed.verdict, permissionSet: source },
  };
}

/** A human-readable line for an approval prompt. */
export function describeDecision(decision: CommandDecision): string {
  const what = decision.command !== undefined ? describeCommand(decision.command) : "an unparsable command";
  return `${what} — ${decision.reason}`;
}
