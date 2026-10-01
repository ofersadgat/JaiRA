/**
 * Presets as tabs: what the rail lists, which tab is chosen after a save, an add or a remove, what a
 * preset says of itself without being opened, and whether a name may be used — everything about the
 * Models page's presets that can be got wrong. `ModelsPage`
 * (`packages/universal/src/components/settings/ModelsPage.tsx`) draws from it.
 *
 * Three kinds of preset share the rail: the layer's OWN; one only another layer states; and a BUILT-IN
 * one — what ships in `builtin/settings.json`. The last two are editable in place: saving an edit
 * writes the preset into the layer being edited, where it wins.
 */
import { presetNameRefusal } from "@jaira/shared/browser";
import { summariseLlmConfig, type LlmConfigDoc } from "./llmConfigModel";
import { presetModelLine } from "./presetCandidates";

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
