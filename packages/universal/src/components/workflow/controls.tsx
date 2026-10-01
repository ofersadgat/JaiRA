import { createContext, useContext, useRef, useState, type JSX, type ReactNode } from "react";
import { PixelRatio, TextInput as RNTextInput, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { MenuItem } from "@jaira/ui/menuTypes";
import { useReadOnly } from "@jaira/ui/reading";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font, lengthToken, padToken, placeholderColor, useHover, type FontSpec } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { ringWidth } from "../artifact/ring";
import { Checkbox } from "../form/inputs";
import { selectKeyProps } from "../form/selectKeys";
import { AUTOFILLED, ListIndicator, SuggestLayer, laidOut, useSuggest, type Suggestion } from "../form/Suggest";
import { Svg } from "../panel/Svg";

/**
 * The plain controls the workflow editor is made of, universal (decision 0015): `styles.css`'s bare
 * `input`, `textarea`, `select`, `button` and `button.sm`, as the state form uses them, and the
 * reading's `fieldset[disabled]` over them. The rules (`cascade.mts '.state-panel'`, `--scene state-config`):
 *
 *   input, textarea, select   font: inherit (the body's app 13/12.5 on a 1.5 line; `.slot-row` 12/12.5),
 *                             --text on --bg, 1px --line (hovered --rule), radius --control-radius,
 *                             padding 5 9 (`.slot-row` 3 6), width 100%; focused, the page's ring
 *                             (2px --focus-ring, 1 out). A placeholder is Chromium's #757575.
 *   textarea                  data 12/12
 *   :disabled                 --dim on --panel-2
 *   .reading :disabled        (the reading's fieldset) no ground, no ring, --text, no side padding; a
 *                             placeholder not drawn; a select with no arrow; a textarea as tall as its text
 *   button                    `Button`'s; `.sm` padding --control-pad-sm (2 8), radius --control-radius-sm,
 *                             app 11/12.5; `.ghost` transparent (hovered --fill-ghost-hover)
 *   button.link               no ground or ring, --accent, data 11/12; hovered underlined
 *   .sub                      --dim, app 11/12.5
 *   .slot-opt                 row, centred, gap 3, app 10.5/12.5, --dim, one line; its checkbox margin 0
 */

/** The font a control inherits from where it stands: the body's (13/12.5), or `.slot-row`'s (12/12.5). */
export interface ControlSize {
  /** Of `--size-app`. */
  scale: number;
  pad: [number, number];
}
export const BODY: ControlSize = { scale: 13 / 12.5, pad: [5, 9] };
export const ROW: ControlSize = { scale: 12 / 12.5, pad: [3, 6] };

/** Whether the lint marks a box: `issue-bad` / `issue-warn` (2px, --bad / --warn), or `.unwired` / `.unresolved` (--warn). */
export type Mark = "" | "bad" | "warn";
/** A `fieldClass` answer (` issue-bad`) as a {@link Mark}. */
export const markOf = (cls: string): Mark => (cls.includes("issue-bad") ? "bad" : cls.includes("issue-warn") ? "warn" : "");

function ring(t: ReturnType<typeof useTokens>, focused: boolean): Record<string, unknown> {
  return focused && isWeb ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: t.v("focus-ring"), outlineOffset: 1 } : { outlineWidth: 0 };
}

/**
 * The form's `<datalist>`s — the ones a box's `list` names, rendered once by the editor (a datalist id
 * has to be unique): what each offers, for the type-ahead a box opens (`form/Suggest.tsx`) and the room
 * Chromium keeps for the list's indicator once a list has something in it ({@link Box}'s `listed`).
 */
export interface Lists {
  bindings: readonly Suggestion[];
  guards: readonly Suggestion[];
  links: readonly Suggestion[];
  functions: readonly Suggestion[];
  childKeys: readonly Suggestion[];
  childStates: readonly Suggestion[];
  /** `transition-targets`: the children's keys and the two terminations. */
  transitions: readonly Suggestion[];
}
const NO_LISTS: Lists = { bindings: [], guards: [], links: [], functions: [], childKeys: [], childStates: [], transitions: [] };
const ListsContext = createContext<Lists>(NO_LISTS);
export const ListsProvider = ListsContext.Provider;
export const useLists = (): Lists => useContext(ListsContext);

