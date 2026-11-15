import type { JSX, ReactNode } from "react";

/** The keyframes, once per page: the page carries no stylesheet to hold them. */
let planted = false;
function plant(): void {
  if (planted || typeof document === "undefined") return;
  planted = true;
  const s = document.createElement("style");
  s.textContent = "@keyframes jaira-breathe{50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.jaira-breathe{animation:none!important}}";
  document.head.appendChild(s);
}

/**
 * `Breathe.tsx` on web: a CSS animation (full, a third, full again every `ms`), so a still picture's
 * `animation: none` holds it, and reduced motion stills it (`.jaira-breathe`'s media rule).
 */
export function Breathe({ ms = 1800, children }: { ms?: number; children: ReactNode }): JSX.Element {
  plant();
  return (
    <div className="jaira-breathe" style={{ display: "flex", animation: `jaira-breathe ${ms}ms ease-in-out infinite` }}>
      {children}
    </div>
  );
}
