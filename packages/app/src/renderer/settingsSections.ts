/**
 * The Settings pages, as the sidebar lists them — ONE flat list (the person's round-5 design,
 * 2026-09-23), with no group headings.
 *
 * The two groups it replaced — "Just you" (Appearance, no switch) and "Project & shared" (layered) —
 * stopped meaning anything the moment the look became a layered setting and "Just you" became a
 * LAYER: every page now has the same switch, `Just you | This project | Shared`, and which of them
 * you are editing is the switch's to say, not the sidebar's. The order is the order a person sets
 * things up in: how it looks, what it can reach, which model answers, what the tools may do, how a
 * run behaves, and what it leaves behind. About comes last and is the one page that is not layered: the
 * build, its updates, its plugins and what it is built from — its one setting, the update track, is
 * the machine's own and always the personal layer's (the person's ruling, 2026-09-26: "no layer switch").
 *
 * Pure data, so the list is testable without drawing the sidebar.
 */
import type { ConfigLayer, HealthItem } from "@jaira/shared/browser";
import type { PillCounts } from "./pillModel";
import { projectName } from "./projects";
import { healthCounts } from "./updatesModel";
import type { SettingsSection } from "./store";

/** The glyph each page wears in the sidebar — `App.tsx` draws them. */
export type SettingsIconName = "appearance" | "connections" | "machines" | "models" | "tools" | "runs" | "data" | "about";

export interface SettingsPageMeta {
  id: SettingsSection;
  label: string;
  icon: SettingsIconName;
  /** The lead's first clause: what the page is for. */
  purpose: string;
  /** False for a page that holds no setting: no layer switch, and its lead is its purpose alone. */
  layered: boolean;
}

export const SECTIONS: readonly SettingsPageMeta[] = [
  { id: "appearance", label: "Appearance", icon: "appearance", purpose: "How JaiRA looks.", layered: true },
  { id: "connections", label: "Connections", icon: "connections", purpose: "What JaiRA can reach, and as whom.", layered: true },
  // The machines that share your projects (decision 0013): this machine's own, so not layered, like About.
  { id: "machines", label: "Machines", icon: "machines", purpose: "The machines that share your projects: this one, and the ones it is paired with.", layered: false },
  { id: "models", label: "Models", icon: "models", purpose: "What answers a state that names nothing, and how.", layered: true },
  { id: "tools", label: "Tools", icon: "tools", purpose: "What an agent may do, and every function a run can call.", layered: true },
  { id: "runs", label: "Runs", icon: "runs", purpose: "How a run behaves while it is going.", layered: true },
  { id: "data", label: "Data & history", icon: "data", purpose: "Where runs keep what they produce, and how much there is.", layered: true },
  {
    id: "about",
    label: "About",
    icon: "about",
    purpose: "The build you are running, how it updates, the plugins it can download, and the open-source software it is built from.",
    layered: false,
  },
];

/**
 * The layer Settings opens on: Shared — the one that exists on every machine and in every window,
 * and the one a person setting things up usually means. Opening a project does not move it; the
 * switch does.
 */
export const DEFAULT_CONFIG_LAYER: ConfigLayer = "base";

/** The layer switch's segments, strongest first — "This project" only while there is one. */
export function settingsLayersFor(hasProject: boolean): ConfigLayer[] {
  return hasProject ? ["you", "project", "base"] : ["you", "base"];
}

/**
 * One glyph per page, in the icon set's own hand (`icons.tsx`: 24-unit strokes at 1.7). Models and
 * Tools borrow its model and tool; the other five are its own: a disc half filled (how a thing looks),
 * a plug (what it connects to), a play mark (a run), stacked disks (stored), an i in a circle (about
 * this build). Path data only, so the sidebar's list (`App.tsx`) and its universal copy draw the same.
 */
export const SETTINGS_ICONS: Record<SettingsIconName, string[]> = {
  appearance: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 3v18"],
  connections: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0Z", "M12 17v4"],
  machines: ["M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M8 20h8", "M12 16v4"],
  models: ["m12 3 8 4.5v9L12 21l-8-4.5v-9Z", "M12 12l8-4.5", "M12 12v9", "M12 12 4 7.5"],
  tools: ["M14.6 6.3a1 1 0 0 0 0 1.4l1.7 1.7a1 1 0 0 0 1.4 0l4-4a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z"],
  runs: ["M7 4.5v15l12-7.5Z"],
  data: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z", "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
  about: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5.5", "M12 7.6v.1"],
};

/** The Just you view's two readings: only what the personal layer states, or every row. */
export type JustYouView = "changed" | "every";

export const JUST_YOU_VIEWS: ReadonlyArray<readonly [string, JustYouView]> = [
  ["What you changed", "changed"],
  ["Every row", "every"],
];

/**
 * What a page's frame draws around it: its title, and whether it has the layer switch and (on the
 * personal layer) the "Which rows" choice — a page with no setting on it (About) has neither — and
 * whether only the rows the layer states are drawn.
 */
export function settingsFrameOf(section: SettingsSection, layer: ConfigLayer, justYou: JustYouView): { title: string; layered: boolean; under: boolean; onlyStated: boolean } {
  const meta = SECTIONS.find((s) => s.id === section);
  if (meta?.layered === false) return { title: meta.label, layered: false, under: false, onlyStated: false };
  return { title: meta?.label ?? "Settings", layered: true, under: layer === "you", onlyStated: layer === "you" && justYou === "changed" };
}

/** A run of the lead, bold where it names a layer's file or a project. */
export interface LeadPart {
  text: string;
  bold?: boolean;
}

/**
 * The page's lead: what the page is FOR, in one clause, then WHOSE settings these are and what anything
 * left unset falls back to — what the layer switch at the head's right edge changes, said in words.
 */
export function settingsLeadParts(section: SettingsSection, layer: ConfigLayer, project: string | null): LeadPart[] | undefined {
  const meta = SECTIONS.find((s) => s.id === section);
  if (meta === undefined) return undefined;
  const purpose = meta.purpose;
  if (!meta.layered) return [{ text: purpose }];
  if (layer === "you") {
    return [
      { text: `${purpose} Showing ` },
      { text: "Just you", bold: true },
      { text: ": kept on this machine in " },
      { text: "personal-settings.json", bold: true },
      { text: ", never shared, and read after every other layer." },
    ];
  }
  if (layer === "project" && project !== null) {
    return [
      { text: `${purpose} Editing ` },
      { text: projectName(project), bold: true },
      { text: "; anything left unset comes from " },
      { text: "~/.jaira", bold: true },
      { text: ", and yours override both." },
    ];
  }
  return [
    { text: `${purpose} Editing ` },
    { text: "~/.jaira", bold: true },
    { text: ", shared by every project on this machine; a project's own settings override it, and yours override both." },
  ];
}

/** The name the layer switch's project segment wears: the open project's label, or its folder's name. */
export function settingsProjectLabel(projects: readonly { project: string; label?: string | undefined }[], at: string | null): string | null {
  return at === null ? null : (projects.find((p) => p.project === at)?.label ?? projectName(at));
}

/** What needs attention on a page, as the Settings row's pills say it for all of them — only Connections and About have any. */
export function settingsPageProblems(health: readonly HealthItem[], id: SettingsSection): PillCounts {
  return id === "connections" || id === "about" ? healthCounts(health, id) : {};
}