/** The reading's fieldset, as a context: every control under it draws as `.reading :disabled`. */
export function useReading(): boolean {
  return useContext(InReading);
}
const InReading = createContext(false);
/** `fieldset.reading[disabled]` around the form's body (`Body` in `stateEditor.tsx`). */
export function ReadingBody({ on, children }: { on: boolean; children: ReactNode }): JSX.Element {
  return <InReading.Provider value={on}>{children}</InReading.Provider>;
}

/** A plain `input`: one line, the font of where it stands. */
export function Box({
  value,
  onChange,
  placeholder,
  size = BODY,
  disabled = false,
  mark = "",
  voice = "app",
  dataScale,
  title,
  label,
  inputMode,
  listed,
  ...layout
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  /**
   * The `<datalist>` the box completes against. With something in it Chromium keeps 16 at the box's end
   * for the list's indicator, which the text stops short of, and the type-ahead opens under it.
   */
  listed?: readonly Suggestion[] | false;
  size?: ControlSize;
  disabled?: boolean | undefined;
  mark?: Mark;
  /** `.link-input`: data 11.5/12. */
  voice?: "app" | "data";
  dataScale?: number;
  title?: string | undefined;
  label?: string | undefined;
  inputMode?: "decimal" | "text";
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const reading = useReading();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const off = disabled || reading;
  const spec: FontSpec = voice === "data" ? { voice: "data", scale: dataScale ?? 1 } : { voice: "app", scale: size.scale };
  const border = mark !== "" ? mark : focused ? "accent" : hovered && !off ? "rule" : "line";
  const [pv, ph] = size.pad;
  const text = font(t, { ...spec, color: disabled && !reading ? "dim" : "text" }) as object;
  const box = {
    borderWidth: mark !== "" && !reading ? 2 : 1,
    borderStyle: "solid",
    borderColor: reading ? "transparent" : t.v(border),
    borderRadius: lengthToken(t, "control-radius", 7),
    backgroundColor: reading ? "transparent" : t.v(disabled ? "panel-2" : "bg"),
    ...ring(t, focused),
  };
  const list = useSuggest(listed === false ? undefined : listed, value, onChange, off);
  const input = (style: Record<string, unknown>): JSX.Element => (
    <RNTextInput {...(ENTER_KEEPS_FOCUS as object)}
      ref={list.ref as never}
      value={value}
      onChangeText={(next) => {
        list.onChangeText(next);
        onChange(next);
      }}
      {...(placeholder !== undefined && !reading ? { placeholder, placeholderTextColor: placeholderColor("light") } : {})}
      editable={!off}
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      inputMode={inputMode ?? "text"}
      spellCheck={false}
      onFocus={() => {
        setFocused(true);
        list.onFocus();
      }}
      onBlur={() => {
        setFocused(false);
        list.onBlur();
      }}
      {...(list.listed ? { onKeyPress: list.onKeyPress, ...list.input } : {})}
      {...((isWeb ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), ...(title !== undefined ? { title } : {}) } : {}) as object)}
      style={{ ...text, minWidth: 0, ...(isWeb && off ? { cursor: reading ? "text" : "not-allowed" } : {}), ...style, ...(list.filled ? { color: AUTOFILLED.text } : {}) } as never}
    />
  );
  if (!list.listed) {
    return input({ width: "100%", paddingVertical: pv, paddingHorizontal: reading ? 0 : ph, ...box, ...layout });
  }
  // A listed box: the indicator's 16 is room INSIDE the content box, not padding — so the box that flexes
  // (and shrinks by its content box) carries the border and the padding, and the text stops 16 short in it.
  const face = voice === "data" ? t.scaled("size-data", dataScale ?? 1) : t.scaled("size-app", size.scale);
  return (
    <SuggestLayer
      layout={layout}
      box={
        <View position="relative" flexDirection="row" width="100%" minWidth={0} paddingHorizontal={reading ? 0 : ph} {...(box as object)} {...(list.filled ? { backgroundColor: AUTOFILLED.ground } : {})} {...layout}>
          {input({ flexGrow: 1, flexShrink: 1, flexBasis: 0, width: "100%", paddingVertical: pv, paddingLeft: 0, paddingRight: 16, borderWidth: 0, backgroundColor: "transparent", outlineWidth: 0 })}
          {(hovered || focused) && !off ? (
            <ListIndicator color={list.filled ? AUTOFILLED.text : (text as { color: string }).color} size={typeof face === "number" ? face : 12} end={laidOut(mark !== "" ? 2 : 1) + ph} />
          ) : null}
        </View>
      }
      popup={list.popup}
    />
  );
}

