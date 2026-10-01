/**
 * What Chromium does with an `<input list>`, as data — the rules of the type-ahead `Suggest.tsx` draws.
 * Handed a `<datalist>`, Blink filters it (`HTMLInputElement::FilteredDataListOptions`) and Electron draws
 * it in a popup window of its own (`shell/browser/ui/autofill_popup.cc`, `views/autofill_popup_view.cc`).
 * Every figure below was measured from that popup, photographed on Windows at 1.5×, light and dark.
 */

/** One `<option>`: its value, and its label where it says something else (`label`, or its text). */
export interface Suggestion {
  value: string;
  label?: string | undefined;
}

/** A `<datalist>`'s options from values and the labels some of them carry (the schema form's `suggestionsOf`). */
export function suggestionsFrom(values: readonly string[], labels: Readonly<Record<string, string>> = {}): Suggestion[] {
  return values.map((value) => ({ value, ...(labels[value] !== undefined ? { label: labels[value] } : {}) }));
}

/**
 * The options the popup lists for what is in the box: those whose value or label CONTAINS it, case
 * folded — not a prefix ("5" lists option-5, option-15, option-25). Nothing typed lists them all; an
 * empty value is no option. A label the same as its value is not drawn (Electron's `GetDataListSuggestions`).
 */
export function filterSuggestions(options: readonly Suggestion[], typed: string): Suggestion[] {
  const want = typed.replace(/\s+/g, " ").trim().toLowerCase();
  return options
    .filter((o) => o.value !== "" && (want === "" || o.value.toLowerCase().includes(want) || (o.label ?? "").toLowerCase().includes(want)))
    .map((o) => (o.label === undefined || o.label === o.value || o.label === "" ? { value: o.value } : o));
}

/**
 * The popup's geometry (`autofill_popup.cc`): a 1px border round rows 24 tall; a value 8 in from the
 * row's start; a label 15 after it, 8 short of the row's end. At least as wide as the box.
 */
export const SUGGEST = { border: 1, row: 24, end: 8, name: 15 } as const;

/**
 * The popup's colours: the OS's light or dark native theme, whatever the page's look — the page sets
 * no `color-scheme`, and the popup is a window of Electron's, not the page's (measured, Windows 11).
 */
export const SUGGEST_COLORS = {
  light: { ground: "#ffffff", selected: "#f2f2f2", border: "#dadce0", value: "#000000", label: "#646464" },
  dark: { ground: "#282828", selected: "#333333", border: "#3c4043", value: "#ffffff", label: "#949494" },
} as const;

/**
 * An accepted suggestion leaves the box autofilled (`input:-internal-autofill-selected`), until it is
 * edited: Chromium's #E8F0FE ground and FieldText, under every look (the page's scheme is light).
 */
export const AUTOFILLED = { ground: "#e8f0fe", text: "#000000" } as const;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the popup goes (Chromium's `CalculatePopupXAndWidth` / `CalculatePopupYAndHeight`, with the
 * window as the screen): from the box's start, growing right — left from its end where the right has
 * less room than the left and too little for it; under the box, or over it where below has too little
 * room and above has more. Capped to the room it has, and clipped there: it does not scroll.
 */
export function placeSuggestions(box: Rect, want: { width: number; height: number }, win: { width: number; height: number }): Rect {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const rightStart = clamp(box.left, 0, win.width);
  const leftEnd = clamp(box.left + box.width, 0, win.width);
  const rightRoom = win.width - rightStart;
  const leftRoom = leftEnd;
  const width = Math.min(want.width, Math.max(rightRoom, leftRoom));
  const left = width > rightRoom && rightRoom < leftRoom ? leftEnd - width : rightStart;
  const topEnd = clamp(box.top, 0, win.height);
  const bottomStart = clamp(box.top + box.height, 0, win.height);
  const above = topEnd;
  const below = win.height - bottomStart;
  if (below >= want.height || below >= above) return { left, top: bottomStart, width, height: Math.min(below, want.height) };
  const height = Math.min(above, want.height);
  return { left, top: topEnd - height, width, height };
}

/** Down: the next line, round to the first — the first from none (`AutofillPopupView::SelectNextLine`). */
export const nextLine = (at: number | null, count: number): number => (at === null || at + 1 >= count ? 0 : at + 1);
/** Up: the line before, round to the last — the last from none (`SelectPreviousLine`). */
export const previousLine = (at: number | null, count: number): number => ((at ?? 0) - 1 < 0 ? count - 1 : (at ?? 0) - 1);
