import type { PublishedVersion } from "@jaira/shared/browser";

/**
 * Where a call's card for a published artifact stands among the artifact's versions.
 *
 *   replacedBy   the newest version CLAUDE published, when it is past this call's: another call's card
 *                draws it, and this one draws its title bar alone ("vN is newer · Show vM")
 *   shows        the version the card shows: the newest — the person's own saves included — when no
 *                later call replaced it, else the call's own
 *
 * Only Claude's publishes replace a call. A version the person saved in the editor is no call's: counted,
 * every card read "v16 is newer" and no card drew v16, so the canvas was drawn nowhere (2026-11-07).
 */
export function callCardOf(versions: readonly Pick<PublishedVersion, "version" | "author">[], callVersion: number): { replacedBy: number | null; shows: number; newest: number } {
  const newest = versions.at(-1)?.version ?? callVersion;
  const byModel = [...versions].reverse().find((v) => v.author === "model")?.version ?? callVersion;
  return byModel > callVersion ? { replacedBy: byModel, shows: callVersion, newest } : { replacedBy: null, shows: Math.max(newest, callVersion), newest };
}
