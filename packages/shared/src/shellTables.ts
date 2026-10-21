/**
 * The shell's own tables (decision 0007 §4) — DATA, so each can grow without touching the parser
 * or the policy, and so a later task can layer them the way permission sets are layered.
 *
 *  - {@link EMBEDDERS}: programs whose arguments are themselves a command. The parser opens them,
 *    recursively. One it does not know is a command like any other, and what it embeds is not seen —
 *    which is what the `shell` entry and `other` are for.
 *  - {@link POSIX_UTILITIES} / {@link POWERSHELL_UTILITIES}: a file utility is the STANDARD TOOL on
 *    its path (`cat` → `read_file`), so a permission set's modes and a scope table apply to the shell exactly
 *    as they do to the tools. This is the shell's native mapping, the counterpart of an executor's.
 *  - {@link NO_REQUEST}: `cd`, `echo`, `pwd`, `test`, `true` — no request at all.
 *  - {@link SCRIPT_INTERPRETERS} / {@link SCRIPT_RUNNERS}: running a file is the subject `script`.
 *  - {@link POWERSHELL_ALIASES}: PowerShell's own names for its cmdlets (`rm` → `remove-item`), so the
 *    tables below name a cmdlet once, and {@link CMD_UTILITIES}: what `cmd /c` runs.
 *  - {@link POWERSHELL_PURE_METHODS} / {@link POWERSHELL_PURE_STATICS}: the .NET calls a PowerShell line
 *    may make without being code nobody can read off it.
 *
 * Everything here is plain JSON-able data: strings, lists, and regular expressions written as strings.
 * Program names are as {@link programName} reports them: lowercased, no path, no `.exe` — and in
 * PowerShell an alias is the cmdlet it stands for.
 */

/** How an embedder carries the command it hides. */
export type EmbedderSpec =
  /**
   * `sh -c "<line>"`: the word after one of `flags` is a whole shell line. `flagPattern` also matches (`-lc`).
   * `rest`: every word after the flag is the line, joined (`cmd /c del x`, `powershell -Command Remove-Item x`).
   * `positional`: a first word that is no flag of the shell's own starts the line too (Windows PowerShell's
   * `powershell Get-ChildItem`). `fileFlags`: the shell runs a FILE instead (`-File x.ps1`), and is not
   * opened. `stdinPayload`: the line word that means "read the line from the input" (`-Command -`).
   * `caseless`: the shell's flags are read in any case. `valueFlags` take the next word.
   */
  | {
      kind: "shell";
      flags: string[];
      flagPattern?: string;
      encodedFlags?: string[];
      encodedPattern?: string;
      rest?: boolean;
      positional?: boolean;
      fileFlags?: string[];
      valueFlags?: string[];
      stdinPayload?: string;
      caseless?: boolean;
    }
  /**
   * PowerShell's `Invoke-Expression`: the value of one of `flags`, or its first argument, is a PowerShell
   * line — read when it is written out; code nobody can read when it is decided as the line runs, or
   * handed down the pipeline.
   */
  | { kind: "expression"; flags: string[] }
  /**
   * PowerShell's `Start-Process`: the program is `fileFlags`' value or the first argument, its words
   * `argFlags`' value or the second. `elevating` flags start it as someone else (`-Verb RunAs`, a value
   * named; `-Credential`, any), which keeps the cmdlet a request of its own. `outputFlags` / `inputFlags`
   * name files it writes and reads (`-RedirectStandardOutput x`). `valueFlags` take the next word.
   */
  | {
      kind: "process";
      fileFlags: string[];
      argFlags: string[];
      valueFlags: string[];
      elevating: Readonly<Record<string, readonly string[]>>;
      outputFlags: string[];
      inputFlags: string[];
      environmentFlags: string[];
    }
  /**
   * PowerShell's `Invoke-Command`, `Start-Job`: what runs is the script block it is handed — taken apart
   * where the line is, as every `{ … }` is. `fileFlags` run a FILE instead (script); `remoteFlags`, or a
   * computer named as its first argument, run it on another machine, which keeps the cmdlet a request
   * of its own. A block decided at run time (`-ScriptBlock $sb`) cannot be read.
   */
  | { kind: "block"; blockFlags: string[]; fileFlags: string[]; remoteFlags: string[]; valueFlags: string[] }
  /**
   * `sudo -u x <argv…>`: skip the embedder's own flags (those in `valueFlags` take the next word),
   * its `VAR=value` words, then `positionals` words of its own (timeout's duration, ssh's host), and
   * what is left is the command. `line: true` when what is left is handed to a shell as ONE LINE
   * (`ssh host "cd x && rm y"`, `watch 'a | b'`, `eval`), so it is joined and taken apart as one.
   * `until` stops the command at a marker word (`parallel cmd ::: args`). `keep: true` when the
   * embedder is a request of its own as well (`ssh` reaches the network whatever it runs).
   */
  | {
      kind: "prefix";
      valueFlags?: string[];
      positionals?: number;
      line?: boolean;
      until?: string[];
      keep?: boolean;
      /** Only an embedder under one of these subcommands (`docker exec`, `pnpm dlx`). */
      subcommands?: string[];
      /** Flags after which the next word is a whole shell line instead (`npx -c "<line>"`). */
      lineFlags?: string[];
      /** The language what it runs is written in, when it is not the line's own (`wsl ls` from PowerShell is POSIX). */
      dialect?: "posix" | "powershell" | "cmd";
    }
  /** `find … -exec <argv…> ;` — every clause opened by one of `clauses`, closed by `;` or `+`. */
  | { kind: "find"; clauses: string[] }
  /** `git -c alias.x='!<line>'` and `git submodule foreach '<line>'`, `git bisect run <argv…>`. */
  | { kind: "git" };

const SH: EmbedderSpec = { kind: "shell", flags: ["-c"], flagPattern: "^-[a-zA-Z]*c$" };
/** PowerShell's own switches that take a value, as PowerShell reads them: any case, either dash, cut short. */
const POWERSHELL_VALUE_FLAGS = [
  "-executionpolicy", "-ex", "-ep", "-exec", "-windowstyle", "-w", "-win", "-version", "-v", "-psconsolefile", "-inputformat", "-if", "-inp",
  "-outputformat", "-of", "-o", "-out", "-configurationname", "-config", "-workingdirectory", "-wd", "-custompipename", "-settingsfile",
];
/**
 * `powershell` and `pwsh`: `-Command` cut short as PowerShell reads its own switches (`-c`, `-com`,
 * `/Command`), every word after it the line. `positional` for `powershell.exe` — Windows PowerShell 5.1,
 * whose first plain word begins the command, where `pwsh`'s is a file.
 */
