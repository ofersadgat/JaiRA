import type { JSX, ReactNode, RefObject } from "react";
import type { ScrollView } from "react-native";

/** `Virtual.tsx` in a browser: all of it nothing — the page draws only what shows, and the DOM stays as it was. */
export interface ScrollWindow {
  content(): null;
  band(): { top: number; bottom: number };
  subscribe(listener: (why: "scrolled" | "moved") => void): () => void;
}

const NOWHERE: ScrollWindow = { content: () => null, band: () => ({ top: -Infinity, bottom: Infinity }), subscribe: () => () => undefined };
const NOTHING = (): void => undefined;

export function useScrollWindow(_scroller: RefObject<ScrollView | null>): { window: ScrollWindow; scrolled: (y: number) => void; sized: (height: number) => void; moved: (width?: number, height?: number) => void; atEnd: () => void } {
  return { window: NOWHERE, scrolled: NOTHING, sized: NOTHING, moved: NOTHING, atEnd: NOTHING };
}

export function ScrollWindowProvider({ children }: { window: ScrollWindow; children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function Virtual({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
