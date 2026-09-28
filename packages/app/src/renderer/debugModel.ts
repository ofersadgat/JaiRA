/**
 * What the Debug room derives, for both shells (decision 0015): the desktop's `DebugPane` (`debugPane.tsx`)
 * and its universal copy (`packages/universal/src/components/debug/`). Moved here from `debugPane.tsx`
 * unchanged; the reasoning behind each is in that file's header.
 */
import type { AvailabilitySnapshot, TaskDetail } from "@jaira/shared/browser";
import type { DebugFile, DebugState } from "./store";

/**
 * What the run's outputs say, read defensively.
 *
 * Defensively because these come off a model. `passed` is only a pass when it is literally `true`:
 * a missing field, a string `"true"`, or a run that failed before publishing anything must all read
 * as "not proven", and a truthiness check would turn two of those three into a green banner.
 */
export function verdictOf(outputs: unknown): { passed: boolean | null; greeting?: string; verdict?: string } {
  if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) return { passed: null };
  const record = outputs as Record<string, unknown>;
  return {
    passed: record["passed"] === true ? true : record["passed"] === false ? false : null,
    ...(typeof record["greeting"] === "string" ? { greeting: record["greeting"] } : {}),
    ...(typeof record["verdict"] === "string" ? { verdict: record["verdict"] } : {}),
  };
}

/** What a self-test row says about the copy that loads: which layer it is in, in the pane's words. */
export function debugFileStatus(file: Pick<DebugFile, "layer">): {
  word: string;
  tone: "success" | "unknown" | "error";
} {
  if (file.layer === null) return { word: "missing", tone: "error" };
  if (file.layer === "system") return { word: "built in", tone: "success" };
  // A person's copy wins over what ships.
  return { word: "overridden", tone: "unknown" };
}

/**
 * Who could answer the live run, as the last availability check found it: which of the three notices
 * `Readiness` shows, and the names reported healthy.
 */
export function readinessOf(availability: AvailabilitySnapshot): { kind: "unchecked" | "none" | "ok"; names: string[] } {
  const ok = [...availability.routes, ...availability.executors].filter((p) => p.status === "ok");
  if (availability.checkedAt === 0) return { kind: "unchecked", names: [] };
  if (ok.length === 0) return { kind: "none", names: [] };
  return { kind: "ok", names: ok.map((p) => p.name) };
}

/**
 * The pane's reading of the selection. The detail is only about the self-test while the selection still
 * IS the self-test; the last run of it, what that run's outputs say, whether it is running, and which of
 * its state files are missing or overridden.
 */
export function debugViewOf(debug: DebugState, detail: TaskDetail | null) {
  const mine = detail !== null && detail.taskId === debug.taskId ? detail : null;
  const run = mine?.runs[mine.runs.length - 1];
  const result = verdictOf(run?.outputs ?? null);
  const running = mine?.status === "running" || run?.outcome === "running";
  const missing = debug.files.filter((f) => f.layer === null).length;
  const overridden = debug.files.filter((f) => f.layer !== null && f.layer !== "system");
  return { mine, run, result, running, missing, overridden };
}

/** The verdict's word and tone. */
export const verdictWord = (passed: boolean | null): { word: string; tone: "good" | "bad" | "unknown" } =>
  passed === true ? { word: "PASS", tone: "good" } : passed === false ? { word: "FAIL", tone: "bad" } : { word: "NO VERDICT", tone: "unknown" };