/**
 * A plain `textarea` — data 12/12 on a 1.5 line, `rows` tall. In a reading, as tall as its text (the
 * reading's `field-sizing: content`), drawn as the text itself.
 */
export function Area({
  value,
  onChange,
  placeholder,
  rows = 2,
  disabled = false,
  mark = "",
  title,
  code = false,
  minHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  rows?: number;
  disabled?: boolean | undefined;
  mark?: Mark;
  title?: string | undefined;
  /** `.code-editor`: data at --size-editor, padding 8, radius 6. */
  code?: boolean;
  minHeight?: number;
}): JSX.Element {
  const t = useTokens();
  const reading = useReading();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const spec: FontSpec = code ? { voice: "data", scale: 1 } : { voice: "data", scale: 1 };
  const size = t.scaled("size-data", 1);
  const line = (typeof size === "number" ? size : 12) * 1.5;
  const pad = code ? 8 : 5;
  const padH = code ? 8 : 9;
  if (reading) {
    return (
      <View paddingVertical={pad} borderWidth={1} borderStyle="solid" borderColor="transparent" {...(isWeb && title !== undefined ? { title } : {})}>
        <Txt spec={{ ...spec, color: "text" }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "break-word" } } as object)}>
          {value.length > 0 ? value : " "}
        </Txt>
      </View>
    );
  }
  const border = mark !== "" ? mark : focused ? "accent" : hovered && !disabled ? "rule" : "line";
  return (
    <RNTextInput {...(ENTER_KEEPS_FOCUS as object)}
      value={value}
      onChangeText={onChange}
      multiline
      numberOfLines={rows}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor("light") } : {})}
      editable={!disabled}
      spellCheck={false}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      {...((isWeb ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), rows, ...(title !== undefined ? { title } : {}) } : {}) as object)}
      style={
        {
          ...(font(t, { ...spec, color: disabled ? "dim" : "text" }) as object),
          width: "100%",
          minWidth: 0,
          ...(isWeb ? {} : { height: rows * line + pad * 2 + 2 }),
          ...(minHeight !== undefined ? { minHeight } : {}),
          paddingVertical: pad,
          paddingHorizontal: padH,
          borderWidth: mark !== "" ? 2 : 1,
          borderStyle: "solid",
          borderColor: t.v(border),
          borderRadius: code ? 6 : lengthToken(t, "control-radius", 7),
          backgroundColor: t.v(disabled ? "panel-2" : "bg"),
          textAlignVertical: "top",
          ...(isWeb ? { resize: "vertical" } : {}),
          ...ring(t, focused),
        } as never
      }
    />
  );
}

export interface PickOption {
  value: string;
  label: string;
}

/** A 1px border as Chromium lays it out: a whole number of device pixels, at least one. */
export const hairline = (): number => Math.max(1, Math.floor(PixelRatio.get())) / PixelRatio.get();

/** Chromium's menulist: the text 4 in from the padding, and room for its arrow after it. */
const INSET = 4;
const ARROW_ROOM = 40.6 - 18 - 2 - INSET;

/**
 * A plain `select` (`logs/Select.tsx`'s drawing, stretched as the form's are): its text on the
 * menulist's `normal` line, Chromium's arrow, a menu of its options. In a reading (`appearance: none`,
 * no side padding) it is the chosen option's words on the inherited 1.5 line.
 */
