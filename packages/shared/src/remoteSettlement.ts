/**
 * What settles a gate from the forge (decision 0004 §3) — as one PURE function.
 *
 * `settleRemote(state, context)` reads what one `read()` found and answers one of two things: the
 * gate settles, with this result; or it keeps waiting, and here is the window's deadline. No clock
 * is read and nothing is fetched — `now` is an argument — which is what lets every row of the
 * decision's table be a test, and what lets the poller and a future relay reach the same answer from
 * the same state.
 *
 * ## The table
 *
 * | On the forge | review-level `decision` | every change |
 * | --- | --- | --- |
 * | merged | `approve` | `merged` |
 * | closed without merging | `cut` | `denied` |
 * | "request changes" submitted | `revise` | `comment` where a thread touches it, else `approved` |
 * | a comment whose WHOLE body is a decision word | that word | per the word |
 * | approved (the forge's own approve) | `approve` | `approved` |
 * | comments, then quiet for `settle_after` | `revise` | as "request changes" |
 *
 * In that ORDER when one read finds several — a weekend's worth at once. The state of the request
 * outranks anything said on it; a standing request for changes outranks an approval, because
 * sending a review back with everything said is the mistake that costs least.
 *
 * ## Who counts
 *
 * Only an account with WRITE access can settle a gate or start its window. Anyone's comment is
 * shown — it rides the result as a note — and the token's own account is JaiRA's own voice, never an
 * event.
 */
import { DECISION_KINDS, type Change, type ChangeDecision, type Changeset, type DecisionKind } from "./changeset";
import type { ForgeComment, ForgeThread, RemoteHandle, RemoteState } from "./forge";
import type { NoteReply, ReviewNote } from "./reviewNotes";

/** What the forge did that settled it. */
export type RemoteAct = "merged" | "closed" | "changes_requested" | "approved" | "decision_word" | "quiet";

export interface SettledBy {
  via: "remote";
  /** Whose act it was, where the forge says. The quiet window is nobody's: it is the LAST commenter. */
  who?: string;
  act: RemoteAct;
  /** The word, when the act was one. */
  word?: string;
}

export interface RemoteSettlement {
  /** Absent when the state names no `options`, or none of them is what the forge said. */
  decision?: string;
  decisions: ChangeDecision[];
  /** Comments on the request as a whole — about the set, shown above the changes. */
  notes: ReviewNote[];
  settledBy: SettledBy;
  /**
   * What the HOST has to do about it, which is never a judgement:
   *
   *  - `adopt` — the request was merged; the forge's history is the history (fetch, reset, fast-forward).
   *  - `apply` — somebody wrote `merged`: apply the changeset locally, as the gate's own Merge does,
   *    and leave the request open.
   */
  effect?: "adopt" | "apply";
}

export type SettleStep =
  | { kind: "settled"; settlement: RemoteSettlement; seen: string[] }
  | {
      kind: "waiting";
      /** The window's deadline, epoch ms — restarted by each new comment that counts. Absent ⇒ none runs. */
      settleAt?: number;
      seen: string[];
      /** What there is to SHOW so far: the same notes a settlement would carry. */
      decisions: ChangeDecision[];
      notes: ReviewNote[];
    };

export interface SettleContext {
  /** The changes under review. Absent for a bare `on_remote_event`, which has none to decide. */
  changeset?: Changeset;
  /**
   * The state's review-level vocabulary (`options`).
   *
   * Given — even empty — it RESTRICTS: a gate may only answer a word its state named. Absent, as for
   * a bare `on_remote_event`, there is no vocabulary to keep to, and the table's own words are used.
   */
  options?: readonly string[];
  /** Ids already folded in by an earlier read. */
  seen: readonly string[];
  /** The running window's deadline, off the row. */
  settleAt?: number;
  settleAfterMs: number;
  now: number;
}

/** The verb forms a decision word may take — "the obvious verb form of one". */
const VERBS: Record<string, DecisionKind> = { approve: "approved", deny: "denied", merge: "merged", revert: "reverted" };

/** What each review-level word means for a change that nothing more specific decided. */
const LEVEL_KINDS: Record<string, DecisionKind | "threads"> = {
  approve: "approved",
  revise: "threads",
  cut: "denied",
};

/** The review-level word a DecisionKind answers with, when the state's options have it. */
const KIND_LEVELS: Record<DecisionKind, string> = { approved: "approve", merged: "approve", denied: "cut", reverted: "cut", comment: "revise" };

export interface DecisionWord {
  /** The word as written, trimmed and case-folded. */
  word: string;
  /** What it does to a change. `threads` = the "request changes" rule. */
  kind: DecisionKind | "threads";
  /** The review-level decision it IS, when the state offers it. */
  level?: string;
}

/**
 * Read a comment as a decision word — EXACT match of the whole body, trimmed and case-folded.
 *
 * Exact on purpose. "approve once the tests pass" contains the word and is the opposite of it; a
 * comment is a decision only when it is nothing else.
 */
