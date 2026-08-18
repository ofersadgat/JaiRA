/**
 * Status as two kinds of pill (SHELL.md §4).
 *
 * The board had a badge and the sidebar had nothing, so "is anything happening over there" was a
 * question you answered by going there. One vocabulary answers it in both places, and the split that
 * makes it readable is not by colour but by what kind of fact each pill states:
 *
 *  - An **active** pill is a LIVE FACT. `▶2` means two runs are working right now, and it is true
 *    whether or not anybody has looked. It is FILLED — a tint of its own colour.
 *  - A **status** pill is an UNSEEN COUNT (§4.3). `✓3` means three finished *since you last looked*,
 *    not three that ever finished, and it clears when you look. It is FLAT.
 *
 * Fill is the second channel, and it is load-bearing: `⛔` error and a red active pill would be told
 * apart by hue alone, which is the one thing colour must never be the only carrier of.
 */
import type { JSX } from "react";
import type { InstanceStatus, ProjectSummary, TaskStatus } from "@jaira/shared/browser";

/**
 * The five pills, in the order they claim room.
 *
 * `running` heads it deliberately. A single pill fits any row this app draws, so putting work at the
 * front means NO WIDTH CAN HIDE THE FACT THAT SOMETHING IS WORKING: a project with nothing running
 * folds all the way to a bare `+5`, and a project with a run in flight keeps `▶1` at 46px.
 *
 * The rest descend by how much the person is on the hook for it — waiting-on-you, then what broke,
 * then what merely stopped, then what worked.
 */
export const PILL_ORDER = ["running", "waiting", "error", "warning", "success"] as const;
export type PillKind = (typeof PILL_ORDER)[number];

/** Which of the two kinds a pill is. See the module comment — this is what decides fill. */
export function pillFill(kind: PillKind): "active" | "status" {
  return kind === "running" || kind === "waiting" ? "active" : "status";
}

/** Glyphs, from the `BADGE` map the board already used. The set is split, not replaced. */
export const PILL_GLYPH: Record<PillKind, string> = {
  running: "▶",
  waiting: "⏸",
  error: "⛔",
  warning: "⚠",
  success: "✓",
};

/** What each pill is called where there is room for a word instead of a count (§5.3). */
export const PILL_WORD: Record<PillKind, string> = {
  running: "running",
  waiting: "waiting",
  error: "failed",
  warning: "stopped",
  success: "done",
};

/**
 * Which pill a status is, or `null` for one that is neither.
 *
 * `queued` is the `null`: nothing is happening and nothing has happened, so it belongs in a total or
 * nowhere. Giving it a pill would put a mark against every task somebody created and has not started.
 *
 * `blocked` folds into `⏸` beside `waiting_for_user`, which costs nothing structurally — `laneOf`
 * already folds both into the `paused` lane — and is right for a person: a workflow gate and a tool
 * approval are both "it stopped, and it is on you". The APPROVALS STRIP still tells them apart,
 * because there the difference is real: an approval has an agent's tool loop parked behind it.
 *
 * OPEN (SHELL.md §9.1): `interrupted` is filed under ⚠ here, because the active set is defined as
 * exactly working and waiting-on-you, and an interrupted run is neither. But `laneOf` calls it "a
 * pause somebody has to end — not a failure", and a person may well read it as theirs to resume. If
 * it becomes active it needs a third active glyph and `PILL_ORDER` grows an entry; the change starts
 * at this one line.
 */
export function pillKindOf(status: TaskStatus | InstanceStatus | undefined): PillKind | null {
  switch (status) {
    case "running":
      return "running";
    case "waiting_for_user":
    case "blocked":
      return "waiting";
    case "failed":
    case "timeout":
      return "error";
    case "interrupted":
    case "canceled":
      return "warning";
    case "completed":
      return "success";
    default:
      return null;
  }
}

export type PillCounts = Partial<Record<PillKind, number>>;

