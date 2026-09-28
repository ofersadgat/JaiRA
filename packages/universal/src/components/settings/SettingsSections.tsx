import type { JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { SECTIONS, SETTINGS_ICONS } from "@jaira/ui/settingsSections";
import type { SettingsSection } from "@jaira/ui/store";
import { Press, Txt, edge, lengthToken, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Pills } from "../Pills";
import { Svg } from "../panel/Svg";
import { useSettingsParts } from "./parts";

/**
 * The Settings panel in the sidebar — `App.tsx`'s `settingsRow.panel`, universal (decision 0015): ONE
 * list of pages, in the order a person sets things up (`settingsSections.ts`), each with its glyph; under
 * the open page, its own sections (`parts.ts`), lit as the page is scrolled past them. The rules, from
 * `styles.css` (`cascade.mts '.sections.icons' --scene settings`):
 *
 *   .side-drawer .sections   padding 2 0 4, scrolls; app at 12.5/12.5
 *   .sections li             row, centred, gap 9, padding 6 8, radius --control-radius-sm; hovered
 *                            --fill-ghost-hover; .sel --fill-ghost-selected, --text at 600
 *   .sections-icon           15 square, --dim (--text on the open page), strokes 1.7
 *   .sections-label          one line, cut with an ellipsis
 *   .prob-li-pills           what needs attention on the page, at the row's right end
 *   .section-parts           2 0 6 30 outside, a --line on the left
 *   .section-parts li        padding 3 8 3 11, 1 left over the line, a 2px edge (--accent when being
 *                            read), radius 0 6 6 0, app at 0.94, --dim; hovered --text on
 *                            --fill-ghost-hover; being read --text at 600
 */
export function SettingsSections({
  section,
  open,
  problems,
  onSection,
}: {
  /** The page Settings is on. */
  section: SettingsSection;
  /** Whether Settings is what the window is showing (the list stays drawn in Logs and Debug). */
  open: boolean;
  /** What needs attention on a page, as the Settings row's pills count it. */
  problems: (id: SettingsSection) => Readonly<Record<string, number>>;
  onSection: (id: SettingsSection) => void;
}): JSX.Element {
  const t = useTokens();
  const parts = useSettingsParts();
  const radius = lengthToken(t, "control-radius-sm", 6);
  return (
    <ScrollView style={{ flexGrow: 1, flexShrink: 1 }} contentContainerStyle={{ paddingTop: 2, paddingBottom: 4 }} {...scrollbarProps(t)}>
      {SECTIONS.map(({ id, label, icon }) => {
        const here = open && section === id;
        const counts = problems(id);
        return (
          <View key={id}>
            <Press
              onPress={() => onSection(id)}
              label={label}
              flexDirection="row"
              alignItems="center"
              gap={9}
              paddingVertical={6}
              paddingHorizontal={8}
              borderRadius={radius}
              box={({ hovered }) => ({ backgroundColor: here ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
            >
              <Svg width={15} height={15} color={String(t.v(here ? "text" : "dim"))} shapes={SETTINGS_ICONS[icon].map((d) => ({ kind: "path" as const, d }))} />
              <Txt spec={{ voice: "app", scale: 1, weight: here ? 600 : 400 }} ellip minWidth={0} flexShrink={1}>
                {label}
              </Txt>
              {counts["error"] !== undefined || counts["warning"] !== undefined ? (
                <View marginLeft="auto" flexDirection="row">
                  <Pills counts={counts} budget={60} />
                </View>
              ) : null}
            </Press>
            {here && parts.parts.length >= 2 ? (
              <View marginTop={2} marginBottom={6} marginLeft={30} {...(edge(t, { left: 1 }) as object)} aria-label={`${label} sections`}>
                {parts.parts.map((part) => {
                  const on = parts.active === part.id;
                  return (
                    <Press
                      key={part.id}
                      onPress={() => parts.go(part.id)}
                      label={part.label}
                      {...({ "aria-current": on ? "location" : undefined } as object)}
                      marginLeft={-1}
                      paddingTop={3}
                      paddingRight={8}
                      paddingBottom={3}
                      paddingLeft={11}
                      borderTopRightRadius={radius}
                      borderBottomRightRadius={radius}
                      box={({ hovered }) => ({
                        ...edge(t, { left: 2 }, on ? String(t.v("accent")) : "rgba(0, 0, 0, 0)"),
                        backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent",
                      })}
                    >
                      {({ hovered }) => (
                        <Txt spec={{ voice: "app", scale: 0.94, weight: on ? 600 : 400, color: on || hovered ? "text" : "dim" }} ellip>
                          {part.label}
                        </Txt>
                      )}
                    </Press>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
