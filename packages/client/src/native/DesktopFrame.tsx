import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Animated, LogBox, Pressable, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

/**
 * The desktop's layout on a phone (decision 0015, ruling 1: "the exact same ui on mobile as there is on
 * desktop", as a migration step before a mobile pass). The universal shell is laid out once, at a
 * desktop's width and at the height that fills the frame when fitted, and shown at any zoom between:
 *
 * - **fit**: scaled down to the phone's width, the whole window at once;
 * - **1:1**: at its own size, a phone's worth of it.
 *
 * Pinch between the two, as a browser zooms a page; a two-finger drag pans while zoomed in. The button
 * in the corner jumps to either end. Both gestures are two-finger ones on purpose: a one-finger drag
 * belongs to what is under it — a scroller in the shell, or an island (Monaco scrolls itself; the
 * island harness found that conflict). `react-native-gesture-handler` decides it natively, so a pinch
 * that starts over a WebView or a scroller is the frame's, and the child's touch is cancelled.
 *
 * The shell never lays out again while zooming: the transform alone changes, from the top-left corner.
 */
const WIDTH = 1280;

/**
 * Gesture handler 2.x finds its detector's view with `findNodeHandle` on a class instance, which React
 * reports as an error under StrictMode (One's root is one) in a development build. Nothing is wrong with
 * the gesture; the report would cover the frame's corner. Gone in a release build.
 */
LogBox.ignoreLogs(["findNodeHandle is deprecated in StrictMode"]);
/** The largest zoom: the desktop's own size. */
const FULL = 1;

type View2 = { z: number; x: number; y: number };

export function DesktopFrame({ children }: { children: ReactNode }): JSX.Element {
  const window = useWindowDimensions();
  // The frame's own size (the safe area is off the window's), the window's until it is measured.
  const [frame, setFrame] = useState({ w: window.width, h: window.height });
  const fit = Math.min(FULL, frame.w / WIDTH);
  const height = frame.h / fit;

  // Where the shell stands: its zoom and its top-left corner in the frame. Held in refs and driven into
  // Animated values, so a gesture moves it without rendering anything.
  const at = useRef<View2>({ z: fit, x: 0, y: 0 });
  const anim = useMemo(() => ({ z: new Animated.Value(fit), x: new Animated.Value(0), y: new Animated.Value(0) }), []);
  const [zoomed, setZoomed] = useState(false);
  const bounds = useRef({ fit, w: frame.w, h: frame.h, height });
  bounds.current = { fit, w: frame.w, h: frame.h, height };

  /** Moves the shell to `next`, kept inside the frame: no empty space past an edge while there is more. */
  const place = (next: View2): void => {
    const b = bounds.current;
    const z = Math.min(FULL, Math.max(b.fit, next.z));
    const x = Math.min(0, Math.max(b.w - WIDTH * z, next.x));
    const y = Math.min(0, Math.max(b.h - b.height * z, next.y));
    at.current = { z, x, y };
    anim.z.setValue(z);
    anim.x.setValue(x);
    anim.y.setValue(y);
    const isZoomed = z > b.fit + 1e-3;
    setZoomed((was) => (was === isZoomed ? was : isZoomed));
  };
  // The phone turned, or the frame was measured: the fitted zoom moved with it, and a fitted shell stays
  // fitted.
  useEffect(() => {
    place(zoomed ? at.current : { z: fit, x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, height]);

  const gesture = useMemo(() => {
    // Each change is applied as it comes: a pinch scales about the point between the fingers, and the
    // fingers moving together pan.
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onChange((e) => {
        const now = at.current;
        const b = bounds.current;
        const z = Math.min(FULL, Math.max(b.fit, now.z * e.scaleChange));
        const r = z / now.z;
        place({ z, x: e.focalX - (e.focalX - now.x) * r, y: e.focalY - (e.focalY - now.y) * r });
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minPointers(2)
      .onChange((e) => place({ ...at.current, x: at.current.x + e.changeX, y: at.current.y + e.changeY }));
    return Gesture.Simultaneous(pinch, pan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>
        <View
          style={{ flex: 1, overflow: "hidden" }}
          onLayout={(e) => {
            const { width, height: h } = e.nativeEvent.layout;
            if (width > 0 && h > 0 && (width !== frame.w || h !== frame.h)) setFrame({ w: width, h });
          }}
        >
          <Animated.View
            style={{
              width: WIDTH,
              height,
              transformOrigin: "0 0",
              transform: [{ translateX: anim.x }, { translateY: anim.y }, { scale: anim.z }],
            }}
          >
            {children}
          </Animated.View>
        </View>
      </GestureDetector>
      <Pressable
        role="button"
        accessibilityLabel={zoomed ? "Fit to the screen" : "Show at full size"}
        onPress={() => place(zoomed ? { z: fit, x: 0, y: 0 } : { z: FULL, x: 0, y: 0 })}
        style={{ position: "absolute", right: 10, bottom: 10, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: "rgba(20, 22, 40, 0.72)" }}
      >
        <Text style={{ color: "#fff", fontSize: 12 }}>{zoomed ? "fit" : "1:1"}</Text>
      </Pressable>
    </GestureHandlerRootView>
  );
}
