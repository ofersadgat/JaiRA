import { useState, type JSX } from "react";
import { lengthToken } from "../../primitives";
import { useLook, useTokens } from "../../tokens";

/**
 * `input[type="range"]` on web: the element itself, under the page's global `input` rule (`font:
 * inherit`, --text on --bg, 1px --line — hovered --rule — radius --control-radius, padding 5 9), its
 * host's width, and the root's `color-scheme`. Chromium draws the track and the thumb, on `/rn` as on
 * `/`, so the copy is the DOM's by construction; `/rn` has no stylesheet, so the rule (and the global
 * `border-box`) is written out here.
 * A phone's is `Range.tsx`.
 */
export function Range({ min = 0, max = 1, step = 0.01, value, onChange, label, width }: { min?: number; max?: number; step?: number; value: number; onChange: (next: number) => void; label?: string; width?: number }): JSX.Element {
  const t = useTokens();
  const scheme = useLook().scheme;
  const [hovered, setHovered] = useState(false);
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      {...(label !== undefined ? { "aria-label": label } : {})}
      onChange={(e) => onChange(Number(e.target.value))}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        boxSizing: "border-box",
        // The root's (`:root { color-scheme }` per theme), which is what Chromium paints the slider in.
        colorScheme: scheme,
        font: "inherit",
        color: String(t.v("text")),
        background: String(t.v("bg")),
        border: `1px solid ${String(t.v(hovered ? "rule" : "line"))}`,
        borderRadius: lengthToken(t, "control-radius", 7),
        padding: "5px 9px",
        resize: "vertical",
        ...(width !== undefined ? { width } : { width: "100%" }),
      }}
    />
  );
}
