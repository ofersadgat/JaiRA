/**
 * Which shell one call's line is in (decision 0007 §4).
 *
 * JaiRA's own `shell` runs where the project runs (`dialectFor`). An agent's own shell tool runs in its
 * own shell (`nativeShellDialect`: Claude Code's `Bash` is POSIX on Windows too, its `PowerShell` is
 * PowerShell) — and the gate is asked about either by the standard name, `shell`, which says nothing of
 * which. So the translated gate notes the dialect against the call's input as it asks
 * ({@link noteCallDialect}), and whoever judges the line finds it there ({@link callDialectOf}), as the
 * policy finds a line's decision by the same input.
 */
import { nativeShellDialect, type CommandDialect } from "@jaira/shared";

const DIALECTS = new WeakMap<object, CommandDialect>();

/** Note the shell a call's line runs in, against the call's own input. */
export function noteCallDialect(input: unknown, dialect: CommandDialect): void {
  if (input !== null && typeof input === "object") DIALECTS.set(input, dialect);
}

/**
 * The shell a call's line runs in: the one noted against its input, else the one the tool it was
 * asked about by is known to run in — or `undefined`, for a line that runs where the project runs.
 */
export function callDialectOf(input: unknown, tool: string): CommandDialect | undefined {
  const noted = input !== null && typeof input === "object" ? DIALECTS.get(input) : undefined;
  return noted ?? nativeShellDialect(tool);
}
