import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView, View as RNView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { JUST_YOU_VIEWS, settingsFrameOf, settingsLeadParts, type JustYouView } from "@jaira/ui/settingsSections";
import { pathNamesOf } from "@jaira/ui/settingsScope";
import { useMachines } from "@jaira/ui/machinesModel";
import { PLAIN_SCROLLER, scrollbarProps } from "../primitives";
import { useTokens } from "../tokens";
import { AppearancePage } from "../components/settings/AppearancePage";
import { ConnectionsPage } from "../components/settings/ConnectionsPage";
import { SettingsLayerContext } from "../components/settings/layers";
import { MachinesPage } from "../components/settings/MachinesPage";
import { DataPage, RunsPage } from "../components/settings/RunsPage";
import { ModelsPage } from "../components/settings/ModelsPage";
import { AboutPage } from "../components/settings/AboutPage";
import { ToolsPage } from "../components/settings/ToolsPage";
import { FormRowsContext } from "../components/form/Field";
import { newPage, scrolled } from "../components/settings/parts";
import { SettingsPage } from "../components/settings/SettingsPage";
import { Segmented } from "../components/settings/controls";
import { fixHealthItem, useForgeOAuth } from "@jaira/ui/settingsShell";
import { useHealth } from "@jaira/ui/updatesStore";
import { SettingsShellContext, type SettingsShell } from "../components/settings/NeedsAttention";
import { useShell } from "./shell";

/**
 * The Settings room: one scrolling column (padding 14 16 on --bg) holding the page — its title, whose
 * settings these are and, on a personal layer, "Which rows" — around the open section's own sections.
 * Whose they are is Settings' path, beside its name in the sidebar's head (`SettingsCrumb`); a page
 * edits the layer it makes, read where it lives (`settingsConfig`). What the frame says is
 * `settingsSections.ts`'s. Every section has a page here.
 */
export function SettingsView(): JSX.Element {
  const t = useTokens();
  const { state, actions } = useShell();
  // Which of the Just you view's readings is on.
  const [justYou, setJustYou] = useState<JustYouView>("changed");
  const section = state.section;
  const layer = state.configLayer;
  const frame = settingsFrameOf(section, layer, justYou);
  const [machines] = useMachines();
  const names = pathNamesOf(state.settingsPath, {
    projects: state.projects,
    grouped: state.settings.ui.groupWorkspaces !== false,
    self: machines !== undefined ? { id: machines.self.id, label: machines.self.label } : undefined,
    machines: (machines?.machines ?? []).map((m) => ({ id: m.id, label: m.label })),
  });
  const namesKey = `${names.project ?? ""}\u0000${names.machine ?? ""}`;
  const layerView = useMemo(
    () => ({ layer, view: state.settingsConfig, onlyStated: frame.onlyStated, names }),
    // `names` stands for its two strings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, state.settingsConfig, frame.onlyStated, namesKey],
  );
  // What the room holds for its pages: the health board, its fixes, and the forge sign-ins in flight.
  const health = useHealth();
  const forgeOAuth = useForgeOAuth(state.availability.forges, actions.readAvailability);
  const shell: SettingsShell = {
    health,
    forgeOAuth,
    fixHealth: (item) =>
      fixHealthItem(item, { forgeOAuth, signIn: (name) => void actions.signIn(name), recheck: () => void actions.recheckAvailability(), setView: actions.setView, setSection: actions.setSection }),
  };

  // The page's scroll box, for the sidebar's accordion (`parts.ts`): where it is, and how to move it.
  const scroller = useRef<ScrollView | null>(null);
  const box = useRef<RNView | null>(null);
  // Once the page's refs are all set (a parent's is set after its children's), and again for a new page.
  useEffect(() => {
    newPage(box.current, (y, animated) => scroller.current?.scrollTo({ y, animated }));
    return () => newPage(null, null);
  }, [section]);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    scrolled({ top: contentOffset.y, height: layoutMeasurement.height, contentHeight: contentSize.height });
  };

  const page: ReactNode =
    section === "appearance" ? (
      <AppearancePage />
    ) : section === "machines" ? (
      <MachinesPage />
    ) : section === "runs" ? (
      <RunsPage />
    ) : section === "data" ? (
      <DataPage />
    ) : section === "models" ? (
      <ModelsPage />
    ) : section === "about" ? (
      <AboutPage />
    ) : section === "tools" ? (
      <ToolsPage />
    ) : section === "connections" ? (
      <ConnectionsPage />
    ) : null;

  return (
    // The scroll box's frame, which the accordion measures its sections against (`parts.ts`). No stacking
    // context of its own on web (`PLAIN_SCROLLER`: react-native-web's View is one, `z-index: 0`), which
    // decides how the page's text is smoothed: with none, Monaco's hidden input (`z-index: -10`, in the
    // File types preview) is painted under the WHOLE page — which puts everything else in a layer over
    // it, where Chromium draws the sidebar's and the inbox strip's text greyscale, as the reference
    // pictures hold it (`pair.mts`). Held inside this box it was painted in the scroller, and the same
    // text came out subpixel.
    <RNView ref={box} collapsable={false} style={{ flex: 1, minWidth: 0, ...PLAIN_SCROLLER } as never}>
      <ScrollView
        // A new page is a new scroll box, at its top.
        key={section}
        ref={scroller}
        style={{ flex: 1, minWidth: 0, backgroundColor: t.v("bg") as string, ...PLAIN_SCROLLER } as never}
        contentContainerStyle={{ paddingVertical: 14, paddingHorizontal: 16, ...PLAIN_SCROLLER } as never}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(e) => scrolled({ height: e.nativeEvent.layout.height })}
        onContentSizeChange={(_, h) => scrolled({ contentHeight: h })}
        {...scrollbarProps(t)}
      >
        <SettingsShellContext.Provider value={shell}>
        <FormRowsContext.Provider value={true}>
        <SettingsLayerContext.Provider value={layerView}>
          <SettingsPage
            title={frame.title}
            lead={[
              ...(settingsLeadParts(section, layer, names) ?? []),
              // The path's own layers could not be read — its machine is offline, an older JaiRA.
              ...(frame.layered && state.settingsProblem !== null ? [{ text: ` ${state.settingsProblem}`, bold: true }] : []),
            ]}
            {...(frame.layered
              ? {
                  onlyStated: frame.onlyStated,
                  ...(frame.under ? { under: <Segmented label="Which rows" value={justYou} options={JUST_YOU_VIEWS} onChange={setJustYou} /> } : {}),
                }
              : {})}
          >
            {page}
          </SettingsPage>
        </SettingsLayerContext.Provider>
        </FormRowsContext.Provider>
        </SettingsShellContext.Provider>
      </ScrollView>
    </RNView>
  );
}
