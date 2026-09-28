import { useRef, useState, type JSX } from "react";
import { TextInput, View as RNView } from "react-native";
import { View } from "@tamagui/core";
import { steppedSize } from "@jaira/ui/sizeStep";
import { Press, Txt, edge, font, lengthToken, placeholderColor } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Svg } from "../panel/Svg";

/**
 * The settings fields, universal (decision 0015): `controls.tsx`'s `SelectInput` and `editorKnobs.tsx`'s
 * `SizeStep`. The rules they carry, from `styles.css`:
 *
 *   select.cfg-input     1px --line (hovered --rule), radius --control-radius, --bg, padding 6 9, app
 *                        at 12.5/12.5 in --text on a `normal` line (DM Sans: 1.3867); as wide as its
 *                        widest choice plus the menulist's arrow, which Chromium draws 8.9 × 5.4, 4.8
 *                        in from the right edge, in the text's colour. Disabled: 0.55 opacity.
 *   .size-box            row, centred, gap 5, padding 3 4 3 9, 1px --line, radius --control-radius,
 *                        --panel
 *   .size-n              34 wide, right-aligned, data-num (data 600 at 0.79, tabular) in --text
 *   the unit             data-faint
 *   .size-step button    15×10, ▲ ▼ at 7px on a line of 1, --dim (hovered --text); at a limit 0.35
 */

/**
 * Chromium's menulist sets its text 4 in from the padding (measured in a 272-wide one: the text sits a
 * device pixel right of 3), and keeps room for its arrow after it: 40.6 wider than the text in all.
 * Its line is `normal` rounded UP to a whole pixel, the text centred in it.
 */
const MENULIST_INSET = 4;
const MENULIST_ROOM = 40.6 - 18 - 2 - MENULIST_INSET;

/** A closed set of choices — `controls.tsx`'s `SelectInput`. It opens a menu of them. */
export function SelectInput({
  value,
  options,
  onChange,
  disabled = false,
  fill = false,
}: {
  value: string;
  options: ReadonlyArray<readonly [label: string, value: string]>;
  onChange: (v: string) => void;
  disabled?: boolean | undefined;
  /** `width: 100%`, as a `.cfg-input` in a field's control is. */
  fill?: boolean;
}): JSX.Element {
  const t = useTokens();
  const box = useRef<RNView | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const shown = options.find(([, v]) => v === value)?.[0] ?? "";
  const text = { voice: "app", scale: 1, lineHeight: 1.3867 } as const;
  const size = t.scaled("size-app", 1);
  const lineBox = typeof size === "number" ? size * 1.3867 : undefined;
  const open = (): void =>
    box.current?.measureInWindow((x, y, _w, h) =>
      setMenu({
        x,
        y: y + h + 3,
        items: options.map(([label, v]) => ({ label, checked: v === value, onSelect: () => onChange(v) })),
      }),
    );
  return (
    <RNView ref={box} collapsable={false} style={fill ? { width: "100%", minWidth: 0 } : undefined}>
      <Press
        onPress={open}
        disabled={disabled}
        {...({ role: "combobox" } as object)}
        label={shown}
        paddingVertical={6}
        paddingLeft={9 + MENULIST_INSET}
        paddingRight={9 + MENULIST_ROOM}
        borderRadius={lengthToken(t, "control-radius", 7)}
        backgroundColor={t.v("bg") as never}
        {...(disabled ? { opacity: 0.55 } : {})}
        box={({ hovered }) => edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, hovered && !disabled ? "rule" : "line")}
      >
        {/* Every choice, laid out and not drawn: the box is as wide as the widest, as a <select> is. */}
        {options.map(([label]) => (
          <Txt key={label} spec={text} height={0} overflow="hidden" aria-hidden numberOfLines={1}>
            {label}
          </Txt>
        ))}
        <View minHeight={typeof lineBox === "number" ? Math.ceil(lineBox) : undefined} justifyContent="center">
          <Txt spec={text} numberOfLines={1}>
            {shown}
          </Txt>
        </View>
        <Chevron right={4.67 - 1 - 0.67} />
      </Press>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </RNView>
  );
}

/**
 * Chromium's menulist arrow, measured off the desktop's pictures: two arms 8 apart at their tops,
 * meeting 3.9 below, stroked 1.2, their tops 2.5 above the box's middle and 4.7 in from its right edge.
 */
