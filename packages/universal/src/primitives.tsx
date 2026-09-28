import { useState, type JSX, type ReactNode } from "react";
import { Platform, Pressable, type GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { useTokens, type Tokens } from "./tokens";

/**
 * What every copy stands on (decision 0015): the things `styles.css` does once for the whole page and a
 * copy has to do for itself, written once here instead of in every copy.
 *
 * - **Type.** On the desktop's page a word inherits its font from `body` and its register's class. On
 *   native nothing inherits into a `Text` from a `View`, so every `Text` states its whole font:
 *   {@link font} builds it, and {@link REGISTERS} are `styles.css`'s ten registers (SHELL.md §3.3).
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
  /** Letter spacing in em, as the stylesheet writes it. */
  ls?: number;
  upper?: boolean;
  /** A colour token name (`dim`) or a colour. */
  color?: string;
  /** Line height: a factor of the size (the body's 1.5 when absent), or `{ px }`. */
  lineHeight?: number | { px: number };
  tabular?: boolean;
}

/**
 * A `Text`'s whole font, from a spec: family, size, weight, spacing, case, colour and line height — what
 * a DOM word inherits and a native one must be told.
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
    // Replayed, sizes are numbers and so must spacing and line height be; on the desktop's page they
    // stay relative, as the stylesheet writes them, so a size preference moves them with the text.
    ...(spec.ls !== undefined ? { letterSpacing: px !== undefined ? spec.ls * px : `${spec.ls}em` } : {}),
    ...(spec.upper === true ? { textTransform: "uppercase" } : {}),
    lineHeight: typeof lh === "object" ? (px !== undefined ? lh.px : `${lh.px}px`) : px !== undefined ? lh * px : String(lh),
    ...(spec.tabular === true ? (isWeb ? { fontVariant: "tabular-nums" } : { fontVariant: ["tabular-nums"] }) : {}),
    color,
  };
}

/**
 * The family, as each platform names it. On web the stack (`var(--font-app)`, or the replayed stack
 * the `/rn` page registers with `@font-face`). On native a single family: the bundled face cut at the
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

/** `styles.css`'s ten registers (SHELL.md §3.3), as font specs. Data never takes a transform. */
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
 * A run of text in a register (or a spec), with overrides. `ellip` is the stylesheet's `.ellip`: one
 * line, cut with an ellipsis.
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
  const base: FontSpec = { ...(register !== undefined ? REGISTERS[register] : { voice: "app", scale: 1 }), ...spec } as FontSpec;
  return (
    // Left unless told otherwise: on web a Pressable is a <button>, which centres the text inside it.
    <Text {...(font(t, base) as object)} textAlign="left" {...(ellip ? { numberOfLines: 1, ellipsizeMode: "tail" } : {})} {...(rest as object)}>
      {children}
    </Text>
  );
}

/** A glyph set in the app voice at a size, centred in a fixed width (the sidebar's `.side-glyph`). */
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
 * Something that can be pressed: React Native's `Pressable` around a Tamagui box. The box's props may be
 * a function of the press state, for the stylesheet's `:hover` (web only; a phone has no pointer).
 * Props that size and place it go on the `Pressable`; the box fills it.
 */
export function Press({
  onPress,
  onLongPress,
  disabled,
  label,
  title,
  children,
  box,
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
} & Record<string, unknown>): JSX.Element {
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) (OUTER.has(k) ? outer : inner)[k] = v;
  return (
    <Pressable
      {...(onPress !== undefined ? { onPress } : {})}
      {...(onLongPress !== undefined ? { onLongPress } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      role="button"
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      style={{ ...(outer as object), ...(isWeb ? { cursor: disabled === true ? "default" : "pointer" } : {}) } as never}
    >
      {(s: { hovered?: boolean; pressed: boolean }) => {
        const state = { hovered: s.hovered === true, pressed: s.pressed };
        return (
          // The tooltip on the box: react-native-web's Pressable drops a `title`, and Tamagui hands one to the element.
          <View flexGrow={1} flexShrink={1} {...((isWeb && title !== undefined ? { title } : {}) as object)} {...(inner as object)} {...((box?.(state) ?? {}) as object)}>
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
 * A border on some sides only, as the stylesheet writes `border-bottom: 1px solid var(--line)`. Every
 * side's width is stated: on web Tamagui leaves the rest at the browser's `medium` (3px) once a style is
 * set, which drew a frame around boxes that have one rule.
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
 * `styles.css`'s ONE scrollbar (`::-webkit-scrollbar`: a 10px gutter, a rounded thumb inset 2px, drawn
 * from `--text` at 16%, 26% over the box that scrolls, 40% under the pointer, 50% held), for a copy's
 * `ScrollView` on web. A pseudo-element has no inline style, so the rules are written once per colour
 * into a `<style>` of their own and the box is pointed at them by `data-scrollbar`. Only scrollbar
 * rules: nothing else on the `/rn` page comes from a stylesheet. Native draws its own overlay
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
 * A length token as a number where the replayed cascade has one (`--control-radius` → 7), or the
 * variable itself on the desktop's page, which resolves it (`var(--control-radius, 7px)`).
 */
export function lengthToken(t: Tokens, name: string, fallback: number): number | string {
  if (!t.replayed) return `var(--${name}, ${fallback}px)`;
  const v = t.v(name);
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A two-length padding token (`--control-pad: 3px 10px`) as `[vertical, horizontal]` numbers. A
 * padding cannot be a `var()` on native, so the desktop's page takes the stylesheet's own values.
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
 * draws text greyscale instead of the subpixel text the DOM's own `overflow: auto` boxes get: every
 * glyph an anti-aliasing pair apart. Native keeps its own.
 */
export const PLAIN_SCROLLER: Record<string, unknown> = isWeb ? { transform: "none", zIndex: "auto", position: "static" } : {};

/** Chromium's own placeholder colour (`::placeholder`, which `styles.css` leaves alone): #757575, or #a9a9a9 in a dark scheme. */
export const placeholderColor = (scheme: "light" | "dark"): string => (scheme === "dark" ? "#a9a9a9" : "#757575");

/**
 * A length the stylesheet writes in `ch` of the app voice (DM Sans), at a scale of `--size-app`: `n` widths
 * of its `0`. The `0` widens with the optical size, which Chromium sets to the font size — measured on the
 * desktop's page at 0.662 of the size at 10px, 0.667 at 11px and 0.6784 at 13px, and read between and
 * beyond those as lines through them. On the desktop's page (not replayed) it is the stylesheet's `ch`.
 */
export function appCh(t: Tokens, scale: number, n: number): number | string {
  const size = t.scaled("size-app", scale);
  if (typeof size !== "number") return `calc(${n}ch)`;
  const zero = size <= 11 ? 0.662 + 0.005 * (size - 10) : 0.667 + 0.0057 * (size - 11);
  return n * size * zero;
}
