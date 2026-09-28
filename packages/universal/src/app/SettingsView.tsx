import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { JUST_YOU_VIEWS, SECTIONS, settingsFrameOf, settingsLayersFor, settingsLeadParts, settingsProjectLabel, type JustYouView } from "@jaira/ui/settingsSections";
import { PLAIN_SCROLLER, scrollbarProps } from "../primitives";
import { useTokens } from "../tokens";
import { AppearancePage } from "../components/settings/AppearancePage";
import { SettingsLayerContext } from "../components/settings/layers";
import { LayerPicker } from "../components/settings/LayerPicker";
import { MachinesPage } from "../components/settings/MachinesPage";
import { newPage, scrolled } from "../components/settings/parts";
import { SettingsPage } from "../components/settings/SettingsPage";
import { Segmented } from "../components/settings/controls";
import { useShell } from "./shell";
import { Uncopied } from "./Uncopied";

/**
 * The Settings room (`.settings-view`: `SettingsFrame` around the open section's page), as `App.tsx`
 * draws it in `.viewport` (decision 0015): one scrolling column (`.col.mid.settings-body`: padding
 * 14 16 on --bg) holding the page — its title, whose settings these are, the layer switch and, on the
 * personal layer, "Which rows" — around the open section's own sections. What the frame says is
 * `settingsSections.ts`'s, as the DOM's is; a page with no copy yet is an {@link Uncopied} box inside it.
 */
export function SettingsView(): JSX.Element {
  const t = useTokens();
  const { state, actions } = useShell();
  // `App.tsx`'s `justYou`: which of the Just you view's readings is on.
  const [justYou, setJustYou] = useState<JustYouView>("changed");
  const section = state.section;
  const layer = state.configLayer;
  const frame = settingsFrameOf(section, layer, justYou);
  const layerView = useMemo(() => ({ layer, view: state.config, onlyStated: frame.onlyStated }), [layer, state.config, frame.onlyStated]);
  const project = settingsProjectLabel(state.projects, state.at);

  // The page's scroll box, for the sidebar's accordion (`parts.ts`): where it is, and how to move it.
  const scroller = useRef<ScrollView | null>(null);
  const attach = useCallback((view: ScrollView | null) => {
    scroller.current = view;
    newPage(view === null ? null : (y, animated) => scroller.current?.scrollTo({ y, animated }));
  }, []);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    scrolled({ top: contentOffset.y, height: layoutMeasurement.height, contentHeight: contentSize.height });
  };

  const page: ReactNode =
    section === "appearance" ? (
      <AppearancePage />
    ) : section === "machines" ? (
      <MachinesPage />
    ) : (
      <Uncopied name={`${SECTIONS.find((s) => s.id === section)?.label ?? section} page`} height={320} />
    );

  return (
    <ScrollView
      // A new page is a new scroll box, at its top (`useSettingsParts` sets `scrollTop = 0` on a new key).
      key={section}
      ref={attach}
      style={{ flex: 1, minWidth: 0, backgroundColor: t.v("bg") as string, ...PLAIN_SCROLLER } as never}
      contentContainerStyle={{ paddingVertical: 14, paddingHorizontal: 16, ...PLAIN_SCROLLER } as never}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={(e) => scrolled({ height: e.nativeEvent.layout.height })}
      onContentSizeChange={(_, h) => scrolled({ contentHeight: h })}
      {...scrollbarProps(t)}
    >
      <SettingsLayerContext.Provider value={layerView}>
        <SettingsPage
          title={frame.title}
          lead={settingsLeadParts(section, layer, state.at)}
          {...(frame.layered
            ? {
                aside: <LayerPicker value={layer} layers={settingsLayersFor(state.at !== null)} projectName={project ?? undefined} onChange={actions.setConfigLayer} disabled={state.busy} />,
                onlyStated: frame.onlyStated,
                ...(frame.under ? { under: <Segmented label="Which rows" value={justYou} options={JUST_YOU_VIEWS} onChange={setJustYou} /> } : {}),
              }
            : {})}
        >
          {page}
        </SettingsPage>
      </SettingsLayerContext.Provider>
    </ScrollView>
  );
}
