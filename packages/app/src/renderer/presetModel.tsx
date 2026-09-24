/**
 * A preset's Model section — which model a state that picks the preset runs on (`presetModels.ts`).
 *
 * Drawn first in the open preset's sections, before the call settings, because it is the one thing
 * that makes `coder` coder. What it shows is the rule and the candidates the rule picks from:
 *
 *  - **The rule**, as a segmented control — "The first available" (the first candidate that can run
 *    here) or "The most left" (the candidate whose account has the most allowance left, read off the
 *    limits board — docs/engineering/contracts/usage-readings.md).
 *  - **The candidates**, through the schema form's own list editor (one row per model id, in order,
 *    moved with ↑ ↓), each row saying which route would serve it on this machine, whether it can run
 *    now, and — on the first that can — that it is the one picked now.
 *
 * A render function: everything it shows arrives as props, so each state it can be in is one call to
 * `renderToStaticMarkup`. Where a candidate stands is the HOST's answer (`candidateLookupOf`), read off
 * the availability snapshot main publishes.
 */
import type { JSX } from "react";
import {
  accountOfRoute,
  remainingPercent,
  modelAvailabilityIn,
  parsePresetModel,
  presetModelSummary,
  routeHealthOf,
  type AvailabilitySnapshot,
  type JairaPromptNode,
  type PresetModel,
} from "@jaira/shared/browser";
import { Field } from "./controls";
import { useLimits } from "./limitsStore";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { Segmented } from "./settingsLayout";

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

type Rule = "first-available" | "most-left";
const RULES: ReadonlyArray<readonly [string, Rule]> = [
  ["The first available", "first-available"],
  ["The most left", "most-left"],
];

/** The rule a draft states; a bare id or a list with none is `first-available`. */
function ruleOf(value: unknown): Rule {
  return value !== null && typeof value === "object" && (value as { choose?: unknown }).choose === "most-left" ? "most-left" : "first-available";
}

/** The candidate list's schema — a list of model ids, the picker's models and the presets offered as suggestions. */
function candidatesSchema(suggestions: readonly string[]): Schema {
  return {
    type: "array",
    minItems: 1,
    items: { type: "string", title: "model id", ...(suggestions.length > 0 ? { examples: [...suggestions] } : {}) },
  };
}

export function PresetModelSection({
  value,
  onChange,
  disabled,
  lookup,
  suggestions,
}: {
  /** The preset's `model`, as the draft holds it. */
  value: unknown;
  /** Write the preset's `model`; `undefined` removes it, and the state's own model answers again. */
  onChange: (next: PresetModel | undefined) => void;
  disabled: boolean;
  lookup: CandidateLookup;
  /** Model ids to offer in each row's box. */
  suggestions: readonly string[];
}): JSX.Element {
  const candidates = candidatesInDraft(value);
  const statuses = candidates.map((id) => (id.trim().length === 0 ? undefined : lookup(id.trim())));
  const rule = ruleOf(value);
  const limits = useLimits();
  // What each candidate's account has left, on the route it would run on — the board's figure.
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
  // A row still being typed is not a mistake yet — Save waits for it, and says nothing until then.
  const typing = candidates.some((id) => id.trim().length === 0);
  const problem = typing ? undefined : presetModelProblem(value);

  return (
    <div className="cfg-stack preset-model">
      <Field
        label="Model"
        param="model"
        hint="Which model a state that picks this preset runs on — chosen when its conversation starts, and kept for the rest of it. Off, the state's own model answers, or the default."
        toggle={{ on: value !== undefined, disabled, onChange: (on) => (on ? undefined : onChange(undefined)) }}
        error={problem}
        wide
      >
        <div className="preset-rule">
          <Segmented
            value={rule}
            options={RULES}
            label="How a candidate is chosen"
            disabled={disabled}
            onChange={(next) => {
              const ids = candidates.filter((id) => id.length > 0);
              if (ids.length > 0) onChange({ candidates: candidates, choose: next });
            }}
          />
          <span className="cfg-hint">
            {rule === "most-left"
              ? "The model whose account has the most usage left answers — ties go to the one higher in this list."
              : "The first model in this list that can run here answers."}
          </span>
        </div>
        <SchemaForm
          schema={candidatesSchema(suggestions)}
          value={candidates}
          onChange={(next) => {
            const ids = Array.isArray(next) ? next.map((id) => (typeof id === "string" ? id : "")) : [];
            onChange(ids.length === 0 ? undefined : { candidates: ids, choose: rule });
          }}
          ctx={{
            path: "model.candidates",
            disabled,
            addLabel: () => "+ another model",
            itemNote: (_path, _item, index) => {
              const status = statuses[index];
              return status === undefined ? null : <CandidateNote status={status} picked={index === picked} left={rule === "most-left" ? lefts[index] ?? null : undefined} />;
            },
          }}
        />
      </Field>
    </div>
  );
}

/** Under one candidate: the route it would go through, whether it can run, and whether it is the one picked. */
function CandidateNote({ status, picked, left }: { status: CandidateStatus; picked: boolean; left?: number | null | undefined }): JSX.Element {
  return (
    <div className="preset-candidate">
      {status.route !== undefined ? (
        <span className="cx-src">
          via {status.route}
          {status.plan !== undefined ? ` · ${status.plan}` : ""}
        </span>
      ) : null}
      {status.state === "unchecked" ? (
        <span className="cfg-status">
          <span className="cfg-dot" aria-hidden="true" />
          not checked yet
        </span>
      ) : status.state === "available" ? (
        <span className="cfg-status available">
          <span className="cfg-dot" aria-hidden="true" />
          available
        </span>
      ) : (
        <span className="cfg-status unavailable" title={status.why}>
          <span className="cfg-dot" aria-hidden="true" />
          not available — {status.why}
        </span>
      )}
      {left !== undefined ? <span className="cx-src">{left === null ? "usage left not known" : `${Math.round(left)}% left`}</span> : null}
      {picked ? <span className="cfg-status here">picked now</span> : null}
    </div>
  );
}
