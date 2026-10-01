import { useMemo, useRef, type JSX, type ReactNode } from "react";
import { View, type View as HostView } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

/**
 * Picking something up on a phone (decision 0015): what HTML5 drag (`draggable`, `dragstart`,
 * `dragover`, `drop`) is on web, as React Native Gesture Handler's pan. The web's is `Lift.web.tsx`, which
 * draws its child and nothing else — there the thing held says `draggable` itself.
 *
 * A one-finger drag on a phone belongs to the scroller under it (and two fingers to the frame's zoom,
 * `DesktopFrame`), so a lift starts on a LONG PRESS: held still for {@link HOLD} ms, the pan activates,
 * Gesture Handler cancels the touch the pressable under it had (its own long press does not fire), and
 * from then on the finger carries it. Let go having moved and it lands where the finger is; let go
 * without moving and it was the long press after all (`onHold`, what the pressable's long press did).
 *
 * The points are the window's (`absoluteX`/`absoluteY`), which is what `measureInWindow` measures the
 * places it may land in against (`liftTargets.ts`).
 */
export const HOLD = 350;

/** How far the finger must travel before a lift is a drag rather than a long press held. */
const MOVED = 8;

export interface LiftProps {
  /** Whether it can be picked up at all. */
  enabled: boolean;
  /** Picked up: the view that was, and where the finger is. */
  onLift: (node: HostView | null, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  /** Let go after moving, at this point. */
  onLand: (x: number, y: number) => void;
  /** Let go without moving: the long press it stood in for, at this point. */
  onHold?: ((x: number, y: number) => void) | undefined;
  /** The lift ended some other way (a second finger, the system): nothing lands. */
  onCancel: () => void;
  children: ReactNode;
}

export function Lift(props: LiftProps): JSX.Element {
  const latest = useRef(props);
  latest.current = props;
  const node = useRef<HostView>(null);
  const moved = useRef(false);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(props.enabled)
        .maxPointers(1)
        .activateAfterLongPress(HOLD)
        .onStart((e) => {
          moved.current = false;
          latest.current.onLift(node.current, e.absoluteX, e.absoluteY);
        })
        .onUpdate((e) => {
          if (Math.hypot(e.translationX, e.translationY) > MOVED) moved.current = true;
          latest.current.onMove(e.absoluteX, e.absoluteY);
        })
        .onEnd((e, success) => {
          if (!success) return;
          if (moved.current) latest.current.onLand(e.absoluteX, e.absoluteY);
          else {
            latest.current.onCancel();
            latest.current.onHold?.(e.absoluteX, e.absoluteY);
          }
          moved.current = false;
        })
        .onFinalize((_e, success) => {
          if (!success) latest.current.onCancel();
        }),
    [props.enabled],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View ref={node} collapsable={false}>
        {props.children}
      </View>
    </GestureDetector>
  );
}
