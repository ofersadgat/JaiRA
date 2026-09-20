/**
 * What the gate's second door SAYS (decision 0004, "What draws") — as words, with no DOM.
 *
 * The strip, the settled-by line and the board card's status word are all sentences computed from
 * data, and this renderer has no DOM test infrastructure. So the sentences live here as pure
 * functions, where a test can read them, and the components in `remoteStripView.tsx` only place them.
 */
import { FORGE_LABELS, type ForgeProviderKind, type InReview, type RemoteStatusView, type ReviewNote, type ReviewRemote } from "@jaira/shared/browser";

/** `GitLab`, for a provider the table knows; the provider's own word otherwise. */
export function forgeName(provider: string | undefined): string {
  return FORGE_LABELS[provider as ForgeProviderKind]?.name ?? provider ?? "the forge";
}

/** `mistlabs/jaira !41` — the request as its forge writes it. */
export function requestLabel(remote: { provider?: string; project?: string; number?: number }): string {
  const sigil = FORGE_LABELS[remote.provider as ForgeProviderKind]?.sigil ?? "#";
  return `${remote.project ?? ""} ${sigil}${remote.number ?? "?"}`.trim();
}

/** `mara and dov commented` — nothing at all when nobody has. */
export function commentersLine(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return `${names[0]} commented`;
  if (names.length === 2) return `${names[0]} and ${names[1]} commented`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more commented`;
}

/** `40 s ago`, `3 min ago`, `2 h ago` — coarse on purpose: it is reassurance, not a clock. */
export function agoLabel(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export interface StripWords {
  forge: string;
  label: string;
  href?: string;
  branch: string;
  who?: string;
  /** Present only while a quiet window is running. */
  window?: { text: string; title: string };
  checked?: string;
  /** The forge cannot be heard. The gate is still answerable here, and the strip says so. */
  error?: string;
}

/** Everything the strip says, from the gate's own `remote` and what the last read found. */
export function stripWords(remote: ReviewRemote, status: RemoteStatusView | undefined, now: number): StripWords {
  const who = commentersLine(status?.commenters ?? []);
  const deadline = status?.settleAt;
  return {
    forge: forgeName(remote.provider),
    label: requestLabel(remote),
    ...(remote.url !== undefined ? { href: remote.url } : {}),
    branch: `${remote.branch ?? ""} → ${remote.target ?? ""}`,
    ...(who !== undefined ? { who } : {}),
    ...(deadline !== undefined && status?.error === undefined
      ? {
          window: {
            text:
              deadline <= now
                ? "going back with what was said"
                : `goes back at ${new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} unless someone writes`,
            title: "settles as “revise” unless someone writes again; each new comment restarts it",
          },
        }
      : {}),
    ...(status?.checkedAt !== undefined ? { checked: `checked ${agoLabel(status.checkedAt, now)}` } : {}),
    ...(status?.error !== undefined ? { error: `cannot reach ${remote.host ?? forgeName(remote.provider)} — still answerable here` } : {}),
  };
}

/**
 * The forge's notes laid over the reviewer's own, per change.
 *
 * Notes written HERE (no `source`) are the person's and are kept exactly; notes that came from the
 * forge are REPLACED wholesale by what the last read found — a thread gains replies and gets
 * resolved there, and a copy that only ever grew would show a conversation nobody is having.
 */
export function mergeForgeNotes(mine: readonly ReviewNote[] | undefined, theirs: readonly unknown[] | undefined): ReviewNote[] {
  const local = (mine ?? []).filter((note) => note.source === undefined);
  return [...local, ...((theirs ?? []) as ReviewNote[])];
}

/** How a gate that was answered ELSEWHERE says so. `undefined` for a gate answered here. */
export function settledByLines(recorded: Record<string, unknown>): { head: string; lines: Array<{ text: string; warned?: boolean }> } | undefined {
  const by = recorded["settled_by"] as { via?: string; who?: string; act?: string; word?: string } | undefined;
  if (by === undefined || by.via !== "remote") return undefined;
  const remote = (recorded["remote"] ?? {}) as { provider?: string; project?: string; number?: number; head?: string; target?: string; adopted?: { reset?: boolean; dropped?: string; target?: string; why?: string } };
  const forge = forgeName(remote.provider);
  const who = by.who !== undefined ? ` by ${by.who}` : "";
  const ACTS: Record<string, string> = {
    merged: `Merged on ${forge}${who}`,
    closed: `Closed on ${forge}${who} without merging`,
    approved: `Approved on ${forge}${who}`,
    changes_requested: `Changes requested on ${forge}${who}`,
    decision_word: `Answered on ${forge}${who} — “${by.word ?? ""}”`,
    quiet: `Went back with what was said on ${forge}${by.who !== undefined ? ` — ${by.who} wrote last` : ""}`,
  };
  const lines: Array<{ text: string; warned?: boolean }> = [];
  const adopted = remote.adopted;
  if (adopted !== undefined) {
    if (adopted.reset === true) lines.push({ text: `this task's worktree now holds ${remote.target ?? "the target"} as merged${remote.head !== undefined ? ` (${remote.head.slice(0, 8)})` : ""}` });
    if (adopted.dropped !== undefined) lines.push({ text: `what it held before is kept under ${adopted.dropped}` });
    if (adopted.target === "fast-forwarded") lines.push({ text: `your ${remote.target ?? "target"} was fast-forwarded` });
    if (adopted.why !== undefined) lines.push({ text: adopted.why, warned: true });
  }
  return { head: ACTS[by.act ?? ""] ?? `Answered on ${forge}${who}`, lines };
}

/** The board card's word when the question is open on a forge: `in review on GitLab !41`. */
export function cardRemoteWord(inReview: InReview): string {
  const sigil = FORGE_LABELS[inReview.provider as ForgeProviderKind]?.sigil ?? "#";
  return `in review on ${forgeName(inReview.provider)} ${sigil}${inReview.number}`;
}
