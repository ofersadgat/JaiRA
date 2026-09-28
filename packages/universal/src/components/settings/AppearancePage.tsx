import { useState, type JSX } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import { PALETTES, surfaceOf, type Appearance, type ThemeMode } from "@jaira/shared/browser";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { APPEARANCE_ROWS as ROWS, BUCKET_CHOICES, MODES, appearanceLayeringOf, appearanceRowLayer, boardPreviewWords, settingsLocked } from "@jaira/ui/appearanceModel";
import { PALETTE_CARDS } from "@jaira/ui/paletteCardsModel";
import { useShell } from "../../app/shell";
import { Uncopied } from "../../app/Uncopied";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Segmented, Switch } from "./controls";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { ThemeMini } from "./ThemeMini";

/**
 * Settings → Appearance (`appearancePane.tsx`'s `AppearancePane`, with what `App.tsx` hands it),
 * universal (decision 0015). Its rows, choices and words are `appearanceModel.ts`'s, as the DOM's are;
 * the rules it carries, from `styles.css`:
 *
 *   .mode-tiles          three equal columns, gap 10, padding 12 (the card's one child)
 *   .mode-tile           column, gap 6, padding 7, 1px --line, radius 12, --panel, --dim; hovered a
 *                        --rule ring; chosen an --accent ring doubled by a 1px --accent shadow, --text,
 *                        on --accent at 5% over --panel
 *   .mode-tile > mini    70 tall, 1px --line, radius 8
 *   .mode-tile-name      centred, the body's text (13/12.5, line 1.5) at 500
 *   .theme-grid          columns of at least 196 filling the row, gap 10, padding 12
 *   .theme-card          column, 1px --line, radius 12, clipped, --panel, --text; hovered and chosen
 *                        as a tile (no ground change)
 *   .theme-card > mini   96 tall, a --line under it
 *   .theme-meta          column, gap 2, padding 8 10 10
 *   .theme-name          row, centred, gap 6, 600
 *   .theme-tag           padding 2 5, radius 4, --panel-3, --dim, app 700 at 0.68, line 1, 0.08em, upper
 *   .theme-desc          0.92, line 1.4, --dim
 *   .theme-check         18 round at 7 7 from the top right, --fill-accent, --on-accent 800 at 0.84,
 *                        a 0 1 3 shadow at 25%
 */
