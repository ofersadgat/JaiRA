/**
 * Presets, as nested vertical tabs: the presets, then the open preset's sections, then its fields.
 *
 * It was a list of rows, each with a `Configure` that opened a whole editor UNDER its row — so
 * comparing two presets meant two editors stacked down the page, an inherited preset was a row that
 * could not be opened at all, and adding one lived in a disclosure at the bottom. One editor with
 * two rails says the same things in one place: the outer rail is the list (each preset still says
 * what it holds without being opened, which is what the row's summary line was for), the inner rail
 * is the section rail the call-settings form has always had, and the detail pane is unchanged.
 *
 * Two layers, because the renderer has no DOM test infrastructure:
 *
 *  - the pure functions at the top decide everything that can be got wrong — what the rail lists,
 *    which tab is chosen after a save, an add or a remove, and whether a name may be used;
 *  - {@link PresetTabs} is a render function over that: every piece of state arrives as a prop, so
 *    each state it can be in is one call to `renderToStaticMarkup`. {@link Presets} is the thin
 *    stateful host the Executors section mounts.
 *
 * Three kinds of preset share the rail (round 5, 2026-09-23): the layer's OWN; one only another layer
 * states; and a BUILT-IN one — what ships in `builtin/settings.json` (`simple`, `coder`, `planner`).
 * The last two are editable in place, like everything else in Settings (the person's note: editing
 * what a layer only sees copies it into the layer being edited first): saving an edit writes the
 * preset into that layer, where it wins. A built-in copy's tab then reads "copied from built in" with
 * "Put back the built-in" to delete it. There is no "Override here" — the first save IS the copy. The
 * open preset's sections start with its Model (`presetModel.tsx`).
 */
import { useEffect, useRef, useState, type JSX, type Ref } from "react";
import { presetNameRefusal } from "@jaira/shared/browser";
import { LlmConfigForm, TabRail, summariseLlmConfig, type CategoryKey, type LeadSection, type LlmConfigDoc, type RailItem } from "./llmConfigForm";
import { PresetModelSection, presetModelLine, presetModelProblem, type CandidateLookup } from "./presetModel";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

// --- the model -----------------------------------------------------------------------

/** What the outer rail has chosen: one preset by name, or the `+ preset` tab. */
export type PresetChoice = { preset: string } | "new";

export interface PresetTab {
  name: string;
  /**
   * `here` — the layer being edited states it. `inherited` — another layer a person writes does, and
   * this one does not. `built-in` — only what ships does, untouched by any layer.
   */
  origin: "here" | "inherited" | "built-in";
  /** For one stated `here`: JaiRA ships a preset of this name, so taking it out of this layer puts the built-in back. */
  shipped?: boolean;
  /** What it holds: the layer's own document for one stated here, the effective one otherwise. */
  value: LlmConfigDoc;
}

export type PresetDocs = Record<string, LlmConfigDoc>;

/**
 * The rail's presets: the ones this layer states, then the ones it only inherits — each of those
 * BUILT-IN when what is in effect is exactly what ships (no layer has touched it), inherited otherwise.
 */
export function presetTabsOf(here: PresetDocs, effective: PresetDocs, builtIn: PresetDocs = {}): PresetTab[] {
  const shipped = (name: string): boolean => Object.prototype.hasOwnProperty.call(builtIn, name);
  return [
    ...Object.keys(here).map((name): PresetTab => ({ name, origin: "here", ...(shipped(name) ? { shipped: true } : {}), value: here[name] ?? {} })),
    ...Object.keys(effective)
      .filter((name) => !(name in here))
      .map(
        (name): PresetTab => ({
          name,
          origin: shipped(name) && JSON.stringify(effective[name]) === JSON.stringify(builtIn[name]) ? "built-in" : "inherited",
          value: effective[name] ?? {},
        }),
      ),
  ];
}

