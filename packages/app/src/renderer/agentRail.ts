/**
 * The agents a conversation started, as LANES on its rail (the person, 2026-11-14, rounds 1–5 of the
 * "agents on the rail" mockups): an agent is drawn the way a nested state is.
 *
 * An agent's rail is always to the RIGHT of the rail of the agent that started it (the person,
 * 2026-11-25: "the outer agents rail should go to the left of the inner agents rail"): the trunk stands
 * at the gutter's left edge, every lane of an agent it started between it and the conversation, and a
 * nested conversation's own rail to the right of all of them.
 *
 *   waited for    the conversation stops until it returns: its lane forks off the trunk to the right,
 *                 its conversation nested beside the lane (folded: the rail's bump with a plus).
 *   background    the conversation goes on while it works (`Async agent launched`): its lane leaves the
 *                 trunk into a gutter column to its right and runs down beside the conversation until it
 *                 returns — where its `task_notification` reached the conversation — curving back into
 *                 the trunk.
 *   crossover     a background agent the conversation then WAITS for (a blocking `TaskOutput` on its
 *                 agent id): its lane comes back to the trunk at a knot there and carries on into its nest.
 *   brought here  a background agent the person brings into the conversation: its lane is drawn as a
 *                 waited-for one at its fork (a filled knot), and pressing the lane sends it back. That is
 *                 the view's state, not the record's — {@link AgentLane} says only what the record does.
 *   resumed       a lane runs only while its agent does (the person, 2026-11-25): an agent the
 *                 conversation continues after it returned (`SendMessage` to its id, answered "Resuming
 *                 agent") is a NEW lane from that call — a run of the same agent, in its hue — and the
 *                 lane before it ended where that run returned.
 *
 * Pure: entries in, lanes out, so the rules can be tested without drawing anything.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { EventEntry, ToolEntry, TranscriptEntry } from "./transcript";
import { isHostCall as isHostWork } from "./workSummary";

/** What a row of the conversation is to an agent's lane. */
export type LaneMark = "fork" | "cross" | "back";

export interface AgentLane {
  /**
   * This lane's own key — what its rows are measured, opened and lit under: the agent's call for its
   * first run, the resuming call's id for a later one.
   */
  key: string;
  /** The call that started the agent: its conversation, its name and its hue (`ToolEntry.sidechain`). */
  call: string;
  /** A later run of an agent that had returned: which (1 for the first resume). */
  resumed?: number;
  /** The key of the agent's next run, when it was resumed after this one: this one ended before it. */
  next?: string;
  /** The agent's own id, from the note a background call answers with: what `TaskOutput` names. */
  agentId?: string;
  /** The conversation went on without waiting for it. */
  background: boolean;
  /** The entry of the call that started it. */
  fork: number;
  /** The entry where the conversation began waiting for it (background agents only). */
  cross?: number;
  /** The entry where its end reached the conversation (background agents only, not crossed over). */
  back?: number;
  /**
   * The gutter column its lane runs down in, right of the trunk: 1 is next to it. 0 for an agent with no
   * lane down the gutter (waited for from the start, or a background agent whose end the record never said).
   */
  column: number;
  /**
   * Agents the conversation started TOGETHER and waited for together (one turn, several calls in a
   * row): the first holds the calls of all of them, the rest name the first. They share one lane, and
   * opened, a concurrent band (`SessionBands.tsx`' columns or tabs) under it.
   */
  batch?: string[];
  inBatch?: string;
}

export interface AgentRail {
  lanes: AgentLane[];
  /** How many gutter columns the busiest stretch needs: the gutter's width is computed once from it. */
  columns: number;
  /** Which lane a row is a mark of, by the entry itself (blocks hold the same objects). */
  marks: Map<TranscriptEntry, { lane: AgentLane; mark: LaneMark }>;
}

const textOf = (value: JsonValue | undefined): string => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/** A background agent's call answers at once with this (`subagentModel.ts`' `isLaunchNote`). */
export const isLaunchNote = (result: JsonValue | undefined): boolean => textOf(result).includes("Async agent launched");

/** The agent id a background call's note names (`agentId: a3fb691e81b1a7512`). */
export function agentIdOf(result: JsonValue | undefined): string | undefined {
  const found = /agentId:\s*([A-Za-z0-9_-]+)/.exec(textOf(result));
  return found?.[1];
}

