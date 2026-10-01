import { createContext, useContext, type JSX } from "react";
import { View } from "@tamagui/core";
import type { HealthItem, HealthPage } from "@jaira/shared/browser";
import type { ForgeOAuth } from "@jaira/ui/settingsShell";
import { healthFixLabel, sinceWords } from "@jaira/ui/updatesModel";
import { dismissHealth } from "@jaira/ui/updatesStore";
import { Press, Txt, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { Pill } from "../Pill";
import { Button } from "./Button";
import { SettingsLayerContext } from "./layers";
import { SettingsRow, SettingsSection } from "./SettingsPage";

/**
 * What the Settings pages take from the shell: the health board, what an item's button does, and the
 * forge sign-ins in flight (`settingsShell.ts`).
 */
export interface SettingsShell {
  health: readonly HealthItem[];
  fixHealth: (item: HealthItem) => void;
  forgeOAuth: ForgeOAuth;
}
export const SettingsShellContext = createContext<SettingsShell | null>(null);
export function useSettingsShell(): SettingsShell {
  const shell = useContext(SettingsShellContext);
  if (shell === null) throw new Error("useSettingsShell() outside the Settings view");
  return shell;
}

/**
 * The section a page opens with while the health board has something for it. What each item says and
 * its button are `updatesModel.ts`'s. How a problem looks:
 *
 *   its row              washed --tint-bad (warning: --tint-warn), rounded 11 at the card's ends
 *   its name             row, centred, gap 8: the pill's glyph (`Pill`), then the title
 *   since when           --text
 *   the dismiss ×        the ↺'s box (20 square, radius 5), × at app 15/12.5, shown only while the row
 *                        is hovered
 */
export function NeedsAttention({ page }: { page: HealthPage }): JSX.Element | null {
  const { health, fixHealth } = useSettingsShell();
  const mine = health.filter((item) => item.page === page);
  if (mine.length === 0) return null;
  return (
    <SettingsLayerContext.Provider value={null}>
      <SettingsSection
        id="attention"
        title="Needs attention"
        info="What was working and stopped, and what failed and can be tried again. Each goes away by itself once the check that raised it passes, or when you dismiss it."
      >
        {mine.map((item, i) => (
          <Problem key={item.id} item={item} first={i === 0} last={i === mine.length - 1} onFix={fixHealth} />
        ))}
      </SettingsSection>
    </SettingsLayerContext.Provider>
  );
}

/** A log count is CLEARED by dismissing it; a problem is hidden until it clears and happens again. */
const dismissWords = (item: HealthItem): string => (item.id.startsWith("log:") ? "Dismiss: clears the count" : "Dismiss: hide until it happens again");

function Problem({ item, first, last, onFix }: { item: HealthItem; first: boolean; last: boolean; onFix: (item: HealthItem) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const r = 11;
  return (
    <View
      backgroundColor={t.v(item.level === "warning" ? "tint-warn" : "tint-bad") as never}
      borderTopLeftRadius={first ? r : 0}
      borderTopRightRadius={first ? r : 0}
      borderBottomLeftRadius={last ? r : 0}
      borderBottomRightRadius={last ? r : 0}
      {...hover}
    >
      <SettingsRow
        name={
          <View flexDirection="row" alignItems="center" gap={8}>
            <Pill kind={item.level === "warning" ? "warning" : "error"} />
            <Txt spec={{ voice: "app", scale: 1.1, weight: 550, lineHeight: 1.3 }}>{item.title}</Txt>
          </View>
        }
        description={
          <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" }}>
            <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45 }}>{sinceWords(item)}</Txt>
            {` · ${item.detail}`}
          </Txt>
        }
        control={
          <>
            {item.action !== undefined ? (
              <Button title={item.fix} onPress={() => onFix(item)}>
                {healthFixLabel(item.action)}
              </Button>
            ) : null}
            <Press
              onPress={() => dismissHealth(item.id)}
              label={dismissWords(item)}
              title={dismissWords(item)}
              width={20}
              height={20}
              alignItems="center"
              justifyContent="center"
              borderRadius={5}
              opacity={hovered ? 1 : 0}
              box={({ hovered: over }) => ({ backgroundColor: over ? t.v("fill-ghost-hover") : "transparent" })}
            >
              {({ hovered: over }) => (
                <Txt spec={{ voice: "app", scale: 15 / 12.5, color: over ? "text" : "dim", lineHeight: 1 }} textAlign="center">
                  ×
                </Txt>
              )}
            </Press>
          </>
        }
      />
    </View>
  );
}