/** Has this preset been edited and not saved? A draft that says what is saved is not one. An inherited preset has no draft. */
export function isDirty(tab: PresetTab, draft: LlmConfigDoc | undefined): boolean {
  return tab.origin !== "inherited" && draft !== undefined && JSON.stringify(draft) !== JSON.stringify(tab.value);
}

/** What a preset holds, in one line: its model first, then its call settings. */
export function presetLine(doc: LlmConfigDoc): string {
  const { model, ...settings } = doc;
  const rest = summariseLlmConfig(settings);
  if (model === undefined) return rest;
  return rest === summariseLlmConfig({}) ? presetModelLine(model) : `${presetModelLine(model)} · ${rest}`;
}

/**
 * The line under a preset's name — the one the row used to show, so a preset still says what it
 * holds without being opened. It follows the DRAFT, and says so: with one editor for every preset,
 * an edit left behind on another tab would otherwise be invisible until it was lost.
 */
export function presetSummary(tab: PresetTab, draft?: LlmConfigDoc): string {
  if (tab.origin === "inherited") return `inherited · ${presetLine(tab.value)}`;
  return isDirty(tab, draft) ? `unsaved · ${presetLine(draft!)}` : presetLine(tab.value);
}

/**
 * The tab that is actually chosen, given the one that was asked for.
 *
 * The asked-for preset can be missing for two opposite reasons. One just ADDED is not in the
 * document until the write lands — `pending` names it, and the view stays on `+ preset` rather
 * than flashing to some other preset and back. One that is simply gone (removed here, removed from
 * the file by hand, a different layer) falls to the first preset, and to `+ preset` when there are
 * none: an empty list opens on the one thing that can be done about it.
 */
export function resolveChoice(tabs: readonly PresetTab[], wanted: PresetChoice | undefined, pending?: string | null): PresetChoice {
  if (wanted === "new") return "new";
  if (wanted !== undefined) {
    if (tabs.some((tab) => tab.name === wanted.preset)) return wanted;
    if (wanted.preset === pending) return "new";
  }
  const first = tabs[0];
  return first === undefined ? "new" : { preset: first.name };
}

/**
 * Where the selection goes when a preset is removed from this layer.
 *
 * It STAYS when another layer states the same name — the tab does not go, it turns into the
 * inherited one, and that is exactly what the person should be shown. Otherwise the next preset
 * down takes it, the one above when it was last, and `+ preset` when it was the only one.
 */
export function choiceAfterRemove(tabs: readonly PresetTab[], name: string, survives: boolean): PresetChoice {
  if (survives) return { preset: name };
  const index = tabs.findIndex((tab) => tab.name === name);
  const rest = tabs.filter((tab) => tab.name !== name);
  if (rest.length === 0) return "new";
  return { preset: rest[Math.min(Math.max(index, 0), rest.length - 1)]!.name };
}

/**
 * Why a name cannot be used for a new preset, or `undefined` when it can.
 *
 * A name is one word no model id can be (`presetNameRefusal`), because a model field may name a preset
 * — which also refuses a dot, which the dotted write (`presets.<name>`) would have saved as a preset
 * called `gpt` holding a setting called `fast`. A name already in the rail is refused because adding
 * it used to REPLACE that preset with an empty one, silently.
 */
