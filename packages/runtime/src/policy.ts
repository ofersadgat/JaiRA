/**
 * The safety policy (DESIGN §10.1, SPEC §11.2/§11.3).
 *
 * JaiRA authors one canonical policy per project; this module decides what a given
 * tool call is allowed to do, and compiles that decision procedure into the
 * `ExecPolicy` the engine and the delegated adapters enforce
 * (`@declarative-ai/permissions`).
 *
 * The shape of the decision matters:
 *
 *  - **Tool-level modes** (`baseline`) cover "may this agent write files at all".
 *  - **A `smart` approver** covers everything that depends on a command's
 *    *arguments* — `git status` is free, `git push --force` is forbidden. Upstream
 *    provides exactly this hook, so DESIGN §10.1's ordered `{ match, action }`
 *    rules become a function over {@link ParsedCommand}s instead of a second
 *    enforcement mechanism.
 *
 * Three properties are deliberate:
 *
 *  1. **Every command on a line is judged**, and the strictest verdict wins — a
 *     denied command cannot be smuggled behind a benign one (`npm test && git
 *     reset --hard`).
 *  2. **Unparsable ⇒ ask.** A command the parser cannot model never resolves to
 *     `allow` (DESIGN §10.1's stated default).
 *  3. **`.jaira/**` is denied by path**, because a worktree normally *does* contain
 *     `.jaira/` (§1g item 5) — the deny rule is the real enforcement, not the
 *     directory layout.
 */
import type { ExecPolicy, PermissionBaseline, PermissionMode, PermissionRequest, SmartVerdict } from "@declarative-ai/permissions";
import { describeCommand, parseCommand, type CommandDialect, type ParsedCommand } from "./command";
import { dialectFor, type ExecEnv } from "./paths";

/** What a rule does when it matches — DESIGN §10.1's vocabulary. */
export type PolicyAction = "allow" | "deny" | "require_approval";

/** A matcher over parsed intent (never a regex over the raw string). */
export interface CommandMatcher {
  /** Program name, already normalized (`git`, `npm`, `curl`). */
  program?: string;
  /** Subcommand (`push`, `publish`). */
  subcommand?: string;
  /** Every one of these flags must be present. */
  flags?: string[];
  /** Any of these flags present is enough. */
  anyFlag?: string[];
  /** Substring that must appear in some argument (paths, URLs). */
  argIncludes?: string;
}

export interface PolicyRule {
  match: CommandMatcher;
  action: PolicyAction;
  /** Shown to the user when this rule causes a prompt or a refusal. */
  reason?: string;
}

export interface JairaPolicy {
  /** Ordered; first match wins (DESIGN §10.1). Evaluated before the built-ins. */
  rules?: PolicyRule[];
  /** Verdict for a command no rule and no built-in matches. Default `allow`. */
  default?: PolicyAction;
  /** Turn off the SPEC §11.2/§11.3 built-ins (tests and deliberate opt-out only). */
  builtins?: boolean;
  /** Per-tool modes for non-command tools (`write_file: "ask"`). */
  tools?: Record<string, PermissionMode>;
  /** Mode for tools with no entry. Unset ⇒ upstream's own default (`ask`). */
  toolDefault?: PermissionMode;
  /** Starting permission profile for a session (`read-only`, `plan`, `full`). */
  profile?: string;
}

/** Tools whose input is a command line, and therefore parsed rather than trusted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "sh", "powershell", "cmd", "run_command", "execute_command", "terminal"]);

/** Input keys a command-running tool might use for the command itself. */
const COMMAND_KEYS = ["command", "cmd", "script", "input", "commandLine"];

/** Input keys that carry a filesystem path. */
const PATH_KEYS = ["path", "file", "file_path", "filePath", "target", "directory", "dir"];

// --- SPEC §11.2: destructive git (deny) --------------------------------------

