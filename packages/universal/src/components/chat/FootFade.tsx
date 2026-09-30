import type { JSX } from "react";
import { View } from "@tamagui/core";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/**
 * `.chat-foot::before`: the thread fading into the ground the box sits on, over its last 18. A phone
 * has no gradient ground, so the fade is drawn: the ground's colour from none of it to all of it.
 * `FootFade.web.tsx` is the stylesheet's gradient.
 */
export function FootFade({ color }: { color: string }): JSX.Element {
  return (
    <View position="absolute" left={0} right={0} top={-18} height={18} pointerEvents="none">
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="chat-foot-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="1" stopColor={color} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#chat-foot-fade)" />
      </Svg>
    </View>
  );
}