export function decisionWordOf(body: string, options: readonly string[] = []): DecisionWord | undefined {
  const word = body.trim().toLowerCase();
  if (word.length === 0 || /\s/.test(word)) return undefined;
  const option = options.find((o) => o.toLowerCase() === word);
  if (option !== undefined) {
    // One of the state's own words. `approve`, `revise` and `cut` mean what the table says; a
    // DecisionKind means itself; anything else the state invented decides nothing about a change,
    // so each change falls to what its threads say.
    const known = (DECISION_KINDS as readonly string[]).includes(word) && word !== "comment" ? (word as DecisionKind) : undefined;
    return { word, kind: LEVEL_KINDS[word] ?? known ?? "threads", level: option };
  }
  const kind = (DECISION_KINDS as readonly string[]).includes(word) ? (word as DecisionKind) : VERBS[word];
  if (kind === undefined) return undefined;
  const level = levelOf(KIND_LEVELS[kind], options);
  return { word, kind: kind === "comment" ? "threads" : kind, ...(level !== undefined ? { level } : {}) };
}

/** A review-level word, if the state offers it — matched without case, returned as the state spells it. */
function levelOf(word: string, options: readonly string[]): string | undefined {
  return options.find((o) => o.toLowerCase() === word);
}

const counts = (c: { canWrite: boolean; own: boolean }): boolean => c.canWrite && !c.own;

/** The change a thread is about: the one whose path (or old path) the anchor names. */
function changeOf(changeset: Changeset | undefined, thread: ForgeThread): Change | undefined {
  const path = thread.anchor?.path;
  if (path === undefined) return undefined;
  return changeset?.changes.find((c) => c.path === path || c.fromPath === path);
}

/** The text of a line on one side of a change — what a note QUOTES, since a note anchors by quote. */
function lineOf(change: Change, line: number, side: "before" | "after"): string {
  const text = (side === "before" ? change.before : change.after) ?? "";
  return text.split(/\r?\n/)[line - 1] ?? "";
}

function replyOf(comment: ForgeComment): NoteReply {
  return { body: comment.body, author: comment.who, at: comment.at } as NoteReply;
}

/** A forge thread as the note it is: the opening comment, with the rest as replies. */
export function noteOfThread(thread: ForgeThread, artifact: string, change?: Change): ReviewNote | undefined {
  const [first, ...rest] = thread.comments;
  if (first === undefined) return undefined;
  const anchor = thread.anchor;
  return {
    artifact,
    quote: anchor !== undefined && change !== undefined ? lineOf(change, anchor.line, anchor.side) : "",
    ...(anchor !== undefined ? { side: anchor.side } : {}),
    body: first.body,
    author: first.who,
    at: first.at,
    ...(rest.length > 0 ? { replies: rest.map(replyOf) } : {}),
  } as ReviewNote;
}

/** The key a general note is filed under — the review as a whole, not any one change. */
export const REVIEW_NOTE_ARTIFACT = "$review";

/** The table's own review-level words — what a settlement says when no state restricts it. */
export const REMOTE_LEVELS = ["approve", "revise", "cut"] as const;

