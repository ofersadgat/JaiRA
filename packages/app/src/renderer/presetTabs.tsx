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
 */
import { useEffect, useRef, useState, type JSX, type Ref } from "react";
import { LlmConfigForm, TabRail, summariseLlmConfig, type CategoryKey, type LlmConfigDoc, type RailItem } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

// --- the model -----------------------------------------------------------------------

/** What the outer rail has chosen: one preset by name, or the `+ preset` tab. */
export type PresetChoice = { preset: string } | "new";

export interface PresetTab {
  name: string;
  /** `here` — the layer being edited states it. `inherited` — only another layer does. */
  origin: "here" | "inherited";
  /** What it holds: the layer's own document for one stated here, the effective one otherwise. */
  value: LlmConfigDoc;
}

export type PresetDocs = Record<string, LlmConfigDoc>;

/** The rail's presets: the ones this layer states, then the ones it only inherits. */
export function presetTabsOf(here: PresetDocs, effective: PresetDocs): PresetTab[] {
  return [
    ...Object.keys(here).map((name): PresetTab => ({ name, origin: "here", value: here[name] ?? {} })),
    ...Object.keys(effective)
      .filter((name) => !(name in here))
      .map((name): PresetTab => ({ name, origin: "inherited", value: effective[name] ?? {} })),
  ];
}

/** Has this preset been edited and not saved? A draft that says what is saved is not one. */
export function isDirty(tab: PresetTab, draft: LlmConfigDoc | undefined): boolean {
  return tab.origin === "here" && draft !== undefined && JSON.stringify(draft) !== JSON.stringify(tab.value);
}

/**
 * The line under a preset's name — the one the row used to show, so a preset still says what it
 * holds without being opened. It follows the DRAFT, and says so: with one editor for every preset,
 * an edit left behind on another tab would otherwise be invisible until it was lost.
 */
export function presetSummary(tab: PresetTab, draft?: LlmConfigDoc): string {
  if (tab.origin === "inherited") return `inherited · ${summariseLlmConfig(tab.value)}`;
  return isDirty(tab, draft) ? `unsaved · ${summariseLlmConfig(draft!)}` : summariseLlmConfig(tab.value);
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
 * A dot is refused because the write is a dotted path (`presets.<name>`): `gpt.fast` would be saved
 * as a preset called `gpt` holding a setting called `fast`. A name already in the rail is refused
 * because adding it used to REPLACE that preset with an empty one, silently.
 */
export function presetNameProblem(name: string, tabs: readonly PresetTab[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "can't be empty";
  if (trimmed.includes(".")) return "a name can't contain a dot — it is written as the key models.presets.<name>";
  const taken = tabs.find((tab) => tab.name === trimmed);
  if (taken === undefined) return undefined;
  return taken.origin === "here"
    ? `there is already a preset called '${trimmed}'`
    : `'${trimmed}' is inherited here — open it and choose Override here`;
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
    [NAME_KEY]: { type: "string", title: "Name", description: "What a state will write in configRef.", minLength: 1 },
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
  onSave: (name: string, value: LlmConfigDoc) => void;
  onRemove: (name: string) => void;
  onOverride: (name: string, value: LlmConfigDoc) => void;
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

  // Inherited: the SAME editor, read-only. Seeing what `thorough` holds is most of what anyone wants
  // from a preset they did not write, and the one thing to do about it is to take it into this layer.
  if (open.origin === "inherited") {
    return (
      <LlmConfigForm
        unframed
        value={open.value}
        disabled
        marks={false}
        onChange={() => undefined}
        section={props.section}
        onSection={props.onSection}
        footer={
          <>
            <p className="cfg-hint preset-note">
              <span className="cfg-status unchecked">
                <span className="cfg-dot" aria-hidden="true" />
                inherited
              </span>{" "}
              from {props.originOf(name)}. Nothing here can be changed in this layer until it is overridden.
            </p>
            <div className="pane-actions">
              <button
                type="button"
                className="ghost"
                disabled={props.locked}
                title="copy this preset into the layer being edited, where it can be changed"
                onClick={() => props.onOverride(name, open.value)}
              >
                Override here
              </button>
            </div>
          </>
        }
      />
    );
  }

  const draft = props.drafts[name] ?? open.value;
  const dirty = isDirty(open, props.drafts[name]);
  return (
    <LlmConfigForm
      unframed
      value={draft}
      disabled={props.locked}
      onChange={(next) => props.onDraft(name, next)}
      section={props.section}
      onSection={props.onSection}
      footer={
        // Remove sits at the far end, away from Save and Revert: it is the one action here that
        // cannot be taken back, and it should not be where a hand going for Save lands.
        <div className="pane-actions">
          <button type="button" className="primary" disabled={props.locked || !dirty} onClick={() => props.onSave(name, draft)}>
            Save
          </button>
          <button type="button" className="ghost" disabled={!dirty} onClick={() => props.onDraft(name, undefined)}>
            Revert
          </button>
          <span className="grow" />
          <button type="button" className="ghost danger" disabled={props.locked} onClick={() => props.onRemove(name)}>
            Remove {name}
          </button>
        </div>
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
  locked,
  originLabel,
  onWrite,
}: {
  /** The presets the layer being edited states. */
  here: PresetDocs;
  /** The presets in effect, every layer merged. */
  effective: PresetDocs;
  /** The presets the OTHER layer states — what decides whether a removed preset survives as inherited. */
  others: PresetDocs;
  locked: boolean;
  /** The other layer, as the layer picker names it. */
  originLabel: string;
  /** Write one preset into the layer. `undefined` removes it. */
  onWrite: (name: string, value: LlmConfigDoc | undefined) => void;
}): JSX.Element {
  const [wanted, setWanted] = useState<PresetChoice | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [section, setSection] = useState<CategoryKey>("sampling");
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

  const tabs = presetTabsOf(here, effective);

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
      onSave={(name, value) => {
        setWanted({ preset: name });
        onWrite(name, value);
      }}
      rootRef={root}
      onRemove={(name) => {
        setWanted(choiceAfterRemove(tabs, name, name in others));
        dropDraft(name);
        setRefocus((n) => n + 1);
        onWrite(name, undefined);
      }}
      onOverride={(name, value) => {
        setWanted({ preset: name });
        dropDraft(name);
        setRefocus((n) => n + 1);
        onWrite(name, structuredClone(value));
      }}
      onAdd={(name) => {
        setWanted({ preset: name });
        setPending(name);
        setSection("sampling");
        onWrite(name, {});
      }}
    />
  );
}
