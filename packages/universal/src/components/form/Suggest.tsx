import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { PixelRatio, Pressable, Text, useColorScheme, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { Svg } from "../panel/Svg";
import { PLACED_IN_WINDOW, SuggestLayer } from "./SuggestLayer";
import { AUTOFILLED, SUGGEST, SUGGEST_COLORS, filterSuggestions, nextLine, placeSuggestions, previousLine, type Rect, type Suggestion } from "./suggestModel";

export { SuggestLayer } from "./SuggestLayer";
export { AUTOFILLED } from "./suggestModel";
export type { Suggestion } from "./suggestModel";

/**
 * A box's `<datalist>`, universal (decision 0015): the type-ahead Chromium opens under an `<input list>`
 * on the desktop — there a popup WINDOW of Electron's (`autofill_popup_view.cc`), drawn in the OS's
 * light or dark theme whatever the page's look, which a capture of the page never shows; here a float
 * drawn to the same measure (`suggestModel.ts` has the figures, the filter and the placing).
 *
 * When it opens and what the keys do are Electron's (`electron_autofill_agent.cc`, `HandleKeyPressEvent`):
 *
 *   typing, the caret at the end   lists what contains the text (nothing typed: closes)
 *   ↓ / ↑ with the list shut       opens it on what is typed, nothing picked (the caret at the end)
 *   a press in the box it already had the focus of   opens it
 *   ↓ ↑                            the next / previous line, round the ends; PageUp / PageDown the first / last
 *   Enter, Tab                     takes the picked line (Enter goes on to the box when none is; Tab always
 *                                  moves on); Escape shuts it
 *   the pointer                    over a line picks it, off the list picks none; a click takes it
 *   leaving the box, scrolling, resizing   shuts it
 *
 * A line taken leaves the box autofilled (`AUTOFILLED`) until it is edited. The box keeps 16 at its end
 * for the list's indicator (a ▼ while hovered or focused, `ListIndicator`) as soon as the list has
 * anything in it.
 */
export interface SuggestBinding {
  /** The list has options: the box keeps its indicator's 16. */
  listed: boolean;
  /** A line was taken and the box not edited since: Chromium's autofilled look. */
  filled: boolean;
  /** For the box's `TextInput`. */
  ref: { current: unknown };
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** The box's key handler: true when the list took the key (the box's own Enter / Escape must not run). */
  onKeyPress: (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => boolean;
  /** Props for the `TextInput` itself (a press in a focused box opens the list). */
  input: Record<string, unknown>;
  /** The popup, for {@link SuggestLayer}'s `popup` (null while shut). */
  popup: JSX.Element | null;
}

/** The DOM input a react-native-web `TextInput` ref is, on web. */
const elementOf = (ref: { current: unknown }): HTMLInputElement | null => {
  const el = ref.current as HTMLInputElement | null;
  return isWeb && el !== null && typeof el.getBoundingClientRect === "function" ? el : null;
};
const caretAtEnd = (el: HTMLInputElement | null): boolean => el === null || (el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length);

/** The popup's faces: the default UI font (Segoe UI 9pt on Windows), bold for a value, a size smaller for a label. */
const VALUE_FONT = { size: 12, weight: "700" } as const;
const LABEL_FONT = { size: 11, weight: "400" } as const;
const FAMILY = isWeb ? "system-ui" : undefined;

/** A string's width in a face, as `gfx::GetStringWidth` rounds it (up, to a whole pixel). Web only. */
let canvas: { getContext: (k: "2d") => CanvasRenderingContext2D | null } | null = null;
function widthOf(text: string, face: { size: number; weight: string }): number {
  if (!isWeb || typeof document === "undefined") return 0;
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return 0;
  ctx.font = `${face.weight} ${face.size}px system-ui`;
  return Math.ceil(ctx.measureText(text).width);
}

/** The width the popup asks for: the box's, or its widest line's (`AutofillPopup::GetDesiredPopupWidth`). */
function wantedWidth(items: readonly Suggestion[], box: number): number {
  let width = box;
  for (const item of items) {
    let row = SUGGEST.end + 2 * SUGGEST.border + widthOf(item.value, VALUE_FONT) + (item.label !== undefined ? widthOf(item.label, LABEL_FONT) : 0);
    if (item.label !== undefined) row += SUGGEST.name + SUGGEST.end;
    width = Math.max(width, row);
  }
  return width;
}

export function useSuggest(options: readonly Suggestion[] | undefined, value: string, onChange: (next: string) => void, disabled = false): SuggestBinding {
  const ref = useRef<unknown>(null);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const win = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const listed = options !== undefined && options.length > 0;
  // What the list shows is filtered on what is in the box NOW, as Blink filters it each time it opens.
  const items = useMemo(() => (open && options !== undefined ? filterSuggestions(options, value) : []), [open, options, value]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = (): void => {
    setOpen(false);
    setAt(null);
  };
  const show = (text: string): void => {
    if (!listed || disabled || filterSuggestions(options ?? [], text).length === 0) return hide();
    const el = elementOf(ref);
    if (el !== null) {
      const r = el.getBoundingClientRect();
      setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    setOpen(true);
    setAt(null);
  };
  const accept = (i: number): void => {
    const item = items[i];
    if (item === undefined) return;
    onChange(item.value);
    setTaken(item.value);
    hide();
  };

  // The list closes when the page scrolls under it or the window changes size (the popup's widget does).
  useEffect(() => {
    if (!open || !isWeb || typeof window === "undefined") return undefined;
    const shut = (): void => hide();
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);
  // Nothing left to list closes it (the text typed matches nothing).
  useEffect(() => {
    if (open && items.length === 0) hide();
  }, [open, items.length]);
  useEffect(() => () => void (blurTimer.current !== null && clearTimeout(blurTimer.current)), []);

  const shown = open && items.length > 0;
  let popup: JSX.Element | null = null;
  if (shown) {
    const height = 2 * SUGGEST.border + items.length * SUGGEST.row;
    const place = PLACED_IN_WINDOW && box !== null ? placeSuggestions(box, { width: wantedWidth(items, box.width), height }, win) : null;
    popup = (
      <SuggestList
        items={items}
        at={at}
        scheme={scheme}
        place={place}
        onHover={setAt}
        onAccept={accept}
      />
    );
  }

  return {
    listed,
    filled: taken !== null && taken === value,
    ref,
    onChangeText: (text) => {
      setTaken(null);
      if (text !== "" && caretAtEnd(elementOf(ref))) show(text);
      else hide();
    },
    onFocus: () => {
      if (blurTimer.current !== null) clearTimeout(blurTimer.current);
      hide();
    },
    onBlur: () => {
      // On a phone a press on a line comes after the box has lost the focus: let it land first.
      if (isWeb) hide();
      else blurTimer.current = setTimeout(hide, 150);
    },
    onKeyPress: (e) => {
      const key = e.nativeEvent.key;
      const take = (): void => e.preventDefault?.();
      if (!shown) {
        if ((key === "ArrowDown" || key === "ArrowUp") && caretAtEnd(elementOf(ref))) show(value);
        return false;
      }
      const count = items.length;
      switch (key) {
        case "ArrowDown":
          take();
          setAt(nextLine(at, count));
          return true;
        case "ArrowUp":
          take();
          setAt(previousLine(at, count));
          return true;
        case "PageUp":
          take();
          setAt(0);
          return true;
        case "PageDown":
          take();
          setAt(count - 1);
          return true;
        case "Escape":
          take();
          hide();
          return true;
        case "Tab":
          if (at !== null) accept(at);
          return false;
        case "Enter":
          if (at === null) return false;
          take();
          accept(at);
          return true;
        default:
          return false;
      }
    },
    input: isWeb
      ? {
          onMouseDown: () => {
            // A press in the box that already had the focus (`DoFocusChangeComplete`), before the caret moves.
            const el = elementOf(ref);
            if (el !== null && typeof document !== "undefined" && document.activeElement === el) show(value);
          },
        }
      : {
          onPressIn: () => {
            const input = ref.current as { isFocused?: () => boolean } | null;
            if (input?.isFocused?.() === true) show(value);
          },
        },
    popup,
  };
}

/**
 * The popup (`AutofillPopupView`): a 1px border, rows 24 tall on the theme's ground (the picked one
 * `selected`), the value bold 8 in, a label a size smaller 8 short of the end. Placed in the window on
 * web and clipped to the room it has (it never scrolls); hung from the box on a phone.
 */
function SuggestList({
  items,
  at,
  scheme,
  place,
  onHover,
  onAccept,
}: {
  items: readonly Suggestion[];
  at: number | null;
  scheme: "light" | "dark";
  place: Rect | null;
  onHover: (i: number | null) => void;
  onAccept: (i: number) => void;
}): JSX.Element {
  const c = SUGGEST_COLORS[scheme];
  const one = { whiteSpace: "nowrap" } as object;
  // Views paints its 1 DIP border in whole device pixels rounded UP (two at 1.5×), over rows that start 1
  // DIP in: the rows sit in 1 of padding, and the border is drawn over their edges.
  const ring = Math.ceil(SUGGEST.border * PixelRatio.get()) / PixelRatio.get();
  return (
    <View
      {...(place !== null ? { position: "absolute", left: place.left, top: place.top, width: place.width, height: place.height } : { minWidth: "100%" })}
      overflow="hidden"
      padding={SUGGEST.border}
      backgroundColor={c.ground}
      {...((isWeb
        ? {
            // The box keeps the focus: a press on the popup is not a press on the page.
            onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
            onMouseLeave: () => onHover(null),
            cursor: "default",
          }
        : {}) as object)}
    >
      {items.map((item, i) => (
        <Pressable
          key={`${i}:${item.value}`}
          onPress={() => onAccept(i)}
          {...((isWeb ? { onMouseMove: () => i !== at && onHover(i), focusable: false, tabIndex: -1 } : {}) as object)}
          style={{
            height: SUGGEST.row,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: SUGGEST.end,
            paddingRight: item.label !== undefined ? SUGGEST.end : 0,
            backgroundColor: i === at ? c.selected : c.ground,
            ...(isWeb ? ({ cursor: "default" } as object) : {}),
          }}
        >
          <Text numberOfLines={1} style={{ fontFamily: FAMILY, fontSize: VALUE_FONT.size, fontWeight: VALUE_FONT.weight, lineHeight: SUGGEST.row, color: c.value, flexShrink: 0, ...one }}>
            {item.value}
          </Text>
          {item.label !== undefined ? (
            // Placed by its width as `gfx` rounds it (up), so it starts where Views starts it.
            <Text
              numberOfLines={1}
              style={{
                fontFamily: FAMILY,
                fontSize: LABEL_FONT.size,
                fontWeight: LABEL_FONT.weight,
                lineHeight: SUGGEST.row,
                color: c.label,
                marginLeft: "auto",
                paddingLeft: SUGGEST.name,
                flexShrink: 0,
                ...(isWeb ? { width: SUGGEST.name + widthOf(item.label, LABEL_FONT), textAlign: "left" } : {}),
                ...one,
              }}
            >
              {item.label}
            </Text>
          ) : null}
        </Pressable>
      ))}
      <View position="absolute" top={0} left={0} right={0} bottom={0} borderWidth={ring} borderStyle="solid" borderColor={c.border} pointerEvents="none" />
    </View>
  );
}

/**
 * The list's indicator, `::-webkit-calendar-picker-indicator` of an `<input list>`: a ▼ in the box's
 * text colour, drawn while the box is hovered or focused (and not disabled), centred in the 16 Chromium
 * keeps at the end of the content box, and hanging from just above its middle. Measured at a 12px face:
 * 8⅔ wide, 8 tall, its top ½ above the box's middle — scaled with the face. `end` is from the box's
 * outer edge to its content box's: its border as laid out ({@link laidOut}) and its padding.
 */
export function ListIndicator({ color, size, end }: { color: string; size: number; end: number }): JSX.Element {
  const k = size / 12;
  const w = 8.667 * k;
  const h = 8 * k;
  return (
    <View position="absolute" right={end + 8 - w / 2} top="50%" marginTop={-0.5 * k} width={w} height={h} pointerEvents="none">
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} color={color} strokeWidth={0} shapes={[{ kind: "path", d: `M0 0H${w}L${w / 2} ${h}Z`, fill: color, stroke: "none" }]} />
    </View>
  );
}

/** A border as Chromium lays it out: in whole device pixels, at least one (1px is 0.667 at 1.5×). */
export const laidOut = (width = 1): number => Math.max(1, Math.floor(width * PixelRatio.get())) / PixelRatio.get();
