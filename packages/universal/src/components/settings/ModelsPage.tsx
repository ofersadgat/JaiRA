import { useEffect, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { DEFAULT_EXECUTOR, type ConfigLayer, type PresetModel } from "@jaira/shared/browser";
import { SOURCE_BRAND, catalogLastLine, catalogRowOf, useCatalogStatus, type CatalogState } from "@jaira/ui/catalogModel";
import { configWriter, presetNamesOf, type Writer } from "@jaira/ui/configWriter";
import { LAYER_LABELS } from "@jaira/ui/layerLabels";
import { useLimits } from "@jaira/ui/limitsStore";
import { summariseLlmConfig, type CategoryKey, type LlmConfigDoc } from "@jaira/ui/llmConfigModel";
import { DEFAULT_ENVIRONMENT, defaultOverlayOf, layerWordOf, mergedDefaultsOf, modelDefaultsOf, otherLayerOf, presetsOf, suggestionsOf, type PresetDocs } from "@jaira/ui/modelsPageModel";
import { PRESET_RULES, candidateLookupOf, candidatesSchema, candidatesViewOf, presetModelLine, presetModelProblem, presetRuleWords, type CandidateLookup, type CandidateStatus } from "@jaira/ui/presetCandidates";
import { choiceAfterRemove, isDirty, presetNameProblem, presetSummary, presetTabsOf, resolveChoice, type PresetChoice, type PresetTab } from "@jaira/ui/presetTabsModel";
import { useShell } from "../../app/shell";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Pill } from "../Pill";
import { Icon } from "../panel/Icon";
import { Disclosure, Field, FieldGrid } from "../form/Field";
import { FormInput } from "../form/inputs";
import { LlmConfigForm, RailDetail, RailFrame, TabRail, type LeadSection, type RailItem } from "../form/LlmConfigForm";
import { SchemaForm } from "../form/SchemaForm";
import { Hint, Mark, PaneActions, SourceTag, Stack, Status } from "./bits";
import { Button } from "./Button";
import { Segmented } from "./controls";
import { ExecutorRoutes, ExecutorTree } from "./ExecutorTree";
import { SettingsSection, useDrawnRow } from "./SettingsPage";

/**
 * Settings → Models: the defaults a state that names nothing is filled in with, the routes a model
 * id's prefix dispatches to, the presets a state picks by name, the catalog the routes report, and —
 * under Advanced — the executor tree. What each reads and writes is `modelsPageModel.ts`'s,
 * `presetTabsModel.ts`'s, `presetCandidates.ts`'s and `catalogModel.ts`'s. What it adds to the page's
 * look:
 *
 *   the presets' frame          172 | 146 | 1fr (172 | 1fr for a new one); the outer rail --text 5%
 *                               into --panel-2
 *   the "set here" dot          6 round, --accent, 6 after the name
 *   a preset's rule             row, centred, wraps, gap 8, 8 above the candidates
 *   a candidate's note          row, centred, wraps, gap 6, 5 below the row
 *   a preset's origin note      2 in, 8 above
 *   a catalog row               padding 13 16 in a card, a --line between; the hover wash
 *   its head                    row, centred, gap 8; the title app 600 at 13/12.5, growing
 *   its version                 data 10.5/12 --dim
 *   what it says                30 in, app 11.5/12.5, line 1.45, --dim; its state --text (--bad failed)
 *   its fix                     app 11/12.5, line 1.4, --accent, 2 above
 *   the catalog's aside         row, centred, gap 10
 *   a row's count               data-secondary, tabular, 8 before the pill
 */
