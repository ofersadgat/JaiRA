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
import { useId, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Field, FieldGrid, NumInput, TextArea, TextInput } from "./controls";
import {
  LIMIT_FIELDS,
  SAMPLING_FIELDS,
  STOPS_FIELD,
  advancedEdit,
  advancedTextOf,
  llmCategoriesOf,
  llmSummariesOf,
  numOf as num,
  railMoveOf,
  railStep,
  reasoningOf,
  reasoningSchemaOf,
  refusedSamplingOf,
  stopsFromText,
  stopsOf,
  withKey,
  withoutSampling,
  KNOWN_KEYS,
  type CategoryKey,
  type LlmConfigDoc,
} from "./llmConfigModel";
import { levelsFooter, useModelParameters } from "./modelParameters";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

export {
  SAMPLING_KEYS,
  railMoveOf,
  railStep,
  reasoningSchemaOf,
  summariseLlmConfig,
  type CategoryKey,
  type LlmConfigDoc,
  type RailMove,
} from "./llmConfigModel";

/**
 * A section a HOST draws first, before the call settings: a preset's Model, which only a preset has.
 * The form places it in the rail and the detail pane; what it says and edits are the host's.
 */
export interface LeadSection {
  key: "model";
  label: string;
  hint: string;
  summary: string;
  body: ReactNode;
}

// --- the rail ------------------------------------------------------------------------

export interface RailItem {
  id: string;
  label?: ReactNode;
  summary: ReactNode;
  /** The label names something a person chose (a preset), so it is set in the data face. */
  mono?: boolean;
  className?: string;
  title?: string;
  /**
   * A HEADING between tabs and not a tab: a bucket's name over its permission sets. It is drawn in the
   * rail's order, takes no focus and is skipped by the arrows — `label` and `summary` are unused.
   */
  heading?: ReactNode;
  /**
   * A heading that FOLDS what is under it — a bucket in the permission-set rail: `open` says whether
   * it is, and `onFold` flips it. Drawn as a button with a chevron; still not a tab.
   */
  fold?: { open: boolean; onFold: () => void } | undefined;
  /** How many steps in this row hangs — a bucket inside a bucket, and what it holds. */
  indent?: number;
}

/** One step of {@link RailItem.indent}, in pixels. */
const RAIL_INDENT = 12;

/**
 * A rail of tabs: each a name over a one-line summary, one of them chosen.
 *
 * A tablist rather than a column of pressed buttons, because that is what it is — one panel beside
 * it, and the rail decides which. The whole rail is ONE tab stop (the chosen tab), arrows move
 * within it, and selection follows focus: there is nothing to confirm about looking at Reasoning.
 */
export function TabRail({
  label,
  items,
  selected,
  onSelect,
  panelId,
  className,
}: {
  /** What the rail lists, for a screen reader: "Presets", "Sections". */
  label: string;
  items: readonly RailItem[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  /** The panel these tabs control. */
  panelId?: string | undefined;
  className?: string | undefined;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rail = event.currentTarget;
    const move = railMoveOf(event.key, getComputedStyle(rail).flexDirection.startsWith("row"));
    if (move === undefined) return;
    if (move === "in" || move === "out") {
      // The rail beside this one, in the same box. Nothing there is not an error — a lone rail
      // simply has no "across" — and the key is left alone so the page can still scroll with it.
      const rails = Array.from(rail.closest(".llm-config")?.querySelectorAll<HTMLElement>('[role="tablist"]') ?? []);
      const other = rails[rails.indexOf(rail) + (move === "in" ? 1 : -1)];
      const target = other?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? other?.querySelector<HTMLElement>('[role="tab"]');
      if (target == null) return;
      event.preventDefault();
      target.focus();
      return;
    }
    const tabs = Array.from(rail.querySelectorAll<HTMLElement>('[role="tab"]'));
    const next = railStep(tabs.indexOf(document.activeElement as HTMLElement), tabs.length, move);
    // Headings are in `items` and not among the tabs, so the nth TAB is the nth item that is one.
    const item = items.filter((one) => one.heading === undefined)[next];
    if (item === undefined) return;
    event.preventDefault();
    onSelect(item.id);
    tabs[next]?.focus();
  };

  // With nothing chosen the first tab holds the rail's one tab stop, or the rail could not be reached.
  const tabItems = items.filter((item) => item.heading === undefined);
  const stop = tabItems.some((item) => item.id === selected) ? selected : tabItems[0]?.id;
  const hang = (item: RailItem): { style: { marginLeft: number } } | undefined =>
    item.indent !== undefined && item.indent > 0 ? { style: { marginLeft: item.indent * RAIL_INDENT } } : undefined;

  return (
    <nav className={`llm-rail${className ? ` ${className}` : ""}`} role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKeyDown}>
      {items.map((item) =>
        item.heading !== undefined ? (
          item.fold !== undefined ? (
            <button
              key={item.id}
              type="button"
              tabIndex={-1}
              className={`set-rail-label set-rail-fold${item.className ? ` ${item.className}` : ""}`}
              aria-expanded={item.fold.open}
              title={item.title}
              {...hang(item)}
              onClick={item.fold.onFold}
            >
              <span className="set-rail-chev" aria-hidden="true">
                ›
              </span>
              {item.heading}
            </button>
          ) : (
            <div key={item.id} role="presentation" className={`set-rail-label${item.className ? ` ${item.className}` : ""}`} title={item.title} {...hang(item)}>
              {item.heading}
            </div>
          )
        ) : (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={`llm-rail-item${item.className ? ` ${item.className}` : ""}${item.id === selected ? " on" : ""}`}
            aria-selected={item.id === selected}
            aria-controls={panelId}
            tabIndex={item.id === stop ? 0 : -1}
            title={item.title}
            {...hang(item)}
            onClick={() => onSelect(item.id)}
          >
            {item.label !== undefined ? <span className={`llm-rail-label${item.mono ? " mono" : ""}`}>{item.label}</span> : null}
            <span className="llm-rail-summary">{item.summary}</span>
          </button>
        ),
      )}
    </nav>
  );
}

