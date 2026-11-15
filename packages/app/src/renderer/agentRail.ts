/**
 * The agents a conversation started, as LANES on its rail (the person, 2026-11-14, rounds 1–5 of the
 * "agents on the rail" mockups): an agent is drawn the way a nested state is.
 *
 *   waited for    the conversation stops until it returns: its lane forks off the trunk to the RIGHT,
 *                 its conversation nested beside the lane (folded: the rail's bump with a plus).
 *   background    the conversation goes on while it works (`Async agent launched`): its lane leaves the
 *                 trunk to the LEFT and runs down the gutter beside the conversation until it returns —
 *                 where its `task_notification` reached the conversation — curving back into the trunk.
 *   crossover     a background agent the conversation then WAITS for (a blocking `TaskOutput` on its
 *                 agent id): its left lane crosses the trunk at a knot there and carries on to the right.
 *   brought here  a background agent the person brings into the conversation: its lane flips to the
 *                 right at its fork (a filled knot), and pressing the lane sends it back. That is the
 *                 view's state, not the record's — {@link AgentLane} says only what the record does.
 *
 * Pure: entries in, lanes out, so the rules can be tested without drawing anything.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { EventEntry, ToolEntry, TranscriptEntry } from "./transcript";

/** What a row of the conversation is to an agent's lane. */
export type LaneMark = "fork" | "cross" | "back";

export interface AgentLane {
  /** The call that started it: its key everywhere (`ToolEntry.sidechain`). */
  call: string;
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
   * The gutter column its left lane runs in: 1 is next to the trunk. 0 for an agent with no left lane
   * (waited for from the start, or a background agent whose end the record never said).
   */
  column: number;
}

export interface AgentRail {
  lanes: AgentLane[];
  /** How many left columns the busiest stretch needs: the gutter's width is computed once from it. */
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
  const byAgent = new Map<string, AgentLane>();
  const byCall = new Map<string, AgentLane>();
  const marks = new Map<TranscriptEntry, { lane: AgentLane; mark: LaneMark }>();
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === "tool" && entry.sidechain !== undefined && !byCall.has(entry.sidechain) && entry.calledBy === undefined) {
      const background = isLaunchNote(entry.result) || askedBackground(entry);
      const agentId = agentIdOf(entry.result);
      const lane: AgentLane = { call: entry.sidechain, ...(agentId !== undefined ? { agentId } : {}), background, fork: i, column: 0 };
      lanes.push(lane);
      byCall.set(lane.call, lane);
      if (agentId !== undefined) byAgent.set(agentId, lane);
      marks.set(entry, { lane, mark: "fork" });
      continue;
    }
    const waited = waitedAgentOf(entry);
    if (waited !== undefined) {
      const lane = byAgent.get(waited);
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
  // Left columns: a background lane takes the lowest column free at its fork, and frees it at the row
  // its left lane ends on (its crossover or its return); one still running holds it to the end.
  const busyUntil: number[] = [];
  let columns = 0;
  for (const lane of lanes) {
    if (!lane.background) continue;
    const end = lane.cross ?? lane.back ?? (running.has(lane.call) ? Number.POSITIVE_INFINITY : undefined);
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
    if (entry.kind !== "tool" || entry.sidechain === undefined) continue;
    if (streaming.has(entry.sidechain) || (working && (entry.result === undefined || isLaunchNote(entry.result)))) running.add(entry.sidechain);
  }
  return running;
}

/** The gutter: the trunk's column at its left edge's 9, each left column 18 further out. */
export const TRUNK_X = 9;
export const LANE_PITCH = 18;
/** The gutter's width for a rail with `columns` left columns: the trunk's own 20 and 18 a column. */
export const gutterOf = (columns: number): number => 20 + columns * LANE_PITCH;
/** Where the trunk is, in the column's own coordinates, given the left columns before it. */
export const trunkXOf = (columns: number): number => columns * LANE_PITCH + TRUNK_X;
/** Where a left column's lane is, in the same coordinates. */
export const leftLaneXOf = (columns: number, column: number): number => trunkXOf(columns) - column * LANE_PITCH;

/**
 * A lane's colour: the golden-angle ladder `rail.ts` hands states, by the order agents started — the
 * same agent continued later keeps its hue, the way a looped state does.
 */
export function laneHueOf(rail: AgentRail, call: string): string {
  const at = rail.lanes.findIndex((lane) => lane.call === call);
  const hue = (18 + (at < 0 ? 0 : at + 1) * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} var(--rail-s) var(--rail-l))`;
}
