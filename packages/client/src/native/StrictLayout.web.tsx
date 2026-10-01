import type { JSX, ReactNode } from "react";

/** `StrictLayout.tsx` in a browser (the `/native` preview): CSS flexbox is the layout the phone is told to follow. */
export function StrictLayout({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