/** Whether a call asked for its agent to run in the background, before any answer says so. */
const askedBackground = (entry: ToolEntry): boolean => {
  const args = entry.args as Record<string, unknown> | null | undefined;
  return args !== null && typeof args === "object" && args["run_in_background"] === true;
};

/** The agent a call WAITS for: a `TaskOutput` that blocks (its default), and the id it names. */
export function waitedAgentOf(entry: TranscriptEntry): string | undefined {
  if (entry.kind !== "tool" || entry.name !== "TaskOutput") return undefined;
  const args = entry.args as Record<string, unknown> | null | undefined;
  if (args === null || typeof args !== "object" || args["block"] === false) return undefined;
  const id = args["task_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The agent a call continues: a `SendMessage` to an agent's id that resumed it — answered `resumedAgentId`,
 * or not answered yet. One answered otherwise (a message to a peer, a note to an agent still running) is
 * not a resume.
 */
export function resumedAgentOf(entry: TranscriptEntry): string | undefined {
  if (entry.kind !== "tool" || entry.name !== "SendMessage" || entry.calledBy !== undefined) return undefined;
  if (entry.result !== undefined) {
    const found = /resumedAgentId\\?"\s*:\s*\\?"([A-Za-z0-9_-]+)/.exec(textOf(entry.result));
    return found?.[1];
  }
  const args = entry.args as Record<string, unknown> | null | undefined;
  const to = args !== null && typeof args === "object" ? args["to"] : undefined;
  return typeof to === "string" && to.length > 0 ? to : undefined;
}

/** The call whose agent a `task_notification` event reports (its `tool_use_id`). */
export function notifiedCallOf(entry: TranscriptEntry): string | undefined {
  if (entry.kind !== "event") return undefined;
  const detail = (entry as EventEntry).detail as Record<string, unknown> | null | undefined;
  if (detail === null || typeof detail !== "object" || detail["subtype"] !== "task_notification") return undefined;
  const id = detail["tool_use_id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Every agent this conversation started, as a lane, with the rows that mark it.
 *
 * `running`: the agents still going (`subagentsOf`' rule, the host's to say) — a background agent still
 * running holds its column to the conversation's end, where its lane's live end is drawn. One that has
 * neither returned nor crossed over and is not running (an older record, kept before its end was) has no
 * left lane at all: a lane hanging to the foot would say it still runs.
 */
export function agentRailOf(entries: readonly TranscriptEntry[], running: ReadonlySet<string> = new Set()): AgentRail {
  const lanes: AgentLane[] = [];
  /** An agent's id → its call; a call → its latest run (what a notification or a wait now means). */
  const byAgent = new Map<string, string>();
  const byCall = new Map<string, AgentLane>();
  /** How many runs each agent has had. */
  const runs = new Map<string, number>();
  const marks = new Map<TranscriptEntry, { lane: AgentLane; mark: LaneMark }>();
  /**
   * The entry before `i` that is the conversation's own doing: not a call a tool made, not a thought, not
   * an event (a rate limit, a note) that arrived while the calls went out.
   */
  const lastFork = (i: number): number => {
    for (let j = i - 1; j >= 0; j--) {
      const e = entries[j]!;
      if (e.kind === "thought" || e.kind === "event" || e.kind === "writing" || (e.kind === "tool" && (e.calledBy !== undefined || isHostWork(e)))) continue;
      return j;
    }
    return -1;
  };
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === "tool" && entry.sidechain !== undefined && !byCall.has(entry.sidechain) && entry.calledBy === undefined) {
      const background = isLaunchNote(entry.result) || askedBackground(entry);
      const agentId = agentIdOf(entry.result);
      const lane: AgentLane = { key: entry.sidechain, call: entry.sidechain, ...(agentId !== undefined ? { agentId } : {}), background, fork: i, column: 0 };
      lanes.push(lane);
      byCall.set(lane.call, lane);
      runs.set(lane.call, 1);
      if (agentId !== undefined) byAgent.set(agentId, lane.call);
      marks.set(entry, { lane, mark: "fork" });
      // Started in the same breath as the waited-for agent just before it: one batch.
      const before = lanes[lanes.length - 2];
      if (!background && before !== undefined && !before.background && before.resumed === undefined && before.fork === lastFork(i)) {
        const head = before.inBatch !== undefined ? byCall.get(before.inBatch)! : before;
        head.batch = [...(head.batch ?? [head.call]), lane.call];
        lane.inBatch = head.call;
      }
      continue;
    }
    // An agent continued after it had returned: a new run, a new lane, from this call on.
    const resumed = resumedAgentOf(entry);
    const resumedCall = resumed !== undefined ? byAgent.get(resumed) : undefined;
    if (resumedCall !== undefined && entry.kind === "tool" && entry.callId !== undefined) {
      const was = byCall.get(resumedCall)!;
      const n = runs.get(resumedCall) ?? 1;
      const lane: AgentLane = { key: entry.callId, call: resumedCall, ...(was.agentId !== undefined ? { agentId: was.agentId } : {}), resumed: n, background: true, fork: i, column: 0 };
      was.next = lane.key;
      lanes.push(lane);
      byCall.set(resumedCall, lane);
      runs.set(resumedCall, n + 1);
      marks.set(entry, { lane, mark: "fork" });
      continue;
    }
    const waited = waitedAgentOf(entry);
    if (waited !== undefined) {
      const call = byAgent.get(waited);
      const lane = call !== undefined ? byCall.get(call) : undefined;
      if (lane !== undefined && lane.background && lane.cross === undefined && lane.back === undefined) {
        lane.cross = i;
        marks.set(entry, { lane, mark: "cross" });
      }
      continue;
    }
    const notified = notifiedCallOf(entry);
    if (notified !== undefined) {
      const lane = byCall.get(notified);
      if (lane !== undefined && lane.background && lane.cross === undefined && lane.back === undefined) {
        lane.back = i;
        marks.set(entry, { lane, mark: "back" });
      }
    }
  }
  // Gutter columns: a background lane takes the lowest column free at its fork, and frees it at the row
  // its lane ends on (its crossover or its return); one still running holds it to the end — only the
  // agent's latest run can be: one resumed after had ended, whether or not the record said where.
  const busyUntil: number[] = [];
  let columns = 0;
  for (const lane of lanes) {
    if (!lane.background) continue;
    const live = lane.next === undefined && (running.has(lane.key) || running.has(lane.call));
    const end = lane.cross ?? lane.back ?? (live ? Number.POSITIVE_INFINITY : undefined);
    if (end === undefined) continue;
    let column = 1;
    while ((busyUntil[column] ?? -1) >= lane.fork) column++;
    busyUntil[column] = end;
    lane.column = column;
    columns = Math.max(columns, column);
  }
  return { lanes, columns, marks };
}

/**
 * The agents of a conversation that may still be running, as the rail needs to know before it can say
 * where a lane ends: one whose conversation still streams by, or — while this conversation is being
 * written — one whose call has not answered, or answered only with its launch note.
 */
export function runningCallsOf(entries: readonly TranscriptEntry[], streaming: ReadonlySet<string>, working: boolean): Set<string> {
  const running = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    // A resumed run still going while the conversation is written (by its call's id: the lane's key).
    if (working && entry.callId !== undefined && resumedAgentOf(entry) !== undefined) running.add(entry.callId);
    if (entry.sidechain === undefined) continue;
    if (streaming.has(entry.sidechain) || (working && (entry.result === undefined || isLaunchNote(entry.result)))) running.add(entry.sidechain);
  }
  return running;
}

/**
 * The gutter: the trunk at its left edge's 9, each lane column 18 further right of it — between the
 * trunk and the conversation, so an agent's rail is always right of the rail of the agent that started it.
 */
export const TRUNK_X = 9;
export const LANE_PITCH = 18;
/** The gutter's width for a rail with `columns` lane columns: the trunk's own 20 and 18 a column. */
export const gutterOf = (columns: number): number => 20 + columns * LANE_PITCH;
/** Where the trunk is, in the column's own coordinates: at the gutter's left edge, however many columns. */
export const trunkXOf = (_columns?: number): number => TRUNK_X;
/** Where a lane column's lane is, in the same coordinates: right of the trunk. */
export const laneXOf = (column: number): number => TRUNK_X + column * LANE_PITCH;

/**
 * A lane's colour: the golden-angle ladder `rail.ts` hands states, by the order agents started — the
 * same agent continued later keeps its hue, the way a looped state does.
 */
export function laneHueOf(rail: AgentRail, call: string): string {
  const at = rail.lanes.filter((lane) => lane.resumed === undefined).findIndex((lane) => lane.call === call);
  const hue = (18 + (at < 0 ? 0 : at + 1) * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} var(--rail-s) var(--rail-l))`;
}