export function ModelsPage(): JSX.Element {
  const { state, actions } = useShell();
  const catalog = useCatalogStatus(state.availability.checkedAt);
  const config = state.config;
  if (config === null) {
    return (
      <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
        The configuration could not be read.
      </Txt>
    );
  }
  const layer = state.configLayer;
  const editable = layer !== "project" || state.at !== null;
  const locked = state.busy || !editable;
  const overlay = defaultOverlayOf(config, layer);
  const onOverlay = (next: Parameters<typeof actions.saveDefinition>[1]): void => void actions.saveDefinition(DEFAULT_EXECUTOR, next, layer);
  const tree = state.availability.tree;
  const notYet = <Hint card>Not resolved yet — the startup check has not finished.</Hint>;
  return (
    <>
      <ModelDefaults {...configWriter(config, layer, locked, actions.saveConfig)} />
      <SettingsSection
        id="routes"
        title="Routes"
        info="Where a model id's prefix sends a call — claude-cli/… to the CLI agent, anthropic/… to the API. Derived from everything available, so a provider or agent you set up appears here by itself; configuring one pins only what you changed."
      >
        {tree === undefined ? notYet : <ExecutorRoutes resolved={tree} overlay={overlay} locked={locked} onOverlay={onOverlay} />}
      </SettingsSection>
      <PresetsGroup layer={layer} locked={locked} lookup={candidateLookupOf(state.availability)} catalogIds={catalog.view?.modelIds ?? []} onSave={actions.saveModels} />
      <CatalogSection catalog={catalog} />
      <SettingsSection
        id="advanced"
        title="Advanced"
        info="The default executor as the tree it is: an operation executor over a function executor and a router, and the layers wrapped around each. What every UI-initiated operation uses — starting a task, proposing workflow changes, summarizing a conversation. Nothing here has to be configured: what is shown is derived from what is available, and a change pins only the field you changed."
      >
        {tree === undefined ? (
          notYet
        ) : (
          <Disclosure card summary="How a call is dispatched" desc="the executor tree, and the layers around each level">
            <ExecutorTree resolved={tree} overlay={overlay} locked={locked} agents={state.executors.map((e) => e.name)} onOverlay={onOverlay} split />
          </Disclosure>
        )}
      </SettingsSection>
    </>
  );
}

