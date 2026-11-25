/**
 * The inbox strip as project lanes (the status-bar mockups of 2026-11-24, round 2, design 09 "lane-lite":
 * `docs/ui/assets/inbox-strip/explore-status-bar-2.html`). The person, on the old strip: "it wastes space
 * duplicating the project for multiple chats/tasks within the project", "the message itself belongs to a
 * nested task, but presented at top level, so you have no idea what top level thing its talking about",
 * "i think grouping multiple things by top level task is better", and "the bottom panel says awaiting 4,
 * but only has 2 and there a button +2 more when there is clearly space for them to fit".
 *
 * So the strip lists the TOP-LEVEL chats and tasks that something under them asks, each once, with every
 * ask under it gathered on its ring, and those under the project they belong to, which is named once per
 * lane. And what folds is decided by the room there is, measured, not by a fixed three.
 *
 * Pure: `InboxStrip.tsx` draws it, and measures the words it hands {@link fitLanes}.
 */
import type { LiveTask, PendingApproval, PendingInteraction, PendingQuestion, ProjectTask } from "@jaira/shared/browser";
import { parentTaskOf } from "@jaira/shared/browser";
import type { RingItem } from "./ringModel";

/** What one request asks, in the order an agent is blocked on them: a question, then an approval, then a gate. */
export type AskKind = "question" | "approval" | "gate";
const RANK: Record<AskKind, number> = { question: 0, approval: 1, gate: 2 };

/** One request, filed under the top-level task it rolls up to. */
export interface LaneAsk {
  requestId: string;
  kind: AskKind;
  /** The task that parked it — where it is answered. */
  taskId: string | undefined;
  /** The project that task is recorded in. */
  project: string;
  /** What it asks, in a line: the question, the command, the gate's prompt. */
  text: string;
  /** The titles from under the top-level task down to the one that asks; empty when it asks itself. */
  path: string[];
  /** When it was asked, as near as the record says. */
  since: number;
}

/** A top-level chat or task, and everything under it that asks. */
export interface LaneEntry {
  /** The top-level task, or the request's own id when nothing names a task. */
  key: string;
  taskId: string | undefined;
  project: string;
  title: string;
  /** Its asks, the most pressing first. */
  asks: LaneAsk[];
  /** What its ring holds: one wait per ask, and work while it or a task that asks is running. */
  ring: RingItem[];
}

/** A project's lane: its entries, the most pressing first. */
export interface Lane {
  project: string;
  entries: LaneEntry[];
  /** How many requests wait in it. */
  asks: number;
}

export interface LaneInputs {
  pending: readonly PendingInteraction[];
  approvals: readonly PendingApproval[];
  questions: readonly PendingQuestion[];
  /** Every task the window holds (`AppState.allTasks`): their titles and the parent links followed up. */
  tasks: readonly Pick<ProjectTask, "taskId" | "project" | "title" | "origin" | "parentTaskId" | "updatedAt">[];
  /** The projects' live tasks — when a gate was parked, and what is working. */
  projects: ReadonlyArray<{ live?: readonly LiveTask[] | undefined }>;
  now: number;
}

/** The gate's prompt when it has one, else its function in words: `choose_option` → "choose option". */
function gateText(p: PendingInteraction): string {
  const prompt = p.config?.prompt ?? (typeof p.inputs.prompt === "string" ? p.inputs.prompt : undefined);
  const line = typeof prompt === "string" ? prompt.split("\n").map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find((l) => l.length > 0) : undefined;
  return line ?? p.component.replace(/[_-]+/g, " ").trim();
}

