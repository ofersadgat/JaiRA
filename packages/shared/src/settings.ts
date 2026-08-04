/**
 * User settings — `~/.jaira/settings.json` (the shared base root, DESIGN §3).
 *
 * Deliberately NOT `config.json`. Project config describes how a project runs and is committed with
 * it: models, policy, executors, the search path. This file describes how the app looks to ONE
 * person on ONE machine, so it belongs to the base root and never to a checkout. Keeping the two
 * apart is why a theme preference cannot arrive through a pull request.
 *
 * Everything here is types and pure functions, so the renderer can import it: the file is READ and
 * WRITTEN in the main process, and the parsed value crosses IPC.
 */

/** Which palette the renderer paints. */
export type JairaTheme = "light" | "dark";

export const THEMES: readonly JairaTheme[] = ["light", "dark"];

export interface JairaSettings {
  /**
   * Light by default — an explicit product decision, not an inherited one. The window's own
   * background colour is set from this too, so a cold start does not flash the wrong palette.
   */
  theme: JairaTheme;
  /**
   * Where the shared base root lives, when it is not `~/.jaira`.
   *
   * Stored so the choice survives a restart without an environment variable. `JAIRA_HOME` still
   * wins when set: an explicit environment is how tests and one-off invocations point somewhere
   * else, and a saved preference must not silently override the command that launched the process.
   */
  baseDir?: string;
  /**
   * Whether the JSON editor wraps long lines.
   *
   * Here rather than in component state because it is the same KIND of thing as the theme: a display
   * preference belonging to one person on one machine, and one that would be irritating to re-set on
   * every file you opened. Off by default — an unwrapped editor keeps line numbers meaningful and
   * gives the end-of-line schema hints somewhere to sit.
   */
  wrapJson: boolean;
}

export function defaultSettings(): JairaSettings {
  return { theme: "light", wrapJson: false };
}

/**
 * Parse the settings document.
 *
 * Forgiving where `parseConfig` is strict, and for a reason: a malformed *project* config is an
 * authoring error worth failing on, whereas an unreadable preferences file should never stop the
 * app from opening. An unknown theme falls back to the default rather than throwing.
 */
export function parseSettings(raw: unknown): JairaSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultSettings();
  const doc = raw as Record<string, unknown>;
  const theme = doc["theme"];
  const baseDir = doc["baseDir"];
  return {
    theme: THEMES.includes(theme as JairaTheme) ? (theme as JairaTheme) : "light",
    wrapJson: doc["wrapJson"] === true,
    ...(typeof baseDir === "string" && baseDir.length > 0 ? { baseDir } : {}),
  };
}
