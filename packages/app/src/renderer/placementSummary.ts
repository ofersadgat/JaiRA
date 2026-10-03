/**
 * How a conversation came to run where it does, as the work summary tells work: phases of actions
 * (decision 0013 §5, ruled 2026-10-02). `PlacementSummary.tsx` draws it above the message, which is not
 * sent until it has somewhere to go.
 *
 *   Placing     each workspace asked is an action. One that has no room, or does not answer, is an
 *               action that failed (`3 workspaces asked 2✕`); a wait before asking again is one too.
 *               It ends in where the task went (`→ this machine / mist-server-3`).
 *   Starting    what was then done to get it going: its worktree made, its workflow pinned, the agent
 *               launched.
 *
 * A phase in progress shows its latest actions under it; a finished one rolls up to its chips. While
 * nothing has room the phase is Placing still, in the waiting tone, and keeps counting. A move between
 * machines, one day, is a third phase in the same grammar.
 */
import type { PlacementAsk, PlacementNote, QueuedPlacement, RunTarget, StartStep } from "@jaira/shared/browser";
import { folderOf } from "./environmentModel";
import type { Said } from "./workSummary";

export type PlaceIcon = "folder" | "clock" | "arrow" | "pin" | "git" | "play";
/** What a chip is coloured as: an ask, a wait, where it went, and the three kinds of start step. */
export type PlaceHue = "ask" | "wait" | "found" | "pin" | "git" | "launch";

export interface PlaceChip {
  key: string;
  icon: PlaceIcon;
  hue: PlaceHue;
  label: string;
  /** How many of the actions it counts failed. */
  failed: number;
  /** Going on now: drawn with the pulse. */
  live?: true;
}

export interface PlaceRow {
  key: string;
  at?: number;
  icon: PlaceIcon;
  /** The machine the action was about: its row wears that machine's icon. */
  machineId?: string;
  said: Said[];
  /** Why the action failed, as its tag. */
  refused?: string;
  wait?: true;
  live?: true;
  /** How long it took; or, going on now, since when. */
  tookMs?: number;
  since?: number;
}

export interface PlacePhase {
  name: string;
  /** `current`: in progress. `waiting`: in progress, and nothing has room. `done`: rolled up. */
  state: "current" | "waiting" | "done";
  chips: PlaceChip[];
  /** Its latest actions, drawn under it while it is in progress. */
  rows: PlaceRow[];
  since: number;
  /** When it ended; absent while it is in progress. */
  until?: number;
}

