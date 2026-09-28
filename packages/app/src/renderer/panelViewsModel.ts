/**
 * What the side panel's tabs DERIVE — a value's one-line preview, how long a step took, a step's path,
 * what a run consumed, a state's checks count — moved out of `panelViews.tsx` unchanged so the universal
 * copies of the tabs (decision 0015, `packages/universal/src/components/panel/`) say the same things
 * from the same code. Nothing here draws.
 */
import { useEffect, useMemo, useRef } from "react";
import type { InstanceNode, SessionRef, StateView } from "@jaira/shared/browser";
import type { RunIndexFit } from "./runIndexModel";
import { nodeAt } from "./trail";

/** How long a pick's own jump through the conversation takes to settle — see `StepsView`. */
export const SETTLE_MS = 1200;

/** How tall one row of the Steps index is — `.rail.run-index`'s `--rail-cap`. */
export const STEP_ROW = 30;

/** How many rows of the index a box this tall holds (`StepsView`'s measure). */
export const stepRowsOf = (height: number): number => Math.max(4, Math.floor((height - 8) / STEP_ROW));

/**
 * The Steps tab's card goes when the step being viewed moves on (the person's ruling, 2026-09-24) —
 * `StepsView`'s rule, shared with the universal copy.
 *
 * The card is about the step you PICKED: scroll the conversation to another sheet, or let the live step
 * advance, and the card closes — picking a step again opens that one's. The move the pick itself
 * causes (the conversation going to the step) is not a move away: `base` is the step being viewed
 * when the pick was made, and reaching the picked step becomes the new base. Until when the
 * conversation is still travelling to the pick (`settling`), what it passes is not a move either.
 */
export function useStepFollow(step: string | undefined, current: string | undefined, onStep: (step: string | undefined) => void): void {
  const base = useRef<string | undefined>(current);
  const settling = useRef(0);
  useEffect(() => {
    base.current = current;
    settling.current = Date.now() + SETTLE_MS;
    // Only on a new pick: the current step at that moment is where "moving on" is measured from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    if (step === undefined || current === undefined) return;
    if (current === step || Date.now() < settling.current) {
      base.current = current;
      return;
    }
    if (current !== base.current) onStep(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
}

/** The index's fit in the Steps box: how many rows, the step to fit around, what is on screen beside it. */
export function useStepsFit(rows: number, step: string | undefined, current: string | undefined, onScreen: ReadonlySet<string> | undefined, convo: boolean): RunIndexFit {
  return useMemo(
    () => ({ capacity: rows, ...(current !== undefined ? { current: step ?? current } : step !== undefined ? { current: step } : {}), ...(onScreen !== undefined ? { onScreen } : {}), convo }),
    [rows, current, step, onScreen, convo],
  );
}

/**
 * A value in one line: a string's first line, a list's length, an object's size — or, for an artifact
 * envelope (`{path, mediaType, content}`), what it is called. The row opens the whole of it.
 */
export function previewOf(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") {
    const line = value.split("\n").find((one) => one.trim() !== "")?.trim() ?? "";
    return line === "" ? '""' : line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const record = value as Record<string, unknown>;
  if (typeof record["content"] === "string" && typeof record["mediaType"] === "string") {
    return typeof record["path"] === "string" ? record["path"] : previewOf(record["content"]);
  }
  const keys = Object.keys(record).length;
  return `{ ${keys} key${keys === 1 ? "" : "s"} }`;
}

/** The rows a value is listed as: one per key of an object (`[key, value]`), or one `value` row. */
export function valueRowsOf(value: unknown): { rows: readonly [string, unknown][]; keyed: boolean } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { rows: Object.entries(value as Record<string, unknown>), keyed: true };
  return { rows: [["value", value]], keyed: false };
}

/** One call of an operation list as a row: "prompt · completed · $0.012". */
export function callLine(call: NonNullable<InstanceNode["operation"]>): string {
  const cost = call.costUsd !== undefined && call.costUsd > 0 ? ` · $${call.costUsd.toFixed(call.costUsd < 0.1 ? 3 : 2)}` : "";
  return `${call.kind} · ${call.status}${cost}`;
}

/** "3m 12s" — how long something took, in the two largest units. */
export function tookOf(start: number, end: number | undefined, now = Date.now()): string {
  const ms = Math.max(0, (end ?? now) - start);
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The names from the run's root down to a node — the step card's path. */
export function pathOf(instances: readonly InstanceNode[], node: InstanceNode): string[] {
  const names: string[] = [];
  let at: InstanceNode | undefined = node;
  while (at !== undefined) {
    names.unshift(at.childKey ?? at.stateId.split("/").pop() ?? at.stateId);
    at = at.parentInstanceId === undefined ? undefined : nodeAt(instances, at.parentInstanceId);
  }
  return names;
}

/** A count, as the locale writes it. */
export const countOf = (n: number): string => n.toLocaleString();

/** `2.4 s`, `1 m 12 s`. */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/** What a run consumed, summed across every call it made — see `RunMetrics`. `null` when there is nothing to say. */
export interface RunMetricsView {
  calls: number;
  started: number | undefined;
  spent: number | undefined;
  cost: number | undefined;
  /** Worst-of: a total is only as trustworthy as its least trustworthy part. */
  source: "unknown" | "table" | "provider" | undefined;
  input: number | undefined;
  output: number | undefined;
  cached: number | undefined;
  written: number | undefined;
  reasoning: number | undefined;
}

export function runMetricsOf(states: readonly SessionRef[]): RunMetricsView | null {
  const sum = (pick: (m: NonNullable<SessionRef["metrics"]>) => number | undefined): number | undefined => {
    let total: number | undefined;
    for (const row of states) {
      const value = row.metrics === undefined ? undefined : pick(row.metrics);
      if (value !== undefined) total = (total ?? 0) + value;
    }
    return total;
  };
  const cost = states.reduce<number | undefined>((acc, row) => (row.costUsd === undefined ? acc : (acc ?? 0) + row.costUsd), undefined);
  const started = states.reduce<number | undefined>((acc, row) => (acc === undefined ? row.at : Math.min(acc, row.at)), undefined);
  const input = sum((m) => m.inputTokens);
  const sources = new Set(states.map((row) => row.metrics?.costSource).filter((s) => s !== undefined));
  const source = sources.has("unknown") ? "unknown" : sources.has("table") ? "table" : sources.has("provider") ? "provider" : undefined;
  if (started === undefined && cost === undefined && input === undefined) return null;
  return {
    calls: states.length,
    started,
    spent: sum((m) => m.durationMs),
    cost,
    source,
    input,
    output: sum((m) => m.outputTokens),
    cached: sum((m) => m.cacheReadTokens),
    written: sum((m) => m.cacheWriteTokens),
    reasoning: sum((m) => m.reasoningTokens),
  };
}

/** "Checks" gets a count on its tab when something is wrong. */
export function checksCountOf(state: StateView | null): { count?: number; tone?: "red" | "amber" } {
  if (state === null) return {};
  const errors = state.issues.filter((issue) => issue.severity === "error").length;
  if (errors > 0) return { count: errors, tone: "red" };
  if (state.issues.length > 0) return { count: state.issues.length, tone: "amber" };
  return {};
}