/** Every waiting request, filed under its top-level task, and those under their projects. */
export function inboxLanesOf(input: LaneInputs): Lane[] {
  const byId = new Map(input.tasks.map((t) => [t.taskId, t] as const));
  const liveWait = new Map<string, number>();
  const running = new Map<string, number>();
  for (const p of input.projects) {
    for (const t of p.live ?? []) {
      if (t.kind === "waiting") liveWait.set(t.taskId, Math.min(liveWait.get(t.taskId) ?? Infinity, t.since));
      else running.set(t.taskId, Math.min(running.get(t.taskId) ?? Infinity, t.since));
    }
  }
  /** The top-level task over `taskId`, and the titles from under it down to `taskId` — cycle-safe. */
  const rootOf = (taskId: string): { root: string; path: string[] } => {
    const chain = [taskId];
    const seen = new Set(chain);
    let at = byId.get(taskId);
    while (at !== undefined) {
      const parent = parentTaskOf(at);
      if (parent === undefined || seen.has(parent) || !byId.has(parent)) break;
      chain.push(parent);
      seen.add(parent);
      at = byId.get(parent);
    }
    const root = chain[chain.length - 1]!;
    const path = chain.slice(0, -1).reverse().map((id) => byId.get(id)?.title ?? id);
    return { root, path };
  };

  const asks: LaneAsk[] = [
    ...input.questions.map((q): LaneAsk => ({ requestId: q.requestId, kind: "question", taskId: q.taskId, project: q.project, text: q.questions[0]?.question ?? "the agent has a question", path: [], since: q.at })),
    ...input.approvals.map((a): LaneAsk => ({ requestId: a.requestId, kind: "approval", taskId: a.taskId, project: a.project, text: a.command ?? a.tool, path: [], since: a.at })),
    ...input.pending
      .filter((p) => p.moves !== true)
      .map((p): LaneAsk => ({
        requestId: p.requestId,
        kind: "gate",
        taskId: p.taskId,
        project: p.project,
        text: gateText(p),
        path: [],
        since: liveWait.get(p.taskId) ?? byId.get(p.taskId)?.updatedAt ?? input.now,
      })),
  ];

  const entries = new Map<string, LaneEntry>();
  for (const ask of asks) {
    const found = ask.taskId !== undefined ? rootOf(ask.taskId) : undefined;
    const root = found !== undefined ? byId.get(found.root) : undefined;
    const key = found?.root ?? ask.requestId;
    const entry = entries.get(key) ?? {
      key,
      taskId: found?.root,
      project: root?.project ?? ask.project,
      title: root?.title ?? (ask.taskId !== undefined ? byId.get(ask.taskId)?.title ?? ask.taskId : ask.text),
      asks: [],
      ring: [],
    };
    entry.asks.push({ ...ask, path: found?.path ?? [] });
    entries.set(key, entry);
  }

  const pressing = (a: { kind: AskKind; since: number }, b: { kind: AskKind; since: number }): number => RANK[a.kind] - RANK[b.kind] || a.since - b.since;
  for (const entry of entries.values()) {
    entry.asks.sort(pressing);
    entry.ring = entry.asks.map((a): RingItem => ({ kind: "waiting", since: a.since }));
    const working = [entry.taskId, ...entry.asks.map((a) => a.taskId)].map((id) => (id === undefined ? undefined : running.get(id))).filter((s): s is number => s !== undefined);
    if (working.length > 0) entry.ring.push({ kind: "running", since: Math.min(...working) });
  }
  const sorted = [...entries.values()].sort((a, b) => pressing(a.asks[0]!, b.asks[0]!));
  const lanes = new Map<string, Lane>();
  for (const entry of sorted) {
    const lane = lanes.get(entry.project) ?? { project: entry.project, entries: [], asks: 0 };
    lane.entries.push(entry);
    lane.asks += entry.asks.length;
    lanes.set(entry.project, lane);
  }
  return [...lanes.values()];
}

/** An entry's tooltip: its title, then each ask with the tasks down to it. */
export function entryTitle(entry: LaneEntry): string {
  return [entry.title, ...entry.asks.map((a) => `  ${[...a.path, a.text].join(" › ")}`)].join("\n");
}

/* ---------------- fitting the lanes into the room there is ---------------- */

/** How a lane is drawn: its entries with titles, its entries as rings only, folded to one ring, or left out. */
export type LaneMode = "titles" | "rings" | "folded" | "hidden";

export interface LaneFit {
  modes: LaneMode[];
  /** The widest a title may be drawn; narrower than its own width cuts it with an ellipsis. */
  titleMax: number;
  /** Requests in lanes left out, for "+N more". */
  more: number;
}

