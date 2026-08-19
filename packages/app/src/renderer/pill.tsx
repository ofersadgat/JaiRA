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

/**
 * The same five, ordered by how much they WANT ATTENTION rather than by how much room they deserve.
 *
 * Not {@link PILL_ORDER} and not its reverse. That one is a claim about space — `running` heads it so
 * no width can hide a live run — and this one is a claim about alarm, which are different questions
 * with different answers at both ends: `running` is the most important to SHOW and among the least
 * alarming to have hidden, because it will say so again by itself.
 *
 * Read by the overflow pill, which tints itself to the worst thing behind the fold (§9.2). Without it
 * a folded error and a folded success are the same grey `+4`, which is the one reading the fold must
 * not produce.
 */
const PILL_SEVERITY: readonly PillKind[] = ["error", "warning", "waiting", "running", "success"];

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
 * `interrupted` is a WARNING (SHELL.md §9.1, decided). The active set is exactly working and
 * waiting-on-you, and an interrupted run is neither: nothing is happening and nothing is being asked
 * of you until you go and restart it. `laneOf` still calls it "a pause somebody has to end", which is
 * true and is a fact about the LANE — where it sits among the cards — rather than about whether the
 * row it is counted on should read as live.
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
 * The colour that stands for one project, as a CSS variable name.
 *
 * The project is the head of every address, and it appears in four places that are nowhere near each
 * other: a dot on its sidebar row, its tile in the collapsed rail, the head crumb of the address bar,
 * and its chip on the inbox strip. One hue ties those together — it is how "this row, that crumb and
 * that pending approval are the same project" is answered without reading three directory names.
 *
 * Three hues, cycled. Not one per project: a palette that grows without bound stops being a code, and
 * three is what a person can hold while two or three checkouts are open — which is what the window is
 * for. Two projects sharing a hue at four-deep is a smaller cost than a fourth colour nobody can name.
 *
 * The shared root and JaiRA's own take the GREY. They are not projects a person is working in — they
 * are the machine's — so they sit outside the code rather than consuming one of its entries.
 */
export function hueOf(kind: ProjectSummary["kind"], index: number): string {
  return kind === "user" ? `var(--p${(index % 3) + 1})` : "var(--p0)";
}

/** What `projectCounts` needs of a project — the live tallies, and the rows a watermark filters. */
export type CountedProject = Pick<ProjectSummary, "statuses" | "waiting" | "ended">;

/**
 * A project's tasks as pills: the active ones live, the status ones UNSEEN (SHELL.md §4.3).
 *
 * Two pieces of arithmetic are worth stating.
 *
 * **`waiting` is a subset of `running`** — a task parked at a gate is `running` in the runtime row
 * and says so nowhere else — so `▶` is what is left once the parked ones are taken out. Counting
 * both straight off `running` would show the same task twice and make `▶2 ⏸2` mean two tasks.
 *
 * **The two kinds count different populations.** An active pill is a live fact and is always true;
 * a status pill counts only what has changed since this person last looked, which is why the second
 * half filters on the watermark and the first half does not.
 *
 * That split is deliberate and settled (SHELL.md §9.3, decided). It does mean `▶2` and `✓3` on one
 * row count different populations, and that is the price of what the pills are FOR: knowing what is
 * happening without opening the view. Unseen-scoping the active kinds would clear `▶2` the moment
 * somebody glanced at the row — leaving two runs going and nothing on screen saying so, which is the
 * one question these rows exist to answer. A live fact is worth stating every time it is true.
 */
export function projectCounts(summary: CountedProject, seen: Readonly<Record<string, number>> = {}): PillCounts {
  const counts: PillCounts = {};
  const add = (kind: PillKind, n: number): void => {
    if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
  };
  add("running", Math.max(0, (summary.statuses.running ?? 0) - summary.waiting));
  add("waiting", summary.waiting);
  // `queued` never reaches here: it is not in `ended`, and it has no pill. See `pillKindOf`.
  for (const task of summary.ended) {
    if ((seen[task.taskId] ?? 0) >= task.updatedAt) continue;
    const kind = pillKindOf(task.status);
    if (kind !== null) add(kind, 1);
  }
  return counts;
}

/**
 * The tasks a row's status pills are counting — what "mark this seen" has to mark.
 *
 * Returned as the pairs rather than the ids: the watermark is monotonic and per task, so clearing a
 * row means moving each of its marks to that task's own clock. Moving them all to "now" would also
 * swallow a turn that landed in the same millisecond as the click.
 */
export function unseenTasks(
  summary: CountedProject,
  seen: Readonly<Record<string, number>> = {},
): { taskId: string; at: number }[] {
  return summary.ended
    .filter((task) => (seen[task.taskId] ?? 0) < task.updatedAt && pillKindOf(task.status) !== null)
    .map((task) => ({ taskId: task.taskId, at: task.updatedAt }));
}

