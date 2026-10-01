import type { PanelStack } from "@jaira/ui/panelStack";

/**
 * The native half of `panelMotion.web.ts`: a phone's panel comes and goes without web's slide, fade and
 * width tween (not written for a phone yet) — the body and the column are drawn where they end up.
 */
export function bodyMotion(motion: PanelStack["motion"]): string {
  return motion;
}

export function paneTween(_on: boolean): Record<string, unknown> {
  return {};
}