const powershellShell = (positional: boolean): EmbedderSpec => ({
  kind: "shell",
  flags: ["-command", "-c"],
  flagPattern: "^[-/]c(o(m(m(a(n(d)?)?)?)?)?)?$",
  encodedFlags: ["-encodedcommand", "-enc", "-e", "-ec"],
  encodedPattern: "^[-/](ec|e(n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?)$",
  rest: true,
  ...(positional ? { positional: true } : {}),
  fileFlags: ["-file", "-f", "/file", "/f"],
  valueFlags: POWERSHELL_VALUE_FLAGS,
  stdinPayload: "-",
  caseless: true,
});
const POWERSHELL = powershellShell(true);
const PWSH = powershellShell(false);
const JOB_VALUE_FLAGS = ["-name", "-credential", "-argumentlist", "-args", "-inputobject", "-psversion", "-type", "-definitionname", "-workingdirectory", "-throttlelimit", "-streaminghost"];

export const EMBEDDERS: Readonly<Record<string, EmbedderSpec>> = {
  sh: SH,
  bash: SH,
  zsh: SH,
  dash: SH,
  ash: SH,
  ksh: SH,
  fish: SH,
  su: { kind: "shell", flags: ["-c", "--command"] },
  // cmd runs the REST of the line after `/c`: `cmd /c del x` deletes x.
  cmd: { kind: "shell", flags: ["/c", "/k", "/r", "-c"], rest: true, caseless: true },
  powershell: POWERSHELL,
  pwsh: PWSH,
  "invoke-expression": { kind: "expression", flags: ["-command"] },
  "start-process": {
    kind: "process",
    fileFlags: ["-filepath", "-path", "-pspath"],
    argFlags: ["-argumentlist", "-args"],
    valueFlags: ["-verb", "-credential", "-workingdirectory", "-windowstyle", "-redirectstandardoutput", "-redirectstandarderror", "-redirectstandardinput", "-environment"],
    elevating: { "-verb": ["runas", "runasuser"], "-credential": [] },
    outputFlags: ["-redirectstandardoutput", "-redirectstandarderror"],
    inputFlags: ["-redirectstandardinput"],
    environmentFlags: ["-environment"],
  },
  "invoke-command": {
    kind: "block",
    blockFlags: ["-scriptblock"],
    fileFlags: ["-filepath"],
    remoteFlags: ["-computername", "-cn", "-session", "-hostname", "-vmname", "-vmid", "-vmguid", "-containerid", "-connectionuri", "-uri", "-sshconnection"],
    valueFlags: [
      "-computername", "-cn", "-session", "-hostname", "-vmname", "-vmid", "-vmguid", "-containerid", "-connectionuri", "-uri", "-sshconnection", "-argumentlist",
      "-args", "-credential", "-port", "-authentication", "-configurationname", "-throttlelimit", "-jobname", "-username", "-keyfilepath", "-sessionoption",
      "-inputobject", "-applicationname", "-certificatethumbprint", "-sessionname", "-subsystem",
    ],
  },
  "start-job": { kind: "block", blockFlags: ["-scriptblock", "-initializationscript"], fileFlags: ["-filepath", "-literalpath"], remoteFlags: [], valueFlags: JOB_VALUE_FLAGS },
  "start-threadjob": { kind: "block", blockFlags: ["-scriptblock", "-initializationscript"], fileFlags: ["-filepath"], remoteFlags: [], valueFlags: JOB_VALUE_FLAGS },
  eval: { kind: "prefix", line: true },
  exec: { kind: "prefix", valueFlags: ["-a"] },
  env: { kind: "prefix", valueFlags: ["-u", "--unset", "-C", "--chdir"] },
  sudo: { kind: "prefix", valueFlags: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "--user", "--group"] },
  doas: { kind: "prefix", valueFlags: ["-u", "-C"] },
  nohup: { kind: "prefix" },
  time: { kind: "prefix", valueFlags: ["-o", "-f", "--output", "--format"] },
  timeout: { kind: "prefix", valueFlags: ["-k", "-s", "--kill-after", "--signal"], positionals: 1 },
  nice: { kind: "prefix", valueFlags: ["-n", "--adjustment"] },
  ionice: { kind: "prefix", valueFlags: ["-c", "-n", "-p", "--class", "--classdata"] },
  stdbuf: { kind: "prefix", valueFlags: ["-i", "-o", "-e"] },
  setsid: { kind: "prefix" },
  command: { kind: "prefix" },
  builtin: { kind: "prefix" },
  watch: { kind: "prefix", valueFlags: ["-n", "--interval", "-d", "--differences"], line: true },
  xargs: {
    kind: "prefix",
    valueFlags: ["-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a", "--max-args", "--max-procs", "--max-lines", "--delimiter", "--arg-file", "--replace"],
  },
  parallel: { kind: "prefix", valueFlags: ["-j", "--jobs", "-S", "--sshlogin", "-a", "--arg-file", "--colsep"], until: [":::", "::::", ":::+"], line: true },
  ssh: {
    kind: "prefix",
    valueFlags: ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-m", "-S", "-W", "-w", "-E", "-B", "-I", "-Q"],
    positionals: 1,
    line: true,
    keep: true,
  },
  // `wsl ls -la` runs a Linux line in a WSL distribution, whatever shell the line itself is in.
  wsl: { kind: "prefix", valueFlags: ["-d", "--distribution", "-u", "--user", "--cd", "--shell-type"], line: true, keep: true, dialect: "posix" },
  docker: { kind: "prefix", subcommands: ["exec"], valueFlags: ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"], positionals: 1, keep: true },
  podman: { kind: "prefix", subcommands: ["exec"], valueFlags: ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"], positionals: 1, keep: true },
  kubectl: { kind: "prefix", subcommands: ["exec"], valueFlags: ["-c", "--container", "-n", "--namespace"], positionals: 1, keep: true },
  npx: { kind: "prefix", valueFlags: ["-p", "--package"], lineFlags: ["-c", "--call"] },
  bunx: { kind: "prefix" },
  pnpx: { kind: "prefix" },
  pnpm: { kind: "prefix", subcommands: ["dlx", "exec"], valueFlags: ["--package"] },
  yarn: { kind: "prefix", subcommands: ["dlx", "exec"], valueFlags: ["-p", "--package"] },
  npm: { kind: "prefix", subcommands: ["exec", "x"], valueFlags: ["-p", "--package"], lineFlags: ["-c", "--call"] },
  find: { kind: "find", clauses: ["-exec", "-execdir", "-ok", "-okdir"] },
  git: { kind: "git" },
};

/** Which of a utility's non-flag words are places. */
export type UtilityPaths =
  /** Every operand (`cat a b`, `rm a b`, `cp a b`). */
  | "all"
  /** Every operand but the first (`grep PATTERN files…`, `chmod MODE files…`). */
  | "after-first"
  /** The first operand only (`Set-Content FILE value`). */
  | "first"
  /** The operands before the first flag (`find PATHS… -name x`). */
  | "before-flags"
  | "none";

export interface UtilitySpec {
  /** The standard tool this utility is, on its path. */
  tool: string;
  paths: UtilityPaths;
  /** The first operand that looks like a url is the request's url (`curl`, `wget`). */
  url?: boolean;
  /** Flags whose next word is a value, not a place (`head -n 5`, `grep -e PATTERN`). */
  valueFlags?: string[];
  /** With one of these flags present the pattern was a flag's value, so EVERY operand is a place. */
  patternFlags?: string[];
  /** A flag that changes which tool it is: `sed -i` writes, `find -delete` writes. Patterns are regular expressions. */
  when?: Array<{ flag: string; tool: string }>;
  /** PowerShell: named parameters whose value is a place / the url. Lowercase. */
  pathParams?: string[];
  urlParams?: string[];
}

const READ: UtilitySpec = { tool: "read_file", paths: "all", valueFlags: ["-n", "-c", "--lines", "--bytes"] };
const LIST: UtilitySpec = { tool: "glob", paths: "all", valueFlags: ["-I", "--ignore", "-L", "--level"] };
const SEARCH: UtilitySpec = {
  tool: "grep",
  paths: "after-first",
  valueFlags: ["-e", "-f", "-A", "-B", "-C", "-m", "-g", "-t", "-T", "--regexp", "--file", "--include", "--exclude", "--exclude-dir", "--glob", "--type", "--max-count", "--context"],
  patternFlags: ["-e", "-f", "--regexp", "--file", "--files"],
};
const WRITE: UtilitySpec = { tool: "write_file", paths: "all", valueFlags: ["-t", "--target-directory", "-m", "--mode", "-S", "--suffix"] };
const WRITE_AFTER_FIRST: UtilitySpec = { tool: "write_file", paths: "after-first", valueFlags: ["--reference"] };
const FETCH: UtilitySpec = {
  tool: "web_fetch",
  paths: "none",
  url: true,
  valueFlags: ["-o", "-O", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "--connect-timeout", "-m", "--max-time", "--retry", "-P", "--directory-prefix", "--post-data", "--post-file"],
};

/** POSIX file utilities → the standard tool each one is on its path. */
export const POSIX_UTILITIES: Readonly<Record<string, UtilitySpec>> = {
  cat: READ,
  head: READ,
  tail: READ,
  less: READ,
  more: READ,
  bat: READ,
  wc: READ,
  ls: LIST,
  tree: LIST,
  dir: LIST,
  find: { tool: "glob", paths: "before-flags", when: [{ flag: "^-delete$", tool: "write_file" }] },
  grep: SEARCH,
  egrep: SEARCH,
  fgrep: SEARCH,
  rg: SEARCH,
  ag: SEARCH,
  rm: WRITE,
  rmdir: WRITE,
  mv: WRITE,
  cp: WRITE,
  touch: { ...WRITE, valueFlags: ["-d", "-t", "-r", "--date", "--reference"] },
  mkdir: WRITE,
  tee: WRITE,
  ln: WRITE,
  truncate: { ...WRITE, valueFlags: ["-s", "--size", "-r", "--reference"] },
  chmod: WRITE_AFTER_FIRST,
  chown: WRITE_AFTER_FIRST,
  chgrp: WRITE_AFTER_FIRST,
  sed: {
    tool: "read_file",
    paths: "after-first",
    valueFlags: ["-e", "-f", "--expression", "--file"],
    patternFlags: ["-e", "-f", "--expression", "--file"],
    when: [{ flag: "^-[a-zA-Z]*i|^--in-place", tool: "write_file" }],
  },
  curl: FETCH,
  wget: FETCH,
  // Utilities that read the files they are given and print — the reading tool, like `cat`.
  diff: { tool: "read_file", paths: "all", valueFlags: ["-U", "-C", "--unified", "--context", "-x", "--exclude", "-X", "--exclude-from", "-I", "--ignore-matching-lines", "-L", "--label"] },
  stat: { tool: "read_file", paths: "all", valueFlags: ["-c", "-f", "--format", "--printf"] },
  file: { tool: "read_file", paths: "all", valueFlags: ["-m", "--magic-file", "-F", "--separator"] },
  jq: { tool: "read_file", paths: "after-first", valueFlags: ["--arg", "--argjson", "--slurpfile", "--rawfile", "--indent", "-L"], patternFlags: ["-f", "--from-file"] },
  // `sort -o out` writes `out`: the value is not a `valueFlag`, so it is one of the places, and the whole part is the writing tool.
  sort: { tool: "read_file", paths: "all", valueFlags: ["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "-T", "--temporary-directory"], when: [{ flag: "^-o|^--output", tool: "write_file" }] },
};

/**
 * Variables a line may set without changing what a program runs — colour, locale, time zone, CI.
 * Any other (`PATH`, `LD_PRELOAD`, `GIT_EXTERNAL_DIFF`, `NODE_OPTIONS`) can make an allowed program run
 * something else, so a part that sets one is not vouched for and asks.
 */
export const HARMLESS_VARIABLES: readonly string[] = ["CI", "NO_COLOR", "FORCE_COLOR", "TZ", "LANG", "LANGUAGE", "TERM", "COLUMNS", "LINES"];

/**
 * Whether setting `name` leaves what runs as it was: {@link HARMLESS_VARIABLES} and the `LC_*` locale
 * family. PowerShell's `$env:Name` is the same variable, spelled in any case; any other PowerShell
 * variable is not one this table knows.
 */
export function isHarmlessVariable(name: string): boolean {
  const env = /^\$env:(.+)$/i.exec(name);
  if (name.startsWith("$") && env === null) return false;
  const key = env !== null ? env[1]!.toUpperCase() : name;
  return HARMLESS_VARIABLES.includes(key) || /^LC_[A-Z_]+$/.test(key);
}

/**
 * A program's own options that change what it runs — `git -c diff.external=./x diff`, `--config-env`,
 * `--exec-path=<dir>` — written before its subcommand. A part that has one is not vouched for: no line
 * about the subcommand can say what it will do. A name ending in `=` is that option with a value
 * (`git --exec-path` alone only prints where git lives).
 */
export const CONFIGURING_OPTIONS: Readonly<Record<string, readonly string[]>> = { git: ["-c", "--config-env", "--exec-path="] };

/** A name no program's environment carries by convention: lower case (`line`, `f`) — a shell's own, until it is exported. */
export const isShellLocalName = (name: string): boolean => /^[a-z_][a-z0-9_]*$/.test(name);

/**
 * Builtins that set a variable, and which of their words name it. They change nothing outside the
 * shell, and are {@link NO_REQUEST} — unless the variable is one that changes what runs next
 * (`export PATH=/tmp/x; git status`), which makes them a part the parser cannot vouch for.
 *  - `assignments`: every `NAME=value` operand (`export`, `declare`, `local`);
 *  - `operands`: every operand is a name (`read NAME`);
 *  - `flag`: the word after the flag is a name (`printf -v NAME`);
 *  - `always`: with the flag present, whatever it names (`hash -p /x/git git` points a command elsewhere).
 */
export const VARIABLE_SETTERS: Readonly<Record<string, { names: "assignments" | "operands" } | { flag: string; always?: boolean }>> = {
  export: { names: "assignments" },
  declare: { names: "assignments" },
  typeset: { names: "assignments" },
  local: { names: "assignments" },
  readonly: { names: "assignments" },
  read: { names: "operands" },
  printf: { flag: "-v" },
  hash: { flag: "-p", always: true },
};

/**
 * PowerShell's parameters whose value is a place. PowerShell reads a parameter cut short to any prefix
 * nothing else shares (`-Pat` is `-Path`), which `commandParts.ts` matches against these lists.
 */
const PS_PATH_PARAMS = ["-path", "-literalpath", "-lp", "-pspath", "-destination", "-destinationpath", "-filepath", "-outfile", "-inputobject", "-catalogfilepath", "-outputmodule"];
const PS_VALUE_PARAMS = [
  "-pattern", "-filter", "-include", "-exclude", "-value", "-encoding", "-totalcount", "-tail", "-first", "-last", "-head",
  "-name", "-itemtype", "-type", "-depth", "-method", "-headers", "-body", "-contenttype", "-context", "-erroraction", "-ea",
  "-useragent", "-timeoutsec", "-credential", "-delimiter", "-readcount", "-stream", "-newname", "-algorithm", "-count",
  "-warningaction", "-wa", "-errorvariable", "-ev", "-outvariable", "-ov", "-outbuffer", "-ob", "-pipelinevariable", "-pv",
  "-informationaction", "-infa", "-informationvariable", "-iv", "-width", "-compressionlevel", "-maximumredirection", "-proxy",
  "-session", "-websession", "-sessionvariable", "-form", "-infile", "-certificate", "-certificatethumbprint", "-propertytype",
  "-aclobject", "-header", "-xpath", "-namespace", "-property",
];
const PS_READ: UtilitySpec = { tool: "read_file", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_LIST: UtilitySpec = { tool: "glob", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_SEARCH: UtilitySpec = { tool: "grep", paths: "after-first", valueFlags: PS_VALUE_PARAMS, patternFlags: ["-pattern"], pathParams: PS_PATH_PARAMS };
const PS_WRITE: UtilitySpec = { tool: "write_file", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_WRITE_FIRST: UtilitySpec = { tool: "write_file", paths: "first", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_FETCH: UtilitySpec = { tool: "web_fetch", paths: "none", url: true, valueFlags: [...PS_VALUE_PARAMS, ...PS_PATH_PARAMS], urlParams: ["-uri"] };

/**
 * PowerShell's cmdlets → the standard tool each one is, by the cmdlet's own name: an alias (`gc`,
 * `rm`, `ls`) is read as the cmdlet it stands for ({@link POWERSHELL_ALIASES}) before this is asked.
 * The programs a PowerShell line runs that are no cmdlet (`findstr`, `tree`, `curl.exe`) are here too.
 *
 * Every cmdlet of PowerShell's own modules that reads, lists, searches, writes or fetches a file or a
 * url is here, so the shell is a way to call the standard tools and a permission set's lines for those
 * tools hold whichever shell runs the line. Reading one item — its content, or what it is (`Get-Item`,
 * `Get-Acl`, as `stat` is) — is `read_file`; listing or resolving places is `glob`. A cmdlet that changes
 * nothing outside the line is {@link NO_REQUEST}; one that acts on the machine with no standard tool
 * for it (`Stop-Process`, `Set-Service`) is a command subject, as `kill` and `systemctl` are.
 */
export const POWERSHELL_UTILITIES: Readonly<Record<string, UtilitySpec>> = {
  "get-content": PS_READ,
  "format-hex": PS_READ,
  "import-csv": PS_READ,
  "import-clixml": PS_READ,
  "import-powershelldatafile": PS_READ,
  "import-localizeddata": { ...PS_READ, paths: "none", pathParams: ["-basedirectory"] },
  "get-filehash": PS_READ,
  "get-authenticodesignature": PS_READ,
  "get-pfxcertificate": PS_READ,
  "test-filecatalog": PS_READ,
  "test-modulemanifest": PS_READ,
  "test-pssessionconfigurationfile": PS_READ,
  "get-cmsmessage": { ...PS_READ, paths: "none" },
  "unprotect-cmsmessage": { ...PS_READ, paths: "none" },
  "test-scriptfileinfo": PS_READ,
  "select-xml": { ...PS_READ, paths: "none" },
  more: PS_READ,
  "get-item": PS_READ,
  "get-itemproperty": PS_READ,
  "get-itempropertyvalue": PS_READ,
  "get-acl": PS_READ,
  "get-childitem": PS_LIST,
  tree: PS_LIST,
  "test-path": PS_LIST,
  "resolve-path": PS_LIST,
  "convert-path": PS_LIST,
  "select-string": PS_SEARCH,
  findstr: { tool: "grep", paths: "after-first" },
  "remove-item": PS_WRITE,
  "move-item": PS_WRITE,
  "copy-item": PS_WRITE,
  "rename-item": PS_WRITE_FIRST,
  "new-item": PS_WRITE,
  mkdir: PS_WRITE,
  "set-item": PS_WRITE_FIRST,
  "clear-item": PS_WRITE,
  "set-content": PS_WRITE_FIRST,
  "add-content": PS_WRITE_FIRST,
  "clear-content": PS_WRITE,
  "out-file": PS_WRITE_FIRST,
  "tee-object": PS_WRITE_FIRST,
  "export-csv": PS_WRITE_FIRST,
  "export-clixml": PS_WRITE_FIRST,
  "set-acl": PS_WRITE_FIRST,
  "set-itemproperty": PS_WRITE_FIRST,
  "new-itemproperty": PS_WRITE_FIRST,
  "remove-itemproperty": PS_WRITE_FIRST,
  "rename-itemproperty": PS_WRITE_FIRST,
  "copy-itemproperty": PS_WRITE,
  "move-itemproperty": PS_WRITE,
  "clear-itemproperty": PS_WRITE_FIRST,
  "expand-archive": PS_WRITE,
  "compress-archive": PS_WRITE,
  "new-temporaryfile": PS_WRITE,
  "unblock-file": PS_WRITE,
  "clear-recyclebin": { ...PS_WRITE, paths: "none" },
  "new-filecatalog": PS_WRITE,
  "set-authenticodesignature": PS_WRITE_FIRST,
  "new-modulemanifest": PS_WRITE_FIRST,
  "update-modulemanifest": PS_WRITE_FIRST,
  "new-scriptfileinfo": PS_WRITE_FIRST,
  "update-scriptfileinfo": PS_WRITE_FIRST,
  "new-pssessionconfigurationfile": PS_WRITE_FIRST,
  "new-psrolecapabilityfile": PS_WRITE_FIRST,
  "export-alias": PS_WRITE_FIRST,
  "export-console": PS_WRITE_FIRST,
  "export-formatdata": PS_WRITE_FIRST,
  "export-pssession": PS_WRITE_FIRST,
  "save-help": PS_WRITE,
  // Reads the file `-Path` names and writes the one `-OutFile` names: the writing tool, on both.
  "protect-cmsmessage": { ...PS_WRITE, paths: "none" },
  "invoke-webrequest": PS_FETCH,
  "invoke-restmethod": PS_FETCH,
  "start-bitstransfer": PS_FETCH,
  curl: FETCH,
  wget: FETCH,
};

/**
 * PowerShell's aliases, each to the cmdlet (or function) it runs — Windows PowerShell 5.1's table, which
 * PowerShell 7 on Windows keeps but for `curl`, `wget`, `sc` and a few of the rest. A word that names
 * its path or its extension (`where.exe`, `curl.exe`) is the program itself, never an alias.
 */
export const POWERSHELL_ALIASES: Readonly<Record<string, string>> = {
  "%": "foreach-object", "?": "where-object", ac: "add-content", asnp: "add-pssnapin", cat: "get-content", cd: "set-location",
  cfs: "convertfrom-string", chdir: "set-location", clc: "clear-content", clear: "clear-host", clhy: "clear-history", cli: "clear-item",
  clp: "clear-itemproperty", cls: "clear-host", clv: "clear-variable", cnsn: "connect-pssession", compare: "compare-object", copy: "copy-item",
  cp: "copy-item", cpi: "copy-item", cpp: "copy-itemproperty", curl: "invoke-webrequest", cvpa: "convert-path", dbp: "disable-psbreakpoint",
  del: "remove-item", diff: "compare-object", dir: "get-childitem", dnsn: "disconnect-pssession", ebp: "enable-psbreakpoint", echo: "write-output",
  epal: "export-alias", epcsv: "export-csv", epsn: "export-pssession", erase: "remove-item", etsn: "enter-pssession", exsn: "exit-pssession",
  fc: "format-custom", fhx: "format-hex", fl: "format-list", foreach: "foreach-object", ft: "format-table", fw: "format-wide", gal: "get-alias",
  gbp: "get-psbreakpoint", gc: "get-content", gcb: "get-clipboard", gci: "get-childitem", gcm: "get-command", gcs: "get-pscallstack",
  gdr: "get-psdrive", ghy: "get-history", gi: "get-item", gin: "get-computerinfo", gjb: "get-job", gl: "get-location", gm: "get-member",
  gmo: "get-module", gp: "get-itemproperty", gps: "get-process", gpv: "get-itempropertyvalue", group: "group-object", gsn: "get-pssession",
  gsnp: "get-pssnapin", gsv: "get-service", gtz: "get-timezone", gu: "get-unique", gv: "get-variable", gwmi: "get-wmiobject", h: "get-history",
  history: "get-history", icm: "invoke-command", iex: "invoke-expression", ihy: "invoke-history", ii: "invoke-item", ipal: "import-alias",
  ipcsv: "import-csv", ipmo: "import-module", ipsn: "import-pssession", irm: "invoke-restmethod", iwmi: "invoke-wmimethod", iwr: "invoke-webrequest",
  kill: "stop-process", lp: "out-printer", ls: "get-childitem", man: "get-help", md: "mkdir", measure: "measure-object", mi: "move-item",
  mount: "new-psdrive", move: "move-item", mp: "move-itemproperty", mv: "move-item", nal: "new-alias", ndr: "new-psdrive", ni: "new-item",
  nmo: "new-module", nsn: "new-pssession", nv: "new-variable", ogv: "out-gridview", oh: "out-host", popd: "pop-location", ps: "get-process",
  pushd: "push-location", pwd: "get-location", r: "invoke-history", rbp: "remove-psbreakpoint", rcjb: "receive-job", rcsn: "receive-pssession",
  rd: "remove-item", rdr: "remove-psdrive", ren: "rename-item", ri: "remove-item", rjb: "remove-job", rm: "remove-item", rmdir: "remove-item",
  rmo: "remove-module", rni: "rename-item", rnp: "rename-itemproperty", rp: "remove-itemproperty", rsn: "remove-pssession",
  rsnp: "remove-pssnapin", rujb: "resume-job", rv: "remove-variable", rvpa: "resolve-path", rwmi: "remove-wmiobject", sajb: "start-job",
  sal: "set-alias", saps: "start-process", sasv: "start-service", sbp: "set-psbreakpoint", sc: "set-content", scb: "set-clipboard",
  select: "select-object", set: "set-variable", shcm: "show-command", si: "set-item", sl: "set-location", sleep: "start-sleep",
  sls: "select-string", sort: "sort-object", sp: "set-itemproperty", spjb: "stop-job", spps: "stop-process", spsv: "stop-service",
  start: "start-process", stz: "set-timezone", sujb: "suspend-job", sv: "set-variable", swmi: "set-wmiinstance", tee: "tee-object",
  trcm: "trace-command", type: "get-content", wget: "invoke-webrequest", where: "where-object", wjb: "wait-job", write: "write-output",
  help: "get-help",
};

/** What `cmd /c` runs that is a file utility: cmd's own builtins and the programs beside them → the standard tool each one is. */
export const CMD_UTILITIES: Readonly<Record<string, UtilitySpec>> = {
  type: { tool: "read_file", paths: "all" },
  more: { tool: "read_file", paths: "all" },
  fc: { tool: "read_file", paths: "all" },
  comp: { tool: "read_file", paths: "all" },
  dir: { tool: "glob", paths: "all" },
  tree: { tool: "glob", paths: "all" },
  findstr: { tool: "grep", paths: "after-first" },
  find: { tool: "grep", paths: "after-first" },
  del: { tool: "write_file", paths: "all" },
  erase: { tool: "write_file", paths: "all" },
  rd: { tool: "write_file", paths: "all" },
  rmdir: { tool: "write_file", paths: "all" },
  md: { tool: "write_file", paths: "all" },
  mkdir: { tool: "write_file", paths: "all" },
  copy: { tool: "write_file", paths: "all" },
  xcopy: { tool: "write_file", paths: "all" },
  robocopy: { tool: "write_file", paths: "all" },
  move: { tool: "write_file", paths: "all" },
  ren: { tool: "write_file", paths: "first" },
  rename: { tool: "write_file", paths: "first" },
  mklink: { tool: "write_file", paths: "all" },
  attrib: { tool: "write_file", paths: "all" },
  curl: FETCH,
  wget: FETCH,
};

/** Programs that move the directory the REST of the line runs in, as each dialect names them. */
export const DIRECTORY_CHANGERS: readonly string[] = ["cd", "chdir", "pushd", "set-location", "push-location", "cd..", "cd\\"];

/** Programs that are no request at all: they change nothing outside the shell that runs the line. */
export const NO_REQUEST: Readonly<Record<"posix" | "powershell" | "cmd", readonly string[]>> = {
  posix: [
    "cd", "echo", "pwd", "test", "[", "[[", "true", "false", ":", "printf", "export", "unset", "set", "pushd", "popd", "exit",
    "return", "local", "declare", "typeset", "readonly", "shift", "wait", "read", "type", "which", "hash", "break", "continue",
  ],
  // Cmdlets by their own names (aliases are read as the cmdlet first). They print, filter, sort and
  // shape what they are handed, or move the line's directory: the script blocks some of them are
  // handed (`ForEach-Object { … }`, `Where-Object { … }`) are taken apart where the line is.
  powershell: [
    "set-location", "push-location", "pop-location", "get-location", "cd..", "cd\\", "write-output", "write-host", "write-verbose", "write-debug",
    "write-warning", "write-error", "write-information", "write-progress", "clear-host", "out-null", "out-string", "out-host", "out-default",
    "select-object", "where-object", "sort-object", "group-object", "measure-object", "measure-command", "compare-object", "format-table",
    "format-list", "format-wide", "format-custom", "foreach-object", "convertto-json", "convertfrom-json", "convertto-csv", "convertfrom-csv",
    "convertto-xml", "convertto-html", "convertfrom-stringdata", "convertfrom-string", "convertfrom-markdown", "get-member", "get-date",
    "get-command", "get-alias", "get-variable", "get-host", "get-culture", "get-uiculture", "get-random", "new-guid", "start-sleep",
    "get-unique", "new-timespan", "get-help", "get-history", "join-path", "split-path", "get-psdrive", "get-module", "get-executionpolicy",
    "get-pscallstack", "get-job", "receive-job", "wait-job", "get-error", "test-json", "get-verb", "pause", "set-variable", "new-variable",
    "clear-variable", "remove-variable", "set-strictmode", "out-gridview",
    // The session's own state, looked at or tidied: its history, providers, runspaces, types, events,
    // jobs and loaded modules — nothing outside the shell is read or changed.
    "add-history", "clear-history", "get-psprovider", "get-psbreakpoint", "get-runspace", "get-runspacedebug", "get-typedata", "get-formatdata",
    "get-tracesource", "get-transaction", "get-event", "get-eventsubscriber", "get-pssnapin", "get-pssession", "get-timezone", "read-host",
    "register-argumentcompleter", "add-member", "update-list", "convert-string", "convertfrom-sddlstring", "convertto-securestring",
    "convertfrom-securestring", "new-pssessionoption", "new-pstransportoption", "remove-job", "stop-job", "suspend-job", "resume-job",
    "remove-module", "wait-event", "wait-process", "export-modulemember",
  ],
  cmd: ["cd", "chdir", "pushd", "popd", "echo", "cls", "rem", "title", "ver", "vol", "pause", "exit", "setlocal", "endlocal", "where", "set"],
};

/** Places a redirect may point at that are no request: nothing is kept and nothing is read. */
export const NULL_DEVICES: readonly string[] = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "nul", "$null", "con"];

/**
 * PowerShell cmdlets that point a NAME at something else for the rest of the line — an alias, a
 * re-run of the history — so no part after them can be judged by what it says it runs.
 */
export const POWERSHELL_REDEFINERS: Readonly<Record<string, string>> = {
  "set-alias": "points a command name at another command",
  "new-alias": "points a command name at another command",
  "import-alias": "points command names at other commands",
  "invoke-history": "runs a command from the history, which the line does not show",
  "new-module": "defines commands the line does not show",
  "import-pssession": "brings in commands from another machine that the line does not show",
  "add-pssnapin": "loads commands the line does not show",
};

/**
 * Members a PowerShell line may name on every object it is handed (`ForEach-Object FullName`,
 * `.ForEach('Name')`) without being code: properties read, and methods that change nothing. Any other
 * name may be a method that does (`ForEach-Object Delete`), which the line cannot show.
 */
export const POWERSHELL_HARMLESS_MEMBERS: readonly string[] = [
  "name", "fullname", "basename", "extension", "length", "directoryname", "directory", "parent", "root", "exists", "lastwritetime",
  "creationtime", "lastaccesstime", "lastwritetimeutc", "creationtimeutc", "mode", "attributes", "pspath", "pschildname", "psparentpath",
  "psdrive", "psprovider", "psiscontainer", "count", "id", "processname", "path", "source", "version", "definition", "value", "key", "keys",
  "values", "line", "linenumber", "filename", "matches", "status", "displayname", "starttype", "commandtype", "modulename", "description",
  "hash", "algorithm", "trim", "tostring", "tolower", "toupper", "gettype",
];

/**
 * .NET methods a PowerShell line may call on any object without being code nobody can read: they
 * change nothing outside the value they are called on. Lowercase. A method named here on the wrong
 * kind of object is an error, never a deed. `Where` and `ForEach` count only with a script block —
 * `.ForEach('Delete')` calls `Delete` on every element.
 */
export const POWERSHELL_PURE_METHODS: readonly string[] = [
  "tostring", "gettype", "equals", "gethashcode", "compareto", "tolower", "toupper", "tolowerinvariant", "toupperinvariant", "trim",
  "trimstart", "trimend", "split", "substring", "startswith", "endswith", "contains", "containskey", "containsvalue", "indexof",
  "lastindexof", "indexofany", "lastindexofany", "padleft", "padright", "tochararray", "normalize", "isnormalized", "adddays", "addhours",
  "addminutes", "addseconds", "addmilliseconds", "addmonths", "addyears", "addticks", "toshortdatestring", "toshorttimestring",
  "tolongdatestring", "tolongtimestring", "touniversaltime", "tolocaltime", "tofiletime", "tofiletimeutc", "getenumerator", "toarray",
  "where", "foreach", "getbytes", "getstring", "getchars", "clone", "match", "matches", "ismatch", "getvalue", "getvaluenames",
  "getsubkeynames", "getfiles", "getdirectories", "getfilesysteminfos", "enumeratefiles", "enumeratedirectories", "getaccessrules",
  "getowner", "getaccesscontrol", "getproperty", "getmethod", "getproperties", "getmethods", "hasflag", "getrange", "join", "format",
  "subtract", "isleapyear",
  // Not `Add`, `Remove`, `Insert` or `Clear`: on an `[adsi]` entry's children they create and delete
  // accounts, and `Clear` on an event log empties it.
];

/**
 * .NET types whose static members (`[string]::Join`, `[IO.Path]::Combine`) a PowerShell line may call
 * without being code nobody can read — every member (`*`), or those named. By the type's name in
 * lowercase, without `system.`. A constructor is `new`.
 */
export const POWERSHELL_PURE_STATICS: Readonly<Record<string, "*" | readonly string[]>> = {
  string: "*",
  char: "*",
  math: "*",
  convert: "*",
  bitconverter: "*",
  regex: "*",
  "text.regularexpressions.regex": "*",
  datetime: "*",
  datetimeoffset: "*",
  timespan: "*",
  guid: "*",
  version: "*",
  int: "*",
  int16: "*",
  int32: "*",
  int64: "*",
  long: "*",
  uint32: "*",
  uint64: "*",
  double: "*",
  single: "*",
  float: "*",
  decimal: "*",
  bool: "*",
  boolean: "*",
  byte: "*",
  array: "*",
  enum: "*",
  "text.encoding": "*",
  "text.stringbuilder": "*",
  stringbuilder: "*",
  "collections.arraylist": "*",
  "collections.hashtable": "*",
  "collections.generic.list": "*",
  "collections.generic.dictionary": "*",
  "collections.generic.hashset": "*",
  "collections.generic.queue": "*",
  "collections.generic.stack": "*",
  "collections.generic.sortedset": "*",
  "collections.generic.sorteddictionary": "*",
  console: ["writeline", "write", "readline", "readkey", "resetcolor", "beep", "out", "error", "in", "outputencoding", "inputencoding", "foregroundcolor", "backgroundcolor", "windowwidth", "windowheight", "bufferwidth", "bufferheight", "keyavailable", "isoutputredirected", "iserrorredirected", "isinputredirected"],
  hashtable: "*",
  ordered: "*",
  pscustomobject: "*",
  psobject: "*",
  object: ["new", "referenceequals", "equals"],
  uri: ["new", "escapedatastring", "unescapedatastring", "escapeuristring", "iswellformeduristring", "trycreate", "checkhostname", "checkschemename"],
  "io.path": [
    "combine", "join", "getfilename", "getfilenamewithoutextension", "getextension", "getdirectoryname", "getfullpath", "getpathroot",
    "hasextension", "ispathrooted", "changeextension", "gettemppath", "getrandomfilename", "getinvalidpathchars", "getinvalidfilenamechars",
    "getrelativepath", "trimendingdirectoryseparator", "endsindirectoryseparator", "directoryseparatorchar", "altdirectoryseparatorchar",
    "pathseparator", "volumeseparatorchar",
  ],
  "io.file": ["exists", "readalltext", "readalllines", "readallbytes", "readlines", "getattributes", "getlastwritetime", "getcreationtime", "getlastaccesstime"],
  "io.directory": ["exists", "getfiles", "getdirectories", "getfilesystementries", "enumeratefiles", "enumeratedirectories", "enumeratefilesystementries", "getcurrentdirectory", "getparent", "getlastwritetime"],
  environment: [
    "getenvironmentvariable", "getenvironmentvariables", "getfolderpath", "expandenvironmentvariables", "getcommandlineargs", "getlogicaldrives",
    "newline", "machinename", "username", "userdomainname", "osversion", "processorcount", "is64bitoperatingsystem", "is64bitprocess",
    "currentdirectory", "tickcount", "tickcount64", "version", "systemdirectory", "processid", "stacktrace",
  ],
  "runtime.interopservices.runtimeinformation": "*",
  "management.automation.wildcardpattern": "*",
  "management.automation.language.parser": ["parseinput", "parsefile"],
  "net.webutility": ["htmlencode", "htmldecode", "urlencode", "urldecode"],
  "web.httputility": ["htmlencode", "htmldecode", "urlencode", "urldecode", "parsequerystring"],
};

export interface InterpreterSpec {
  /** Flags after which the next word is CODE, run without being a file — still `script`: what it does cannot be read off the line. */
  inlineFlags?: string[];
  /** Flags that make the invocation something other than running a file (`python -m pytest`): an ordinary command. */
  moduleFlags?: string[];
  /** Flags whose next word is a value. */
  valueFlags?: string[];
  /** Flags whose next word IS the file (`pwsh -File x.ps1`). */
  fileFlags?: string[];
  /** Any first operand is the file (`bash build`, `source env`); otherwise it must look like one (`node x.js`, not `bun install`). */
  anyOperand?: boolean;
}

/**
 * Programs that run the file they are given. The shells are here too: `bash x.sh` is `script`, where
 * `bash -c "…"` is an embedder and is opened instead.
 */
export const SCRIPT_INTERPRETERS: Readonly<Record<string, InterpreterSpec>> = {
  sh: { anyOperand: true },
  bash: { anyOperand: true },
  zsh: { anyOperand: true },
  dash: { anyOperand: true },
  ksh: { anyOperand: true },
  fish: { anyOperand: true },
  source: { anyOperand: true },
  ".": { anyOperand: true },
  python: { inlineFlags: ["-c"], moduleFlags: ["-m"], valueFlags: ["-W", "-X"] },
  python3: { inlineFlags: ["-c"], moduleFlags: ["-m"], valueFlags: ["-W", "-X"] },
  py: { inlineFlags: ["-c"], moduleFlags: ["-m"] },
  node: { inlineFlags: ["-e", "--eval", "-p", "--print"], valueFlags: ["-r", "--require", "--import", "--loader"] },
  deno: {},
  bun: {},
  tsx: { inlineFlags: ["-e", "--eval"] },
  "ts-node": { inlineFlags: ["-e", "--eval"] },
  ruby: { inlineFlags: ["-e"] },
  perl: { inlineFlags: ["-e", "-E"] },
  php: { inlineFlags: ["-r"], fileFlags: ["-f"] },
  powershell: { fileFlags: ["-file", "-f"] },
  pwsh: { fileFlags: ["-file", "-f"] },
  cscript: {},
  wscript: {},
  // PowerShell cmdlets that run what they are given: a file opened with the program it belongs to,
  // a module's code, a compiled type, a script on a job or another machine.
  "import-module": { anyOperand: true, valueFlags: ["-prefix", "-function", "-cmdlet", "-variable", "-alias", "-argumentlist", "-args", "-minimumversion", "-maximumversion", "-requiredversion", "-scope", "-pssession", "-cimsession"] },
  // Its first plain word is the type's source: code, as `python -c`'s is. `-AssemblyName` loads a framework's.
  "add-type": {
    inlineFlags: ["-typedefinition", "-memberdefinition"],
    fileFlags: ["-path", "-literalpath"],
    valueFlags: ["-assemblyname", "-an", "-name", "-namespace", "-ns", "-usingnamespace", "-using", "-language", "-referencedassemblies", "-ra", "-outputassembly", "-oa", "-outputtype", "-ot", "-compilerparameters", "-codedomprovider"],
    anyOperand: true,
  },
  "invoke-command": { fileFlags: ["-filepath"] },
  "start-job": { fileFlags: ["-filepath", "-literalpath"] },
  "start-threadjob": { fileFlags: ["-filepath"] },
};

/** Programs that run a NAMED script out of a project file: `npm run build`, `make all`. */
export const SCRIPT_RUNNERS: ReadonlyArray<{ program: string; subcommands?: string[] }> = [
  { program: "npm", subcommands: ["run", "run-script", "test", "t", "start", "stop", "restart"] },
  { program: "pnpm", subcommands: ["run", "run-script", "test", "t", "start"] },
  { program: "yarn", subcommands: ["run", "test", "start"] },
  { program: "bun", subcommands: ["run", "test"] },
  { program: "deno", subcommands: ["run", "task"] },
  { program: "make" },
  { program: "gmake" },
  { program: "just" },
  { program: "cargo", subcommands: ["run"] },
];

/**
 * The cmdlets of {@link SCRIPT_INTERPRETERS}: their flags are PowerShell's, read in any case and cut
 * short to a prefix (`-Fi` is `-FilePath`).
 */
export const POWERSHELL_INTERPRETERS: readonly string[] = ["import-module", "add-type", "invoke-command", "start-job", "start-threadjob", "powershell", "pwsh"];

/** File extensions that make a bare word a script (`build.sh`), as against a program on the PATH. */
export const SCRIPT_EXTENSIONS: readonly string[] = [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".php", ".ps1", ".bat", ".cmd"];

/** How a package manager names a script out of `package.json` — see {@link PACKAGE_SCRIPT_RUNNERS}. */
export interface PackageScriptRunner {
  /** Subcommands after which the next word is the script (`npm run lint`). */
  run: string[];
  /** Subcommands that are a script's own name (`npm test`, `npm t` → `test`). */
  named: Record<string, string>;
  /** Any other first word is a script of that name, when the package has one and it is not one of these (`pnpm lint`). */
  bare?: string[];
  /** Words after the script name go to the script (`pnpm test -u`), where npm keeps them for itself until `--`. */
  passesArgs: boolean;
  /** The manager's own flags that change nothing about what runs. Any other flag of its own makes the line one nobody can read off the script. */
  quiet: string[];
  /** The manager's own flags that change nothing about what runs and take a value (`pnpm --workspace-concurrency 4`). */
  quietValued?: string[];
  /**
   * Flags whose value picks workspaces — repeatable (`npm -w a -w packages/b`, `pnpm --filter a`): by
   * name, by a name glob, by a path or a folder above them; `!` before one takes it back.
   */
  workspace?: string[];
  /** Selectors of that value this does not read, which pick by what a package depends on (pnpm's `a...`, `^...`, `[origin/main]`). */
  unreadPicks?: string[];
  /** Flags that pick every workspace (`npm --workspaces`). */
  allWorkspaces?: string[];
  /** Flags that add the workspace root to the workspaces picked (`npm -ws --include-workspace-root`). */
  includeRoot?: string[];
  /** Flags that run the script in the workspace root, wherever the line runs (`pnpm -w lint`). */
  rootOnly?: string[];
  /** Flags whose value is the directory the package is found from (`npm --prefix app`). */
  prefix?: string[];
  /** Flags that pass over a picked package without the script, where it would otherwise be an error. */
  ifPresent?: string[];
  /** Several workspaces picked pass over one without the script unasked (`pnpm -r test`). */
  skipsMissing?: boolean;
}

const MANAGER_BUILTINS = [
  "add", "audit", "bin", "cache", "config", "create", "dedupe", "deploy", "dlx", "env", "exec", "fetch", "global", "help", "i", "import", "info",
  "init", "install", "licenses", "link", "list", "login", "logout", "ls", "node", "npm", "outdated", "owner", "pack", "patch", "plugin", "prune",
  "publish", "rebuild", "remove", "rm", "root", "server", "set", "setup", "store", "tag", "unlink", "up", "update", "upgrade", "version", "whoami",
  "why", "workspace", "workspaces",
];

/**
 * Package managers that run a script out of `package.json` by its name. `npm run lint` is judged by
 * the line the script runs — with its `pre` and `post` scripts, and the words passed on to it — so a
 * `"lint": "eslint ."` reads what it reads and a `"lint": "eslint --fix ."` writes what it writes.
 * Workspaces are followed: `npm -w @app/cli run build`, `pnpm --filter @app/cli build` and
 * `yarn workspace @app/cli build` are the build script of the workspace named `@app/cli`, in its own
 * directory. yarn's `workspace` and `workspaces` commands are read by `commandParts.ts` itself, since
 * they are subcommands rather than flags.
 */
export const PACKAGE_SCRIPT_RUNNERS: Readonly<Record<string, PackageScriptRunner>> = {
  npm: {
    run: ["run", "run-script", "rum", "urn"],
    named: { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" },
    passesArgs: false,
    quiet: ["--silent", "-s", "--quiet", "-q"],
    workspace: ["-w", "--workspace"],
    allWorkspaces: ["-ws", "--workspaces"],
    includeRoot: ["-iwr", "--include-workspace-root"],
    prefix: ["-C", "--prefix"],
    ifPresent: ["--if-present"],
  },
  pnpm: {
    run: ["run", "run-script"],
    named: { test: "test", t: "test", start: "start" },
    bare: MANAGER_BUILTINS,
    passesArgs: true,
    quiet: ["--silent", "-s", "--parallel", "--stream", "--no-bail", "--bail", "--sort", "--no-sort", "--reverse", "--aggregate-output"],
    quietValued: ["--workspace-concurrency", "--reporter", "--loglevel"],
    workspace: ["--filter", "-F", "--filter-prod"],
    unreadPicks: ["...", "^", "["],
    allWorkspaces: ["-r", "--recursive"],
    includeRoot: ["--include-workspace-root"],
    rootOnly: ["-w", "--workspace-root"],
    prefix: ["-C", "--dir"],
    ifPresent: ["--if-present"],
    skipsMissing: true,
  },
  yarn: { run: ["run"], named: { test: "test", start: "start" }, bare: MANAGER_BUILTINS, passesArgs: true, quiet: ["--silent", "-s"], prefix: ["--cwd"] },
};
