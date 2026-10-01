import type { JSX, ReactNode } from "react";

/** The keyframes, once per page: the page carries no stylesheet to hold them. */
let planted = false;
function plant(): void {
  if (planted || typeof document === "undefined") return;
  planted = true;
  const s = document.createElement("style");
  s.textContent = "@keyframes jaira-turn{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.jaira-turn{animation:none!important}}";
  document.head.appendChild(s);
}

/**
 * `Turn.tsx` on web: a CSS animation (a turn every `ms`, linear, for ever), so a still picture's
 * `animation: none` holds it, and reduced motion stills it (`.jaira-turn`'s media rule).
 */
export function Turn({ ms = 900, children }: { ms?: number; children: ReactNode }): JSX.Element {
  plant();
  return (
    <div className="jaira-turn" style={{ display: "flex", animation: `jaira-turn ${ms}ms linear infinite` }}>
      {children}
    </div>
  );
}
