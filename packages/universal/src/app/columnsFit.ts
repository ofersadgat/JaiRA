import { useWindowDimensions } from "react-native";
import { columnsFitOf, useKeptColumn } from "@jaira/ui/shellFit";
import { FOLD, PANE, openOf, paneOf } from "@jaira/ui/uiState";
import { SHEET_PEEK } from "../components/panel/PanelSheet";
import { usePhone } from "./phone";
import { useShell } from "./shell";
import { panelLeftOpen, panelOpenWidth } from "./viewState";

/**
 * Which of the desktop's two columns stand open in this window (`shellFit.ts`): the sidebar folds first,
 * then the side panel, so the room between them keeps its floor. Read by the sidebar, its splitter and
 * the panel column. On a phone neither is a column: the person's folds stand as they are.
 */
/**
 * What a room keeps clear at its foot on a phone (or a window as narrow): the height of its panel's sheet
 * at its head, while the sheet is up — Tasks always has it, a room whose panel folds while it is
 * unfolded — so the sheet does not lie over the room's own foot (a conversation's composer). 0 else.
 */
export function useSheetInset(): number {
  const { state } = useShell();
  const phone = usePhone();
  const panelWidth = panelOpenWidth.use();
  const panelOpen = panelLeftOpen.use();
  return phone && panelWidth > 0 && (state.view === "tasks" || panelOpen) ? SHEET_PEEK : 0;
}

export function useColumnsFit(): { sidebar: boolean; panel: boolean } {
  const { state } = useShell();
  const phone = usePhone();
  const { width } = useWindowDimensions();
  const panelWidth = panelOpenWidth.use();
  const panelOpen = panelLeftOpen.use();
  const kept = useKeptColumn();
  const ui = state.settings.ui;
  const sidebar = { open: openOf(ui, FOLD.shellSidebar), width: paneOf(ui, PANE.shellSidebar) };
  if (phone) return { sidebar: sidebar.open, panel: panelOpen };
  return columnsFitOf({ width, sidebar, panel: { open: panelOpen, width: panelWidth }, kept });
}
