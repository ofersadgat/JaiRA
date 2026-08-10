/**
 * The LLM configuration element — the settings a prompt call is made WITH.
 *
 * This replaces a JSON textarea, which was the wrong answer for the reason every JSON textarea in a
 * settings screen is: it makes the user the parser. You had to already know that the field is called
 * `maxOutputTokens` and not `maxTokens`, that `reasoning` is an object and not a string, and that a
 * model is sampling XOR reasoning — none of which the box told you, and all of which it would accept
 * and then fail on at run time.
 *
 * Its shape is findmyprompt's `SearchSpace`: a rail of categories, each carrying a live one-line
 * SUMMARY, beside a detail pane that edits the selected one. The summaries are what keep a form of
 * this size legible — you can see that sampling is at defaults and reasoning is off without opening
 * either. The one deliberate difference is arity: findmyprompt is searching a space, so each field
 * there is a MENU of options; here a config is a single point, so each field is one value.
 *
 * Two rules it enforces that the textarea could not:
 *
 *  - **Empty is UNSET.** Every box left blank writes nothing, so the value falls through to the
 *    provider's own default rather than being pinned to zero.
 *  - **Sampling XOR reasoning.** `parseLlmConfig` upstream rejects a config carrying both, so the
 *    form refuses to produce one: turning reasoning on retires the sampling knobs, and says why.
 */
import { useMemo, useState, type JSX } from "react";
import { Disclosure, Field, FieldGrid, NumInput, SelectInput, TextArea, TextInput } from "./controls";

/** The config as a plain document — what a preset or an executor's `models.config` holds. */
export type LlmConfigDoc = Record<string, unknown>;

/**
 * The knobs a sampling endpoint takes, and a reasoning endpoint REFUSES.
 *
 * Upstream's `SAMPLING_KEYS`, restated because `shared` must not import `@declarative-ai/llm` into
 * the renderer's bundle. If that list gains a key, this one does too — the cost of the split, and
 * cheaper than pulling the provider layer into Chromium.
 */
const SAMPLING_KEYS = ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty"] as const;

const EFFORTS: Array<[string, string]> = [
  ["— inherit", ""],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
];

/** The categories, their fields, and how each summarises itself when collapsed. */
type CategoryKey = "sampling" | "reasoning" | "limits" | "advanced";

function num(doc: LlmConfigDoc, key: string): number | undefined {
  const value = doc[key];
  return typeof value === "number" ? value : undefined;
}

function reasoningOf(doc: LlmConfigDoc): { effort?: string; budgetTokens?: number } | undefined {
  const value = doc["reasoning"];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { effort?: string; budgetTokens?: number })
    : undefined;
}

/** The keys this form edits with a dedicated control. Everything else is "advanced", never dropped. */
const KNOWN_KEYS = new Set<string>([
  ...SAMPLING_KEYS,
  "reasoning",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "maxSteps",
]);

