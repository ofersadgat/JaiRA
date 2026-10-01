import { createContext, useContext } from "react";
import type { ConfigPath } from "@jaira/shared/browser";
import { inheritLabelOf, layerRowOf, type SettingsLayerView } from "@jaira/ui/settingsRows";

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
