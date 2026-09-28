import type { JSX } from "react";
import { useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { MenuItem } from "@jaira/ui/crumbModel";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { MenuLayer } from "./MenuLayer";

/**
 * `menu.tsx`'s `ContextMenu`, universal (decision 0015): a list of items at a point, over everything, gone
 * on any press outside it (or Back, or Escape) — see `MenuLayer`. The rules, from `styles.css`:
 *
 *   .context-menu      column, padding 5 0, --panel, 1px --line, radius 8, --lift; 232 wide (MENU_WIDTH)
 *   .menu-item         row, gap 8, padding 5 12, app voice at 12.5/12.5, --text, one line; hovered:
 *                      --accent ground, --panel ink (note and mark too)
 *   .menu-item.here    weight 600, a "•" in --accent in the gutter (6 wide, -12 left)
 *   .menu-item.sep     a --line above, 4 above that, padding-top 8
 *   .menu-note         --dim, app voice at 11/12.5, at most 45%
 *   .menu-item:disabled  --dim; .danger  --bad (hovered: --bad ground)
 *
 * Placement is the desktop's `Popover` below-start, kept inside the window.
 */
export const MENU_WIDTH = 232;

export interface MenuAt {
  x: number;
  y: number;
  items: readonly MenuItem[];
}

export function ContextMenu({ anchor, onClose }: { anchor: MenuAt; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const left = Math.max(4, Math.min(anchor.x, win.width - MENU_WIDTH - 4));
  return (
    <MenuLayer onClose={onClose}>
      <View
        position="absolute"
        left={left}
        top={anchor.y}
        width={MENU_WIDTH}
        flexDirection="column"
        paddingVertical={5}
        backgroundColor={t.v("panel") as never}
        borderRadius={8}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: t.v("lift") } as object)}
        role="menu"
      >
        {anchor.items.map((item, i) => (
          <Press
            key={`${item.label}-${i}`}
            onPress={() => {
              onClose();
              item.onSelect();
            }}
            disabled={item.disabled === true}
            label={item.label}
            flexDirection="row"
            alignItems="baseline"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={12}
            {...(item.separator === true ? { marginTop: 4, paddingTop: 8, ...edge(t, { top: 1 }) } : {})}
            box={({ hovered }) => ({ backgroundColor: hovered && item.disabled !== true ? t.v(item.danger === true ? "bad" : "accent") : "transparent" })}
          >
            {({ hovered }) => {
              const lit = hovered && item.disabled !== true;
              const ink = lit ? "panel" : item.disabled === true ? "dim" : item.danger === true ? "bad" : "text";
              return (
                <>
                  {item.checked === true ? (
                    <Txt spec={{ voice: "app", scale: 1, color: lit ? "panel" : "accent" }} width={6} marginLeft={-12} flexShrink={0}>
                      •
                    </Txt>
                  ) : null}
                  <Txt spec={{ voice: "app", scale: 1, color: ink, weight: item.checked === true ? 600 : 400 }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
                    {item.label}
                  </Txt>
                  {item.note !== undefined ? (
                    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: lit ? "panel" : "dim", weight: item.checked === true ? 600 : 400 }} ellip flexShrink={0} maxWidth="45%">
                      {item.note}
                    </Txt>
                  ) : null}
                </>
              );
            }}
          </Press>
        ))}
      </View>
    </MenuLayer>
  );
}
