import { createContext, useContext, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Platform, Pressable, type GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { useTokens, type Tokens } from "./tokens";

/**
 * What every component of this tree stands on (decision 0015). The tree is drawn by react-native-web in a
 * browser (the desktop's window is one) and natively on a phone, and its page carries no stylesheet: what
 * a stylesheet does once for a whole page, a component has to do for itself — written once here instead
 * of in every component.
 *
 * - **Type.** Nothing gives a word a font from outside: on native nothing inherits into a `Text` from a
 *   `View`, and on web there is no `body` rule to inherit from. So every `Text` states its whole font:
 *   {@link font} builds it, and {@link REGISTERS} are the ten registers (SHELL.md §3.3).
 * - **Pressing.** React Native's `Pressable`, because Tamagui's `onPress` never fired on Android (found on
 *   the emulator); {@link Press} puts a Tamagui box inside it and hands the box its hover and press state.
 */

/** The two voices: `--font-app` (DM Sans, words the app says) and `--font-data` (JetBrains Mono, values). */
export type Voice = "app" | "data";

export interface FontSpec {
  voice: Voice;
  /** `--size-app` or `--size-data` times this. */
  scale: number;
  weight?: number;
  italic?: boolean;
  /** Letter spacing in em. */
  ls?: number;
  upper?: boolean;
  /** A colour token name (`dim`) or a colour. */
  color?: string;
  /** Line height: a factor of the size (the body's 1.5 when absent), or `{ px }`. */
  lineHeight?: number | { px: number };
  tabular?: boolean;
}

/**
 * A `Text`'s whole font, from a spec: family, size, weight, spacing, case, colour and line height — all
 * of which it must be told, since it inherits none.
 */
export function font(t: Tokens, spec: FontSpec): Record<string, unknown> {
  const size = t.scaled(`size-${spec.voice}`, spec.scale);
  const px = typeof size === "number" ? size : undefined;
  const weight = spec.weight ?? 400;
  const lh = spec.lineHeight ?? 1.5;
  const color = spec.color === undefined ? t.v("text") : /^[a-z][a-z0-9-]*$/.test(spec.color) ? t.v(spec.color) : spec.color;
  return {
    fontSize: size,
    fontWeight: String(weight),
    // After the weight: on native a cut face says `normal`, since the weight is in the face itself.
    ...familyOf(t, spec.voice, weight, px ?? 12),
    ...(spec.italic === true ? { fontStyle: "italic" } : {}),
    // Replayed, sizes are numbers and so must spacing and line height be; where the tokens are CSS
    // variables they stay relative (`em`, a factor), so a size preference moves them with the text.
    ...(spec.ls !== undefined ? { letterSpacing: px !== undefined ? spec.ls * px : `${spec.ls}em` } : {}),
    ...(spec.upper === true ? { textTransform: "uppercase" } : {}),
    lineHeight: typeof lh === "object" ? (px !== undefined ? lh.px : `${lh.px}px`) : px !== undefined ? lh * px : String(lh),
    ...(spec.tabular === true ? (isWeb ? { fontVariant: "tabular-nums" } : { fontVariant: ["tabular-nums"] }) : {}),
    color,
  };
}

/**
 * The family, as each platform names it. On web the stack (the replayed one, whose faces the page
 * registers with `@font-face`, or `var(--font-app)`). On native a single family: the bundled face cut at the
 * nearest weight — and for DM Sans the nearest optical size, which Chromium sets to the font size —
 * since Android can pick neither out of one variable file (`scripts/fonts.py` cuts them).
 */
function familyOf(t: Tokens, voice: Voice, weight: number, size: number): Record<string, unknown> {
  const stack = t.v(`font-${voice}`);
  if (Platform.OS === "web") return { fontFamily: stack };
  const first = String(stack).split(",")[0]!.trim().replace(/^["']|["']$/g, "");
  const family = nativeFamily(first, weight, size);
  // A cut face is its own family, drawn at its own weight: asking for a weight on top of it would
  // make Android fake one.
  return family === first ? { fontFamily: family } : { fontFamily: family, fontWeight: "normal" };
}

const WEIGHTS = [400, 450, 500, 550, 600, 650, 700, 800];
const OPSZ = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 32];
const nearest = (all: readonly number[], x: number): number => all.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
function nativeFamily(family: string, weight: number, size: number): string {
  if (family === "JetBrains Mono") return `JetBrainsMono_${nearest(WEIGHTS, weight)}`;
  if (family === "DM Sans") return `DMSans_${nearest(WEIGHTS, weight)}_${nearest(OPSZ, size)}`;
  return family;
}

/** The ten registers (SHELL.md §3.3), as font specs. Data never takes a transform. */
export const REGISTERS = {
  "app-title": { voice: "app", scale: 1.05, weight: 700, ls: -0.012, color: "text" },
  "app-label": { voice: "app", scale: 0.8, weight: 700, upper: true, ls: 0.1, color: "dim" },
  "app-text": { voice: "app", scale: 1, weight: 500, color: "text" },
  "app-secondary": { voice: "app", scale: 0.88, weight: 400, color: "dim" },
  "app-absent": { voice: "app", scale: 1, weight: 500, italic: true, color: "tok-hint" },
  "data-title": { voice: "data", scale: 1.12, weight: 700, ls: -0.02, color: "text" },
  "data-text": { voice: "data", scale: 0.96, weight: 400, ls: -0.01, color: "text" },
  "data-secondary": { voice: "data", scale: 0.84, weight: 400, color: "dim" },
  "data-faint": { voice: "data", scale: 0.84, weight: 400, color: "tok-hint" },
  "data-num": { voice: "data", scale: 0.79, weight: 600, tabular: true, color: "dim" },
} as const satisfies Record<string, FontSpec>;
export type Register = keyof typeof REGISTERS;

/**
 * A run of text in a register (or a spec), with overrides. `ellip`: one line, cut with an ellipsis.
 */
export function Txt({
  register,
  spec,
  ellip = false,
  children,
  ...rest
}: {
  register?: Register;
  spec?: Partial<FontSpec>;
  ellip?: boolean;
  children?: ReactNode;
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const ink = useContext(InkContext);
  const base: FontSpec = { ...(register !== undefined ? REGISTERS[register] : { voice: "app", scale: 1 }), ...spec } as FontSpec;
  if (base.color === undefined && ink !== undefined) base.color = ink;
  // A factor stays a factor on web (`line-height: 1.5`, a number): Blink multiplies it out and snaps
  // the product DOWN to a sixty-fourth of a device pixel, where a length is snapped to the nearest — a
  // title one sixty-fourth taller put a line of JSON far below it on the other side of a pixel from
  // its reference picture. Not where the size is given apart from the spec (`fontSize`):
  // there the line is the spec's own size times the factor, as it always was. A phone is told the product.
  const factor = isWeb && typeof base.lineHeight !== "object" && rest["fontSize"] === undefined ? { lineHeight: String(base.lineHeight ?? 1.5) } : {};
  return (
    // Left unless told otherwise: on web a Pressable is a <button>, which centres the text inside it.
    <Text {...(font(t, base) as object)} {...factor} textAlign="left" {...(ellip ? { numberOfLines: 1, ellipsizeMode: "tail" } : {})} {...(rest as object)}>
      {children}
    </Text>
  );
}

/**
 * The colour a `Txt` that names none takes: the body's --text, unless a box round it sets another — CSS
 * inheritance, for the one place the tree needs it (an adopted task's history drawn inside a step's
 * note row, whose --dim reaches every word in it that sets no colour of its own).
 */
export const InkContext = createContext<string | undefined>(undefined);

/** A glyph set in the app voice at a size, centred in a fixed width (a sidebar row's glyph). */
export function Glyph({ children, width, scale = 1, color = "dim", ...rest }: { children: ReactNode; width?: number; scale?: number; color?: string } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale, color }} textAlign="center" {...(width !== undefined ? { width, flexShrink: 0 } : {})} {...rest}>
      {children}
    </Txt>
  );
}