export function presetNameProblem(name: string, tabs: readonly PresetTab[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "can't be empty";
  // The parser's own rule, so a name this accepts is one a save cannot be refused over. It also rules
  // out the dot the dotted write (`presets.<name>`) would have split on.
  const refused = presetNameRefusal(trimmed);
  if (refused !== undefined) return refused;
  const taken = tabs.find((tab) => tab.name === trimmed);
  if (taken === undefined) return undefined;
  if (taken.origin === "here") return `there is already a preset called '${trimmed}'`;
  return taken.origin === "built-in"
    ? `'${trimmed}' ships built in — open it and edit it, and the edit is saved here`
    : `'${trimmed}' is inherited here — open it and edit it, and the edit is saved here`;
}

// --- the render function -------------------------------------------------------------

const NEW_ID = "+";
const tabId = (name: string): string => `preset:${name}`;

/** The member's KEY is the placeholder the path ends in, so the field's key tag reads as the path a name is written to. */
const NAME_KEY = "<name>";
const NAME_SCHEMA: Schema = {
  type: "object",
  required: [NAME_KEY],
  properties: {
    [NAME_KEY]: { type: "string", title: "Name", description: "What a state will write in configRef — one word, since a model field may name it too.", minLength: 1 },
  },
};
const NAME_PATH = "models.presets";

export interface PresetTabsProps {
  tabs: readonly PresetTab[];
  choice: PresetChoice;
  onChoice: (next: PresetChoice) => void;
  section: CategoryKey;
  onSection: (next: CategoryKey) => void;
  /** Unsaved edits, by preset name. Kept per preset so that looking at another one loses nothing. */
  drafts: PresetDocs;
  onDraft: (name: string, next: LlmConfigDoc | undefined) => void;
  /** The name being typed under `+ preset`. */
  newName: string;
  onNewName: (next: string) => void;
  /** The layer cannot be written right now — another write is in flight, or it is read-only. */
  locked: boolean;
  /** Where an inherited preset comes from, as the layer picker names it: "Shared (all projects)". */
  originOf: (name: string) => string;
  /** The layer being edited, in a word — "shared", "this project" — for "copied from built in". */
  layerWord: string;
  /** Where each candidate model stands on this machine, for the Model section. */
  lookup: CandidateLookup;
  /** Model ids the Model section offers in each candidate's box. */
  suggestions: readonly string[];
  onSave: (name: string, value: LlmConfigDoc) => void;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
  /** The box, for a host that has to put the focus back on the rail — see {@link Presets}. */
  rootRef?: Ref<HTMLDivElement>;
}

export function PresetTabs(props: PresetTabsProps): JSX.Element {
  const { tabs, choice, drafts } = props;
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
              <i className="set-here-dot" title="set in the layer you are editing" />
              {tab.shipped ? <span className="cx-src">{props.layerWord} · copied from built in</span> : null}
            </>
          ) : tab.origin === "built-in" ? (
            <>
              {tab.name}
              <span className="cx-src">built in</span>
            </>
          ) : (
            tab.name
          ),
        summary: presetSummary(tab, drafts[tab.name]),
      }),
    ),
    { id: NEW_ID, className: "set-rail-add", summary: "+ preset", title: "add a preset" },
  ];

  // The box and the outer rail are drawn HERE, at one place in the tree whatever is open, so the rail
  // stays mounted while the editor beside it is swapped — a tab reached with an arrow key keeps the
  // focus it was given. The editor is keyed by preset so nothing typed into one leaks into the next.
  return (
    <div ref={props.rootRef} className={`llm-config preset-config${open === undefined ? " preset-new" : ""}`}>
      <TabRail
        label="Presets"
        className="preset-rail"
        items={items}
        selected={open === undefined ? NEW_ID : tabId(open.name)}
        onSelect={(id) => props.onChoice(id === NEW_ID ? "new" : { preset: id.slice(tabId("").length) })}
      />
      {open === undefined ? <NewPreset {...props} /> : <OpenPreset key={`${open.origin}:${open.name}`} open={open} {...props} />}
    </div>
  );
}

