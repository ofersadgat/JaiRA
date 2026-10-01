import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pressable, View } from "react-native";
import { NO_DRAG } from "../primitives";

/**
 * `no-drag`, for whatever a layer holds: the desktop's drag strips are hit-tested by the OS, so a press
 * on a float lying over one would move the window and never reach the page. The property inherits, and
 * this box has none of its own (`display: contents`): each float punches its own shape out of the strip,
 * and the rest of the strip still moves the window.
 */
export const FLOATS: Record<string, unknown> = { display: "contents", ...NO_DRAG };

/**
 * The layers that are open, oldest first. Escape closes the one on TOP and no other: a menu opened from
 * a card closes, and the card stays.
 */
const OPEN: { close: () => void }[] = [];

/** Whether a key was typed into a text box, whose own handler has the first say over it. */
const typedInBox = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
};

/**
 * Escape, for the layer on top. Heard as the event goes DOWN to its target: react-native-web's text boxes
 * stop a key from bubbling past them, so a listener on the window's way up never heard Escape while one
 * had the focus (a right-click menu opened over the composer, a card with a box in it). A key typed into
 * a box is its box's first (the composer's `@` list, a suggestion list): the layer closes after the box
 * has had it, unless the box took it.
 */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const top = OPEN[OPEN.length - 1];
  if (top === undefined) return;
  if (!typedInBox(event.target)) return top.close();
  setTimeout(() => {
    if (!event.defaultPrevented && OPEN[OPEN.length - 1] === top) top.close();
  }, 0);
}

/**
 * The web half of `MenuLayer.tsx`: a fixed layer in `<body>`, out of every stacking context and
 * `overflow` round the row it was opened from. Closed by a press outside the menu, Escape, or the window
 * resizing.
 */
export function MenuLayer({ onClose, z = 1000, children }: {
  onClose: () => void;
  /** Its place in the stack: a menu's over everything, a dialog's (`--z-modal` 50) under the toast (`--z-toast` 60). */
  z?: number;
  children: ReactNode;
}): JSX.Element {
  // The latest `onClose`, for an entry made once: a host that hands a new function each render must not
  // move its layer to the top of the stack by doing so.
  const live = useRef(onClose);
  live.current = onClose;
  useEffect(() => {
    const entry = { close: (): void => live.current() };
    if (OPEN.length === 0) window.addEventListener("keydown", onEscape, true);
    OPEN.push(entry);
    return () => {
      OPEN.splice(OPEN.indexOf(entry), 1);
      if (OPEN.length === 0) window.removeEventListener("keydown", onEscape, true);
    };
  }, []);
  useEffect(() => {
    window.addEventListener("resize", onClose);
    return () => window.removeEventListener("resize", onClose);
  }, [onClose]);
  return createPortal(
    <View style={{ position: "fixed" as never, top: 0, left: 0, right: 0, bottom: 0, zIndex: z }}>
      {/* Out of the Tab order: a menu is closed by a press anywhere else, which is no control at all. */}
      <Pressable tabIndex={-1} onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, cursor: "default" as never }} accessibilityLabel="close the menu" />
      <View style={FLOATS as never}>{children}</View>
    </View>,
    document.body,
  );
}
