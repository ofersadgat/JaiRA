import type { JSX } from "react";
import { Platform } from "react-native";
import type { MenuItem } from "@jaira/ui/crumbModel";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { Float, pointRect } from "./floats/Float";
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
 *   .menu-item:disabled  --dim; .danger  --bad (hovered: --bad ground), and still --bad disabled (it comes later)
 *   .menu-title        padding 5 12 4, data voice at 9.5/12, 0.09em, uppercase, --dim (`MenuAnchor.title`)
 *
 * Placement is the desktop's `Popover` below-start with no gap (`floats/Float.tsx`, the same arithmetic):
 * kept inside the window, opening upward from the point when there is more room above.
 */
export const MENU_WIDTH = 232;

export interface MenuAt {
  x: number;
  y: number;
  items: readonly MenuItem[];
  /** A dim caption above the items (`menu.tsx`'s `MenuAnchor.title`). */
  title?: string;
}

export function ContextMenu({ anchor, onClose }: { anchor: MenuAt; onClose: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={pointRect(anchor.x, anchor.y)}
        side="below"
        align="start"
        offset={0}
        width={MENU_WIDTH}
        flexDirection="column"
        paddingVertical={5}
        backgroundColor={t.v("panel") as never}
        borderRadius={8}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: t.v("lift") } as object)}
        role="menu"
      >
        {anchor.title !== undefined ? (
          <Txt spec={{ voice: "data", scale: 9.5 / 12, ls: 0.09, upper: true, color: "dim" }} paddingTop={5} paddingHorizontal={12} paddingBottom={4}>
            {anchor.title}
          </Txt>
        ) : null}
        {anchor.items.map((item, i) => (
          <Press
            key={`${item.label}-${i}`}
            onPress={() => {
              onClose();
              item.onSelect();
            }}
            disabled={item.disabled === true}
            label={item.label}
            // `<button role="menuitem">`, as the desktop's rows are (web; a phone's are its own buttons).
            {...((Platform.OS === "web" ? { role: "menuitem" } : {}) as object)}
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
              // `.menu-item.danger` comes after `.menu-item:disabled` (both 0,2,0): a disabled danger item stays --bad.
              const ink = lit ? "panel" : item.danger === true ? "bad" : item.disabled === true ? "dim" : "text";
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
      </Float>
    </MenuLayer>
  );
}
