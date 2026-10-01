/**
 * What a preset's Model section works out, as pure functions — where each candidate stands on this
 * machine, which one is picked now, what the rail line says and what the parser would refuse.
 * `ModelsPage.tsx` (`packages/universal/src/components/settings`) draws from it.
 */
import {
  accountOfRoute,
  remainingPercent,
  modelAvailabilityIn,
  parsePresetModel,
  presetModelSummary,
  routeHealthOf,
  type AvailabilitySnapshot,
  type JairaPromptNode,
  type LimitsView,
} from "@jaira/shared/browser";
import type { Schema } from "./schemaForm/types";

/** Where one candidate stands on this machine. `unchecked` until the startup check has run. */
export interface CandidateStatus {
  state: "available" | "unavailable" | "unchecked";
  /** The route that would serve it — `claude-cli`, `anthropic`. */
  route?: string;
  /** What that route runs on — the signed-in account's plan, "API key", "local server". */
  plan?: string;
  /** Why it cannot run, for `unavailable`. */
  why?: string;
}

export type CandidateLookup = (model: string) => CandidateStatus;

/** What a route runs on, in the words the Connections page uses for it. */
function planOf(snapshot: AvailabilitySnapshot, route: string): string | undefined {
  const agent = snapshot.executors.find((probe) => probe.name === route);
  if (agent !== undefined) {
    const account = agent.accounts?.find((a) => a.active) ?? agent.accounts?.[0];
    return account?.plan ?? account?.method;
  }
  if (route === "local") return "local server";
  if (route === "embedded") return "on this machine";
  return snapshot.routes.some((probe) => probe.name === route) ? "API key" : undefined;
}

/**
 * The host's lookup, over the availability snapshot: the configured routes and the last check's
 * verdict on each — the same question `modelAvailabilityFor` in main asks when a session chooses, so
 * what this pane says is picked is what a run would pick.
 */
export function candidateLookupOf(snapshot: AvailabilitySnapshot): CandidateLookup {
  const node = snapshot.configured?.prompt as JairaPromptNode | undefined;
  if (snapshot.checkedAt === 0 || node === undefined) return () => ({ state: "unchecked" });
  const health = routeHealthOf(snapshot);
  return (model) => {
    const answer = modelAvailabilityIn(node, model, health);
    if (!answer.available) return { state: "unavailable", why: answer.why };
    const plan = planOf(snapshot, answer.route);
    return { state: "available", route: answer.route, ...(plan !== undefined ? { plan } : {}) };
  };
}

/** The draft's `model`, read as a candidate list — a plain id is a list of one. */
export function candidatesInDraft(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const list = (value as { candidates?: unknown }).candidates;
  return Array.isArray(list) ? list.map((id) => (typeof id === "string" ? id : "")) : [];
}

/** What is wrong with the draft's `model`, in the parser's own words — or undefined when it would save. */
export function presetModelProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    parsePresetModel(value, "model");
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The rail line for the Model section: `first available: opus · gpt-5.6-terra`. */
export function presetModelLine(value: unknown): string {
  if (value === undefined) return presetModelSummary(undefined);
  const ids = candidatesInDraft(value).filter((id) => id.trim().length > 0);
  return ids.length === 0 ? "no model yet" : presetModelSummary(typeof value === "string" ? value : { candidates: ids, choose: ruleOf(value) });
}

export type PresetRule = "first-available" | "most-left";
export const PRESET_RULES: ReadonlyArray<readonly [string, PresetRule]> = [
  ["The first available", "first-available"],
  ["The most left", "most-left"],
];

/** What the rule beside the choice says. */
export function presetRuleWords(rule: PresetRule): string {
  return rule === "most-left" ? "The model whose account has the most usage left answers — ties go to the one higher in this list." : "The first model in this list that can run here answers.";
}

/** The rule a draft states; a bare id or a list with none is `first-available`. */
export function ruleOf(value: unknown): PresetRule {
  return value !== null && typeof value === "object" && (value as { choose?: unknown }).choose === "most-left" ? "most-left" : "first-available";
}

/** The candidate list's schema — a list of model ids, the picker's models and the presets offered as suggestions. */
export function candidatesSchema(suggestions: readonly string[]): Schema {
  return {
    type: "array",
    minItems: 1,
    items: { type: "string", title: "model id", ...(suggestions.length > 0 ? { examples: [...suggestions] } : {}) },
  };
}

/**
 * Where the Model section's candidates stand: each one's status, what its account has left on the
 * route it would run on (the limits board's figure), which one is picked now, and the parser's
 * complaint — none while a row is still being typed.
 */
export function candidatesViewOf(
  value: unknown,
  lookup: CandidateLookup,
  limits: LimitsView,
): { candidates: string[]; statuses: Array<CandidateStatus | undefined>; lefts: Array<number | null>; rule: PresetRule; picked: number; problem: string | undefined } {
  const candidates = candidatesInDraft(value);
  const statuses = candidates.map((id) => (id.trim().length === 0 ? undefined : lookup(id.trim())));
  const rule = ruleOf(value);
  const lefts = candidates.map((id, k) => {
    const route = statuses[k]?.route;
    if (route === undefined) return null;
    const reading = limits.accounts.find((a) => a.key === accountOfRoute(route))?.reading ?? null;
    return reading === null ? null : remainingPercent(reading, id.trim());
  });
  const scoreOf = (k: number): number => {
    const left = lefts[k];
    return left === null || left === undefined ? -1 : left <= 0 ? -2 : left;
  };
  const picked =
    rule === "most-left"
      ? statuses.reduce<number>((best, status, k) => (status?.state !== "available" ? best : best === -1 || scoreOf(k) > scoreOf(best) ? k : best), -1)
      : statuses.findIndex((status) => status?.state === "available");
  const typing = candidates.some((id) => id.trim().length === 0);
  return { candidates, statuses, lefts, rule, picked, problem: typing ? undefined : presetModelProblem(value) };
}
