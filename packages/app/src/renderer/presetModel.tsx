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
import type { PresetModel } from "@jaira/shared/browser";
import { Field } from "./controls";
import { useLimits } from "./limitsStore";
import { PRESET_RULES as RULES, candidatesSchema, candidatesViewOf, presetRuleWords, type CandidateLookup, type CandidateStatus } from "./presetCandidates";
import { SchemaForm } from "./schemaForm/SchemaForm";
import { Segmented } from "./settingsLayout";

export {
  candidateLookupOf,
  candidatesInDraft,
  presetModelLine,
  presetModelProblem,
  type CandidateLookup,
  type CandidateStatus,
} from "./presetCandidates";

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
  // Each candidate's status and what its account has left, which is picked now, and — unless a row is
  // still being typed, which is not a mistake yet — what the parser would refuse.
  const { candidates, statuses, lefts, rule, picked, problem } = candidatesViewOf(value, lookup, useLimits());

  return (
    <div className="cfg-stack preset-model">
      <Field
        label="Model"
        param="model"
        hint="Which model a state that picks this preset runs on — chosen when its conversation starts, and kept for the rest of it. With none, the state's own model answers, or the default."
        layer={{ stated: value !== undefined, disabled, label: "Name no model — the state's own answers", onInherit: () => onChange(undefined) }}
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
          <span className="cfg-hint">{presetRuleWords(rule)}</span>
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