const DESTRUCTIVE: PolicyRule[] = [
  { match: { program: "git", subcommand: "push", anyFlag: ["--force", "-f", "--force-with-lease"] }, action: "deny", reason: "force push rewrites published history" },
  { match: { program: "git", subcommand: "push", anyFlag: ["--mirror"] }, action: "deny", reason: "mirror push overwrites every ref" },
  { match: { program: "git", subcommand: "reset", anyFlag: ["--hard"] }, action: "deny", reason: "hard reset discards work" },
  { match: { program: "git", subcommand: "rebase" }, action: "deny", reason: "rebase rewrites history" },
  { match: { program: "git", subcommand: "filter-branch" }, action: "deny", reason: "filter-branch rewrites history" },
  { match: { program: "git", subcommand: "filter-repo" }, action: "deny", reason: "filter-repo rewrites history" },
  { match: { program: "git", subcommand: "gc" }, action: "deny", reason: "gc can drop unreachable objects" },
  { match: { program: "git", subcommand: "prune" }, action: "deny", reason: "prune drops unreachable objects" },
  { match: { program: "git", subcommand: "clean", anyFlag: ["-f", "-fd", "-fdx", "--force"] }, action: "deny", reason: "clean deletes untracked files" },
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

function matches(matcher: CommandMatcher, command: ParsedCommand): boolean {
  if (matcher.program !== undefined && matcher.program !== command.program) return false;
  if (matcher.subcommand !== undefined && matcher.subcommand !== command.subcommand) return false;
  if (matcher.flags !== undefined && !matcher.flags.every((f) => command.flags.includes(f))) return false;
  if (matcher.anyFlag !== undefined && !matcher.anyFlag.some((f) => command.flags.includes(f))) return false;
  if (matcher.argIncludes !== undefined && !commandWords(command).some((a) => a.includes(matcher.argIncludes!))) return false;
  return true;
}

/** The built-in verdict for one command, or undefined when no built-in applies. */
export function builtinVerdict(command: ParsedCommand): { action: PolicyAction; reason: string } | undefined {
  for (const rule of DESTRUCTIVE) {
    if (matches(rule.match, command)) return { action: "deny", reason: rule.reason ?? "destructive git operation" };
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

export interface CommandDecision {
  action: PolicyAction;
  reason: string;
  /** The command the verdict is about (absent when the line was unparsable). */
  command?: ParsedCommand;
}

/**
 * Decide a whole command line: parse it, judge every command, and return the
 * strictest verdict.
 */
export function decideCommand(policy: JairaPolicy, line: string, dialect: CommandDialect = "posix"): CommandDecision {
  const parsed = parseCommand(line, dialect);
  if (parsed.unparsed || parsed.commands.length === 0) {
    // DESIGN §10.1: "Unparsable commands default to require_approval."
    return {
      action: "require_approval",
      reason: parsed.reason !== undefined ? `command could not be parsed (${parsed.reason})` : "command could not be parsed",
    };
  }

  let worst: CommandDecision = { action: policy.default ?? "allow", reason: "no rule matched" };
  for (const command of parsed.commands) {
    let verdict: { action: PolicyAction; reason: string } | undefined;
    // Authored rules first (first match wins), then the built-ins.
    for (const rule of policy.rules ?? []) {
      if (matches(rule.match, command)) {
        verdict = { action: rule.action, reason: rule.reason ?? `matched a project policy rule` };
        break;
      }
    }
    if (verdict === undefined && policy.builtins !== false) verdict = builtinVerdict(command);
    const decided = verdict ?? { action: policy.default ?? "allow", reason: "no rule matched" };
    if (RANK[decided.action] >= RANK[worst.action]) {
      worst = { ...decided, command };
    }
  }
  return worst;
}

/**
 * Whether this policy can ever escalate a call to a human.
 *
 * True with the built-ins on, because SPEC §11.3's classes are all
 * `require_approval`; otherwise only if an authored rule or the default asks. This
 * is what capability gating (DESIGN §8.2) checks a runtime against — a policy that
 * cannot ask needs nothing enforced interactively.
 */
export function policyCanEscalate(policy: JairaPolicy): boolean {
  if (policy.builtins !== false) return true;
  if (policy.default === "require_approval") return true;
  return (policy.rules ?? []).some((rule) => rule.action === "require_approval");
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
}

export interface PolicyAuditEntry {
  tool: string;
  /** The raw command line, when the tool takes one. */
  command?: string;
  /** The parsed command the verdict is about. */
  parsed?: ParsedCommand;
  action: PolicyAction;
  reason: string;
  sessionId: string;
}

/**
 * Compile a JaiRA policy into the `ExecPolicy` the engine enforces.
 *
 * Command-running tools get `smart` mode, so their verdict depends on the parsed
 * command; everything else resolves through the authored per-tool baseline. The
 * `smart` approver returns `allow`/`deny` directly and escalates to `ask` only for
 * `require_approval`, which is what routes a decision to the human gate.
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
      // A command tool with no command to read: nothing to judge, so escalate
      // rather than assume.
      audit({ tool, action: "require_approval", reason: "no command found in the tool input", sessionId: req.sessionId });
      return "ask";
    }
    const decision = decideCommand(policy, line, dialect);
    // Screen the command's own words for `.jaira/`: a path matcher applied to the
    // whole line would never match, because the path is preceded by a space.
    const touchesJaira = parseCommand(line, dialect).commands.some((c) => commandWords(c).some(isDeniedPath));
    if (touchesJaira) {
      audit({ tool, command: line, action: "deny", reason: ".jaira/ is engine-owned", sessionId: req.sessionId });
      return "deny";
    }

    audit({
      tool,
      command: line,
      ...(decision.command !== undefined ? { parsed: decision.command } : {}),
      action: decision.action,
      reason: decision.reason,
      sessionId: req.sessionId,
    });
    return decision.action === "allow" ? "allow" : decision.action === "deny" ? "deny" : "ask";
  };

  const baseline: PermissionBaseline = {
    ...(policy.toolDefault !== undefined ? { default: policy.toolDefault } : {}),
    tools: {
      // Command tools are decided per call by the smart approver.
      ...Object.fromEntries([...COMMAND_TOOLS].map((tool) => [tool, "smart" as PermissionMode])),
      ...policy.tools,
    },
    ...(policy.profile !== undefined ? { profile: policy.profile } : {}),
  };

  const smart: Record<string, (req: PermissionRequest) => SmartVerdict> = {};
  for (const tool of COMMAND_TOOLS) smart[tool] = (req) => verdictFor(tool, req);
  // An authored `smart` entry for a non-command tool still gets path screening.
  for (const [tool, mode] of Object.entries(policy.tools ?? {})) {
    if (mode === "smart" && smart[tool] === undefined) smart[tool] = (req) => verdictFor(tool, req);
  }

  return { baseline, smart };
}

/** A human-readable line for an approval prompt. */
export function describeDecision(decision: CommandDecision): string {
  const what = decision.command !== undefined ? describeCommand(decision.command) : "an unparsable command";
  return `${what} — ${decision.reason}`;
}