/** The default model and the call settings a state that names nothing gets. */
function ModelDefaults({ effective, locked, set, layer }: Writer): JSX.Element {
  const { model, knobs } = modelDefaultsOf(effective);
  // The presets, each marked as one — a list to pick a preset from, in a box that still takes any
  // model id.
  const presets = presetNamesOf(effective).map((name) => ({ value: name, label: "preset" }));
  return (
    <SettingsSection
      id="defaults"
      title="Defaults"
      info="What a state that names nothing is filled in with — the same fields a state's own environment block carries, one level out. Applied under whatever a state says, so naming a field there always wins."
    >
      <FieldGrid>
        <Field
          label="Default model"
          param={`${DEFAULT_ENVIRONMENT}.model`}
          hint="A model id, or a preset's name — 'coder' means the model coder chooses. A bare id routes to whatever serves that family here — 'claude-sonnet-5' reaches the CLI agent on a machine with no API key. Prefix it ('claude-cli/sonnet') to insist on one route. Empty leaves the choice to the state."
          layer={layer(`${DEFAULT_ENVIRONMENT}.model`)}
        >
          <FormInput value={model} mono placeholder="a model id, or a preset" disabled={locked} suggest={presets} onChange={(v) => set(`${DEFAULT_ENVIRONMENT}.model`, v === "" ? undefined : v)} />
        </Field>
        <Field label="Call settings" hint={summariseLlmConfig(knobs)} wide>
          <LlmConfigForm value={knobs} levelsFor={model === "" ? undefined : model} disabled={locked} onChange={(next) => set(DEFAULT_ENVIRONMENT, mergedDefaultsOf(next, model))} />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** Named LLM configurations a state selects with `operation.configRef`. */
function PresetsGroup({ layer, locked, lookup, catalogIds, onSave }: { layer: ConfigLayer; locked: boolean; lookup: CandidateLookup; catalogIds: readonly string[]; onSave: (fields: Record<string, unknown>, layer: ConfigLayer) => void }): JSX.Element {
  const { state } = useShell();
  const config = state.config!;
  const builtIn = presetsOf(config.system);
  const effective = presetsOf(config.effective);
  const other = otherLayerOf(layer);
  return (
    <SettingsSection
      id="presets"
      title="Presets"
      info="A named model and set of call settings a state picks with configRef, merged under its own config — simple, coder and planner ship built in, and editing one saves your copy in this layer. A model field (the default model, the judge) may name a preset too. A definition is the heavier tool — it chooses the provider and the stack too."
    >
      <Presets
        key={layer}
        here={presetsOf(config[layer])}
        effective={effective}
        others={presetsOf(config[other])}
        builtIn={builtIn}
        locked={locked}
        originLabel={LAYER_LABELS[other]}
        layerWord={layerWordOf(layer)}
        lookup={lookup}
        suggestions={suggestionsOf(catalogIds, effective, builtIn)}
        onWrite={(name, value) => onSave({ [`presets.${name}`]: value }, layer)}
      />
    </SettingsSection>
  );
}

const NEW_ID = "+";
const tabId = (name: string): string => `preset:${name}`;
const NAME_KEY = "<name>";
const NAME_SCHEMA = {
  type: "object",
  required: [NAME_KEY],
  properties: { [NAME_KEY]: { type: "string", title: "Name", description: "What a state will write in configRef — one word, since a model field may name it too.", minLength: 1 } },
};
const NAME_PATH = "models.presets";

/** The stateful host over the rail of presets and the open one's editor (`presetTabsModel.ts`). */
function Presets({
  here,
  effective,
  others,
  builtIn,
  locked,
  originLabel,
  layerWord,
  lookup,
  suggestions,
  onWrite,
}: {
  here: PresetDocs;
  effective: PresetDocs;
  others: PresetDocs;
  builtIn: PresetDocs;
  locked: boolean;
  originLabel: string;
  layerWord: string;
  lookup: CandidateLookup;
  suggestions: readonly string[];
  onWrite: (name: string, value: LlmConfigDoc | undefined) => void;
}): JSX.Element {
  const t = useTokens();
  const [wanted, setWanted] = useState<PresetChoice | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [section, setSection] = useState<CategoryKey>("model");
  const [drafts, setDrafts] = useState<PresetDocs>({});
  const [newName, setNewName] = useState("");
  // Add, Remove and "Put back the built-in" each take away the button that was just pressed — the pane
  // it sat in is replaced — and the focus would go with it to nowhere. It is put on the chosen preset's
  // tab instead, where what just happened is shown. Web: a phone has no focus to lose.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus === 0 || !isWeb) return;
    const rail = document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${PRESETS_RAIL}"]`);
    // Only when the focus is here or lost: a person who has gone elsewhere while the write was in flight
    // is not pulled back.
    const active = document.activeElement;
    if (active !== null && active !== document.body && rail?.closest("[data-llm-config]")?.contains(active) !== true) return;
    rail?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [refocus]);
  const tabs = presetTabsOf(here, effective, builtIn);
  if (pending !== null && tabs.some((tab) => tab.name === pending)) {
    setPending(null);
    setNewName("");
    setRefocus((n) => n + 1);
  }
  const dropDraft = (name: string): void =>
    setDrafts((current) => {
      if (!(name in current)) return current;
      const { [name]: _gone, ...rest } = current;
      return rest;
    });
  const choice = resolveChoice(tabs, wanted, pending);
  const open = choice === "new" ? undefined : tabs.find((tab) => tab.name === choice.preset);
  const items: RailItem[] = [
    ...tabs.map(
      (tab): RailItem => ({
        id: tabId(tab.name),
        mono: true,
        label:
          tab.origin === "here" ? (
            <>
              {tab.name}
              <HereDot />
              {tab.shipped ? <SourceTag>{`${layerWord} · copied from built in`}</SourceTag> : null}
            </>
          ) : tab.origin === "built-in" ? (
            <>
              {tab.name}
              <SourceTag>built in</SourceTag>
            </>
          ) : (
            tab.name
          ),
        summary: presetSummary(tab, drafts[tab.name]),
      }),
    ),
    { id: NEW_ID, add: true, summary: "+ preset", title: "add a preset" },
  ];
  return (
    <RailFrame card>
        <TabRail
          width={172}
          ground={t.mix(t.v("text"), 5, t.v("panel-2"))}
          label={PRESETS_RAIL}
          items={items}
          selected={open === undefined ? NEW_ID : tabId(open.name)}
          onSelect={(id) => setWanted(id === NEW_ID ? "new" : { preset: id.slice(tabId("").length) })}
        />
        {open === undefined ? (
          <NewPreset
            tabs={tabs}
            newName={newName}
            onNewName={setNewName}
            locked={locked}
            onAdd={(name) => {
              setWanted({ preset: name });
              setPending(name);
              setSection("model");
              onWrite(name, {});
            }}
          />
        ) : (
          <OpenPreset
            key={`${open.origin}:${open.name}`}
            open={open}
            drafts={drafts}
            onDraft={(name, next) => (next === undefined ? dropDraft(name) : setDrafts((current) => ({ ...current, [name]: next })))}
            section={section}
            onSection={setSection}
            locked={locked}
            layerWord={layerWord}
            origin={originLabel}
            lookup={lookup}
            suggestions={suggestions}
            onSave={(name, value) => {
              setWanted({ preset: name });
              onWrite(name, value);
            }}
            onRemove={(name) => {
              setWanted(choiceAfterRemove(tabs, name, name in others || name in builtIn));
              dropDraft(name);
              setRefocus((n) => n + 1);
              onWrite(name, undefined);
            }}
          />
        )}
    </RailFrame>
  );
}

/** The presets rail's accessible name — and how the focus finds it again after an add or a remove. */
const PRESETS_RAIL = "Presets";

/** The dot after the name of a preset this layer states: 6 round, --accent. */
function HereDot(): JSX.Element {
  const t = useTokens();
  return <View display={"inline-flex" as "flex"} width={6} height={6} marginLeft={6} borderRadius={999} backgroundColor={t.v("accent") as never} {...({ title: "set in the layer you are editing", verticalAlign: "middle" } as object)} />;
}

function NewPreset({ tabs, newName, onNewName, locked, onAdd }: { tabs: readonly PresetTab[]; newName: string; onNewName: (next: string) => void; locked: boolean; onAdd: (name: string) => void }): JSX.Element {
  const problem = presetNameProblem(newName, tabs);
  const typed = newName.trim().length > 0;
  return (
    <RailDetail title="A new preset" hints={["A named set of call settings. A name is all it needs — its sections appear once it has one."]}>
      <SchemaForm
        schema={NAME_SCHEMA}
        value={{ [NAME_KEY]: newName }}
        onChange={(next) => {
          const name = (next as Record<string, unknown> | undefined)?.[NAME_KEY];
          onNewName(typeof name === "string" ? name : "");
        }}
        ctx={{ path: NAME_PATH, disabled: locked, ...(typed && problem !== undefined ? { errors: [{ path: `${NAME_PATH}.${NAME_KEY}`, message: problem }] } : {}) }}
      />
      <PaneActions>
        <Button kind="primary" disabled={locked || problem !== undefined} onPress={() => onAdd(newName.trim())}>
          Add it
        </Button>
      </PaneActions>
    </RailDetail>
  );
}

function OpenPreset({
  open,
  drafts,
  onDraft,
  section,
  onSection,
  locked,
  layerWord,
  origin,
  lookup,
  suggestions,
  onSave,
  onRemove,
}: {
  open: PresetTab;
  drafts: PresetDocs;
  onDraft: (name: string, next: LlmConfigDoc | undefined) => void;
  section: CategoryKey;
  onSection: (next: CategoryKey) => void;
  locked: boolean;
  layerWord: string;
  origin: string;
  lookup: CandidateLookup;
  suggestions: readonly string[];
  onSave: (name: string, value: LlmConfigDoc) => void;
  onRemove: (name: string) => void;
}): JSX.Element {
  const name = open.name;
  const draft = drafts[name] ?? open.value;
  const dirty = isDirty(open, drafts[name]);
  const unsaveable = presetModelProblem(draft["model"]) !== undefined;
  const lead: LeadSection = {
    key: "model",
    label: "Model",
    hint: "Which model a state that picks this preset runs on, and how it is chosen.",
    summary: presetModelLine(draft["model"]),
    body: (
      <PresetModelSection
        value={draft["model"]}
        disabled={locked}
        lookup={lookup}
        suggestions={suggestions}
        onChange={(model) => {
          const { model: _was, ...rest } = draft;
          onDraft(name, model === undefined ? rest : { ...rest, model });
        }}
      />
    ),
  };
  // A preset's origin note: a hint, the status pill set inline in its sentence.
  const note = (kind: "plain" | "unchecked", word: string, rest: string): ReactNode => (
    <Hint marginTop={8} marginHorizontal={2}>
      <Status kind={kind} inline>
        {word}
      </Status>
      {` ${rest}`}
    </Hint>
  );
  return (
    <LlmConfigForm
      unframed
      railWidth={146}
      value={draft}
      disabled={locked}
      marks={open.origin === "here"}
      onChange={(next) => onDraft(name, next)}
      lead={lead}
      levelsFor={name}
      section={section}
      onSection={onSection}
      footer={
        <>
          {open.origin === "built-in"
            ? note("plain", "built in", `What JaiRA ships. Saving a change copies it into ${layerWord}, where it wins; what ships stays as it is.`)
            : open.origin === "inherited"
              ? note("unchecked", "inherited", `from ${origin}. Saving a change copies it into ${layerWord}, where it wins.`)
              : null}
          <PaneActions marginTop="auto">
            <Button kind="primary" disabled={locked || !dirty || unsaveable} onPress={() => onSave(name, draft)}>
              Save
            </Button>
            <Button kind="ghost" disabled={!dirty} onPress={() => onDraft(name, undefined)}>
              Revert
            </Button>
            <View flex={1} minWidth={0} />
            {open.origin === "here" ? (
              <Button kind={open.shipped ? "ghost" : "danger"} disabled={locked} {...(open.shipped ? { title: `delete this layer's copy — ${name} is then what ships` } : {})} onPress={() => onRemove(name)}>
                {open.shipped ? "Put back the built-in" : `Remove ${name}`}
              </Button>
            ) : null}
          </PaneActions>
        </>
      }
    />
  );
}

/** A preset's Model section: the rule and the candidates it picks from. */
function PresetModelSection({ value, onChange, disabled, lookup, suggestions }: { value: unknown; onChange: (next: PresetModel | undefined) => void; disabled: boolean; lookup: CandidateLookup; suggestions: readonly string[] }): JSX.Element {
  const { candidates, statuses, lefts, rule, picked, problem } = candidatesViewOf(value, lookup, useLimits());
  return (
    <Stack>
      <Field
        label="Model"
        param="model"
        hint="Which model a state that picks this preset runs on — chosen when its conversation starts, and kept for the rest of it. With none, the state's own model answers, or the default."
        layer={{ stated: value !== undefined, disabled, label: "Name no model — the state's own answers", onInherit: () => onChange(undefined) }}
        error={problem}
        wide
      >
        <>
          <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={8} marginBottom={8} width="100%">
            <Segmented
              value={rule}
              options={PRESET_RULES}
              label="How a candidate is chosen"
              disabled={disabled}
              onChange={(next) => {
                const ids = candidates.filter((id) => id.length > 0);
                if (ids.length > 0) onChange({ candidates, choose: next });
              }}
            />
            <Hint>{presetRuleWords(rule)}</Hint>
          </View>
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
                return status === undefined ? null : <CandidateNote status={status} picked={index === picked} left={rule === "most-left" ? (lefts[index] ?? null) : undefined} />;
              },
            }}
          />
        </>
      </Field>
    </Stack>
  );
}