function Chevron({ right }: { right: number }): JSX.Element {
  const t = useTokens();
  return (
    <Svg
      width={10}
      height={6}
      viewBox="0 0 10 6"
      color={String(t.v("text"))}
      strokeWidth={1.2}
      linecap="butt"
      linejoin="miter"
      shapes={[{ kind: "path", d: "M1 1.1 L5 4.97 L9 1.1" }]}
      box={{ position: "absolute", right, top: "50%", marginTop: -3.6, pointerEvents: "none", "aria-hidden": true }}
    />
  );
}

/** A size as a number and a stepper — `editorKnobs.tsx`'s `SizeStep`. */
export function SizeStep({
  value,
  limits,
  by = 0.5,
  unit = "px",
  disabled = false,
  onChange,
}: {
  value: number;
  limits: { min: number; max: number };
  by?: number;
  unit?: string;
  disabled?: boolean | undefined;
  onChange: (size: number) => void;
}): JSX.Element {
  const t = useTokens();
  const [draft, setDraft] = useState<string | null>(null);
  const step = (direction: number): void => onChange(steppedSize(value, direction, by, limits));
  const arrow = (glyph: string, direction: number, title: string, off: boolean): JSX.Element => (
    <Press onPress={() => step(direction)} disabled={off} title={title} label={title} width={15} height={10} alignItems="center" justifyContent="center" {...(off ? { opacity: 0.35 } : {})}>
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 1, lineHeight: { px: 7 }, color: hovered && !off ? "text" : "dim" }} fontSize={7} textAlign="center">
          {glyph}
        </Txt>
      )}
    </Press>
  );
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={5}
      flexShrink={0}
      paddingTop={3}
      paddingRight={4}
      paddingBottom={3}
      paddingLeft={9}
      borderRadius={lengthToken(t, "control-radius", 7)}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      {...(disabled ? { opacity: 0.55 } : {})}
    >
      <TextInput
        value={draft ?? String(value)}
        editable={!disabled}
        inputMode="decimal"
        onChangeText={(text) => {
          setDraft(text);
          const n = Number(text);
          if (text.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
        style={{ ...(font(t, { voice: "data", scale: 0.79, weight: 600, tabular: true }) as object), width: 34, padding: 0, borderWidth: 0, textAlign: "right", backgroundColor: "transparent" } as never}
      />
      <Txt register="data-faint">{unit}</Txt>
      <View flexDirection="column" flexShrink={0}>
        {arrow("▲", 1, `larger (max ${limits.max})`, disabled || value >= limits.max)}
        {arrow("▼", -1, `smaller (min ${limits.min})`, disabled || value <= limits.min)}
      </View>
    </View>
  );
}

/**
 * `controls.tsx`'s `TextInput`: a plain text box (`.cfg-input`) — app at 12.5/12.5 on the body's 1.5
 * line, --text on --bg, 1px --line (hovered --rule), radius --control-radius, padding 6 9. With no width
 * it is an <input>'s own: 20 characters, 152 wide at 12.5px (10.56 × the size, and the padding and border). Disabled: 0.55 opacity,
 * --dim on --panel-2.
 */
export function TextField({
  value,
  onChange,
  placeholder,
  disabled = false,
  mono = false,
  label,
  width,
  onBlur,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  mono?: boolean;
  label?: string | undefined;
  width?: number | string | undefined;
  onBlur?: (() => void) | undefined;
  onSubmit?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const [hovered, setHovered] = useState(false);
  const spec = mono ? ({ voice: "data", scale: 1 } as const) : ({ voice: "app", scale: 1 } as const);
  const size = t.scaled(`size-${spec.voice}`, 1);
  // An <input>'s own width in Chromium: 152 at 12.5px, whatever the device's pixel ratio.
  const own = typeof size === "number" ? 10.56 * size + 20 : undefined;
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor(look.scheme) } : {})}
      editable={!disabled}
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      {...(onBlur !== undefined ? { onBlur } : {})}
      {...(onSubmit !== undefined ? { onSubmitEditing: onSubmit } : {})}
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)}
      style={
        {
          ...(font(t, { ...spec, color: disabled ? "dim" : "text" }) as object),
          ...(width !== undefined ? { width } : own !== undefined ? { width: own } : {}),
          minWidth: 0,
          paddingVertical: 6,
          paddingHorizontal: 9,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(hovered && !disabled ? "rule" : "line"),
          borderRadius: lengthToken(t, "control-radius", 7),
          backgroundColor: t.v(disabled ? "panel-2" : "bg"),
          ...(disabled ? { opacity: 0.55 } : {}),
        } as never
      }
    />
  );
}
