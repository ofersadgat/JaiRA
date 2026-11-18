import { createContext, useContext } from "react";
import type { ConfigPath } from "@jaira/shared/browser";
import { inheritLabelOf, layerRowOf, type SettingsLayerView } from "@jaira/ui/settingsRows";
import { configTargetOf, settingsProjectOf } from "@jaira/ui/settingsScope";
import { useShell } from "../../app/shell";

/**
 * The layer a Settings page is editing, provided once around the page, and null inside a row's own
 * control. What a row does with it is `settingsRows.ts`'s.
 */
export const SettingsLayerContext = createContext<SettingsLayerView | null>(null);

/** Whether a row is drawn in the Just you view, and its "instead of" line. */
export function useLayerRow(
  paths: readonly ConfigPath[] | undefined,
  stated?: boolean,
  format?: (value: unknown, path: string) => string,
): { hidden: boolean; instead: string | undefined } {
  return layerRowOf(useContext(SettingsLayerContext), paths, stated, format);
}

/** What the ↺ says. */
export function useInheritLabel(paths: readonly ConfigPath[] | undefined, format?: (value: unknown, path: string) => string): string {
  return inheritLabelOf(useContext(SettingsLayerContext), paths, format);
}

/**
 * The project a Settings page's project-bound parts read (its files, permission sets, automations):
 * the one Settings' path names, else the one the shell stands on — `settingsProjectOf`.
 */
export function useSettingsAt(): string | null {
  const { state } = useShell();
  return settingsProjectOf(state.settingsPath, { projects: state.projects, grouped: state.settings.ui.groupWorkspaces !== false, machines: [] }, state.at);
}

/**
 * Where a Settings page's project-bound parts are read and written: {@link useSettingsAt}'s project —
 * or, for a paired machine the path names with no project, that machine itself (`machine`: its shared
 * root's permission sets and automations, and its own layers of them, read there).
 */
export function useSettingsWhere(): { at: string | null; machine?: string } {
  const { state } = useShell();
  const ctx = { projects: state.projects, grouped: state.settings.ui.groupWorkspaces !== false, machines: [] };
  const target = configTargetOf(state.settingsPath, ctx, state.at);
  if (target?.machine !== undefined) return { at: null, machine: target.machine };
  return { at: settingsProjectOf(state.settingsPath, ctx, state.at) };
}
