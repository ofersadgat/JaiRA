import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { useConnectionLost } from "../../app/connection";

/**
 * The "Disconnected" line: the connection to the machine went away, said across the top of the window
 * over everything until the bridge is welcomed again (it tries by itself, with growing waits). How it
 * looks:
 *
 *   fixed across the top, z 1000; padding 6 12; --fill-accent (which every look sets), #fff; the app
 *   face at 12px whatever the size preference, 400, on a line of 16 (DM Sans's `normal` at 12: 12 + 4,
 *   Chromium rounding its ascent and descent apart)
 *
 * `staged` places it in its box rather than the window's (the specimens).
 */
export function Disconnected({ staged = false }: { staged?: boolean }): JSX.Element | null {
  const lost = useConnectionLost();
  return lost === null ? null : <DisconnectedLine lost={lost} staged={staged} />;
}

export function DisconnectedLine({ lost, staged = false }: { lost: string; staged?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      position={(isWeb && !staged ? "fixed" : "absolute") as never}
      top={0}
      left={0}
      right={0}
      zIndex={1000}
      paddingVertical={6}
      paddingHorizontal={12}
      backgroundColor={t.v("fill-accent") as never}
    >
      {/* Three text nodes, as the JSX writes them: Blink shapes each apart. */}
      <Txt spec={{ voice: "app", scale: 1, color: "#fff" }} fontSize={12} lineHeight={16}>
        {"Disconnected: "}
        {lost}
        {". Reconnecting…"}
      </Txt>
    </View>
  );
}