/** Under one candidate: the route it would go through, whether it can run, and whether it is picked. */
function CandidateNote({ status, picked, left }: { status: CandidateStatus; picked: boolean; left?: number | null | undefined }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={6} marginTop={5}>
      {status.route !== undefined ? <SourceTag first>{`via ${status.route}${status.plan !== undefined ? ` · ${status.plan}` : ""}`}</SourceTag> : null}
      {status.state === "unchecked" ? (
        <Status>not checked yet</Status>
      ) : status.state === "available" ? (
        <Status kind="available">available</Status>
      ) : (
        <Status kind="unavailable" title={status.why}>{`not available — ${status.why ?? ""}`}</Status>
      )}
      {left !== undefined ? <SourceTag first>{left === null ? "usage left not known" : `${Math.round(left)}% left`}</SourceTag> : null}
      {picked ? (
        <Status kind="here" dot={false}>
          picked now
        </Status>
      ) : null}
    </View>
  );
}

/**
 * A button in a section's heading is set in the heading's font: its size, weight and line, not its
 * tracking, which stays the heading's own.
 */
export const SECTION_FONT = { scale: 1.1, weight: 450, lineHeight: 1.3 } as const;

/** Settings → Models → Catalog: what this machine's routes say they serve. */
function CatalogSection({ catalog }: { catalog: CatalogState }): JSX.Element {
  const { view, now, busy, refresh } = catalog;
  const last = catalogLastLine(view, now);
  return (
    <SettingsSection
      id="catalog"
      title="Catalog"
      info="What this machine's routes say they serve — each model's levels, limits and price. Refreshed by itself after every availability check and hourly; press Refresh after installing a model or updating an agent."
      action={
        <View flexDirection="row" alignItems="center" gap={10}>
          {/* In the heading: the words take its line and tracking, the button its font (450 at 1.1×, line 1.3). */}
          {last !== undefined ? <Txt register="app-secondary" spec={{ lineHeight: 1.3, ls: -0.005 }}>{last}</Txt> : null}
          <Button kind="ghost" disabled={busy} onPress={refresh} font={SECTION_FONT}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </View>
      }
    >
      {view === null ? (
        <Hint card>Reading the catalog…</Hint>
      ) : (
        // The sources: a column, 2 between rows.
        <View flexDirection="column" gap={2}>
          {view.sources.map((source, i) => (
            <CatalogRow key={source.name} source={source} now={now} first={i === 0} />
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

function CatalogRow({ source, now, first }: { source: NonNullable<CatalogState["view"]>["sources"][number]; now: number; first: boolean }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const row = catalogRowOf(source, now);
  // A source is a row that is always drawn: under "What you changed" the catalog and its Refresh stay.
  useDrawnRow(true);
  return (
    <View
      flexDirection="column"
      gap={3}
      paddingVertical={13}
      paddingHorizontal={16}
      // The row's radius, which rounds the ends of the rule above it too.
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(first ? {} : (edge(t, { top: 1 }) as object))}
      backgroundColor={hovered ? (t.v("fill-ghost-hover") as never) : "transparent"}
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)}
    >
      <View flexDirection="row" alignItems="center" gap={8}>
        <Mark brand={SOURCE_BRAND[source.name] ?? source.name} state={row.state} />
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} numberOfLines={1}>
          {source.name}
        </Txt>
        {source.version !== undefined ? (
          <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} flexShrink={0}>
            {source.version}
          </Txt>
        ) : null}
        <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} />
        {source.fetched !== undefined && source.state === "ok" ? (
          <Txt register="data-secondary" spec={{ tabular: true }} marginRight={8}>{`${source.fetched} rows`}</Txt>
        ) : null}
        {source.state === "failed" && source.models.length > 0 ? (
          <Txt register="data-secondary" spec={{ tabular: true }} marginRight={8}>{`${source.models.length} rows, kept`}</Txt>
        ) : null}
        {source.state === "ok" ? <Pill kind="success" word="ok" /> : source.state === "failed" ? <Pill kind="error" word="failed" /> : null}
        {source.models.length > 0 ? (
          <Press
            onPress={() => setOpen((v) => !v)}
            label={open ? `hide ${source.name}'s models` : `show ${source.name}'s models`}
            title={open ? "Hide the models" : "Show the models"}
            {...({ "aria-expanded": open } as object)}
            padding={2}
            // A quiet button: its ring is there, transparent.
            borderWidth={1}
            borderStyle="solid"
            borderColor="transparent"
            borderRadius={lengthToken(t, "control-radius", 7)}
            box={({ hovered: over }) => ({ backgroundColor: over ? t.v("fill-ghost-hover") : "transparent" })}
          >
            <View transform={[{ rotate: open ? "180deg" : "0deg" }]}>
              <Icon name="chevron" size={14} color={String(t.v("dim"))} />
            </View>
          </Press>
        ) : null}
      </View>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.45, color: "dim" }} paddingLeft={30}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.45, color: row.state === "unavailable" ? "bad" : "text" }}>{source.state}</Txt>
        {row.say}
      </Txt>
      {source.fix !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "accent" }} paddingLeft={30} marginTop={2}>{`→ ${source.fix}`}</Txt>
      ) : null}
      {open ? (
        <View flexDirection="row" gap={18} marginTop={8} paddingLeft={30}>
          {(["id", "levels", "hidden"] as const).map((col) => (
            <View key={col} flexDirection="column" gap={3}>
              {source.models.map((model) =>
                col === "id" ? (
                  <Txt key={model.id} register="data-text">
                    {model.id}
                  </Txt>
                ) : col === "levels" ? (
                  <Txt key={model.id} register="app-secondary">
                    {model.alias ?? model.levels ?? ""}
                  </Txt>
                ) : (
                  <Txt key={model.id} spec={{ voice: "data", scale: 0.76, weight: 600, lineHeight: 1.45, color: "tok-hint" }}>
                    {model.hidden === true ? "hidden" : ""}
                  </Txt>
                ),
              )}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
