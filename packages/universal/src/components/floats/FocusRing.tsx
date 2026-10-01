import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { useTokens } from "../../tokens";

/**
 * The focus ring (2px --focus-ring, 1 outside the box, following its radius) round a control, for the
 * one a dialog focuses when it opens — its confirm, which Chromium rings when it is focused that way
 * although the dialog was opened with the mouse. On web the control inside is focused on mount
 * (`autoFocus`) and the ring drawn while focus is within it; a phone has no focus ring, and draws the
 * control alone.
 */
export function FocusRing({ radius, autoFocus = false, children }: { radius: number | string; autoFocus?: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const ref = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!isWeb || el === null || typeof el.addEventListener !== "function") return undefined;
    const into = (): void => setFocused(true);
    const out = (): void => setFocused(false);
    el.addEventListener("focusin", into);
    el.addEventListener("focusout", out);
    // The ring is this box's; the browser's own (`-webkit-focus-ring-color auto`) is taken off the
    // control inside.
    const control = el.querySelector<HTMLElement>("[tabindex], button, input, textarea");
    if (control !== null) control.style.outline = "none";
    if (autoFocus) control?.focus({ preventScroll: true });
    return () => {
      el.removeEventListener("focusin", into);
      el.removeEventListener("focusout", out);
    };
    // The control is focused once, when it is first drawn, as `autoFocus` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!isWeb) return <>{children}</>;
  return (
    <View
      ref={ref as never}
      borderRadius={radius as never}
      {...((focused ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: t.v("focus-ring"), outlineOffset: 1 } : {}) as object)}
    >
      {children}
    </View>
  );
}