/** The least a row has to know about a task to be counted: what it is doing, and when it last did. */
export type CountedTask = { taskId: string; status: TaskStatus; updatedAt: number };

/**
 * A named LIST of tasks as pills — what a view row counts, where a project row counts a summary.
 *
 * The difference is the population, and it is the whole reason this exists beside
 * {@link projectCounts}. A project row answers "how much is in this project"; a view row answers
 * "how much of it is in HERE", and the two rooms inside a project hold different things. A summary
 * cannot be asked that — `ended` carries no workflow, so nothing in it says which rows are
 * conversations — but the lists the views are drawn from can, because they ARE the rows.
 *
 * Same split as `projectCounts` on what the watermark applies to: an active pill is a live fact and
 * is always true, a status pill counts only what has stopped since this person last looked.
 *
 * `waiting` is the one thing it cannot see. Whether a running task is parked on a person is counted
 * from the session's own requests and is not on the task row, so a conversation waiting on an
 * answer reads as `▶` here and is broken out only on the project row above. That is a fair trade
 * for a view row: it is a pointer to where to look, and it does point.
 */
export function taskCounts(rows: readonly CountedTask[], seen: Readonly<Record<string, number>> = {}): PillCounts {
  const counts: PillCounts = {};
  for (const row of rows) {
    const kind = pillKindOf(row.status);
    if (kind === null) continue;
    if (pillFill(kind) === "status" && (seen[row.taskId] ?? 0) >= row.updatedAt) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** The rows a {@link taskCounts} status pill is counting — what "mark this row seen" has to mark. */
export function unseenRows(
  rows: readonly CountedTask[],
  seen: Readonly<Record<string, number>> = {},
): { taskId: string; at: number }[] {
  return rows
    .filter((row) => {
      // `queued` has no pill at all, so there is nothing about it to have seen — see `pillKindOf`.
      const kind = pillKindOf(row.status);
      return kind !== null && pillFill(kind) === "status" && (seen[row.taskId] ?? 0) < row.updatedAt;
    })
    .map((row) => ({ taskId: row.taskId, at: row.updatedAt }));
}

/** Two tallies added — how a root row sums the projects under it. */
export function addCounts(a: PillCounts, b: PillCounts): PillCounts {
  const out: PillCounts = { ...a };
  for (const kind of PILL_ORDER) {
    const n = (a[kind] ?? 0) + (b[kind] ?? 0);
    if (n > 0) out[kind] = n;
  }
  return out;
}

/**
 * One tally less another — how "everything here" becomes "everything here that is not a
 * conversation".
 *
 * Floored at zero per kind, because the two sides are counted from different places and can
 * disagree by one: `waiting` is broken out of `running` on a summary and is not visible on a task
 * row at all (see {@link taskCounts}). A negative count is not a number worth propagating, and the
 * kinds that can disagree are the live ones, which say so again a second later.
 */
export function minusCounts(all: PillCounts, part: PillCounts): PillCounts {
  const out: PillCounts = {};
  for (const kind of PILL_ORDER) {
    const n = Math.max(0, (all[kind] ?? 0) - (part[kind] ?? 0));
    if (n > 0) out[kind] = n;
  }
  return out;
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
  /**
   * The most alarming kind behind the fold, by {@link PILL_SEVERITY} — what `+N` takes its colour
   * from. `null` when nothing is folded.
   */
  worst: PillKind | null;
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
  const hidden = PILL_ORDER.filter((k) => !shown.has(k) && (counts[k] ?? 0) > 0);
  return {
    fit,
    rest: hidden.reduce((sum, k) => sum + (counts[k] ?? 0), 0),
    worst: PILL_SEVERITY.find((k) => hidden.includes(k)) ?? null,
  };
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
      {/* No register class on either: the PILL is the register (see `.pill`), and a `data-num` here
          would re-declare a size the pill has already settled. */}
      {word !== undefined ? <span className="pill-word">{word}</span> : null}
      {n !== undefined ? <span className="pill-n">{n}</span> : null}
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
  const { fit, rest, worst } = layoutPills(counts, budget);
  if (fit.length === 0) return null;
  return (
    <span
      className="pills"
      {...(onClear !== undefined
        ? { role: "button", title: "mark these seen", onClick: onClear }
        : {})}
    >
      {fit.map(({ kind, n }) => (
        <Pill key={kind} kind={kind} n={n} title={`${n} ${kind}`} />
      ))}
      {rest > 0 ? (
        // TINTED to the worst thing it hides (SHELL.md §9.2, decided). Colourless, a folded error and
        // a folded success were the same grey `+4` — the fold would have been hiding the one fact it
        // exists to summarise. It stays FLAT rather than filled: it is an overflow marker, not a
        // sixth status, and a filled `+4` would read as a live count of something.
        <span className={`pill pill-more${worst === null ? "" : ` pill-${worst}`}`} title={`${rest} more`}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
