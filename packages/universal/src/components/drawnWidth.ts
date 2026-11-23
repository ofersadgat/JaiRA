import { useCallback, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { isWeb } from "@tamagui/core";

/**
 * How wide a box is drawn, and the props that tell it: spread them on the box (a Tamagui `View`).
 *
 * On a phone that is `onLayout`. On web it is a `ResizeObserver` on the box, through a callback `ref`:
 * Tamagui's `onLayout` there is a POLL — about every tenth frame it observes every element that has
 * one, and its parent, for as long as it is mounted — and a long conversation's many small boxes kept
 * the window busy while nothing moved (2026-11-22). A `ResizeObserver` says only when the size changes.
 * It says nothing of where the box stands: use `onLayout` for a position.
 */
export function useDrawnWidth(): [number | undefined, Record<string, unknown>] {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const watching = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: unknown) => {
    watching.current?.disconnect();
    watching.current = null;
    if (!(el instanceof HTMLElement)) return;
    // The border box, as `onLayout`'s width is: a padded box is as wide as it is drawn.
    const read = (): void => setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      read();
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(el);
    watching.current = observer;
  }, []);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  return [width, isWeb ? { ref } : { onLayout }];
}