/** `+ preset`: a name is all a new one needs, so a name is all this asks for. */
function NewPreset(props: PresetTabsProps): JSX.Element {
  const problem = presetNameProblem(props.newName, props.tabs);
  const typed = props.newName.trim().length > 0;
  return (
    <div className="llm-detail" role="tabpanel" aria-label="A new preset">
      <div className="llm-detail-head">
        <span className="llm-detail-title">A new preset</span>
        <span className="cfg-hint">A named set of call settings. A name is all it needs — its sections appear once it has one.</span>
      </div>
      <SchemaForm
        schema={NAME_SCHEMA}
        value={{ [NAME_KEY]: props.newName }}
        onChange={(next) => {
          const name = (next as Record<string, unknown> | undefined)?.[NAME_KEY];
          props.onNewName(typeof name === "string" ? name : "");
        }}
        ctx={{
          path: NAME_PATH,
          disabled: props.locked,
          // Said only once something is typed: an empty box is not a mistake yet, and the button
          // under it is already inactive.
          ...(typed && problem !== undefined ? { errors: [{ path: `${NAME_PATH}.${NAME_KEY}`, message: problem }] } : {}),
        }}
      />
      <div className="pane-actions">
        <button type="button" className="primary" disabled={props.locked || problem !== undefined} onClick={() => props.onAdd(props.newName.trim())}>
          Add it
        </button>
      </div>
    </div>
  );
}

/** One preset in the editor: its sections and fields, then what can be done with it as a whole. */
function OpenPreset({ open, ...props }: PresetTabsProps & { open: PresetTab }): JSX.Element {
  const name = open.name;
  /** The Model section over a document — the draft for an editable preset, the value for an inherited one. */
  const modelLead = (doc: LlmConfigDoc, disabled: boolean, onDoc: (next: LlmConfigDoc) => void): LeadSection => ({
    key: "model",
    label: "Model",
    hint: "Which model a state that picks this preset runs on, and how it is chosen.",
    summary: presetModelLine(doc["model"]),
    body: (
      <PresetModelSection
        value={doc["model"]}
        disabled={disabled}
        lookup={props.lookup}
        suggestions={props.suggestions}
        onChange={(model) => {
          const { model: _was, ...rest } = doc;
          onDoc(model === undefined ? rest : { ...rest, model });
        }}
      />
    ),
  });

  // Every preset is the same editor, editable. One this layer does not state — built in, or another
  // layer's — is saved INTO the layer being edited, the normal layered write, and from then on it is
  // that layer's copy.
  const draft = props.drafts[name] ?? open.value;
  const dirty = isDirty(open, props.drafts[name]);
  const unsaveable = presetModelProblem(draft["model"]) !== undefined;
  return (
    <LlmConfigForm
      unframed
      value={draft}
      disabled={props.locked}
      // "set here" is true only of the layer's own; one it does not state yet is not set here until saved.
      marks={open.origin === "here"}
      onChange={(next) => props.onDraft(name, next)}
      lead={modelLead(draft, props.locked, (next) => props.onDraft(name, next))}
      // The preset resolves in main as a run would — to the model it would pick on this machine — and
      // Reasoning offers that model's levels (decision 0009).
      levelsFor={name}
      section={props.section}
      onSection={props.onSection}
      footer={
        // Remove sits at the far end, away from Save and Revert: it is the one action here that
        // cannot be taken back, and it should not be where a hand going for Save lands.
        <>
          {open.origin === "built-in" ? (
            <p className="cfg-hint preset-note">
              <span className="cfg-status">
                <span className="cfg-dot" aria-hidden="true" />
                built in
              </span>{" "}
              What JaiRA ships. Saving a change copies it into {props.layerWord}, where it wins; what ships stays as it is.
            </p>
          ) : open.origin === "inherited" ? (
            <p className="cfg-hint preset-note">
              <span className="cfg-status unchecked">
                <span className="cfg-dot" aria-hidden="true" />
                inherited
              </span>{" "}
              from {props.originOf(name)}. Saving a change copies it into {props.layerWord}, where it wins.
            </p>
          ) : null}
          <div className="pane-actions">
            <button type="button" className="primary" disabled={props.locked || !dirty || unsaveable} onClick={() => props.onSave(name, draft)}>
              Save
            </button>
            <button type="button" className="ghost" disabled={!dirty} onClick={() => props.onDraft(name, undefined)}>
              Revert
            </button>
            <span className="grow" />
            {open.origin === "here" ? (
              <button
                type="button"
                className={`ghost${open.shipped ? "" : " danger"}`}
                disabled={props.locked}
                title={open.shipped ? `delete this layer's copy — ${name} is then what ships` : undefined}
                onClick={() => props.onRemove(name)}
              >
                {open.shipped ? "Put back the built-in" : `Remove ${name}`}
              </button>
            ) : null}
          </div>
        </>
      }
    />
  );
}