export function LlmConfigForm({
  value,
  onChange,
  disabled = false,
  /** Shown under the header — what this particular configuration is FOR. */
  hint,
}: {
  value: LlmConfigDoc;
  onChange: (next: LlmConfigDoc) => void;
  disabled?: boolean;
  hint?: string;
}): JSX.Element {
  const [active, setActive] = useState<CategoryKey>("sampling");
  const reasoning = reasoningOf(value);
  const reasoningOn = reasoning !== undefined;

  /** Write one key. `undefined` REMOVES it, which is how a box goes back to inheriting. */
  const set = (key: string, next: unknown): void => {
    const doc = { ...value };
    if (next === undefined) delete doc[key];
    else doc[key] = next;
    onChange(doc);
  };

  const stops = Array.isArray(value["stopSequences"])
    ? (value["stopSequences"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const extras = useMemo(() => Object.keys(value).filter((k) => !KNOWN_KEYS.has(k)), [value]);

  const summaries: Record<CategoryKey, string> = {
    sampling: reasoningOn
      ? "not applicable — reasoning is on"
      : (() => {
          const set = SAMPLING_KEYS.filter((k) => value[k] !== undefined);
          return set.length === 0 ? "provider defaults" : set.join(" · ");
        })(),
    reasoning: reasoning === undefined ? "off" : (reasoning.effort ?? `${reasoning.budgetTokens ?? "?"} tokens`),
    limits: [
      value["maxOutputTokens"] === undefined ? null : `${String(value["maxOutputTokens"])} tokens`,
      stops.length > 0 ? `${stops.length} stop` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "no limits",
    advanced: extras.length === 0 ? "none" : `${extras.length} extra`,
  };

  const CATEGORIES: Array<{ key: CategoryKey; label: string; hint: string }> = [
    {
      key: "sampling",
      label: "Sampling",
      hint: "How the model picks its next token. A reasoning model rejects these outright, so they are only offered while reasoning is off.",
    },
    {
      key: "reasoning",
      label: "Reasoning",
      hint: "How hard to think, as an effort level and/or a token budget. Provider-neutral: it is adapted to each provider's own shape at the call.",
    },
    { key: "limits", label: "Output limits", hint: "How long an answer may run, and what ends it." },
    {
      key: "advanced",
      label: "Advanced",
      hint: "Anything this form has no dedicated control for. Editable as JSON so a setting is never silently dropped.",
    },
  ];

  return (
    <div className="llm-config">
      <nav className="llm-rail">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            className={`llm-rail-item${cat.key === active ? " on" : ""}`}
            aria-pressed={cat.key === active}
            onClick={() => setActive(cat.key)}
          >
            <span className="llm-rail-label">{cat.label}</span>
            <span className="llm-rail-summary">{summaries[cat.key]}</span>
          </button>
        ))}
      </nav>

      <div className="llm-detail">
        <div className="llm-detail-head">
          <span className="llm-detail-title">{CATEGORIES.find((c) => c.key === active)!.label}</span>
          <span className="cfg-hint">{CATEGORIES.find((c) => c.key === active)!.hint}</span>
          {hint && active === "sampling" ? <span className="cfg-hint">{hint}</span> : null}
        </div>

        {active === "sampling" ? (
          reasoningOn ? (
            <div className="notice warn">
              Reasoning is on, and a model is sampling <em>or</em> reasoning — never both. The sampling knobs
              are refused by a reasoning endpoint, so they are not offered here. Turn reasoning off to use them.
            </div>
          ) : (
            <FieldGrid>
              <Field
                label="Temperature"
                param="temperature"
                hint="Higher is more varied, lower more repeatable. Empty inherits the provider's default."
                set={value["temperature"] !== undefined}
              >
                <NumInput value={num(value, "temperature")} disabled={disabled} onChange={(n) => set("temperature", n)} />
              </Field>
              <Field
                label="Top-p"
                param="topP"
                hint="Nucleus sampling: consider only the most likely tokens adding up to this probability mass (0–1)."
                set={value["topP"] !== undefined}
              >
                <NumInput value={num(value, "topP")} disabled={disabled} onChange={(n) => set("topP", n)} />
              </Field>
              <Field
                label="Top-k"
                param="topK"
                hint="Consider only the k most likely tokens. Provider-dependent; empty inherits."
                set={value["topK"] !== undefined}
              >
                <NumInput value={num(value, "topK")} disabled={disabled} onChange={(n) => set("topK", n)} />
              </Field>
              <Field
                label="Presence penalty"
                param="presencePenalty"
                hint="Discourages tokens that already appeared at all."
                set={value["presencePenalty"] !== undefined}
              >
                <NumInput
                  value={num(value, "presencePenalty")}
                  disabled={disabled}
                  onChange={(n) => set("presencePenalty", n)}
                />
              </Field>
              <Field
                label="Frequency penalty"
                param="frequencyPenalty"
                hint="Discourages tokens in proportion to how often they already appeared."
                set={value["frequencyPenalty"] !== undefined}
              >
                <NumInput
                  value={num(value, "frequencyPenalty")}
                  disabled={disabled}
                  onChange={(n) => set("frequencyPenalty", n)}
                />
              </Field>
              <Field
                label="Seed"
                param="seed"
                hint="Fixes the sampler so an identical call draws an identical answer, where the provider supports it."
                set={value["seed"] !== undefined}
              >
                <NumInput value={num(value, "seed")} disabled={disabled} onChange={(n) => set("seed", n)} />
              </Field>
            </FieldGrid>
          )
        ) : null}

        {active === "reasoning" ? (
          <div className="cfg-stack">
            <Field
              label="Effort"
              param="reasoning.effort"
              hint="A level rather than a number of tokens, so it means the same thing across providers. A provider that tops out lower clamps rather than refusing."
              set={reasoning?.effort !== undefined}
            >
              <SelectInput
                value={reasoning?.effort ?? ""}
                options={EFFORTS}
                disabled={disabled}
                onChange={(v) => {
                  const next = { ...(reasoning ?? {}) };
                  if (v === "") delete next.effort;
                  else next.effort = v;
                  set("reasoning", Object.keys(next).length === 0 ? undefined : next);
                }}
              />
            </Field>
            <Field
              label="Thinking budget"
              param="reasoning.budgetTokens"
              hint="A token ceiling on the thinking itself, for the models that take one instead of a level."
              set={reasoning?.budgetTokens !== undefined}
            >
              <NumInput
                value={reasoning?.budgetTokens}
                disabled={disabled}
                onChange={(n) => {
                  const next = { ...(reasoning ?? {}) };
                  if (n === undefined) delete next.budgetTokens;
                  else next.budgetTokens = n;
                  set("reasoning", Object.keys(next).length === 0 ? undefined : next);
                }}
              />
            </Field>
            {reasoningOn && SAMPLING_KEYS.some((k) => value[k] !== undefined) ? (
              <div className="notice warn">
                This configuration also sets{" "}
                {SAMPLING_KEYS.filter((k) => value[k] !== undefined).join(", ")}, which a reasoning endpoint
                refuses. Clear them, or turn reasoning off.
                <div className="pane-actions">
                  <button
                    className="ghost"
                    disabled={disabled}
                    onClick={() => {
                      const doc = { ...value };
                      for (const key of SAMPLING_KEYS) delete doc[key];
                      onChange(doc);
                    }}
                  >
                    Clear the sampling knobs
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {active === "limits" ? (
          <FieldGrid>
            <Field
              label="Max output tokens"
              param="maxOutputTokens"
              hint="A ceiling on the answer's length — the main lever on the cost of one call. Empty means the model's own maximum."
              set={value["maxOutputTokens"] !== undefined}
            >
              <NumInput
                value={num(value, "maxOutputTokens")}
                disabled={disabled}
                onChange={(n) => set("maxOutputTokens", n)}
              />
            </Field>
            <Field
              label="Max tool steps"
              param="maxSteps"
              hint="How many model→tool→model round trips one call may take before it is stopped."
              set={value["maxSteps"] !== undefined}
            >
              <NumInput value={num(value, "maxSteps")} disabled={disabled} onChange={(n) => set("maxSteps", n)} />
            </Field>
            <Field
              label="Stop sequences"
              param="stopSequences"
              hint="Comma-separated strings that end generation as soon as they appear."
              set={value["stopSequences"] !== undefined}
            >
              <TextInput
                value={stops.join(", ")}
                placeholder="—"
                disabled={disabled}
                onChange={(v) => {
                  const list = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
                  set("stopSequences", list.length > 0 ? list : undefined);
                }}
              />
            </Field>
          </FieldGrid>
        ) : null}

        {active === "advanced" ? <AdvancedJson value={value} known={KNOWN_KEYS} disabled={disabled} onChange={onChange} /> : null}
      </div>
    </div>
  );
}

/**
 * The escape hatch: every key this form has no control for, as JSON.
 *
 * It exists so the form is never LOSSY. A config carrying `providerOptions` or an upstream field
 * added since must survive a round trip through this screen — a form that silently dropped what it
 * did not recognise would quietly delete settings whenever anything else was saved.
 */
function AdvancedJson({
  value,
  known,
  disabled,
  onChange,
}: {
  value: LlmConfigDoc;
  known: Set<string>;
  disabled: boolean;
  onChange: (next: LlmConfigDoc) => void;
}): JSX.Element {
  const extras = Object.fromEntries(Object.entries(value).filter(([k]) => !known.has(k)));
  const saved = Object.keys(extras).length === 0 ? "" : JSON.stringify(extras, null, 2);
  const [text, setText] = useState(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);

  // The document changed underneath — follow it unless this box is mid-edit, the same reconciliation
  // every other form in the settings screen does.
  if (baseline !== saved) {
    if (text === baseline) setText(saved);
    setBaseline(saved);
  }

  return (
    <div className="cfg-stack">
      <Field
        label="Other settings"
        param="(any)"
        hint="Everything with no dedicated control above — provider passthroughs, and anything newer than this form. Kept exactly as written."
      >
        <TextArea
          value={text}
          rows={8}
          placeholder={'{ "providerOptions": { "anthropic": { "cacheControl": true } } }'}
          disabled={disabled}
          onChange={(v) => {
            setText(v);
            if (v.trim() === "") {
              setProblem(null);
              onChange(Object.fromEntries(Object.entries(value).filter(([k]) => known.has(k))));
              return;
            }
            try {
              const parsed: unknown = JSON.parse(v);
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                setProblem("must be a JSON object");
                return;
              }
              setProblem(null);
              onChange({
                ...Object.fromEntries(Object.entries(value).filter(([k]) => known.has(k))),
                ...(parsed as LlmConfigDoc),
              });
            } catch (e) {
              setProblem((e as Error).message);
            }
          }}
        />
      </Field>
      {problem ? <div className="sub warn-text">not saved — {problem}</div> : null}
    </div>
  );
}

/** A one-line summary of a config, for a row that shows one without opening it. */
export function summariseLlmConfig(doc: LlmConfigDoc): string {
  const parts: string[] = [];
  const reasoning = reasoningOf(doc);
  if (reasoning !== undefined) parts.push(`reasoning ${reasoning.effort ?? `${reasoning.budgetTokens ?? "?"}t`}`);
  for (const key of SAMPLING_KEYS) if (doc[key] !== undefined) parts.push(`${key} ${String(doc[key])}`);
  if (doc["maxOutputTokens"] !== undefined) parts.push(`≤${String(doc["maxOutputTokens"])} tokens`);
  const extra = Object.keys(doc).filter((k) => !KNOWN_KEYS.has(k)).length;
  if (extra > 0) parts.push(`+${extra} more`);
  return parts.length === 0 ? "provider defaults" : parts.join(" · ");
}