/** The strip's measures, in px — what `InboxStrip.tsx` draws them at. */
export const LANE_METRICS = {
  /** Between two lanes. */
  laneGap: 0,
  /** A lane's padding on each side, and its hued edge. */
  lanePad: 12,
  laneEdge: 2,
  /** The project's dot and the gap after it. */
  dot: 7 + 5,
  /** Between the lane's name and its entries, and between two entries (titles / rings only). */
  headGap: 8,
  entryGap: 12,
  ringGap: 5,
  ring: 22,
  /** Between a ring and its title. */
  ringTitle: 6,
  /** A folded lane: its ring and its count after the name. */
  folded: 22 + 5 + 22,
  fullTitle: 220,
  shortTitle: 120,
  /** "+N more" and the gap before it. */
  more: 64,
} as const;

/** What has to be measured: a title in the app face, a project's name in the data face. */
export interface Measure {
  title: (text: string) => number;
  name: (text: string) => number;
}

/**
 * The least folding that fits `width`, in steps that each give up a little more: titles cut short; the
 * last lanes' titles dropped, then theirs folded, back to the second; the first lane's titles dropped;
 * then lanes left out from the end, counted in "+N more". The first lane holds the most pressing ask, so
 * it keeps its words longest.
 */
export function fitLanes(lanes: readonly Lane[], width: number, measure: Measure, m: typeof LANE_METRICS = LANE_METRICS): LaneFit {
  const n = lanes.length;
  const names = lanes.map((l) => measure.name(l.project));
  const titles = lanes.map((l) => l.entries.map((e) => measure.title(e.title)));
  const laneWidth = (i: number, mode: LaneMode, titleMax: number): number => {
    if (mode === "hidden") return 0;
    const head = m.lanePad * 2 + m.laneEdge + m.dot + names[i]!;
    if (mode === "folded") return head + m.headGap + m.folded;
    const k = lanes[i]!.entries.length;
    if (mode === "rings") return head + m.headGap + k * m.ring + (k - 1) * m.ringGap;
    const words = titles[i]!.reduce((sum, w) => sum + m.ring + m.ringTitle + Math.min(w, titleMax), 0);
    return head + m.headGap + words + (k - 1) * m.entryGap;
  };
  const total = (modes: LaneMode[], titleMax: number): number => {
    const shown = modes.filter((x) => x !== "hidden").length;
    const more = modes.some((x) => x === "hidden") ? m.more : 0;
    return modes.reduce((sum, mode, i) => sum + laneWidth(i, mode, titleMax), 0) + Math.max(0, shown - 1) * m.laneGap + more;
  };
  const moreOf = (modes: LaneMode[]): number => modes.reduce((sum, mode, i) => sum + (mode === "hidden" ? lanes[i]!.asks : 0), 0);
  const steps: Array<{ modes: LaneMode[]; titleMax: number }> = [];
  const modes: LaneMode[] = lanes.map(() => "titles");
  steps.push({ modes: [...modes], titleMax: m.fullTitle });
  steps.push({ modes: [...modes], titleMax: m.shortTitle });
  for (let i = n - 1; i >= 1; i--) {
    modes[i] = "rings";
    steps.push({ modes: [...modes], titleMax: m.shortTitle });
  }
  // A lane is folded only where that saves room: two rings are no wider than one ring and a count.
  for (let i = n - 1; i >= 1; i--) {
    if (laneWidth(i, "folded", 0) >= laneWidth(i, "rings", 0)) continue;
    modes[i] = "folded";
    steps.push({ modes: [...modes], titleMax: m.shortTitle });
  }
  if (n > 0) {
    modes[0] = "rings";
    steps.push({ modes: [...modes], titleMax: m.shortTitle });
  }
  for (let i = n - 1; i >= 1; i--) {
    modes[i] = "hidden";
    steps.push({ modes: [...modes], titleMax: m.shortTitle });
  }
  // Each step gives up more than the one before it, so the first that fits is the least folding.
  const fits = steps.find((s) => total(s.modes, s.titleMax) <= width) ?? steps[steps.length - 1]!;
  return { modes: fits.modes, titleMax: fits.titleMax, more: moreOf(fits.modes) };
}
