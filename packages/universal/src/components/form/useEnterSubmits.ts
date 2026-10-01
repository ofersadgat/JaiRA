import { useEffect, useRef, type RefObject } from "react";
import { isWeb } from "@tamagui/core";

/**
 * A `<form onSubmit>`'s implicit submission, for a form that is a column of boxes and a button: Enter in
 * a single-line box submits, as it does in a real `<form>` (a text area takes Enter as a line, a button
 * as its own press). The ref goes on the box that stands for the `<form>`.
 *
 * Listened for on the element itself: react-native-web's text boxes stop a key from reaching a React
 * handler above them. A box whose own handler took the Enter (a suggestion list accepting its line) has
 * prevented the default by the time this looks, and nothing is submitted. Web only: a phone's return key
 * moves on, and its form is submitted by its button.
 */
export function useEnterSubmits(onSubmit: () => void): RefObject<unknown> {
  const form = useRef<unknown>(null);
  const live = useRef(onSubmit);
  live.current = onSubmit;
  useEffect(() => {
    const el = form.current as HTMLElement | null;
    if (!isWeb || el === null || typeof el.addEventListener !== "function") return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const box = event.target as HTMLInputElement | null;
      if (event.key !== "Enter" || event.isComposing || box === null || box.tagName !== "INPUT" || !TEXT_BOXES.has(box.type)) return;
      // After the box's own handler, which React runs once the key has bubbled to the root.
      setTimeout(() => {
        if (!event.defaultPrevented) live.current();
      }, 0);
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);
  return form;
}

/** The inputs HTML submits a form from on Enter (not a checkbox, a radio or a file box). */
const TEXT_BOXES: ReadonlySet<string> = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
