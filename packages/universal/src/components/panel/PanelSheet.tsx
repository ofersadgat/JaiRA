import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Animated, Keyboard, PanResponder, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { dragHeight, settleSheet, sheetHeights, type SheetDetent, type SheetHeights } from "@jaira/ui/phoneModel";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { focusedInputTop, useKeyboardShown } from "../floats/keyboard";

/**
 * A phone's context panel (decision 0015, amended 2026-10-04): the panel (`SidePanel`) in a sheet over
 * the room, at one of three heights — its head alone (`peek`), half the room, or all of it but a strip
 * (`full`). Where a drag lets it go is `phoneModel.ts`' `settleSheet`:
 *
 * - dragged by its handle or its head (the body scrolls as its own), it follows the finger and settles at
 *   the nearest height, or one on when flicked;
 * - dragged past full, it moves the conversation into the main view (`onMain`: the panel's own "Show this
 *   conversation in the main view"), and comes back down to its head;
 * - dragged down past its head, it closes (`onClose`).
 *
 * It opens at its head; `ask` raises it (the Inbox opens a task with its question showing). Typing into
 * a box inside it raises it to full while the keyboard is up, with a Done along the keyboard's edge, and
 * puts it back after. How it looks:
 *
 *   the sheet      --panel, a --line on top, radius 14 14 0 0, a shadow up; its height eased (a spring)
 *   the handle     22 tall, centred: 38 × 5, radius 3, --rule
 *   the cover      at full, --scrim over the room above it at 0.6; a press on it puts the sheet at half
 *   Done           while typing: a bar 44 tall at the sheet's foot, --panel-2, a --line on top; Done app
 *                  14/12.5, 600, --accent, at its right
 */
export function PanelSheet({
  children,
  ask,
  onMain,
  onClose,
}: {
  children: ReactNode;
  /** A height asked for, stamped so the same one twice means "again". */
  ask?: { detent: SheetDetent; at: number } | null | undefined;
  /** Into the main view, where the entry has one. */
  onMain?: (() => void) | undefined;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const [room, setRoom] = useState(0);
  const heights = useMemo(() => sheetHeights(room, PEEK), [room]);
  // An ask made just now (the Inbox opened this task) is the height it opens at; an old one is not.
  const fresh = ask != null && Date.now() - ask.at < 3000;
  const [detent, setDetent] = useState<SheetDetent>(fresh ? ask.detent : "peek");
  const height = useRef(new Animated.Value(0)).current;
  // What the responder reads, which it was made once with.
  const live = useRef({ heights, detent, onMain, onClose });
  live.current = { heights, detent, onMain, onClose };

  const animateTo = (to: number, done?: () => void): void => {
    Animated.spring(height, { toValue: to, useNativeDriver: false, bounciness: 0, speed: 16 }).start(({ finished }) => {
      if (finished) done?.();
    });
  };
  const goTo = (next: SheetDetent): void => {
    setDetent(next);
    animateTo(live.current.heights[next]);
  };
  // The room was measured or turned: the sheet keeps its height by name.
  useEffect(() => {
    if (room > 0) animateTo(heights[detent]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heights.peek, heights.half, heights.full]);
  // A height asked for.
  useEffect(() => {
    if (ask != null && fresh && room > 0) goTo(ask.detent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.at]);

  // Typing into the sheet: full while the keyboard is up, then back where it was — with a Done on the
  // keyboard's edge, since a box of many lines has no key that puts the keyboard away.
  const sheet = useRef<RNView>(null);
  const before = useRef<SheetDetent | null>(null);
  const [typing, setTyping] = useState(false);
  const keyboard = useKeyboardShown();
  useEffect(() => {
    if (!keyboard) {
      if (before.current !== null) goTo(before.current);
      before.current = null;
      setTyping(false);
      return;
    }
    focusedInputTop((top) => {
      if (top === null) return;
      sheet.current?.measureInWindow((_x, y) => {
        if (top < y) return;
        setTyping(true);
        if (live.current.detent === "full") return;
        before.current = live.current.detent;
        goTo("full");
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard]);

  const responder = useMemo(() => {
    let start = 0;
    const at = (dy: number): number => dragHeight(start, dy, live.current.heights, live.current.onMain !== undefined);
    return PanResponder.create({
      // A press is the head's own (its buttons, its crumbs); a vertical drag is the sheet's.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
      onPanResponderGrant: () => {
        height.stopAnimation((v) => {
          start = v;
        });
      },
      onPanResponderMove: (_e, g) => height.setValue(at(g.dy)),
      onPanResponderRelease: (_e, g) => {
        const { heights: h, onMain: main, onClose: close } = live.current;
        const settled = settleSheet(at(g.dy), g.vy, h, main !== undefined);
        if (settled === "main") {
          main?.();
          return goTo("peek");
        }
        if (settled === "close") return animateTo(0, close);
        goTo(settled);
      },
      onPanResponderTerminate: () => goTo(live.current.detent),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cover = height.interpolate({ inputRange: [0, Math.max(1, heights.half), Math.max(2, heights.full)], outputRange: [0, 0, 0.6], extrapolate: "clamp" });
  return (
    <RNView pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }} onLayout={(e) => setRoom(e.nativeEvent.layout.height)}>
      {detent === "full" ? (
        <Animated.View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: cover }}>
          <Press onPress={() => goTo("half")} label="Lower the panel" position="absolute" top={0} left={0} right={0} bottom={0} box={() => ({ backgroundColor: t.v("scrim") })} />
        </Animated.View>
      ) : null}
      <Animated.View
        ref={sheet as never}
        {...responder.panHandlers}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height,
          overflow: "hidden",
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          backgroundColor: t.v("panel") as string,
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: -4 },
          elevation: 16,
          ...(isWeb ? { boxShadow: "0 -6px 22px rgba(18, 21, 48, 0.16)" } : {}),
        }}
      >
        <View flexShrink={0} height={HANDLE} alignItems="center" justifyContent="center" {...({ "aria-label": "Drag the panel" } as object)} {...(edge(t, { top: 1 }) as object)} borderTopLeftRadius={14} borderTopRightRadius={14}>
          <View width={38} height={5} borderRadius={3} backgroundColor={t.v("rule") as never} />
        </View>
        <View flex={1} minHeight={0}>
          {children}
        </View>
        {typing ? (
          <View flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" height={44} paddingHorizontal={8} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1 }) as object)}>
            <Press onPress={() => Keyboard.dismiss()} label="Done typing" height={44} paddingHorizontal={12} justifyContent="center">
              <Txt spec={{ voice: "app", scale: 14 / 12.5, weight: 600, color: "accent" }}>Done</Txt>
            </Press>
          </View>
        ) : null}
      </Animated.View>
    </RNView>
  );
}

/** The handle's height. */
const HANDLE = 22;
/** The sheet at its head: the handle and the panel's head (44 at least, two lines of title at a phone's size). */
const PEEK = HANDLE + 60;

export type { SheetHeights };