export function Pick({
  value,
  options,
  onChange,
  size = BODY,
  disabled = false,
  mark = "",
  title,
  label,
  weight = 400,
  ...layout
}: {
  value: string;
  options: readonly PickOption[];
  /** The weight of where it stands (`font: inherit` — `.slots-head` is 600). */
  weight?: number;
  onChange: (v: string) => void;
  size?: ControlSize;
  disabled?: boolean | undefined;
  mark?: Mark;
  title?: string | undefined;
  label?: string | undefined;
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const reading = useReading();
  const box = useRef<unknown>(null);
  const [hovered, hover] = useHover();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const shown = options.find((o) => o.value === value)?.label ?? "";
  const off = disabled || reading;
  const [pv, ph] = size.pad;
  // The menulist's `normal` line (DM Sans: 1.3867), measured at no less than 17.33 (12px draws 17.33).
  const px = t.scaled("size-app", size.scale);
  const text: FontSpec = { voice: "app", scale: size.scale, weight, lineHeight: reading ? 1.5 : typeof px === "number" ? { px: Math.max(17.33, px * 1.3867) } : 1.3867 };
  const open = (): void => {
    const items: MenuItem[] = options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }));
    const node = box.current as { getBoundingClientRect?: () => DOMRect; measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.getBoundingClientRect !== undefined) {
      const r = node.getBoundingClientRect();
      setMenu({ x: r.left, y: r.bottom + 3, items });
    } else node?.measureInWindow?.((x, y, _w, h) => setMenu({ x, y: y + h + 3, items }));
  };
  const ring = reading ? "rgba(0, 0, 0, 0)" : mark !== "" ? mark : hovered && !off ? "rule" : "line";
  const width = mark !== "" && !reading ? 2 : 1;
  return (
    // The box is the flex item itself, padding and border and all, as a `<select>` is: squeezed, it stops
    // at them, and it shrinks by its content box.
    <View
      ref={box as never}
      position="relative"
      flexDirection="column"
      minWidth={0}
      overflow="hidden"
      paddingVertical={pv}
      paddingHorizontal={reading ? 0 : ph}
      borderRadius={lengthToken(t, "control-radius", 7)}
      backgroundColor={(reading ? "transparent" : t.v(disabled ? "panel-2" : "bg")) as never}
      {...(edge(t, { top: width, right: width, bottom: width, left: width }, ring) as object)}
      {...(isWeb && title !== undefined ? { title } : {})}
      {...(off ? {} : hover)}
      {...layout}
    >
      <Press onPress={open} disabled={off} {...({ role: "combobox" } as object)} {...(selectKeyProps(options, value, onChange) as object)} label={label ?? shown} minWidth={0} overflow="hidden" {...(reading ? {} : { paddingLeft: INSET, paddingRight: ARROW_ROOM })}>
        {reading
          ? null
          : options.map((o) => (
              <Txt key={o.value} spec={text} height={0} overflow="hidden" aria-hidden numberOfLines={1}>
                {o.label}
              </Txt>
            ))}
        {/* On web the line is a menulist's own — the font's `normal` line and a device pixel above and below
            it, in whole device pixels — not the factor's product, a thirty-second of a pixel taller. */}
        <Txt spec={{ ...text, color: disabled && !reading ? "dim" : "text" }} {...(isWeb && !reading ? { lineHeight: "normal", paddingVertical: ringWidth() } : {})} numberOfLines={1} ellipsizeMode="clip">
          {shown}
        </Txt>
      </Press>
      {reading ? null : <Chevron />}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** Chromium's menulist arrow (measured, `logs/Select.tsx`): a chevron 7.2 × 3.33, 5.2 in from the right. */
function Chevron(): JSX.Element {
  const t = useTokens();
  const ink = t.v("text") as never;
  const [w, h, stroke] = [7.2, 3.33, 1.5];
  const length = Math.hypot(w / 2, h) + stroke / 2;
  const angle = (Math.atan2(h, w / 2) * 180) / Math.PI;
  const bar = (cx: number, turn: number): JSX.Element => (
    <View position="absolute" left={cx - length / 2} top={h / 2 - stroke / 2} width={length} height={stroke} backgroundColor={ink} transform={[{ rotate: `${turn * angle}deg` }]} />
  );
  return (
    <View position="absolute" right={5.2} top="50%" marginTop={-h / 2 - 0.2} width={w} height={h} aria-hidden>
      {bar(w / 4, 1)}
      {bar((3 * w) / 4, -1)}
    </View>
  );
}

/**
 * `button.sm` (and `.ghost`): padding --control-pad-sm, radius --control-radius-sm, app 11/12.5 at the
 * weight of where it stands (`.slots-head` is 600). `quiet` is `.link-toggle`'s 0.7, `on` its accent.
 */
export function SmallButton({
  children,
  onPress,
  title,
  disabled = false,
  ghost = true,
  weight = 400,
  opacity,
  accent = false,
  lineOne = false,
  ...layout
}: {
  children: string;
  onPress: () => void;
  title?: string | undefined;
  disabled?: boolean | undefined;
  ghost?: boolean;
  weight?: number;
  opacity?: number;
  accent?: boolean;
  /** `.reorder button`: on a line of 1. */
  lineOne?: boolean;
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const [pv, ph] = padToken(t, "control-pad-sm", [2, 8]);
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      {...(title !== undefined ? { title } : {})}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={5}
      flexShrink={0}
      paddingVertical={pv}
      paddingHorizontal={ph}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius-sm", 6)}
      {...(disabled ? { opacity: 0.5 } : opacity !== undefined ? { opacity } : {})}
      box={({ hovered }) => {
        const hover = hovered && !disabled;
        return ghost
          ? { backgroundColor: hover ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(accent ? "accent" : hover ? "rule" : "line"), ...(hover && opacity !== undefined ? { opacity: 1 } : {}) }
          : { backgroundColor: t.v(hover ? "panel-3" : "panel-2"), borderColor: t.v(hover ? "rule" : "line") };
      }}
      {...layout}
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight, color: accent ? "accent" : "text", ...(lineOne ? { lineHeight: 1 } : {}) }} numberOfLines={1} textAlign="center">
        {children}
      </Txt>
    </Press>
  );
}

