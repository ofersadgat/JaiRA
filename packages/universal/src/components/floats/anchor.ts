import { isWeb } from "@tamagui/core";
import type { FloatRect } from "@jaira/ui/floatPlace";

/**
 * The box a float is placed against: the element a press was on (`e.currentTarget`). A caller that was
 * handed nothing (its parent drops the event) finds it from the event being dispatched, by the control's
 * accessible name; on a phone there is no element to ask, and it is `null` — the caller places the float
 * by a rule of its own.
 */
export function anchorRectOf(from: unknown, label?: string): FloatRect | null {
  if (!isWeb) return null;
  const given = from as { getBoundingClientRect?: () => DOMRect } | null | undefined;
  let el: { getBoundingClientRect: () => DOMRect } | null = typeof given?.getBoundingClientRect === "function" ? (given as { getBoundingClientRect: () => DOMRect }) : null;
  if (el === null && label !== undefined) {
    // The press is being handled: the event it is handled in names the element it landed on.
    const target = (globalThis as { event?: { target?: unknown } }).event?.target as Element | undefined;
    el = typeof target?.closest === "function" ? target.closest(`[aria-label=${JSON.stringify(label)}]`) : null;
  }
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
