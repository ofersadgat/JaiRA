import { useState, type JSX, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";

/**
 * The desktop-width frame in a BROWSER (the `/native` preview of the phone app): fit to the width, or
 * 1:1 and scrolled, switched by the button in the corner. The phone's (`DesktopFrame.tsx`) pinches between
 * the two with `react-native-gesture-handler`, which on web brings Reanimated's worklets with it — and
 * those touch `requestAnimationFrame` as they load, which breaks `one build` (it imports every route in
 * Node). A browser has its own zoom; the preview does not need a second one.
 */
const WIDTH = 1280;

export function DesktopFrame({ children }: { children: ReactNode }): JSX.Element {
  const screen = useWindowDimensions();
  const [fit, setFit] = useState(true);
  const scale = Math.min(1, screen.width / WIDTH);
  const content = fit ? (
    // Laid out at the desktop's width and at the height that fills the screen once scaled, then scaled
    // from the top-left corner into the phone's width.
    <View style={{ width: screen.width, flex: 1, overflow: "hidden" }}>
      <View
        style={{
          width: WIDTH,
          height: screen.height / scale,
          transform: [{ translateX: -(WIDTH * (1 - scale)) / 2 }, { translateY: -((screen.height / scale) * (1 - scale)) / 2 }, { scale }],
        }}
      >
        {children}
      </View>
    </View>
  ) : (
    <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ width: WIDTH }}>
      <View style={{ width: WIDTH, height: screen.height }}>{children}</View>
    </ScrollView>
  );
  return (
    <View style={{ flex: 1 }}>
      {content}
      <Pressable
        role="button"
        accessibilityLabel={fit ? "Show at full size" : "Fit to the screen"}
        onPress={() => setFit(!fit)}
        style={{ position: "absolute", right: 10, bottom: 10, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: "rgba(20, 22, 40, 0.72)" }}
      >
        <Text style={{ color: "#fff", fontSize: 12 }}>{fit ? "1:1" : "fit"}</Text>
      </Pressable>
    </View>
  );
}