// --- the host ------------------------------------------------------------------------

/**
 * The state {@link PresetTabs} is drawn from, and the writes it asks for.
 *
 * The selection lives HERE and is a name, not an index — which is the whole of "the selection
 * survives a Save": the document is re-read and the props change, this component does not remount,
 * and the name still resolves. Mount it with a `key` of the layer, so a different layer starts clean
 * instead of showing one layer's unsaved edits over another's presets.
 */
export function Presets({
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
  /** The presets the layer being edited states. */
  here: PresetDocs;
  /** The presets in effect, every layer merged. */
  effective: PresetDocs;
  /** The presets the OTHER layer states — what decides whether a removed preset survives as inherited. */
  others: PresetDocs;
  /** The presets JaiRA ships (`ConfigView.system`) — a copy of one taken out of this layer leaves the built-in. */
  builtIn: PresetDocs;
  locked: boolean;
  /** The other layer, as the layer picker names it. */
  originLabel: string;
  /** The layer being edited, in a word — see {@link PresetTabsProps.layerWord}. */
  layerWord: string;
  lookup: CandidateLookup;
  suggestions: readonly string[];
  /** Write one preset into the layer. `undefined` removes it. */
  onWrite: (name: string, value: LlmConfigDoc | undefined) => void;
}): JSX.Element {
  const [wanted, setWanted] = useState<PresetChoice | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [section, setSection] = useState<CategoryKey>("model");
  const [drafts, setDrafts] = useState<PresetDocs>({});
  const [newName, setNewName] = useState("");

  // Add, Remove and Override each take away the button that was just pressed — the panel it sat in
  // is replaced — and the focus would go with it to nowhere. It is put on the chosen preset's tab
  // instead, which is where the thing that just happened is shown.
  const root = useRef<HTMLDivElement>(null);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus === 0) return;
    // Only when the focus is here or lost: a person who has gone elsewhere while the write was in
    // flight is not pulled back.
    const active = document.activeElement;
    if (active !== null && active !== document.body && root.current?.contains(active) !== true) return;
    root.current?.querySelector<HTMLElement>('.preset-rail [role="tab"][aria-selected="true"]')?.focus();
  }, [refocus]);

  const tabs = presetTabsOf(here, effective, builtIn);

  // The preset that was added has arrived: the view moves to it by itself (it is what `wanted`
  // names), and the box that named it is emptied for the next one.
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

  return (
    <PresetTabs
      tabs={tabs}
      choice={resolveChoice(tabs, wanted, pending)}
      onChoice={setWanted}
      section={section}
      onSection={setSection}
      drafts={drafts}
      onDraft={(name, next) => (next === undefined ? dropDraft(name) : setDrafts((current) => ({ ...current, [name]: next })))}
      newName={newName}
      onNewName={setNewName}
      locked={locked}
      originOf={() => originLabel}
      layerWord={layerWord}
      lookup={lookup}
      suggestions={suggestions}
      onSave={(name, value) => {
        setWanted({ preset: name });
        onWrite(name, value);
      }}
      rootRef={root}
      onRemove={(name) => {
        setWanted(choiceAfterRemove(tabs, name, name in others || name in builtIn));
        dropDraft(name);
        setRefocus((n) => n + 1);
        onWrite(name, undefined);
      }}
      onAdd={(name) => {
        setWanted({ preset: name });
        setPending(name);
        setSection("model");
        onWrite(name, {});
      }}
    />
  );
}
