/**
 * What a permission set's lines say — each mode's glyph, word and sentence, a tool's glyph, and the
 * standing sentences of the shell, `script` and the command runners. One table for every place a line is
 * drawn: Settings' permission sets, a state's Tools field, the composer's Tools card.
 */
import { PLACE_ANYWHERE, SMART_FUNCTION, SYSTEM_AREAS, isFunctionMode, type PermissionMode, type PermissionSetMode, type PlaceKind } from "@jaira/shared/browser";
import { PATHS } from "./iconPaths";

type IconName = keyof typeof PATHS;

export const TOOL_ICONS: Record<string, IconName> = {
  shell: "terminal",
  read_file: "read",
  write_file: "write",
  ...Object.fromEntries(SYSTEM_AREAS.flatMap((area) => [[area.look, "system"], [area.change, "system"]])),
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

/**
 * The fourth decision (decision 0023 §1, ruling 4): the model is not handed the tool. Offered in the
 * mode menu of a tool, the shell and an MCP line, and nowhere else — a command, a runner, `script`,
 * `other` and a place cannot be unavailable.
 */
export const UNAVAILABLE_META: { icon: IconName; label: string; hint: string } = { icon: "eyeOff", label: "unavailable", hint: "not offered — the agent never sees it" };

// --- places on a line (decision 0023 §3, §4.2) ----------------------------------------------------

/** The named places a path may start from, in the words the card writes beside them. */
export const NAMED_PLACE_WORDS: Readonly<Record<string, string>> = {
  $PROJECT: "this project",
  $WORKTREE: "the task's worktree",
  $AGENT_WORKSPACE: "the agent's own folder",
  $TEMP: "temp",
  "~": "your home folder",
};

/**
 * The places a credential is kept in, as the add-a-place menu's `credential files` writes them —
 * §7.1's list, the one what ships asks about in every set.
 */
export const CREDENTIAL_PLACES: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "~/.ssh", "~/.aws", "~/.claude/.credentials.json", "~/.codex/auth.json"];

/** A place's words beside it, in the hint's face: a named place's name, `credentials`, `everywhere else`. */
export function placeWordsOf(kind: PlaceKind, place: string): string | undefined {
  const text = place.trim();
  if (text === PLACE_ANYWHERE) return kind === "branch" ? "every other branch" : "everywhere else";
  if (Object.hasOwn(NAMED_PLACE_WORDS, text)) return NAMED_PLACE_WORDS[text];
  if (kind === "path" && CREDENTIAL_PLACES.includes(text)) return "credentials";
  if (kind === "site" && text.startsWith("*.")) return "its subdomains";
  return undefined;
}

/**
 * A place's glyph, by what it names: a FILE (a pattern that pins files — a glob not ending in `/**`) is
 * a sheet with its corner turned, any other path a folder; a site the globe; a branch or a repository
 * the git glyph; a workflow the workflow's; a program the machine.
 */
export function placeGlyphOf(kind: PlaceKind, place: string): IconName {
  const text = place.trim();
  switch (kind) {
    case "path":
      return text !== PLACE_ANYWHERE && /[*?{]/.test(text) && !text.endsWith("/**") ? "script" : "folder";
    case "site":
    case "host":
      return "web";
    case "branch":
    case "repository":
      return "git";
    case "workflow":
      return "workflow";
    case "program":
      return "system";
  }
}

/** What one of a line's places is called, counted: `1 place`, `5 sites`, `2 branches`. */
export function placeNoun(kind: PlaceKind, n: number): string {
  const [one, many] = kind === "site" ? ["site", "sites"] : kind === "branch" ? ["branch", "branches"] : ["place", "places"];
  return `${n} ${n === 1 ? one : many}`;
}

/** What `+ add a place` is called on a line of this kind. */
export function addPlaceLabel(kind: PlaceKind): string {
  return kind === "site" ? "add a site" : kind === "branch" ? "add a branch" : "add a place";
}

/** What `another…` asks for, by kind — the example under its box. */
export function placeExample(kind: PlaceKind): string {
  switch (kind) {
    case "path":
      return "a folder like src, a file like *.lock, or a glob";
    case "site":
      return "a host like github.com, *.github.com, or github.com/owner/**";
    case "branch":
      return "a branch like main, claude/**, or origin:main";
    case "repository":
      return "owner/name";
    case "workflow":
      return "a workflow id";
    case "program":
      return "a process, service or app name";
    case "host":
      return "a host name";
  }
}

/**
 * The glyph a permission set wears (decision 0023 §4.1) — `permissionSetIconOf`'s word drawn: a mode
 * word as that mode's glyph (`ask` a shut lock, `smart` the star), an icon the app has by its name, and
 * anything else the generic layers.
 */
export function setIconGlyph(icon: string): IconName {
  if (icon === "ask" || icon === "allow" || icon === "deny") return MODE_META[icon].icon;
  if (Object.hasOwn(PATHS, icon)) return icon as IconName;
  if (icon === SMART_FUNCTION) return FUNCTION_ICON;
  return "layers";
}
