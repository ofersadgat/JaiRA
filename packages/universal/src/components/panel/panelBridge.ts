import { useSyncExternalStore } from "react";
import type { PanelEntry, PanelStack } from "@jaira/ui/panelStack";

/**
 * What passes between the middle column and the side panel, which are separate regions of the shell
 * (`BoardColumn.tsx`/`FilesView.tsx` and `PanelColumn.tsx`): the panel's stack (a run card's click
 * describes its state in the panel), the step the run's conversation is showing, for the panel's Steps
 * index beside it (`runViewed`), and the other way, a step the index asks the conversation to go to
 * (`runFocus`). One small store per fact, as `app/viewState.ts` keeps its own.
 */
function shared<T>(initial: T): { get: () => T; set: (next: T) => void; use: () => T } {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (on: () => void): (() => void) => {
    listeners.add(on);
    return () => listeners.delete(on);
  };
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const on of listeners) on();
    },
    use: () => useSyncExternalStore(subscribe, () => value, () => value),
  };
}

export type OnStack = (next: (stack: PanelStack) => PanelStack) => void;

/** The panel column's `onStack`, while it is drawn. */
export const panelOnStack = shared<OnStack | null>(null);

/** Unfold the room's panel where it folds — what putting something in it does — while the column is drawn. */
export const panelUnfold = shared<(() => void) | null>(null);

/** What is on top of the side panel's stack, for the place buttons to light (`places.ts`). */
export const panelTop = shared<PanelEntry | undefined>(undefined);

/** The step the run's conversation in the middle column is showing, and every step with a sheet on screen. */
export const runViewed = shared<{ current?: string | undefined; onScreen?: ReadonlySet<string> | undefined }>({});

/** A step the panel's index asked the middle column's conversation to go to. */
export const runFocus = shared<{ instance: string; at: number } | undefined>(undefined);
