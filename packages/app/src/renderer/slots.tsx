import { createContext, useContext, type ComponentProps, type ComponentType, type JSX, type ReactNode } from "react";
import type { CardProps } from "./board";

/**
 * Where a universal copy stands in for a DOM component (decision 0013).
 *
 * A component that has a copy is exported through `slotted`: it draws the copy when the page has
 * provided one, and its DOM self otherwise. The desktop provides nothing and draws exactly what it
 * drew before; the One client's `/universal` route provides every copy, and the fidelity gate diffs
 * the two. When a copy passes, the desktop provides it too (S4), and the DOM version is deleted.
 */
export interface Slots {
  Pill: ComponentType<PillSlotProps>;
  TaskCard: ComponentType<CardProps>;
}

export type { CardProps };

/** `pill.tsx`'s `Pill` props, restated so this file needs nothing from the component it replaces. */
export interface PillSlotProps {
  kind: "running" | "waiting" | "error" | "warning" | "success";
  n?: number;
  word?: string;
  title?: string;
}

const SlotsContext = createContext<Partial<Slots>>({});

export function SlotsProvider({ slots, children }: { slots: Partial<Slots>; children: ReactNode }): JSX.Element {
  return <SlotsContext.Provider value={slots}>{children}</SlotsContext.Provider>;
}

export function slotted<K extends keyof Slots>(name: K, Dom: Slots[K]): Slots[K] {
  function Slotted(props: ComponentProps<Slots[K]>): JSX.Element {
    // Erased to one props shape here only: `Slots` already ties each name to its props.
    const Drawn = (useContext(SlotsContext)[name] ?? Dom) as unknown as ComponentType<Record<string, unknown>>;
    return <Drawn {...(props as Record<string, unknown>)} />;
  }
  Slotted.displayName = `Slot(${name})`;
  return Slotted as unknown as Slots[K];
}
