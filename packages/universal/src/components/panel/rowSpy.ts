import { createContext, useCallback, useContext, useRef } from "react";

/**
 * Where a run's conversation keeps the rows a bookmark can land on — the DOM's `[data-entered]` (the
 * row where the run went into a state) and `[data-instance]` (a letterhead, a solo sheet's body), which
 * `runViews.tsx`'s `track` and `sessionPanels.tsx`'s focus effect query in the page. A copy has no page
 * to query on a phone, so each such row puts its element here as it mounts (`useSpyRow`), and the
 * conversation measures them against its own scroller (`RunTranscript.tsx`).
 *
 * `lit` is the instance a bookmark just landed on, for the 1.2s ring a solo sheet's body takes
 * (`.sb-bare.sb-panel-lit`).
 */
export interface RowSpy {
  place: (el: unknown, row: SpiedRow | null, was: unknown) => void;
  lit: string | null;
}

export interface SpiedRow {
  id: string;
  kind: "entered" | "instance";
}

export const RowSpyContext = createContext<RowSpy | null>(null);

/** A ref callback that files this row's element with the conversation's spy — none outside one. */
export function useSpyRow(id: string | undefined, kind: SpiedRow["kind"]): ((el: unknown) => void) | undefined {
  const spy = useContext(RowSpyContext);
  const last = useRef<unknown>(null);
  const place = spy?.place;
  const ref = useCallback(
    (el: unknown) => {
      if (place === undefined) return;
      place(el, el === null || id === undefined ? null : { id, kind }, last.current);
      last.current = el;
    },
    [place, id, kind],
  );
  return spy === null || id === undefined ? undefined : ref;
}

/** Whether a bookmark just landed on this instance (`sb-panel-lit`). */
export function useSpyLit(id: string): boolean {
  return useContext(RowSpyContext)?.lit === id;
}
