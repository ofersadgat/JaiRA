/**
 * The Settings pages, as the sidebar lists them — ONE flat list (the person's round-5 design,
 * 2026-09-23), with no group headings.
 *
 * The two groups it replaced — "Just you" (Appearance, no switch) and "Project & shared" (layered) —
 * stopped meaning anything the moment the look became a layered setting and "Just you" became a
 * LAYER: every page now has the same switch, `Just you | This project | Shared`, and which of them
 * you are editing is the switch's to say, not the sidebar's. The order is the order a person sets
 * things up in: how it looks, what it can reach, which model answers, what the tools may do, how a
 * run behaves, and what it leaves behind.
 *
 * Pure data, so the list is testable without drawing the sidebar.
 */
import type { ConfigLayer } from "@jaira/shared/browser";
import type { SettingsSection } from "./store";

/** The glyph each page wears in the sidebar — `App.tsx` draws them. */
export type SettingsIconName = "appearance" | "connections" | "models" | "tools" | "runs" | "data";

export interface SettingsPageMeta {
  id: SettingsSection;
  label: string;
  icon: SettingsIconName;
  /** The lead's first clause: what the page is for. */
  purpose: string;
}

export const SECTIONS: readonly SettingsPageMeta[] = [
  { id: "appearance", label: "Appearance", icon: "appearance", purpose: "How JaiRA looks." },
  { id: "connections", label: "Connections", icon: "connections", purpose: "What JaiRA can reach, and as whom." },
  { id: "models", label: "Models", icon: "models", purpose: "What answers a state that names nothing, and how." },
  { id: "tools", label: "Tools", icon: "tools", purpose: "What an agent may do, and every function a run can call." },
  { id: "runs", label: "Runs", icon: "runs", purpose: "How a run behaves while it is going." },
  { id: "data", label: "Data & history", icon: "data", purpose: "Where runs keep what they produce, and how much there is." },
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
