/** The stack panel's motion on a phone: none — each view is drawn as it lands (`stackMotion.web.ts` has the web's). */
export function morphMotion(_phase: "opening" | "on"): Record<string, unknown> {
  return {};
}

export function columnMotion(): Record<string, unknown> {
  return {};
}

export function arriveMotion(_how: "fade" | "unfold"): Record<string, unknown> {
  return {};
}

export function turnMotion(): Record<string, unknown> {
  return {};
}
