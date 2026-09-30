import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `App.tsx`'s toast, universal (decision 0015): the store's error — or, with none, its notice — at the
 * foot of the window, gone when pressed. The rules, from `styles.css`:
 *
 *   .toast             fixed, 52 above the window's foot, left 50% and translated back by half its own
 *                      width — so it is as wide as its words up to HALF the window (what a box placed
 *                      at 50% has left), before its `max-width: 70vw` could bite; --bad, #fff, 600,
 *                      padding 8 14, radius 8, the body's font (13/12.5 on 1.5); z --z-toast (60)
 *   .toast.toast-info  --panel, --text (its --line border-color has no border to colour)
 *
 * Fixed on web; on a phone over the frame it is mounted in. `staged` places it in its box instead (the
 * specimens).
 */
export function Toast({ error, notice, onDismissError, onDismissNotice, staged = false }: { error: string | null; notice: string | null; onDismissError: () => void; onDismissNotice: () => void; staged?: boolean }): JSX.Element | null {
  const t = useTokens();
  const words = error ? error : notice ? notice : null;
  if (words === null) return null;
  const info = !error;
  const box = (
    <Press onPress={info ? onDismissNotice : onDismissError} paddingVertical={8} paddingHorizontal={14} borderRadius={8} backgroundColor={t.v(info ? "panel" : "bad") as never}>
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, color: info ? "text" : "#fff" }}>{words}</Txt>
    </Press>
  );
  // On web placed as the DOM places it — at 50%, translated back — so it lands on the same fraction of a
  // pixel. On a phone a layer across the frame centres it, as wide as its words up to half the frame.
  if (isWeb) {
    return (
      <View position={(staged ? "absolute" : "fixed") as never} left="50%" bottom={52} zIndex={60} maxWidth="70vw" {...({ transform: [{ translateX: "-50%" }] } as object)}>
        {box}
      </View>
    );
  }
  return (
    <View position="absolute" left={0} right={0} bottom={52} zIndex={60} alignItems="center" pointerEvents="box-none">
      <View maxWidth="50%">{box}</View>
    </View>
  );
}
