import type { JSX, ReactNode } from "react";

/** The keyframes, once per page: `/rn` carries no stylesheet of the desktop's. */
let planted = false;
function plant(): void {
  if (planted || typeof document === "undefined") return;
  planted = true;
  const s = document.createElement("style");
  s.textContent = "@keyframes jaira-turn{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.jaira-turn{animation:none!important}}";
  document.head.appendChild(s);
}

/**
 * `Turn.tsx` on web: a CSS animation (`.spinner`'s `spin 900ms linear infinite`), so a still picture's
 * `animation: none` holds it where the desktop's stops, and reduced motion stills it as `.spinner`'s does.
 */
export function Turn({ ms = 900, children }: { ms?: number; children: ReactNode }): JSX.Element {
  plant();
  return (
    <div className="jaira-turn" style={{ display: "flex", animation: `jaira-turn ${ms}ms linear infinite` }}>
      {children}
    </div>
  );
}
