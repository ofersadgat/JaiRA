/**
 * A line's VARIABLES, read through where the line and its environment alone decide them (decision 0007
 * §4, amended 2026-11-25).
 *
 * `$e = "C:\…\msedge.exe"; & $e --headless` runs msedge: the line says so. Read as written, `& $e` is a
 * program decided when the line runs, which nobody can judge. So a reference whose value is CERTAIN
 * where it is read stands for that value while the line is taken apart, and each request is judged on
 * what it runs. A value is certain when:
 *  - the text assigns it exactly once, at its top (no block, branch, loop, pipeline, `&&` or `&`), as a
 *    literal — a quoted string, or a POSIX word — whose own references are certain, before the reference;
 *  - or the text never touches it, it is an environment variable (PowerShell's `$env:X`, a POSIX `$X`,
 *    cmd's `%X%`), and the environment the line runs in holds it.
 *
 * Never:
 *  - a name that looks like a secret's — its value would be drawn in the approval for anybody to read;
 *  - a variable the shell keeps itself (`$PWD`, `$_`, `$args`, `%ERRORLEVEL%`);
 *  - anything on a text that can set variables a way this does not follow (`eval`, `read`, `source`,
 *    `Set-Variable`, `iex`, `-OutVariable`, dot-sourcing, a `.ps1` it runs, cmd's `set`);
 *  - in POSIX and cmd, an unquoted value the shell would split, glob or read again as syntax.
 *
 * A payload the line hands another shell (`sh -c '…'`, `powershell -Command "…"`) is a text of its own,
 * with a scope of its own: it inherits the environment, less whatever the texts around it may set in it.
 *
 * Every reference read through is RECORDED with its span: what lets the approval draw the line as it
 * was written and each part as it runs (`CommandApproval.variables`).
 */
import type { ResolvedVariable } from "./commandParts";
import { isShellLocalName } from "./shellTables";

/** The environment a line runs in, by name — the host's to give; absent, only the line's own values are read. */
export type EnvironmentLookup = (name: string) => string | undefined;

/**
 * An environment's values as a {@link EnvironmentLookup}: by the exact name, and where names are not
 * case-sensitive (Windows) by any case of it — a copied environment is a plain object, which is.
 */
export function environmentLookupOf(env: Readonly<Record<string, string | undefined>>, ignoreCase: boolean): EnvironmentLookup {
  return (name) => {
    const exact = Object.hasOwn(env, name) ? env[name] : undefined;
    if (exact !== undefined || !ignoreCase) return exact;
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
    return undefined;
  };
}

/** Lower-case names programs read from the environment all the same: the proxies curl, git and wget obey. */
const LOWER_CASE_ENVIRONMENT = ["http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy", "rsync_proxy"];

/**
 * Whether a POSIX assignment of `name` that is NOT exported (`E=x`, `read E`, `local E=x`) reaches the
 * programs the line runs after it: only when `name` is in the environment already — the shell then
 * hands them its new value (decision 0007 §4, amended 2026-11-25 (later)). Without the environment,
 * guessed from the convention that a program's variables are upper case (`PATH`, `GIT_DIR`) and a
 * shell's own are not (`line`, `f`) — the proxies excepted.
 */
export function reachesPrograms(name: string, env: EnvironmentLookup | undefined): boolean {
  if (env !== undefined) return env(name) !== undefined;
  return !isShellLocalName(name) || LOWER_CASE_ENVIRONMENT.includes(name);
}

export type VariableDialect = "posix" | "powershell" | "cmd";

/** A name whose value is a credential's, or may be: never read through, so never drawn. */
const SECRET = /pass|secret|token|credential|auth|cookie|session|private|signature|cert|apikey|(?:^|[_-])(?:api[_-]?)?keys?(?:$|[_-])/i;

export function looksSecret(name: string): boolean {
  return SECRET.test(name);
}

/** What a POSIX shell keeps itself, whatever the environment says. */
const POSIX_KEPT = new Set([
  "PWD", "OLDPWD", "RANDOM", "SRANDOM", "SECONDS", "LINENO", "BASHPID", "PPID", "UID", "EUID", "REPLY", "OPTIND", "OPTARG", "OPTERR",
  "IFS", "PIPESTATUS", "FUNCNAME", "BASH_SOURCE", "BASH_LINENO", "BASH_REMATCH", "BASH_COMMAND", "BASH_SUBSHELL", "HISTCMD",
  "EPOCHSECONDS", "EPOCHREALTIME", "COLUMNS", "LINES", "SHLVL", "_",
]);

/** cmd's dynamic variables, lowercase: decided as the line runs. */
const CMD_KEPT = new Set(["cd", "date", "time", "random", "errorlevel", "cmdextversion", "cmdcmdline", "highestnumanodenumber", "__cd__", "__appdir__"]);