/** Add one status to a tally. A status that is neither pill is dropped, which is the point. */
export function tally(counts: PillCounts, status: TaskStatus | InstanceStatus | undefined): PillCounts {
  const kind = pillKindOf(status);
  if (kind !== null) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/** Every item in a tally, whatever kind. What `+N` counts up to. */
export function pillTotal(counts: PillCounts): number {
  return PILL_ORDER.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

/**
 * A project's tasks as pills.
 *
 * The one piece of arithmetic worth stating: `waiting` is a SUBSET of `running` — a task parked at a
 * gate is `running` in the runtime row and says so nowhere else — so `▶` is what is left after the
 * parked ones are taken out. Counting both from `running` would show the same task twice and make
 * `▶2 ⏸2` mean two tasks.
 */
export function projectCounts(summary: Pick<ProjectSummary, "statuses" | "waiting">): PillCounts {
  const counts: PillCounts = {};
  const add = (kind: PillKind, n: number): void => {
    if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
  };
  add("running", Math.max(0, (summary.statuses.running ?? 0) - summary.waiting));
  add("waiting", summary.waiting);
  add("error", summary.statuses.failed ?? 0);
  add("warning", (summary.statuses.interrupted ?? 0) + (summary.statuses.canceled ?? 0));
  add("success", summary.statuses.completed ?? 0);
  // `queued` is deliberately absent: nothing is happening and nothing has happened. See `pillKindOf`.
  return counts;
}

/*
 * How wide a pill is, near enough to decide what fits.
 *
 * Estimated rather than measured: measuring costs a layout pass per row per render, and the only
 * decision resting on it is how many pills to draw — a job an estimate that is a pixel or two out
 * does exactly as well. The numbers are the `.pill` box at the default `--size-data`; a larger data
 * size makes real pills wider than this thinks, which costs at most one pill of the fold.
 */
const PILL_PAD = 13;
const PILL_GLYPH_W = 9;
const PILL_DIGIT_W = 6;
const PILL_GAP = 4;

const pillWidth = (digits: number): number => PILL_PAD + PILL_GLYPH_W + PILL_DIGIT_W * digits;
/** `+N` carries no glyph — the `+` sits where one would. */
const overflowWidth = (digits: number): number => PILL_PAD + PILL_DIGIT_W * (digits + 1);

export interface PillLayout {
  fit: { kind: PillKind; n: number }[];
  /** How many ITEMS did not fit — not how many kinds. */
  rest: number;
}

/**
 * Which pills fit in `budget` pixels, and what is left over.
 *
 * `+N` counts **items**, not kinds. The number a person wants from a fold is how much is behind it,
 * and it is the number that shrinks as they work through it; "three kinds are hidden" is a fact
 * about the layout rather than about the work.
 *
 * Room for `+N` is reserved BEFORE a pill is admitted, so the last one in cannot be the reason the
 * overflow has nowhere to go. The first kind in the order goes in regardless: a budget too small for
 * one pill is too small to say anything, and what it would otherwise say is `+5` — which is the one
 * reading that hides a live run.
 */
export function layoutPills(counts: PillCounts, budget: number): PillLayout {
  const present = PILL_ORDER.filter((kind) => (counts[kind] ?? 0) > 0);
  const total = pillTotal(counts);
  // Sized for the worst case — everything folding — so the reserve cannot grow after the fact and
  // push back out the last pill it let in.
  const reserve = overflowWidth(String(total).length);
  const fit: PillLayout["fit"] = [];
  let used = 0;
  for (const kind of present) {
    const n = counts[kind] ?? 0;
    const width = (fit.length === 0 ? 0 : PILL_GAP) + pillWidth(String(n).length);
    // Only owed while something would still be behind the fold.
    const owed = present.length - fit.length - 1 > 0 ? PILL_GAP + reserve : 0;
    if (used + width + owed > budget && fit.length > 0) break;
    fit.push({ kind, n });
    used += width;
  }
  const shown = new Set(fit.map((f) => f.kind));
  return { fit, rest: PILL_ORDER.reduce((sum, k) => sum + (shown.has(k) ? 0 : (counts[k] ?? 0)), 0) };
}

/**
 * One pill: a glyph, and either a count or a word.
 *
 * `word` is what the board card uses (§5.3) — a card is one task, so "how many" is always one and
 * saying so is noise, while "running" is what the column sorts itself by before a title is read.
 */
export function Pill({
  kind,
  n,
  word,
  title,
}: {
  kind: PillKind;
  n?: number;
  word?: string;
  title?: string;
}): JSX.Element {
  return (
    <span className={`pill pill-${kind} pill-${pillFill(kind)}`} {...(title !== undefined ? { title } : {})}>
      <span className="pill-glyph">{PILL_GLYPH[kind]}</span>
      {word !== undefined ? <span className="pill-word">{word}</span> : null}
      {n !== undefined ? <span className="pill-n data-num">{n}</span> : null}
    </span>
  );
}

/**
 * A row of pills, folded to fit.
 *
 * `budget` is the pixels the caller can spare — a sidebar row's trailing space, a card's head row. It
 * is passed rather than measured for the same reason `pillWidth` is estimated: it decides how many
 * pills to draw, and nothing downstream needs the answer to be exact.
 */
export function Pills({
  counts,
  budget,
  onClear,
}: {
  counts: PillCounts;
  budget: number;
  /** Marking this row's share seen — see §4.3. Absent where the pills are live facts only. */
  onClear?: (() => void) | undefined;
}): JSX.Element | null {
  const { fit, rest } = layoutPills(counts, budget);
  if (fit.length === 0) return null;
  return (
    <span className="pills" {...(onClear !== undefined ? { onClick: onClear } : {})}>
      {fit.map(({ kind, n }) => (
        <Pill key={kind} kind={kind} n={n} title={`${n} ${kind}`} />
      ))}
      {rest > 0 ? (
        // OPEN (SHELL.md §9.2): `+N` is colourless, so a folded error looks like a folded success.
        // Tinting it to the most severe kind it hides is the recommendation, and it is one line —
        // add ` pill-${worstHidden}` here, where `worstHidden` is the last kind of PILL_ORDER not in
        // `fit` that has a count. Left colourless until that is decided, because a `+4` that is
        // sometimes red and sometimes not is harder to read than one that is never either.
        <span className="pill pill-more" title={`${rest} more`}>
          <span className="pill-n data-num">+{rest}</span>
        </span>
      ) : null}
    </span>
  );
}
