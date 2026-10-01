/**
 * What a permission set's lines say — each mode's glyph, word and sentence, a tool's glyph, and the
 * standing sentences of the shell, `script` and the command runners. One table for every place a line is
 * drawn: Settings' permission sets, a state's Tools field, the composer's Tools card.
 */
import { SMART_FUNCTION, isFunctionMode, type PermissionMode, type PermissionSetMode } from "@jaira/shared/browser";
import type { PATHS } from "./iconPaths";

type IconName = keyof typeof PATHS;

export const TOOL_ICONS: Record<string, IconName> = {
  bash: "terminal",
  read_file: "read",
  write_file: "write",
};

/** What the shell's line says in the Tools card: it is also where every unnamed command lands. */
export const SHELL_HINT = "the shell — and the mode for any command not named below";
export const SCRIPT_HINT = "running a file — ./x.sh, bash x.sh, python x.py — and what a runner runs that could not be read";
export const RUNNERS_HINT = "whether JaiRA looks inside what a runner runs — each command inside is judged on its own";

/**
 * What one permission MODE means, and the glyph for it.
 *
 * Drawn as what the agent may DO rather than as a tier: a shut lock asks every time, the same lock
 * open goes ahead, a shield refuses. Somebody scanning a tool row is asking what happens when that
 * tool is reached, and a rank answers a different question. A line that names a FUNCTION wears a
 * star and the function's name — see {@link modeMeta}.
 */
export const MODE_META: Record<PermissionMode, { icon: IconName; label: string; hint: string }> = {
  ask: { icon: "lock", label: "ask", hint: "stop and ask before each call" },
  allow: { icon: "unlocked", label: "allow", hint: "goes ahead without asking" },
  deny: { icon: "shield", label: "deny", hint: "refused every time" },
};

/** The glyph for a line that names a function — the star the approval draws beside what one decided. */
export const FUNCTION_ICON: IconName = "star";

/** {@link MODE_META} for any mode: a function reads as its own name, decided per call. */
export function modeMeta(mode: PermissionSetMode): { icon: IconName; label: string; hint: string } {
  if (!isFunctionMode(mode)) return MODE_META[mode];
  return {
    icon: FUNCTION_ICON,
    label: mode.function,
    hint: mode.function === SMART_FUNCTION ? "a model judges each call, and asks you when it is unsure" : `the function ${mode.function} decides each call`,
  };
}