export function LlmConfigForm({
  value,
  onChange,
  disabled = false,
  /** Shown under the header — what this particular configuration is FOR. */
  hint,
  section,
  onSection,
  footer,
  unframed = false,
  marks = true,
  lead,
  levelsFor,
}: {
  /**
   * Whose reasoning levels the Reasoning section offers: a model id, or a PRESET's name — which main
   * resolves to the model it would pick on this machine (decision 0009). Absent ⇒ the config's own
   * `model`, and with none, the usual levels as suggestions.
   */
  levelsFor?: string | undefined;
  value: LlmConfigDoc;
  onChange: (next: LlmConfigDoc) => void;
  disabled?: boolean;
  hint?: string;
  /**
   * The chosen category, when the HOST keeps it. A host that swaps the value under one form — the
   * presets, which draw one editor for whichever preset is chosen — keeps it so that looking at
   * Reasoning in one preset and then the next stays on Reasoning. Absent, the form keeps its own.
   */
  section?: CategoryKey | undefined;
  onSection?: ((next: CategoryKey) => void) | undefined;
  /** Drawn at the end of the detail pane — a host's actions and notes about the value as a whole. */
  footer?: ReactNode;
  /**
   * Draw the rail and the detail pane WITHOUT the box around them. The box is a place, and a place
   * is the caller's: the presets put a rail of their own in it first, and that rail has to stay
   * mounted while this form is swapped for the next preset's — or a tab reached with an arrow key
   * would lose the focus it was just given.
   */
  unframed?: boolean;
  /**
   * Whether a stated value carries the `set here` tag. It means "the layer you are editing states
   * this", which is false of every value in a document shown from ANOTHER layer — an inherited
   * preset — however many of them it states.
   */
  marks?: boolean;
  /** A section of the host's, drawn first — see {@link LeadSection}. */
  lead?: LeadSection | undefined;
}): JSX.Element {
  const here = (stated: unknown): boolean => marks && stated !== undefined;
  const [own, setOwn] = useState<CategoryKey>(lead?.key ?? "sampling");
  // A host keeping its section across forms may ask for the lead on a form that has none.
  const asked = section ?? own;
  const active: CategoryKey = asked === "model" && lead === undefined ? "sampling" : asked;
  const setActive = (next: CategoryKey): void => {
    setOwn(next);
    onSection?.(next);
  };
  const panelId = useId();
  const reasoning = reasoningOf(value);
  const reasoningOn = reasoning !== undefined;
  const ownModel = typeof value["model"] === "string" ? (value["model"] as string) : undefined;
  const thinking = useModelParameters(levelsFor ?? ownModel);

  /** Write one key. `undefined` REMOVES it, which is how a box goes back to inheriting. */
  const set = (key: string, next: unknown): void => onChange(withKey(value, key, next));

  const stops = stopsOf(value);

  const summaries = llmSummariesOf(value, lead?.summary);

  const CATEGORIES = llmCategoriesOf(lead);

  return (
    <Frame unframed={unframed}>
      <TabRail
        label="Sections"
        items={CATEGORIES.map((cat) => ({ id: cat.key, label: cat.label, summary: summaries[cat.key] }))}
        selected={active}
        onSelect={(id) => setActive(id as CategoryKey)}
        panelId={panelId}
      />

      <div className="llm-detail" id={panelId} role="tabpanel" aria-label={CATEGORIES.find((c) => c.key === active)!.label}>
        <div className="llm-detail-head">
          <span className="llm-detail-title">{CATEGORIES.find((c) => c.key === active)!.label}</span>
          <span className="cfg-hint">{CATEGORIES.find((c) => c.key === active)!.hint}</span>
          {hint && active === "sampling" ? <span className="cfg-hint">{hint}</span> : null}
        </div>

        {active === "model" ? lead?.body : null}

        {active === "sampling" ? (
          reasoningOn ? (
            <div className="notice warn">
              Reasoning is on, and a model is sampling <em>or</em> reasoning — never both. The sampling knobs
              are refused by a reasoning endpoint, so they are not offered here. Turn reasoning off to use them.
            </div>
          ) : (
            <FieldGrid>
              {SAMPLING_FIELDS.map((field) => (
                <Field key={field.param} label={field.label} param={field.param} hint={field.hint} set={here(value[field.param])}>
                  <NumInput value={num(value, field.param)} disabled={disabled} onChange={(n) => set(field.param, n)} />
                </Field>
              ))}
            </FieldGrid>
          )
        ) : null}

        {active === "reasoning" ? (
          <div className="cfg-stack">
            {/* What the model this configuration resolves to takes (decision 0009): its levels, with
                their source's descriptions, and a budget only where it takes one — drawn by SchemaForm
                from that model's own `reasoning` schema rather than from a list kept here. */}
            {here(reasoning) ? (
              <span className="cfg-field-head">
                <span className="cfg-set" title="set in the layer you are editing">
                  set here
                </span>
              </span>
            ) : null}
            <SchemaForm
              schema={reasoningSchemaOf(thinking)}
              value={reasoning ?? {}}
              onChange={(next) => {
                const doc = (next ?? {}) as Record<string, unknown>;
                set("reasoning", Object.keys(doc).length === 0 ? undefined : doc);
              }}
              ctx={{ path: "reasoning", disabled }}
            />
            {thinking?.via !== undefined ? <p className="cfg-hint">{thinking.via}</p> : null}
            {thinking?.resolved !== undefined && thinking.reasoning === false ? (
              <p className="cfg-hint">{thinking.resolved} takes no reasoning request, so nothing set here is sent.</p>
            ) : thinking?.resolved !== undefined && thinking.budget === false ? (
              <p className="cfg-hint">No thinking budget: {thinking.resolved} takes a level only.</p>
            ) : null}
            <p className="cfg-hint">{levelsFooter(thinking)}</p>
            {refusedSamplingOf(value).length > 0 ? (
              <div className="notice warn">
                This configuration also sets{" "}
                {refusedSamplingOf(value).join(", ")}, which a reasoning endpoint
                refuses. Clear them, or turn reasoning off.
                <div className="pane-actions">
                  <button
                    className="ghost"
                    disabled={disabled}
                    onClick={() => onChange(withoutSampling(value))}
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
            {LIMIT_FIELDS.map((field) => (
              <Field key={field.param} label={field.label} param={field.param} hint={field.hint} set={here(value[field.param])}>
                <NumInput value={num(value, field.param)} disabled={disabled} onChange={(n) => set(field.param, n)} />
              </Field>
            ))}
            <Field label={STOPS_FIELD.label} param={STOPS_FIELD.param} hint={STOPS_FIELD.hint} set={here(value[STOPS_FIELD.param])}>
              <TextInput value={stops.join(", ")} placeholder="—" disabled={disabled} onChange={(v) => set("stopSequences", stopsFromText(v))} />
            </Field>
          </FieldGrid>
        ) : null}

        {active === "advanced" ? <AdvancedJson value={value} known={KNOWN_KEYS} disabled={disabled} onChange={onChange} /> : null}
        {footer}
      </div>
    </Frame>
  );
}

function Frame({ unframed, children }: { unframed: boolean; children: ReactNode }): JSX.Element {
  return unframed ? <>{children}</> : <div className="llm-config">{children}</div>;
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
  void known;
  const saved = advancedTextOf(value);
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
            const edit = advancedEdit(value, v);
            if ("problem" in edit) {
              setProblem(edit.problem);
              return;
            }
            setProblem(null);
            onChange(edit.doc);
          }}
        />
      </Field>
      {problem ? <div className="sub warn-text">not saved — {problem}</div> : null}
    </div>
  );
}