export function settleRemote(state: RemoteState, context: SettleContext): SettleStep {
  const options = context.options ?? REMOTE_LEVELS;
  const changes = context.changeset?.changes ?? [];
  const seen = new Set(context.seen);

  // --- what has been said, as notes — shown whoever said it ------------------------------------
  const perChange = new Map<string, { notes: ReviewNote[]; comment: string[]; word?: DecisionKind; open: boolean }>();
  const slot = (id: string) => {
    let held = perChange.get(id);
    if (held === undefined) perChange.set(id, (held = { notes: [], comment: [], open: false }));
    return held;
  };
  const general: ReviewNote[] = [];

  for (const thread of state.threads) {
    const change = changeOf(context.changeset, thread);
    if (change === undefined) {
      // A thread about nothing under review — the request as a whole, or a file outside the set.
      const note = noteOfThread(thread, REVIEW_NOTE_ARTIFACT);
      if (note !== undefined) general.push(note);
      continue;
    }
    const held = slot(change.id);
    const note = noteOfThread(thread, change.id, change);
    if (note !== undefined) held.notes.push(note);
    if (!thread.resolved && thread.comments.some((c) => !c.own)) held.open = true;
    // A reply on a file's thread that is a decision word decides THAT change, and settles nothing.
    for (const comment of thread.comments) {
      if (!counts(comment)) continue;
      const word = decisionWordOf(comment.body, options);
      if (word !== undefined && word.kind !== "threads") held.word = word.kind;
    }
  }
  for (const comment of state.comments) {
    if (decisionWordOf(comment.body, options) !== undefined && counts(comment)) continue; // an act, not a remark
    general.push({ artifact: REVIEW_NOTE_ARTIFACT, quote: "", body: comment.body, author: comment.who, at: comment.at } as ReviewNote);
  }

  const decide = (rest: DecisionKind | "threads"): ChangeDecision[] =>
    changes.map((change) => {
      const held = perChange.get(change.id);
      // Most specific first: a word on the change's own thread, then the rule for everything else.
      const decision: DecisionKind = held?.word ?? (rest === "threads" ? (held?.open === true ? "comment" : "approved") : rest);
      return {
        id: change.id,
        decision,
        ...(held !== undefined && held.notes.length > 0 ? { notes: held.notes } : {}),
      };
    });

  const allIds = [
    ...state.reviews.map((r) => r.id),
    ...state.comments.map((c) => c.id),
    ...state.threads.flatMap((t) => t.comments.map((c) => c.id)),
  ];
  const nowSeen = [...new Set([...context.seen, ...allIds])];
  const settled = (decision: string | undefined, rest: DecisionKind | "threads", settledBy: SettledBy, effect?: "adopt" | "apply"): SettleStep => ({
    kind: "settled",
    seen: nowSeen,
    settlement: {
      ...(decision !== undefined ? { decision } : {}),
      decisions: decide(rest),
      notes: general,
      settledBy,
      ...(effect !== undefined ? { effect } : {}),
    },
  });
  const who = (name: string | undefined): { who?: string } => (name !== undefined && name.length > 0 ? { who: name } : {});

  // 1. The request's own state outranks anything said on it.
  if (state.state === "merged") {
    // Merging the request IS merging the changes — every one, whatever a thread said about it.
    perChange.forEach((held) => delete held.word);
    return settled(levelOf("approve", options), "merged", { via: "remote", ...who(state.closedBy), act: "merged" }, "adopt");
  }
  if (state.state === "closed") {
    perChange.forEach((held) => delete held.word);
    return settled(levelOf("cut", options), "denied", { via: "remote", ...who(state.closedBy), act: "closed" });
  }

  // 2. Explicit acts nobody has been told about yet, by people who count.
  const fresh = <T extends { id: string }>(items: readonly T[]): T[] => items.filter((item) => !seen.has(item.id));
  const reviews = fresh(state.reviews).filter(counts).sort((a, b) => a.at.localeCompare(b.at));
  const requested = reviews.filter((r) => r.verdict === "changes_requested").at(-1);
  if (requested !== undefined) {
    return settled(levelOf("revise", options), "threads", { via: "remote", who: requested.who, act: "changes_requested" });
  }
  const worded = fresh(state.comments)
    .filter(counts)
    .map((comment) => ({ comment, word: decisionWordOf(comment.body, options) }))
    .filter((entry): entry is { comment: ForgeComment; word: DecisionWord } => entry.word !== undefined)
    .sort((a, b) => a.comment.at.localeCompare(b.comment.at))
    .at(-1);
  if (worded !== undefined) {
    const { comment, word } = worded;
    return settled(word.level, word.kind, { via: "remote", who: comment.who, act: "decision_word", word: word.word }, word.kind === "merged" ? "apply" : undefined);
  }
  const approved = reviews.filter((r) => r.verdict === "approved").at(-1);
  if (approved !== undefined) {
    // Approving is not merging: every change is `approved`, and the request stays open.
    return settled(levelOf("approve", options), "approved", { via: "remote", who: approved.who, act: "approved" });
  }

  // 3. Remarks: each one that counts (re)starts the quiet window.
  const remarks = [...fresh(state.comments), ...state.threads.flatMap((t) => fresh(t.comments))]
    .filter(counts)
    .filter((comment) => decisionWordOf(comment.body, options) === undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
  // The window runs from the COMMENT, not from the moment JaiRA happened to read it: "quiet for
  // settle_after" is a fact about the conversation, and a poll that arrives late must not extend it.
  // That is also what settles a window whose deadline passed while the app was closed — on the first
  // read, with the late comments in it.
  let settleAt = context.settleAt;
  const last = remarks.at(-1);
  if (last !== undefined) {
    const said = Date.parse(last.at);
    const restarted = (Number.isFinite(said) ? said : context.now) + context.settleAfterMs;
    settleAt = settleAt === undefined ? restarted : Math.max(settleAt, restarted);
  }

  if (settleAt !== undefined && context.now >= settleAt) {
    // Whose window it was: the last person who said something that counted.
    const everyone = [...state.comments, ...state.threads.flatMap((t) => t.comments)].filter(counts).sort((a, b) => a.at.localeCompare(b.at));
    return settled(levelOf("revise", options), "threads", { via: "remote", ...who(everyone.at(-1)?.who), act: "quiet" });
  }
  return { kind: "waiting", ...(settleAt !== undefined ? { settleAt } : {}), seen: nowSeen, decisions: decide("threads"), notes: general };
}

/** The result a gate answers with when the forge settled it — today's, plus who and where. */
export function resultOfSettlement(settlement: RemoteSettlement, remote: RemoteHandle): Record<string, unknown> {
  return {
    ...(settlement.decision !== undefined ? { decision: settlement.decision } : {}),
    decisions: settlement.decisions,
    ...(settlement.notes.length > 0 ? { notes: settlement.notes } : {}),
    settled_by: settlement.settledBy,
    remote,
  };
}