/** `button.link`: --accent, data 11/12 (or the font it stands in), no ground; hovered underlined. */
export function LinkButton({ children, onPress, title, disabled = false, spec }: { children: ReactNode; onPress: () => void; title?: string | undefined; disabled?: boolean; spec?: Partial<FontSpec> }): JSX.Element {
  return (
    <Press onPress={onPress} disabled={disabled} {...(title !== undefined ? { title } : {})} flexDirection="row" alignItems="center" gap={5} flexShrink={0} {...(disabled ? { opacity: 0.5 } : {})}>
      {({ hovered }) => (
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent", ...spec }} numberOfLines={1} {...(hovered && !disabled ? { textDecorationLine: "underline" } : {})}>
          {children}
        </Txt>
      )}
    </Press>
  );
}

/** `.sub`: --dim, app 11/12.5 (or another colour — `.sub.warn`, `.warn-text`). */
export function Sub({ children, color = "dim", ...rest }: { children: ReactNode; color?: string } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color }} {...rest}>
      {children}
    </Txt>
  );
}

/** `p.empty`: --dim, 8 above and below, and the paragraph's margins (1em of the body's 13). */
export function Empty({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}

/** `.reason`: --bad, app 11/12.5. */
export function Reason({ children, ...rest }: { children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} {...rest}>
      {children}
    </Txt>
  );
}

/**
 * `label.slot-opt`: a checkbox and its word — app 10.5/12.5, --dim, gap 3, the box's margin 0 (the
 * form's `Checkbox` carries Chromium's 3 3 3 4, taken back here). In a reading the word alone, said
 * only when true.
 */
export function SlotOpt({ checked, onChange, children, title, wide = false }: { checked: boolean; onChange: (next: boolean) => void; children: string; title?: string | undefined; wide?: boolean }): JSX.Element {
  const scale = (wide ? 11 : 10.5) / 12.5;
  return (
    <View flexDirection="row" alignItems="center" gap={3} flexShrink={0} {...(isWeb && title !== undefined ? { title } : {})}>
      <Tick checked={checked} onChange={onChange} />
      <Press onPress={() => onChange(!checked)} flexShrink={0}>
        <Txt spec={{ voice: "app", scale, color: "dim" }} numberOfLines={1}>
          {children}
        </Txt>
      </Press>
    </View>
  );
}

/**
 * Chromium's checkbox in a `.slot-opt` (margin 0): checked, the form's own drawing (`form/inputs.tsx`'s
 * `Checkbox`); unchecked, a ring the whole 13-square, as the desktop paints this one — measured, a device
 * pixel wider and taller than the form's.
 */
