/**
 * The shell's own tables (decision 0007 §4) — DATA, so each can grow without touching the parser
 * or the policy, and so a later task can layer them the way permission sets are layered.
 *
 *  - {@link EMBEDDERS}: programs whose arguments are themselves a command. The parser opens them,
 *    recursively. One it does not know is a command like any other, and what it embeds is not seen —
 *    which is what the `bash` entry and `other` are for.
 *  - {@link POSIX_UTILITIES} / {@link POWERSHELL_UTILITIES}: a file utility is the STANDARD TOOL on
 *    its path (`cat` → `read_file`), so a permission set's modes and a scope table apply to the shell exactly
 *    as they do to the tools. This is the shell's native mapping, the counterpart of an executor's.
 *  - {@link NO_REQUEST}: `cd`, `echo`, `pwd`, `test`, `true` — no request at all.
 *  - {@link SCRIPT_INTERPRETERS} / {@link SCRIPT_RUNNERS}: running a file is the subject `script`.
 *
 * Everything here is plain JSON-able data: strings, lists, and regular expressions written as strings.
 * Program names are as {@link programName} reports them: lowercased, no path, no `.exe`.
 */

/** How an embedder carries the command it hides. */
export type EmbedderSpec =
  /** `sh -c "<line>"`: the word after one of `flags` is a whole shell line. `flagPattern` also matches (`-lc`). */
  | { kind: "shell"; flags: string[]; flagPattern?: string; encodedFlags?: string[] }
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
    }
  /** `find … -exec <argv…> ;` — every clause opened by one of `clauses`, closed by `;` or `+`. */
  | { kind: "find"; clauses: string[] }
  /** `git -c alias.x='!<line>'` and `git submodule foreach '<line>'`, `git bisect run <argv…>`. */
  | { kind: "git" };

const SH: EmbedderSpec = { kind: "shell", flags: ["-c"], flagPattern: "^-[a-zA-Z]*c$" };
const POWERSHELL: EmbedderSpec = { kind: "shell", flags: ["-command", "-c"], encodedFlags: ["-encodedcommand", "-enc", "-e", "-ec"] };

export const EMBEDDERS: Readonly<Record<string, EmbedderSpec>> = {
  sh: SH,
  bash: SH,
  zsh: SH,
  dash: SH,
  ash: SH,
  ksh: SH,
  fish: SH,
  su: { kind: "shell", flags: ["-c", "--command"] },
  cmd: { kind: "shell", flags: ["/c", "/k", "-c"] },
  powershell: POWERSHELL,
  pwsh: POWERSHELL,
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
};

const PS_PATH_PARAMS = ["-path", "-literalpath", "-lp", "-destination", "-filepath", "-outfile", "-inputobject"];
const PS_VALUE_PARAMS = [
  "-pattern", "-filter", "-include", "-exclude", "-value", "-encoding", "-totalcount", "-tail", "-first", "-last", "-head",
  "-name", "-itemtype", "-type", "-depth", "-method", "-headers", "-body", "-contenttype", "-context", "-erroraction", "-ea",
  "-useragent", "-timeoutsec", "-credential", "-delimiter", "-readcount", "-stream", "-newname",
];
const PS_READ: UtilitySpec = { tool: "read_file", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_LIST: UtilitySpec = { tool: "glob", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_SEARCH: UtilitySpec = { tool: "grep", paths: "after-first", valueFlags: PS_VALUE_PARAMS, patternFlags: ["-pattern"], pathParams: PS_PATH_PARAMS };
const PS_WRITE: UtilitySpec = { tool: "write_file", paths: "all", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_WRITE_FIRST: UtilitySpec = { tool: "write_file", paths: "first", valueFlags: PS_VALUE_PARAMS, pathParams: PS_PATH_PARAMS };
const PS_FETCH: UtilitySpec = { tool: "web_fetch", paths: "none", url: true, valueFlags: [...PS_VALUE_PARAMS, ...PS_PATH_PARAMS], urlParams: ["-uri"] };

/** PowerShell cmdlets, their aliases, and the `cmd` builtins → the standard tool each one is. */
export const POWERSHELL_UTILITIES: Readonly<Record<string, UtilitySpec>> = {
  "get-content": PS_READ,
  gc: PS_READ,
  cat: PS_READ,
  type: PS_READ,
  more: PS_READ,
  "get-childitem": PS_LIST,
  gci: PS_LIST,
  ls: PS_LIST,
  dir: PS_LIST,
  tree: PS_LIST,
  "get-item": PS_LIST,
  gi: PS_LIST,
  "test-path": PS_LIST,
  "resolve-path": PS_LIST,
  "select-string": PS_SEARCH,
  sls: PS_SEARCH,
  findstr: { tool: "grep", paths: "after-first" },
  "remove-item": PS_WRITE,
  ri: PS_WRITE,
  rm: PS_WRITE,
  del: PS_WRITE,
  erase: PS_WRITE,
  rmdir: PS_WRITE,
  rd: PS_WRITE,
  "move-item": PS_WRITE,
  mi: PS_WRITE,
  mv: PS_WRITE,
  move: PS_WRITE,
  "copy-item": PS_WRITE,
  cpi: PS_WRITE,
  cp: PS_WRITE,
  copy: PS_WRITE,
  "rename-item": PS_WRITE_FIRST,
  rni: PS_WRITE_FIRST,
  ren: PS_WRITE_FIRST,
  "new-item": PS_WRITE,
  ni: PS_WRITE,
  mkdir: PS_WRITE,
  md: PS_WRITE,
  "set-content": PS_WRITE_FIRST,
  "add-content": PS_WRITE_FIRST,
  ac: PS_WRITE_FIRST,
  "clear-content": PS_WRITE,
  clc: PS_WRITE,
  "out-file": PS_WRITE_FIRST,
  "tee-object": PS_WRITE_FIRST,
  tee: PS_WRITE_FIRST,
  "set-itemproperty": PS_WRITE_FIRST,
  "invoke-webrequest": PS_FETCH,
  iwr: PS_FETCH,
  "invoke-restmethod": PS_FETCH,
  irm: PS_FETCH,
  curl: FETCH,
  wget: FETCH,
  "start-bitstransfer": PS_FETCH,
};

/** Programs that are no request at all: they change nothing outside the shell that runs the line. */
export const NO_REQUEST: Readonly<Record<"posix" | "powershell", readonly string[]>> = {
  posix: [
    "cd", "echo", "pwd", "test", "[", "[[", "true", "false", ":", "printf", "export", "unset", "set", "pushd", "popd", "exit",
    "return", "local", "declare", "typeset", "readonly", "shift", "wait", "read", "type", "which", "hash", "break", "continue",
  ],
  powershell: [
    "cd", "chdir", "sl", "set-location", "push-location", "pop-location", "pushd", "popd", "echo", "write-output", "write-host",
    "write-verbose", "write-debug", "pwd", "gl", "get-location", "exit", "return", "break", "continue", "cls", "clear-host",
    "out-null", "select-object", "where-object", "sort-object", "measure-object", "format-table", "format-list", "out-string",
    "foreach-object", "convertto-json", "convertfrom-json", "get-command", "get-date", "rem",
  ],
};

/** Places a redirect may point at that are no request: nothing is kept and nothing is read. */
export const NULL_DEVICES: readonly string[] = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "nul", "$null", "con"];

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
];

/** File extensions that make a bare word a script (`build.sh`), as against a program on the PATH. */
export const SCRIPT_EXTENSIONS: readonly string[] = [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".php", ".ps1", ".bat", ".cmd"];
