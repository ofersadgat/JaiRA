/**
 * Command runners (decision 0007, amended 2026-09-26, later): programs that run OTHER commands — a
 * package manager's scripts, make's targets, a shell's `-c` line, sudo's argv.
 *
 * A permission set's `runner:<program>` line, and `runner:*` for every runner without a line of its
 * own, is a GATE on that program, not a verdict on what it runs:
 *  - `deny` refuses it without looking inside;
 *  - `allow` looks inside and lets each command there decide, on its own line;
 *  - `ask` (or a function) is put to a person (or the function) about the runner, and what is inside
 *    is judged all the same.
 * Membership is the whole program: `npm install` passes the gate too, and is then judged as the
 * command `npm install`, since it runs nothing inside. A command line naming the program (`npm`,
 * `npm run build`) decides every command of it outright, and nothing is looked inside. A set with no
 * runner line at all has no gate: runners are opened and judged as before.
 *
 * `script` stays apart: running a FILE (`./build.sh`, `python x.py`), and what a runner runs that
 * could not be read.
 */
import type { PermissionSetMode } from "./operationVocabulary";
import type { PermissionSet } from "./permissionSets";

export interface CommandRunner {
  /** As a line names it, lowercased, no path, no `.exe`. */
  program: string;
  /** What looking inside it reads — the line Settings draws under its name. */
  hint: string;
  /** It changes who or where a command runs; the shipped sets give it a line of its own. */
  elevates?: boolean;
}

/** Every command runner, in the order Settings lists them. */
export const COMMAND_RUNNERS: readonly CommandRunner[] = [
  { program: "npm", hint: "run · test · start — the script in package.json, -w workspaces followed" },
  { program: "pnpm", hint: "<script> · run — --filter, -r, pnpm-workspace.yaml" },
  { program: "yarn", hint: "<script> · workspace · workspaces foreach" },
  { program: "bun", hint: "run <script> — not read yet, so what it runs is script" },
  { program: "deno", hint: "task <name> — not read yet, so what it runs is script" },
  { program: "npx", hint: "the program it finds or fetches" },
  { program: "make", hint: "<target> — its dry run, when the Makefile runs nothing as it is read" },
  { program: "gmake", hint: "<target> — as make" },
  { program: "just", hint: "<recipe> — not read yet, so what it runs is script" },
  { program: "cargo", hint: "run — the binary it builds is not read, so it is script" },
  { program: "sh", hint: "-c \"…\" — the line it is handed" },
  { program: "bash", hint: "-c \"…\" — the line it is handed" },
  { program: "zsh", hint: "-c \"…\" — the line it is handed" },
  { program: "dash", hint: "-c \"…\" — the line it is handed" },
  { program: "ash", hint: "-c \"…\" — the line it is handed" },
  { program: "ksh", hint: "-c \"…\" — the line it is handed" },
  { program: "fish", hint: "-c \"…\" — the line it is handed" },
  { program: "pwsh", hint: "-Command \"…\" — the line it is handed" },
  { program: "powershell", hint: "-Command \"…\" — the line it is handed" },
  { program: "cmd", hint: "/c \"…\" — the line it is handed" },
  { program: "eval", hint: "the line it is handed" },
  { program: "exec", hint: "the command it becomes" },
  { program: "env", hint: "the command it wraps, with the variables it sets" },
  { program: "nohup", hint: "the command it wraps" },
  { program: "time", hint: "the command it wraps" },
  { program: "timeout", hint: "the command it wraps" },
  { program: "nice", hint: "the command it wraps" },
  { program: "watch", hint: "the command it repeats" },
  { program: "xargs", hint: "the command it runs for each input" },
  { program: "parallel", hint: "the command it runs for each input" },
  { program: "sudo", hint: "runs it as another user", elevates: true },
  { program: "doas", hint: "runs it as another user", elevates: true },
  { program: "su", hint: "runs it as another user", elevates: true },
  { program: "ssh", hint: "runs it on another machine, where no path scope reaches", elevates: true },
  { program: "docker", hint: "exec — runs it in a container", elevates: true },
  { program: "podman", hint: "exec — runs it in a container", elevates: true },
  { program: "kubectl", hint: "exec — runs it in a cluster's container", elevates: true },
];

const BY_PROGRAM: ReadonlyMap<string, CommandRunner> = new Map(COMMAND_RUNNERS.map((runner) => [runner.program, runner]));

/** The line every runner without one of its own answers to. */
export const RUNNER_GROUP_SUBJECT = "runner:*";
const PREFIX = "runner:";

export function isCommandRunner(program: string): boolean {
  return BY_PROGRAM.has(program);
}

export function commandRunnerOf(program: string): CommandRunner | undefined {
  return BY_PROGRAM.get(program);
}

/** `npm` → `runner:npm`. */
export function runnerSubject(program: string): string {
  return `${PREFIX}${program}`;
}

/** `runner:*` → `{}`, `runner:npm` → `{ program: "npm" }`, anything else `undefined`. */
export function parseRunnerSubject(subject: string): { program?: string } | undefined {
  if (!subject.startsWith(PREFIX)) return undefined;
  const rest = subject.slice(PREFIX.length);
  if (rest === "*") return {};
  return /^[a-z][a-z0-9.+-]*$/.test(rest) ? { program: rest } : undefined;
}

export function isRunnerSubject(subject: string): boolean {
  return parseRunnerSubject(subject) !== undefined;
}

/** The gate a set puts on a runner: its own line, else the group's, else none (`undefined`). */
export function runnerModeOf(permissionSet: Pick<PermissionSet, "entries">, program: string): { mode: PermissionSetMode; line: string } | undefined {
  const own = (subject: string): PermissionSetMode | undefined => (Object.hasOwn(permissionSet.entries, subject) ? permissionSet.entries[subject]!.mode : undefined);
  const mine = own(runnerSubject(program));
  if (mine !== undefined) return { mode: mine, line: runnerSubject(program) };
  const group = own(RUNNER_GROUP_SUBJECT);
  return group !== undefined ? { mode: group, line: RUNNER_GROUP_SUBJECT } : undefined;
}