export function AppearancePage(): JSX.Element {
  const { state, actions } = useShell();
  const look = lookOf(state.config);
  const layer = state.configLayer;
  const busy = settingsLocked(state.busy, layer, state.at);
  const layered = appearanceLayeringOf(state.config, layer, busy, (writes, into) => void actions.writeLook(writes, into));
  const rowLayer = (...fields: string[]) => appearanceRowLayer(layered, ...fields);
  const onChange = (patch: Partial<Appearance>): void => void actions.setAppearance(patch, layer);
  const onTheme = (mode: ThemeMode): void => void actions.setTheme(mode, layer);
  const appearance = look as unknown as Appearance;
  const surface = surfaceOf(appearance);
  return (
    <>
      <SettingsSection id="mode" title="Mode" layer={rowLayer("mode")}>
        <ModeTiles mode={look.mode} palette={appearance.palette} busy={busy} onTheme={onTheme} />
      </SettingsSection>

      <SettingsSection id="theme" title="Theme" layer={rowLayer("palette")}>
        <ThemeCards palette={appearance.palette} mode={look.mode} busy={busy} onPick={(palette) => onChange({ palette, laneColors: null, buckets: null, statusWash: null })} />
      </SettingsSection>

      <SettingsSection id="board" title="Board">
        <SettingsRow {...ROWS.laneColors} layer={rowLayer("laneColors")} control={<Switch on={surface.laneColors} label={ROWS.laneColors.name} disabled={busy} onChange={(laneColors) => onChange({ laneColors })} />} />
        <SettingsRow
          {...ROWS.buckets}
          layer={rowLayer("buckets")}
          control={<Segmented label={ROWS.buckets.name} value={surface.buckets} options={BUCKET_CHOICES} disabled={busy} onChange={(buckets) => onChange({ buckets })} />}
        />
        <SettingsRow {...ROWS.statusWash} layer={rowLayer("statusWash")} control={<Switch on={surface.statusWash} label={ROWS.statusWash.name} disabled={busy} onChange={(statusWash) => onChange({ statusWash })} />} />
        <SettingsRow {...boardPreviewWords(appearance.palette)} full>
          <Uncopied name="TaskPreview" height={260} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="conversation" title="Conversation">
        <SettingsRow name="Conversation" full>
          <Uncopied name="Conversation section" height={400} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="text" title="Text">
        <SettingsRow name="Text" full>
          <Uncopied name="Text section" height={400} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

/** Light, dark or follow the system — each tile the current palette's board in that mode. */
function ModeTiles({ mode, palette, busy, onTheme }: { mode: ThemeMode; palette: Appearance["palette"]; busy: boolean; onTheme: (mode: ThemeMode) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" gap={10} padding={12} role="group" aria-label="Mode">
      {MODES.map(([label, option]) => {
        const on = mode === option;
        return (
          <Press
            key={option}
            onPress={() => onTheme(option)}
            disabled={busy}
            {...({ "aria-pressed": on } as object)}
            flex={1}
            flexBasis={0}
            minWidth={0}
            gap={6}
            padding={7}
            borderRadius={12}
            {...(busy ? { opacity: 0.5 } : {})}
            box={({ hovered }) => ({
              ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : hovered && !busy ? "rule" : "line"),
              borderRadius: 12,
              backgroundColor: on ? t.mix(t.v("accent"), 5, t.v("panel")) : t.v("panel"),
              ...(on ? { boxShadow: `0 0 0 1px ${String(t.v("accent"))}` } : {}),
            })}
          >
            <ThemeMini palette={palette} theme={option} height={70} borderRadius={8} {...edge(t, { top: 1, right: 1, bottom: 1, left: 1 })} />
            <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 500, color: on ? "text" : "dim" }} textAlign="center">
              {label}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/** The palettes as cards, each a miniature of the task board in its own colours. */
function ThemeCards({ palette, mode, busy, onPick }: { palette: Appearance["palette"]; mode: ThemeMode; busy: boolean; onPick: (palette: Appearance["palette"]) => void }): JSX.Element {
  const t = useTokens();
  // `repeat(auto-fill, minmax(196px, 1fr))` over the grid's width inside its padding.
  const [width, setWidth] = useState(0);
  const per = Math.max(1, Math.floor((width + 10) / (196 + 10)));
  const rows: Appearance["palette"][][] = [];
  PALETTES.forEach((option, i) => (i % per === 0 ? rows.push([option]) : rows[rows.length - 1]!.push(option)));
  const cellWidth = per > 0 ? (width - 10 * (per - 1)) / per : 0;
  return (
    <View padding={12} gap={10} role="group" aria-label="Theme" onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 24)}>
      {width > 0
        ? rows.map((row, r) => (
            <View key={r} flexDirection="row" gap={10} alignItems="stretch">
              {row.map((option) => {
                const card = PALETTE_CARDS[option];
                const on = option === palette;
                return (
                  <Press
                    key={option}
                    onPress={() => onPick(option)}
                    disabled={busy}
                    {...({ "aria-pressed": on } as object)}
                    width={cellWidth}
                    borderRadius={12}
                    overflow="hidden"
                    {...(busy ? { opacity: 0.5 } : {})}
                    box={({ hovered }) => ({
                      ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : hovered && !busy ? "rule" : "line"),
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: t.v("panel"),
                      ...(on ? { boxShadow: `0 0 0 1px ${String(t.v("accent"))}` } : {}),
                    })}
                  >
                    <ThemeMini palette={option} theme={mode} height={96} {...edge(t, { bottom: 1 })} />
                    <View gap={2} paddingTop={8} paddingHorizontal={10} paddingBottom={10}>
                      <View flexDirection="row" alignItems="center" gap={6}>
                        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>{card.label}</Txt>
                        {option === PALETTES[0] ? (
                          <View paddingVertical={2} paddingHorizontal={5} borderRadius={4} backgroundColor={t.v("panel-3") as never}>
                            <Txt spec={{ voice: "app", scale: 0.68, weight: 700, lineHeight: 1, ls: 0.08, upper: true, color: "dim" }}>default</Txt>
                          </View>
                        ) : null}
                      </View>
                      <Txt spec={{ voice: "app", scale: 0.92, lineHeight: 1.4, color: "dim" }}>{card.note}</Txt>
                    </View>
                    {on ? (
                      <View
                        position="absolute"
                        top={7}
                        right={7}
                        zIndex={1}
                        width={18}
                        height={18}
                        borderRadius={9}
                        alignItems="center"
                        justifyContent="center"
                        backgroundColor={t.v("fill-accent") as never}
                        {...({ boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)" } as object)}
                      >
                        <Txt spec={{ voice: "app", scale: 0.84, weight: 800, color: "on-accent" }} textAlign="center">
                          ✓
                        </Txt>
                      </View>
                    ) : null}
                  </Press>
                );
              })}
            </View>
          ))
        : null}
    </View>
  );
}
