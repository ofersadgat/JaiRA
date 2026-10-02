import { useSyncExternalStore } from "react";

/**
 * Whether the pointer can HOVER — what decides how something that shows more of itself is opened
 * (`components/floats/hoverFloat.tsx`): under a pointer that can, by hovering; under one that cannot — a
 * touch screen, in the phone app (`canHover.native.ts`) or in a phone's browser — by a press, closed by
 * a press outside it. On web it is the browser's own answer (`hover: hover` is the PRIMARY pointer's, so
 * a laptop with a touch screen still hovers), and it is heard again when it changes (a tablet whose
 * mouse is unplugged).
 */
const QUERY = "(hover: hover)";

const media = (): MediaQueryList | null => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

function subscribe(changed: () => void): () => void {
  const query = media();
  if (query === null) return () => undefined;
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

/** A page with no window to ask (a test, a server render) is a desktop's: it hovers. */
export function useCanHover(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? true,
    () => true,
  );
}
