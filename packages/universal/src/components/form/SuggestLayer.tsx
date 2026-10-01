import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import type { View as HostView } from "react-native";
import { View } from "@tamagui/core";

/**
 * Where a box's suggestions are drawn on a phone. There is no layer over everything that leaves the
 * keyboard up (a `Modal` would take the focus from the box), so the shell keeps one of its own
 * ({@link SuggestHost}, mounted with its floats): a box over the whole frame that takes a touch only
 * where the list is, and the list is placed in it under the box, by where the window says the box is.
 * Hung from the box itself, as it first was, the list was drawn but could not be pressed — Android gives
 * a child no touch outside its parent's bounds — and a scroller round the box cut it off.
 *
 * Where no host is mounted (a screen outside the shell) the list still hangs from the box. The box is
 * wrapped either way, taking the layout it was given (`layout`). The web half (`SuggestLayer.web.tsx`)
 * portals the popup into `<body>` instead.
 */
type Shown = { owner: object; popup: ReactNode; x: number; y: number; width: number; height: number };

const listeners = new Set<() => void>();
let shown: Shown | null = null;
let hosts = 0;
const tell = (): void => listeners.forEach((on) => on());
const subscribe = (on: () => void): (() => void) => {
  listeners.add(on);
  return () => listeners.delete(on);
};

export function SuggestLayer({ box, popup, layout }: { box: ReactNode; popup: ReactNode | null; layout?: Record<string, unknown> }): JSX.Element {
  const ref = useRef<HostView>(null);
  const owner = useRef({}).current;
  const hosted = useSyncExternalStore(subscribe, () => hosts > 0, () => false);
  // After every draw: the popup is a new element each time (its lines, the one picked).
  useEffect(() => {
    if (!hosted) return;
    if (popup === null) {
      if (shown?.owner === owner) {
        shown = null;
        tell();
      }
      return;
    }
    ref.current?.measureInWindow((x, y, width, height) => {
      shown = { owner, popup, x, y, width, height };
      tell();
    });
  });
  useEffect(
    () => () => {
      if (shown?.owner !== owner) return;
      shown = null;
      tell();
    },
    [owner],
  );
  return (
    // Never flattened away (`collapsable`): a view with nothing to draw is, until it is given a `zIndex` —
    // and Android then makes it and moves the box into it, which takes the focus from the box. The list
    // opened on the first letter and the box was left in the same breath, so the list shut again.
    <View ref={ref as never} collapsable={false} position="relative" width="100%" minWidth={0} {...(popup !== null && !hosted ? { zIndex: 1000 } : {})} {...(layout as object)}>
      {box}
      {popup === null || hosted ? null : (
        <View position="absolute" top="100%" left={0} minWidth="100%" zIndex={1000} {...({ elevation: 4 } as object)}>
          {popup}
        </View>
      )}
    </View>
  );
}

/**
 * The shell's layer for a box's suggestions (`ShellFloats`): over the frame, taking no touch but the
 * list's. The box's place is the window's; the frame may be drawn at another scale than the window's (a
 * phone shows the desktop's layout fitted), so the layer's own box as the window measures it, over its
 * width as laid out, says where the window's points fall in it.
 */
export function SuggestHost(): JSX.Element {
  const at = useSyncExternalStore(subscribe, () => shown, () => null);
  const ref = useRef<HostView>(null);
  const laid = useRef(0);
  const [origin, setOrigin] = useState<{ x: number; y: number; scale: number } | null>(null);
  useEffect(() => {
    hosts += 1;
    tell();
    return () => {
      hosts -= 1;
      tell();
    };
  }, []);
  useEffect(() => {
    if (at === null) return;
    ref.current?.measureInWindow((x, y, width) => setOrigin({ x, y, scale: laid.current > 0 && width > 0 ? width / laid.current : 1 }));
  }, [at]);
  return (
    <View ref={ref as never} collapsable={false} position="absolute" top={0} left={0} right={0} bottom={0} zIndex={1000} pointerEvents="box-none" onLayout={(e: { nativeEvent: { layout: { width: number } } }) => (laid.current = e.nativeEvent.layout.width)}>
      {at === null || origin === null ? null : (
        <View position="absolute" left={(at.x - origin.x) / origin.scale} top={(at.y + at.height - origin.y) / origin.scale} alignItems="flex-start" {...({ elevation: 4 } as object)}>
          {/* As wide as the box at least, and as its widest line (the list stretches to this, not to the layer). */}
          <View minWidth={at.width / origin.scale}>{at.popup}</View>
        </View>
      )}
    </View>
  );
}

/** On a phone the popup hangs under the box, and is not placed in the window by its own arithmetic. */
export const PLACED_IN_WINDOW = false;