export interface PressState {
  hovered: boolean;
  pressed: boolean;
}

/** Props that size and place a box in its parent — they belong on the `Pressable`, not the box inside it. */
const OUTER = new Set(["flex", "flexGrow", "flexShrink", "flexBasis", "alignSelf", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft", "marginHorizontal", "marginVertical", "position", "top", "right", "bottom", "left", "zIndex"]);

/**
 * What says a control's kind and state to someone not looking at it (`role`, `aria-expanded`,
 * `aria-selected`, `aria-pressed`, …) and what follows its focus (`onKeyDown`, `onFocus`, `onBlur`): on
 * web they belong on the element that TAKES the focus, the `Pressable` (a `<button>`) — on the box inside
 * it a tab's `aria-selected` described a `div` nobody can reach, and a key handler heard nothing. A phone
 * keeps them on the box: React Native reads its own accessibility props there, and has no keyboard.
 */
const onControl = (k: string): boolean => isWeb && (k === "role" || k.startsWith("aria-") || k === "onKeyDown" || k === "onFocus" || k === "onBlur");

/** The box's corners, which the `Pressable` takes too on web: `:focus-visible`'s outline follows the radius of the element it rings. */
const CORNERS = ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"] as const;

/**
 * A pressable as a plain `<button>` stands in a page: react-native-web's View is positioned and a
 * stacking context (`position: relative; z-index: 0`), and a page whose every button is one is PAINTED
 * out of document order — the buttons after everything that is not one. Chromium layers a page by that
 * order: what is painted after a scroller shares a layer with its scrollbar, and the text of such a
 * layer is greyscale; so a row of tabs, a tree's rows, a gate's buttons came out greyscale where the
 * reference pictures have subpixel text, and the other way round. Native keeps its own.
 */
const PLAIN_PRESS: Record<string, unknown> = isWeb ? { position: "static", zIndex: "auto" } : {};

/**
 * Something that can be pressed: React Native's `Pressable` around a Tamagui box. The box's props may be
 * a function of the press state, for what CSS writes as `:hover` (web only; a phone has no pointer).
 * Props that size and place it go on the `Pressable`; the box fills it.
 *
 * A `role` other than a button's (`tab`, `switch`, `checkbox`, `menuitem`) is a `<button role="tab">`:
 * on web the element stays the `<button>` react-native-web draws for a button — Space presses it,
 * `disabled` disables it, and it lays out as every other `Press` — and the role is written on it once
 * it is there, since react-native-web picks the element FROM the role and would draw a `div`.
 *
 * On web it is no stacking context and not positioned ({@link PLAIN_PRESS}), as a `<button>` is neither.
 * Something placed absolutely inside a `Press` needs it positioned, as it needs a `<button>` to be: say
 * `position="relative"` (it is still no stacking context).
 */
export function Press({
  onPress,
  onLongPress,
  disabled,
  label,
  title,
  children,
  box,
  fill = true,
  focusable,
  ...props
}: {
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  disabled?: boolean;
  /** The accessible name (`aria-label`). */
  label?: string;
  /** The tooltip (web). */
  title?: string;
  children?: ReactNode | ((state: PressState) => ReactNode);
  /** Box props that depend on the press state (hover ground, pressed tint). */
  box?: (state: PressState) => Record<string, unknown>;
  /**
   * The box grows to fill the pressable (the default). `false` where the pressable is only ever its
   * content's size inside a box whose height is still being settled (a stretched flex line): there Yoga
   * feeds the growth back into that height, pass after pass, and a row of Connections ran to a million
   * pixels on a phone.
   */
  fill?: boolean;
  /** `false`: out of the Tab order (`tabindex="-1"`), for a control a key handler moves focus to (a rail's tabs). */
  focusable?: boolean;
} & Record<string, unknown>): JSX.Element {
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  const control: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) (onControl(k) ? control : OUTER.has(k) ? outer : inner)[k] = v;
  if (isWeb) for (const k of CORNERS) if (inner[k] !== undefined) outer[k] = inner[k];
  const { role, ...said } = control;
  const host = useRef<unknown>(null);
  useLayoutEffect(() => {
    const el = host.current as { setAttribute?: (name: string, value: string) => void } | null;
    if (isWeb && typeof el?.setAttribute === "function") el.setAttribute("role", typeof role === "string" ? role : "button");
  }, [role]);
  return (
    <Pressable
      ref={host as never}
      {...(onPress !== undefined ? { onPress } : {})}
      {...(onLongPress !== undefined ? { onLongPress } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(focusable !== undefined ? (isWeb ? { tabIndex: focusable ? 0 : -1 } : { focusable }) : {})}
      role="button"
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      {...(said as object)}
      style={{ ...PLAIN_PRESS, ...(outer as object), ...(isWeb ? { cursor: disabled === true ? "default" : "pointer" } : {}) } as never}
    >
      {(s: { hovered?: boolean; pressed: boolean }) => {
        const state = { hovered: s.hovered === true, pressed: s.pressed };
        return (
          // The tooltip on the box: react-native-web's Pressable drops a `title`, and Tamagui hands one to the element.
          <View flexGrow={fill ? 1 : 0} flexShrink={1} {...((isWeb && title !== undefined ? { title } : {}) as object)} {...(inner as object)} {...((box?.(state) ?? {}) as object)}>
            {typeof children === "function" ? children(state) : children}
          </View>
        );
      }}
    </Pressable>
  );
}

/**
 * `:hover` on a box that is not itself pressed (a row whose ground lights while any of it is under the
 * pointer). Web only: the props are the DOM's mouse events, which Tamagui hands to the element; a phone
 * has no pointer, so there the box is simply never hovered.
 */
export function useHover(): [boolean, Record<string, unknown>] {
  const [hovered, setHovered] = useState(false);
  return [hovered, isWeb ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } : {}];
}

/**
 * A border on some sides only (CSS's `border-bottom: 1px solid var(--line)`). Every side's width is
 * stated: on web Tamagui leaves the rest at the browser's `medium` (3px) once a style is set, which drew
 * a frame around boxes that have one rule.
 */
export function edge(
  t: Tokens,
  sides: { top?: number; right?: number; bottom?: number; left?: number },
  color: string = "line",
  style: "solid" | "dashed" = "solid",
): Record<string, unknown> {
  return {
    borderTopWidth: sides.top ?? 0,
    borderRightWidth: sides.right ?? 0,
    borderBottomWidth: sides.bottom ?? 0,
    borderLeftWidth: sides.left ?? 0,
    borderStyle: style,
    borderColor: /^[a-z][a-z0-9-]*$/.test(color) ? t.v(color) : color,
  };
}

/**
 * `-webkit-app-region: drag` with `user-select: none` (the title bar's empty stretch, the sidebar's
 * head): where the desktop's frameless window is grabbed and moved. The OS hit-tests it, not the page,
 * so a press there never reaches a handler — and the property INHERITS, so anything clickable inside a
 * strip stands in a box that says {@link NO_DRAG} (the sidebar head's button), as does a float lying
 * over one (`FLOATS`). In a `style`; nothing on a phone, whose window is not moved.
 */
export const DRAG_REGION: Record<string, unknown> = isWeb ? { WebkitAppRegion: "drag", userSelect: "none" } : {};
export const NO_DRAG: Record<string, unknown> = isWeb ? { WebkitAppRegion: "no-drag" } : {};

/**
 * A region of the window by what it is — the sidebar (`navigation`, a `<nav>`'s role), the title bar
 * (`banner`, a `<header>`'s), the side panel (`complementary`, an `<aside>`'s) and the inbox strip
 * (`contentinfo`, a `<footer>`'s) — for a reader moving by landmark. Web only: a phone's screen reader
 * has no landmarks to move by, and a role React Native does not know has crashed Android before
 * (`separator`).
 */
export const landmark = (role: "navigation" | "banner" | "complementary" | "contentinfo"): Record<string, unknown> => (isWeb ? { role } : {});

/**
 * The gutters the OS draws the window's buttons into (`--wco-left`: macOS's traffic lights; `--wco-right`:
 * minimise, maximise and close on Windows and Linux — from Chromium's `titlebar-area-*` environment
 * variables), added to a padding or a least width: what the window's top row keeps clear of them. CSS
 * on web, where a plain browser resolves each to no gutter at all; a phone has no such buttons. The
 * band's height (`--wco-height`) is the 34 the top row already stands at: `titleBarOverlay` asks for
 * exactly it.
 */
export const WINDOW_GUTTER: { left: (pad: number) => number | string; right: (pad: number) => number | string } = isWeb
  ? {
      left: (pad) => `calc(${pad}px + env(titlebar-area-x, 0px))`,
      right: (pad) => `calc(${pad}px + (100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))`,
    }
  : { left: (pad) => pad, right: (pad) => pad };

/**
 * The app's ONE scrollbar (`::-webkit-scrollbar`: a 10px gutter, a rounded thumb inset 2px, drawn
 * from `--text` at 16%, 26% over the box that scrolls, 40% under the pointer, 50% held), for a
 * `ScrollView` on web. A pseudo-element has no inline style, so the rules are written once per colour
 * into a `<style>` of their own and the box is pointed at them by `data-scrollbar`. Only scrollbar
 * rules: no component takes anything else from a stylesheet. Native draws its own overlay
 * indicator, with no gutter, and gets nothing.
 */
export function scrollbarProps(t: Tokens): Record<string, unknown> {
  if (!isWeb || typeof document === "undefined") return {};
  const ink = (pct: number): string => (t.replayed ? t.mix(t.v("text"), pct, "transparent") : `color-mix(in srgb, var(--text) ${pct}%, transparent)`);
  const colours = [ink(16), ink(26), ink(40), ink(50)];
  const key = colours.join("|");
  let id = SCROLLBARS.get(key);
  if (id === undefined) {
    id = `s${SCROLLBARS.size + 1}`;
    SCROLLBARS.set(key, id);
    let sheet = document.getElementById("jaira-scrollbars") as HTMLStyleElement | null;
    if (sheet === null) {
      sheet = document.createElement("style");
      sheet.id = "jaira-scrollbars";
      document.head.appendChild(sheet);
    }
    const at = `[data-scrollbar="${id}"]`;
    sheet.appendChild(
      document.createTextNode(
        `${at}::-webkit-scrollbar{width:10px;height:10px}` +
          `${at}::-webkit-scrollbar-track,${at}::-webkit-scrollbar-corner{background:transparent}` +
          `${at}::-webkit-scrollbar-thumb{min-height:32px;border:2px solid transparent;border-radius:999px;background-clip:padding-box;background-color:${colours[0]}}` +
          `${at}:hover::-webkit-scrollbar-thumb{background-color:${colours[1]}}` +
          `${at}::-webkit-scrollbar-thumb:hover{background-color:${colours[2]}}` +
          `${at}::-webkit-scrollbar-thumb:active{background-color:${colours[3]}}` +
          `${at}::-webkit-scrollbar-button{display:none}`,
      ),
    );
  }
  return { dataSet: { scrollbar: id } };
}
const SCROLLBARS = new Map<string, string>();

/**
 * {@link scrollbarProps} for a Tamagui `View` that scrolls itself (`overflow: auto`): Tamagui hands its
 * props to the element as they are, so `dataSet` would land as `dataset="[object Object]"` — the
 * attribute is spelled out instead.
 */
export function viewScrollbarProps(t: Tokens): Record<string, unknown> {
  const id = (scrollbarProps(t) as { dataSet?: { scrollbar?: string } }).dataSet?.scrollbar;
  return id === undefined ? {} : { "data-scrollbar": id };
}

/**
 * A length token as a number where the replayed cascade has one (`--control-radius` → 7), or the
 * variable itself where the tokens are CSS variables, for the browser to resolve
 * (`var(--control-radius, 7px)`).
 */
export function lengthToken(t: Tokens, name: string, fallback: number): number | string {
  if (!t.replayed) return `var(--${name}, ${fallback}px)`;
  const v = t.v(name);
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A two-length padding token (`--control-pad: 3px 10px`) as `[vertical, horizontal]` numbers. Where
 * the tokens are CSS variables there is no number to read: the fallback, the token's default, is returned.
 */
export function padToken(t: Tokens, name: string, fallback: [number, number]): [number, number] {
  if (!t.replayed) return fallback;
  const [v, h] = String(t.v(name))
    .split(/\s+/)
    .map((one) => parseFloat(one));
  return [Number.isFinite(v) ? v! : fallback[0], Number.isFinite(h) ? h! : Number.isFinite(v) ? v! : fallback[1]];
}

/**
 * A `ScrollView`'s style on web without what react-native-web gives every scroller — `translateZ(0)`
 * and a `z-index: 0` stacking context — either of which lets Chromium composite the scroller, where it
 * draws text greyscale instead of the subpixel text a plain `overflow: auto` box gets: every glyph an
 * anti-aliasing pair apart from its reference picture. Native keeps its own.
 */
export const PLAIN_SCROLLER: Record<string, unknown> = isWeb ? { transform: "none", zIndex: "auto", position: "static" } : {};

/**
 * A react-native-web `View` that stays positioned (`position: relative`, for what is placed against it)
 * and is no stacking context: with {@link PLAIN_SCROLLER} (for a box that can be static) what keeps the
 * page painted in document order, by which Chromium layers it ({@link PLAIN_PRESS}). In a `style`;
 * nothing on a phone.
 */
export const NO_STACK: Record<string, unknown> = isWeb ? { zIndex: "auto" } : {};

/**
 * Enter leaves the focus in a single-line text box, as it does in an `<input>`: react-native-web blurs one
 * on Enter by default, which lost the box a person was typing a second entry into (a hide rule, a tag, a
 * search) and ran a box's commit-on-blur a second time. Spread on a `TextInput`; nothing on a phone, where
 * the return key putting the keyboard away is what a phone does.
 */
export const ENTER_KEEPS_FOCUS: Record<string, unknown> = isWeb ? { blurOnSubmit: false } : {};

/** Chromium's own placeholder colour (an unstyled `::placeholder`), the app's too: #757575, or #a9a9a9 in a dark scheme. */
export const placeholderColor = (scheme: "light" | "dark"): string => (scheme === "dark" ? "#a9a9a9" : "#757575");

/**
 * A length in `ch` of the app voice (DM Sans), at a scale of `--size-app`: `n` widths of its `0`. The
 * `0` widens with the optical size, which Chromium sets to the font size — measured in Chromium at
 * 0.662 of the size at 10px, 0.667 at 11px and 0.6784 at 13px, and read between and beyond those as
 * lines through them. Not replayed, it is CSS's own `ch`.
 */
export function appCh(t: Tokens, scale: number, n: number): number | string {
  const size = t.scaled("size-app", scale);
  if (typeof size !== "number") return `calc(${n}ch)`;
  const zero = size <= 11 ? 0.662 + 0.005 * (size - 10) : 0.667 + 0.0057 * (size - 11);
  return n * size * zero;
}

/**
 * The family for a text that writes its own font rather than going through `Txt` (a card's rows, a pill,
 * a chip): on web the voice's stack (the replayed one, or `var(--font-data)`); on a phone the
 * cut face `Txt` would pick (`familyOf`) at that weight and size. A CSS stack is no family on Android,
 * which drew all of these in the system font. Spread it in place of a `fontFamily`; a `fontWeight` set
 * beside it stays, and names the weight the face was cut at, so Android fakes nothing.
 */
export function faceOf(t: Tokens, voice: Voice, weight: number, size: number | string): Record<string, unknown> {
  return familyOf(t, voice, weight, typeof size === "number" ? size : 12);
}