/** PowerShell's automatic variables, lowercase: PowerShell sets them, not the line. */
const POWERSHELL_AUTOMATIC = new Set([
  "_", "psitem", "args", "input", "this", "matches", "lastexitcode", "error", "pwd", "home", "host", "myinvocation", "pscmdlet",
  "psboundparameters", "psscriptroot", "pscommandpath", "executioncontext", "true", "false", "null", "ofs", "shellid", "pid",
  "profile", "psversiontable", "pshome", "stacktrace", "event", "eventargs", "eventsubscriber", "sender", "foreach", "switch",
  "nestedpromptlevel", "consolefilename", "islinux", "iswindows", "ismacos", "iscoreclr", "psculture", "psuiculture",
  "psedition", "psdebugcontext", "pssenderinfo", "psitem", "?", "^", "$",
]);

/**
 * PowerShell that can set a variable this does not follow: the `*-Variable` cmdlets and their aliases,
 * the `variable:` drive, `iex`, `[ref]`, the common parameters that name a variable to fill, a session
 * state reached by hand, a script it runs (whose `$global:` reaches this line's), and dot-sourcing.
 */
const POWERSHELL_UNFOLLOWED =
  /(?<![\w$.-])(?:set|sv|nv|rv|clv|gv|iex|ipmo)(?![\w-])|\b(?:set|new|remove|clear|get)-variable\b|\binvoke-expression\b|\bimport-module\b|variable:|\$executioncontext\b|\$pscmdlet\b|\[ref\]|(?<![\w-])[-\u2013\u2014\u2015](?:ov|ev|wv|iv|pv|pi|outv|errorv|warningv|informationv|pipelinev)\w*|\.psm?1\b|(?:^|[\n;|&({])\s*\.\s+\S/i;

/** PowerShell that can change the environment a payload inherits, past `$env:X = …`. */
const POWERSHELL_ENVIRONMENT = /(?<![$\w{])env:|setenvironmentvariable|\[(?:system\.)?environment\]::/i;

/** POSIX that can set a variable this does not follow. */
const POSIX_UNFOLLOWED =
  /(?<![\w./$-])(?:eval|source|read|declare|typeset|local|readonly|unset|getopts|mapfile|readarray|let|set|select|printf|export\s+-n)(?![\w.-])|\(\(|(?:^|[\n;&|(){}]|\b(?:then|do|else)\b)\s*\.\s+\S/;

/** cmd that sets a variable — and so changes what `%X%` is, on a line of its own after it. */
const CMD_UNFOLLOWED = /(?<![\w-])(?:set|call|setlocal)(?![\w-])/i;

/** A PowerShell variable reference: `$x`, `$env:X`, `${any name}`. Group 1 a braced name, group 2 a bare one. */
const POWERSHELL_REFERENCE = /\$(?:\{([^}]*)\}|([A-Za-z0-9_?]+(?::[A-Za-z0-9_?]+)?))/g;
/**
 * What makes a reference to it an assignment: `=`, `+=`, `??=`, and `++`/`--` standing alone — not the
 * `--headless` an argument starts with (`& $e --headless`).
 */
const POWERSHELL_ASSIGNS = /^\s*(?:=(?!=)|[+\-*/%]=|\?\?=)|^\s*(?:\+\+|--)(?![\w-])/;

/** What one text does to its variables, as far as this follows it. */
interface Analysis {
  /** Nothing on the text is certain: it can set variables a way this does not follow. */
  all: boolean;
  /** How many times the text assigns each name (by key). */
  assigned: Map<string, number>;
  /** Names the text touches in a way this does not follow (by key). */
  touched: Set<string>;
  /** Environment names (lowercase) the text may change for what it starts. */
  environment: Set<string>;
  /** The text may change any of the environment for what it starts. */
  environmentAll: boolean;
  /** POSIX: `IFS` is touched, so no unquoted value can be said to stay one word. */
  splitting: boolean;
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function analysePowerShell(text: string): Analysis {
  const out: Analysis = { all: POWERSHELL_UNFOLLOWED.test(text), assigned: new Map(), touched: new Set(), environment: new Set(), environmentAll: POWERSHELL_ENVIRONMENT.test(text), splitting: false };
  for (const m of text.matchAll(POWERSHELL_REFERENCE)) {
    const name = m[1] ?? m[2]!;
    const at = m.index;
    const before = text.slice(0, at);
    const after = text.slice(at + m[0].length);
    const assigning = POWERSHELL_ASSIGNS.test(after) || /(?<![\w-])(?:\+\+|--)$/.test(before);
    const colon = name.indexOf(":");
    const drive = colon > 0 ? name.slice(0, colon).toLowerCase() : undefined;
    const own = (colon > 0 ? name.slice(colon + 1) : name).toLowerCase();
    if (drive === "env") {
      if (assigning) {
        out.environment.add(own);
        out.touched.add(`env:${own}`);
      }
    } else if (drive !== undefined) {
      // `$script:e`, `$global:e`: the same variable by another way in — or a drive item, which is code.
      if (["global", "script", "local", "private", "using", "variable"].includes(drive)) out.touched.add(own);
    } else if (assigning) bump(out.assigned, own);
    else if (/^\s+in\b/i.test(after) && /foreach\s*\(\s*$/i.test(before)) out.touched.add(own);
  }
  return out;
}

function analysePosix(text: string): Analysis {
  const all = POSIX_UNFOLLOWED.test(text);
  const out: Analysis = { all, assigned: new Map(), touched: new Set(), environment: new Set(), environmentAll: all, splitting: /\bIFS\b/.test(text) };
  for (const m of text.matchAll(/(?:^|[\s;&|(){}`])([A-Za-z_][A-Za-z0-9_]*)\+?=/g)) bump(out.assigned, m[1]!);
  for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/g)) out.touched.add(m[1]!);
  // `${X:=y}` assigns, `${X:-y}` reads something else: no reference with an operator is certain.
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}A-Za-z0-9_]/g)) out.touched.add(m[1]!);
  for (const name of [...out.assigned.keys(), ...out.touched]) out.environment.add(name.toLowerCase());
  return out;
}

function analyseCmd(text: string): Analysis {
  const all = CMD_UNFOLLOWED.test(text);
  return { all, assigned: new Map(), touched: new Set(), environment: new Set(), environmentAll: all, splitting: false };
}

/**
 * What one text's references are read through: the values its own top-level assignments gave, and the
 * environment it was handed less what the texts around it may have set in it.
 */
export class VariableScope {
  private readonly analysis: Analysis;
  private readonly values = new Map<string, string>();

  constructor(
    readonly dialect: VariableDialect,
    text: string,
    private readonly parent: VariableScope | undefined,
    private readonly env: EnvironmentLookup | undefined,
    private readonly sink: ResolvedVariable[],
  ) {
    this.analysis = dialect === "powershell" ? analysePowerShell(text) : dialect === "posix" ? analysePosix(text) : analyseCmd(text);
  }

  /** POSIX names are case-sensitive; PowerShell's and cmd's are not. */
  private key(name: string): string {
    return this.dialect === "posix" ? name : name.toLowerCase();
  }

  /**
   * A top-level, straight-line assignment of a literal: kept when it is the only assignment of `name` the
   * text makes and nothing else touches it. `name` as a reference would name it (`e`, `HOME`).
   */
  assign(name: string, value: string): void {
    const key = this.key(name);
    if (this.analysis.all || this.analysis.touched.has(key) || this.analysis.assigned.get(key) !== 1) return;
    if (looksSecret(name) || this.kept(name)) return;
    this.values.set(key, value);
  }

  /**
   * The value of a reference, when it is certain where it is read: `e` and `env:TEMP` in PowerShell,
   * `HOME` in POSIX, `TEMP` in cmd. `undefined` leaves the reference decided when the line runs.
   */
  value(name: string): string | undefined {
    if (this.analysis.all || name.length === 0 || looksSecret(name)) return undefined;
    const key = this.key(name);
    if (this.dialect === "powershell") {
      if (key.startsWith("env:")) return this.analysis.touched.has(key) ? undefined : this.fromEnvironment(name.slice(4));
      if (key.includes(":") || POWERSHELL_AUTOMATIC.has(key)) return undefined;
      return this.values.get(key);
    }
    if (this.values.has(key)) return this.values.get(key);
    if (this.kept(name) || this.analysis.assigned.has(key) || this.analysis.touched.has(key)) return undefined;
    return this.fromEnvironment(name);
  }

  /**
   * Whether `value` stays the one word the reference was, where the reference stands: a PowerShell
   * value always does; a POSIX one unquoted is split and globbed, a cmd one read again as syntax.
   */
  fits(value: string, quoted: boolean): boolean {
    if (this.dialect === "powershell") return true;
    if (this.dialect === "posix") return quoted || (value.length > 0 && !this.analysis.splitting && !/[\s*?[\]]/.test(value));
    return quoted ? !/["%!\r\n]/.test(value) : value.length > 0 && !/[\s&|<>^"%!(),;=]/.test(value);
  }

  /** A reference read through, for the approval to draw. */
  record(resolved: ResolvedVariable): void {
    this.sink.push(resolved);
  }

  private kept(name: string): boolean {
    if (this.dialect === "posix") return POSIX_KEPT.has(name);
    if (this.dialect === "cmd") return CMD_KEPT.has(name.toLowerCase());
    return POWERSHELL_AUTOMATIC.has(name.toLowerCase());
  }

  private fromEnvironment(name: string): string | undefined {
    if (this.env === undefined || looksSecret(name) || this.environmentChanged(name.toLowerCase())) return undefined;
    return this.env(name);
  }

  /** Whether this text or one around it may have set `name` (lowercase) in the environment. */
  private environmentChanged(name: string): boolean {
    const a = this.analysis;
    if (a.environmentAll || a.environment.has(name)) return true;
    return this.parent?.environmentChanged(name) ?? false;
  }
}
