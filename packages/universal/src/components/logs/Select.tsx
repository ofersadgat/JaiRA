import { useMemo, useRef, useState, type JSX } from "react";
import { View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { MenuItem } from "@jaira/ui/menuTypes";
import { sourceGroups } from "@jaira/ui/logsModel";
import { PLAIN_SCROLLER, Press, Txt, edge, lengthToken, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { ringWidth } from "../artifact/ring";
import { MenulistArrow } from "../form/MenulistArrow";
import { selectKeyProps } from "../form/selectKeys";

/**
 * A plain `<select>`, universal (decision 0015) — the one `styles.css` styles as `input, textarea,
 * select` with no class, which the Logs room's bar and its Configure panel use. (Settings' `SelectInput`
 * is `select.cfg-input`, a different padding and size.) The rules it carries:
 *
 *   select               font: inherit (the body's: app at 13/12.5), --text on --bg, 1px --line
 *                        (hovered --rule), radius --control-radius, padding 5 9. Chromium's menulist
 *                        draws its text on a `normal` line (DM Sans: 1.3867), 3 in from the padding, and
 *                        keeps room for its arrow after it (40.6 wider than the text in all); the arrow
 *                        in the text's colour (`MenulistArrow`). On web the width is Chromium's to the
 *                        device pixel: the widest choice rounded UP to a whole one, then 20 for the
 *                        inset and the arrow (`MENULIST_SNAPPED`) — measured over eight selects at 1.5×,
 *                        each `ceil(text) + 59` device pixels wide (2 of border, 27 of padding, 30).
 *   .logs-bar select     width auto, flex none, min-width 150
 *
 * Options may come in groups (`<optgroup>`): the menu lists a group's label, disabled, over its entries.
 */
export interface SelectOption {
  label: string;
  value: string;
}
export interface SelectGroup {
  group: string;
  options: readonly SelectOption[];
}

const MENULIST_INSET = 4;
const MENULIST_ROOM = 40.6 - 18 - 2 - MENULIST_INSET;
/** The arrow's room once the widest choice is rounded up to a device pixel, as Chromium rounds it. */
const MENULIST_SNAPPED = 20 - MENULIST_INSET;

export function Select({
  value,
  options,
  onChange,
  label,
  minWidth,
  font: fontSpec = { voice: "app", scale: 13 / 12.5 },
  lineHeight = 1.3867,
  disabled = false,
}: {
  value: string;
  options: ReadonlyArray<SelectOption | SelectGroup>;
  onChange: (v: string) => void;
  label?: string;
  minWidth?: number;
  font?: FontSpec;
  /** The menulist's `normal` line, as a factor of the size. */
  lineHeight?: number;
  disabled?: boolean;
}): JSX.Element {
  const t = useTokens();
  const box = useRef<RNView | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // The widest choice as laid out (web): rounded up to a whole device pixel below, as a menulist's is.
  const [widest, setWidest] = useState<number | null>(null);
  const device = isWeb ? ringWidth() : 1;
  const snapped = isWeb && widest !== null && widest > 0 ? Math.ceil(widest / device - 0.01) * device : undefined;
  const flat = options.flatMap((o) => ("group" in o ? o.options : [o]));
  const shown = flat.find((o) => o.value === value)?.label ?? "";
  const text = { ...fontSpec, lineHeight } as FontSpec;
  const open = (): void =>
    box.current?.measureInWindow((x, y, _w, h) => {
      const items: MenuItem[] = [];
      for (const o of options) {
        if ("group" in o) {
          items.push({ label: o.group, disabled: true, onSelect: () => undefined });
          for (const one of o.options) items.push({ label: `  ${one.label}`, checked: one.value === value, onSelect: () => onChange(one.value) });
        } else items.push({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) });
      }
      setMenu({ x, y: y + h + 3, items });
    });
  return (
    <RNView ref={box} collapsable={false} style={{ flexShrink: 0, ...PLAIN_SCROLLER } as never}>
      <Press
        onPress={open}
        disabled={disabled}
        {...({ role: "combobox" } as object)}
        // A closed `<select>`'s keys: the arrows step it, a letter finds a choice (`selectModel.ts`).
        {...(selectKeyProps(flat, value, onChange) as object)}
        label={label ?? shown}
        // The arrow is placed against it (`MenulistArrow`).
        position="relative"
        {...(minWidth !== undefined ? { minWidth } : {})}
        paddingVertical={5}
        paddingLeft={9 + MENULIST_INSET}
        paddingRight={9 + (snapped !== undefined ? MENULIST_SNAPPED : MENULIST_ROOM)}
        borderRadius={lengthToken(t, "control-radius", 7)}
        backgroundColor={t.v(disabled ? "panel-2" : "bg") as never}
        box={({ hovered }) => edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, hovered && !disabled ? "rule" : "line")}
      >
        {/* Every choice, laid out and not drawn: the box is as wide as the widest, as a <select> is. */}
        <View height={0} overflow="hidden" alignSelf="flex-start" aria-hidden {...(snapped !== undefined ? { width: snapped } : {})}>
          <View alignSelf="flex-start" {...(isWeb ? { onLayout: (e: { nativeEvent: { layout: { width: number } } }) => setWidest(e.nativeEvent.layout.width) } : {})}>
            {flat.map((o) => (
              <Txt key={o.value} spec={text} numberOfLines={1}>
                {o.label}
              </Txt>
            ))}
          </View>
        </View>
        {/* On web the line is a menulist's own: the font's `normal` line and a device pixel above and
            below it, all whole device pixels (18 at 13px, where the factor gives 18.027 — a thirty-second
            that moved what stood under a row of these). */}
        <Txt spec={{ ...text, color: disabled ? "dim" : "text" }} {...(isWeb ? { lineHeight: "normal", paddingVertical: device } : {})} numberOfLines={1}>
          {shown}
        </Txt>
        <MenulistArrow color={disabled ? "dim" : "text"} />
      </Press>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </RNView>
  );
}

/** `logs.tsx`'s `SourceSelect`: every source, grouped by its first dot-segment. */
export function SourceSelect({ value, sources, onChange, label = "Source", minWidth }: { value: string; sources: string[]; onChange: (value: string) => void; label?: string; minWidth?: number }): JSX.Element {
  const groups = useMemo(() => sourceGroups(sources), [sources]);
  const options: (SelectOption | SelectGroup)[] = [
    { label: "all sources", value: "" },
    ...groups.map(([top, list]): SelectOption | SelectGroup =>
      list.length === 1 && list[0] === top
        ? { label: top, value: top }
        : { group: top, options: [{ label: `${top} (all)`, value: top }, ...list.filter((s) => s !== top).map((s) => ({ label: s, value: s }))] },
    ),
  ];
  return <Select value={value} options={options} onChange={onChange} label={label} {...(minWidth !== undefined ? { minWidth } : {})} />;
}
