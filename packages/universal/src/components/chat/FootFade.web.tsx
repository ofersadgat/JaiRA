import type { JSX } from "react";
import { View } from "@tamagui/core";

/** `.chat-foot::before` on web: `linear-gradient(to bottom, transparent, var(--bg))`, 18 over the thread. */
export function FootFade({ color }: { color: string }): JSX.Element {
  return <View position="absolute" left={0} right={0} top={-18} height={18} pointerEvents="none" {...({ backgroundImage: `linear-gradient(to bottom, transparent, ${color})` } as object)} />;
}