function Tick({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }): JSX.Element {
  const look = useLook();
  // Chromium paints a native checkbox snapped to device pixels (its edges rounded to the nearest), where a
  // drawing at a fractional place would be anti-aliased across two: on web the ring is drawn where the
  // desktop's would be.
  const box = useRef<unknown>(null);
  const [snap, setSnap] = useState<{ dx: number; dy: number; w: number; h: number } | null>(null);
  const measure = (): void => {
    const node = box.current as { getBoundingClientRect?: () => DOMRect } | null;
    if (!isWeb || node?.getBoundingClientRect === undefined || typeof window === "undefined") return;
    const r = node.getBoundingClientRect();
    // The scale the page is DRAWN at, read off a border: `devicePixelRatio` says 2 in a window drawn at 1.5.
    const k = 1 / ringWidth();
    const x0 = Math.round(r.left * k) / k;
    const y0 = Math.round(r.top * k) / k;
    const next = { dx: x0 - r.left, dy: y0 - r.top, w: Math.round((r.left + 13) * k) / k - x0, h: Math.round((r.top + 13) * k) / k - y0 };
    if (snap === null || Math.abs(snap.dx - next.dx) > 0.001 || Math.abs(snap.dy - next.dy) > 0.001 || snap.w !== next.w || snap.h !== next.h) setSnap(next);
  };
  if (checked) {
    return (
      <View marginTop={-3} marginRight={-3} marginBottom={-3} marginLeft={-4}>
        <Checkbox checked onChange={onChange} />
      </View>
    );
  }
  const dark = look.scheme === "dark";
  const { dx, dy, w, h } = snap ?? { dx: 0, dy: 0, w: 13, h: 13 };
  return (
    <Press onPress={() => onChange(true)} {...({ role: "checkbox", "aria-checked": false } as object)} width={13} height={13} flexShrink={0} position="relative">
      {({ hovered }) => (
        <View ref={box as never} position="absolute" left={0} top={0} width={13} height={13} onLayout={measure}>
          <Svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            strokeWidth={1}
            linecap="butt"
            linejoin="miter"
            box={{ position: "absolute", left: dx, top: dy }}
            shapes={[
              {
                kind: "path",
                d: `M2.5 0.5 H${w - 2.5} A2 2 0 0 1 ${w - 0.5} 2.5 V${h - 2.5} A2 2 0 0 1 ${w - 2.5} ${h - 0.5} H2.5 A2 2 0 0 1 0.5 ${h - 2.5} V2.5 A2 2 0 0 1 2.5 0.5 Z`,
                fill: dark ? "#3b3b3b" : "#ffffff",
                stroke: dark ? (hovered ? "#9c9c9c" : "#858585") : hovered ? "#4f4f4f" : "#767676",
                strokeWidth: 1,
              },
            ]}
          />
        </View>
      )}
    </Press>
  );
}

/** `span.slot-opt.sub`: what a reading says in place of a switch — only when it is true. */
export function SlotOptWords({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
      {children}
    </Txt>
  );
}

/**
 * `.slots-head`: the heading of one table — app 600 at 11/12.5, 0.09em, uppercase, --dim (its first
 * word --text inside `.slots`), spaced; a `.sub` after it (400, no tracking, pushed right), and its
 * buttons (`.ghost.sm` at the heading's 600).
 */
export function SlotsHead({ title, sub, strong = true, children }: { title: string; sub?: string | undefined; strong?: boolean; children?: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={8} flexShrink={0}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, ls: 0.09, upper: true, color: strong ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
        {title}
      </Txt>
      {sub !== undefined ? (
        <Sub marginLeft="auto" flexShrink={1}>
          {sub}
        </Sub>
      ) : null}
      {children}
    </View>
  );
}

/** A `.field`'s name over (or, `.inline`, beside) its control: app 11/12.5, --dim, 0.04em, uppercase. */
export function FieldName({ children, accent = false, ...rest }: { children: ReactNode; accent?: boolean } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: 0.04, upper: true, color: accent ? "accent" : "dim" }} {...rest}>
      {children}
    </Txt>
  );
}

/**
 * `details` with a `summary` — `.slot-more`'s: app 10.5/12.5 --dim, padding 1 0 1 12, its ▸ (▾ open) at
 * 8/12.5 absolutely 2 in and 4 down; what it holds 4 below. Uncontrolled, as a `details` is: `open` is
 * where it starts.
 */
export function Details({ summary, open: initial, children, ...box }: { summary: ReactNode; open: boolean; children: ReactNode } & Record<string, unknown>): JSX.Element {
  const [open, setOpen] = useState(initial);
  return (
    <View flexDirection="column" {...box}>
      <Press onPress={() => setOpen(!open)} position="relative" paddingTop={1} paddingBottom={1} paddingLeft={12} flexDirection="row">
        <Txt spec={{ voice: "app", scale: 8 / 12.5, color: "dim" }} position="absolute" left={2} top={4} aria-hidden>
          {open ? "▾" : "▸"}
        </Txt>
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }}>{summary}</Txt>
      </Press>
      {open ? <View marginTop={4}>{children}</View> : null}
    </View>
  );
}

/** The form's reading flag (`reading.ts`'s `ReadOnlyContext`) — the same context the desktop's form reads. */
export { useReadOnly };
