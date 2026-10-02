import type { JSX } from "react";
import { View } from "@tamagui/core";
import { useTokens } from "../../tokens";

/** The keyframes, once per page: the page carries no stylesheet to hold them. */
let planted = false;
function plant(): void {
  if (planted || typeof document === "undefined") return;
  planted = true;
  const s = document.createElement("style");
  s.textContent = "@keyframes jaira-pulse{0%,100%{opacity:.2}50%{opacity:1}}@media (prefers-reduced-motion:reduce){.jaira-pulse{animation:none!important;opacity:.55!important}}";
  document.head.appendChild(s);
}

/**
 * `Pulse.tsx` on web: each dot a CSS animation (1.25s ease-in-out for ever, opacity 0.2 → 1 → 0.2, the
 * second and third 0.18s and 0.36s behind). With less motion asked for it stands still at 0.55
 * (`.jaira-pulse`'s media rule). A still picture's `animation: none` holds it whole — the dot has no
 * opacity of its own — which is what the reference pictures have.
 */
export function Pulse({ color = "accent" }: { color?: string }): JSX.Element {
  const t = useTokens();
  plant();
  return (
    <View flexDirection="row" alignItems="center" gap={3} flexShrink={0}>
      {[0, 1, 2].map((i) => (
        <View key={i} className="jaira-pulse" width={4} height={4} borderRadius={999} backgroundColor={t.v(color) as never} style={{ animation: `jaira-pulse 1.25s ease-in-out ${i * 0.18}s infinite` } as never} />
      ))}
    </View>
  );
}