export interface PlaceSummary {
  phases: PlacePhase[];
  /** Every action known, in order — what "Every step" opens. */
  every: PlaceRow[];
  /** How many actions there were in all (more than `every` holds, once it has asked more than one round). */
  steps: number;
  since: number;
  until?: number;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A workspace as a row names it: `machine / folder`, the engine's own machine being "this machine". */
export function askNameOf(ask: Pick<PlacementAsk, "machineId" | "label" | "dir">, selfId: string | undefined): string {
  return `${ask.machineId === selfId ? "this machine" : ask.label} / ${folderOf(ask.dir)}`;
}

function askRows(asks: readonly PlacementAsk[], selfId: string | undefined): PlaceRow[] {
  return asks.map((ask, i) => ({
    key: `ask:${i}:${ask.project}`,
    at: ask.at,
    icon: "folder" as const,
    machineId: ask.machineId,
    said: [{ text: "Asked " }, { code: askNameOf(ask, selfId) }],
    ...(ask.why !== undefined ? { refused: `refused · ${ask.why}` } : {}),
  }));
}

/** What a wait is before: asking the one workspace, the one machine, or everything again. */
function againWords(target: RunTarget | undefined, asks: readonly PlacementAsk[], selfId: string | undefined): string {
  if (target?.project !== undefined) {
    const ask = asks.find((a) => a.project === target.project);
    return ask !== undefined ? `asking ${folderOf(ask.dir)} again` : "asking that workspace again";
  }
  if (target?.machine !== undefined) {
    const ask = asks.find((a) => a.machineId === target.machine);
    return `asking ${target.machine === selfId ? "this machine" : (ask?.label ?? "that machine")} again`;
  }
  return "asking again";
}

function askChips(asked: number, refused: number, waits: number): PlaceChip[] {
  const chips: PlaceChip[] = [];
  if (asked > 0) chips.push({ key: "asked", icon: "folder", hue: "ask", label: `${count(asked, "workspace")} asked`, failed: refused });
  if (waits > 0) chips.push({ key: "waits", icon: "clock", hue: "wait", label: count(waits, "wait"), failed: 0 });
  return chips;
}

/** The rounds before the latest, which nothing kept row by row: one line for all of them. */
function earlierRow(asked: number, shown: number): PlaceRow[] {
  const earlier = asked - shown;
  return earlier > 0 ? [{ key: "earlier", icon: "folder", said: [{ text: `Asked ${count(earlier, "workspace")} before that: none had room` }] }] : [];
}

const STEP_WORDS: Record<StartStep["kind"], { icon: PlaceIcon; hue: PlaceHue; chip: string; said: (what: string) => Said[] }> = {
  workspace: { icon: "git", hue: "git", chip: "worktree", said: (what) => [{ text: "Made the worktree for " }, { code: what }] },
  pin: { icon: "pin", hue: "pin", chip: "snapshot", said: (what) => [{ text: "Pinned " }, { code: what }, { text: " as it is now" }] },
};

/**
 * The summary of a task that is being placed or waits (`queued`), or of one that was placed (`placed`,
 * with `starting` while its run has said nothing yet). Nothing for a task that was never placed: a
 * project with one workspace asks nobody.
 */
export function placementSummaryOf(input: { queued?: QueuedPlacement | undefined; placed?: PlacementNote | undefined; starting?: boolean; agent?: string | undefined; selfId?: string | undefined }): PlaceSummary | undefined {
  const { queued, placed, selfId } = input;
  if (placed !== undefined) {
    const where = `${placed.on.machineId === selfId ? "this machine" : placed.on.label} / ${folderOf(placed.on.dir)}`;
    const found: PlaceChip = { key: "found", icon: "arrow", hue: "found", label: where, failed: 0 };
    const placing: PlacePhase = {
      name: "Placed",
      state: "done",
      chips: [...(placed.byHand === true ? [{ key: "hand", icon: "arrow" as const, hue: "ask" as const, label: "sent by hand", failed: 0 }] : []), ...askChips(placed.asked, placed.refused, placed.waits), found],
      rows: [],
      since: placed.since,
      until: placed.at,
    };
    const steps = placed.steps ?? [];
    const stepRows: PlaceRow[] = steps.map((step, i) => ({ key: `step:${i}`, at: step.at, icon: STEP_WORDS[step.kind].icon, said: STEP_WORDS[step.kind].said(step.what), tookMs: step.tookMs }));
    const last = steps.at(-1);
    const prepared = last !== undefined ? last.at + last.tookMs : placed.at;
    const starting = input.starting === true;
    const launch: PlaceRow = {
      key: "launch",
      at: prepared,
      icon: "play",
      said: [{ text: starting ? "Launching " : "Launched " }, ...(input.agent !== undefined ? [{ code: input.agent }, { text: " in " }] : [{ text: "the agent in " }]), { code: folderOf(placed.on.dir) }],
      ...(starting ? { live: true as const, since: prepared } : {}),
    };
    const kinds = [...new Set(steps.map((s) => s.kind))];
    const start: PlacePhase = {
      name: starting ? "Starting" : "Started",
      state: starting ? "current" : "done",
      chips: [
        ...kinds.map((kind) => ({ key: kind, icon: STEP_WORDS[kind].icon, hue: STEP_WORDS[kind].hue, label: count(steps.filter((s) => s.kind === kind).length, STEP_WORDS[kind].chip), failed: 0 })),
        starting ? { key: "launch", icon: "play" as const, hue: "launch" as const, label: "launching", failed: 0, live: true as const } : { key: "launch", icon: "play" as const, hue: "launch" as const, label: input.agent ?? "agent", failed: 0 },
      ],
      rows: starting ? [...stepRows, launch] : [],
      since: placed.at,
      ...(starting ? {} : { until: prepared }),
    };
    const went: PlaceRow = { key: "found", at: placed.at, icon: "arrow", machineId: placed.on.machineId, said: [{ text: placed.byHand === true ? "Sent by hand to " : "Placed on " }, { code: where }] };
    return {
      phases: [placing, start],
      every: [...earlierRow(placed.asked, placed.asks.length), ...askRows(placed.asks, selfId), went, ...stepRows, launch],
      steps: placed.asked + placed.waits + 1 + steps.length + 1,
      since: placed.since,
      ...(starting ? {} : { until: prepared }),
    };
  }
  if (queued === undefined) return undefined;
  const waiting = queued.phase === "waiting";
  const rows = askRows(queued.asks, selfId);
  const wait: PlaceRow[] =
    waiting && queued.askedAt !== undefined
      ? [
          {
            key: "wait",
            at: queued.askedAt,
            icon: "clock",
            wait: true,
            said: [{ text: `Waiting ${Math.round(((queued.nextAt ?? queued.askedAt) - queued.askedAt) / 1000)} s before ${againWords(queued.target, queued.asks, selfId)}` }],
            since: queued.askedAt,
          },
        ]
      : [];
  const chips = askChips(queued.asked, queued.refused, queued.waits);
  const placing: PlacePhase = {
    name: "Placing",
    state: waiting ? "waiting" : "current",
    chips: chips.length > 0 || waiting ? chips : [{ key: "asking", icon: "folder", hue: "ask", label: "asking", failed: 0, live: true }],
    rows: [...rows, ...wait],
    since: queued.since,
  };
  return { phases: [placing], every: [...earlierRow(queued.asked, queued.asks.length), ...rows, ...wait], steps: queued.asked + queued.waits, since: queued.since };
}
