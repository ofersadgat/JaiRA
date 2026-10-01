import type { JSX, ReactNode } from "react";
import { experimental_LayoutConformance as LayoutConformance } from "react-native";

/**
 * Flexbox as a browser lays it out, for everything the phone draws. The components are written against
 * the web's flexbox (react-native-web is CSS itself, and each is held to its reference picture there),
 * and React Native's Yoga does not lay out that way by default: it keeps the behaviour of its old
 * versions ("errata"), one of which lets a child that may grow (`flex-grow`) take all the height its
 * box was OFFERED, where CSS gives a box sized by its content nothing to grow into. Every `Press` holds
 * such a child (its box fills the pressable), so a button in a column whose height was still being
 * settled stood as tall as the room above it — a transcript's "From feature/plan" badge 27,000 tall
 * with the conversation pushed out of reach under it, the Components room's cards a million. `strict`
 * turns the errata off for the subtree (`YGErrataNone`), so the same styles mean the same boxes.
 * `StrictLayout.web.tsx` is nothing: a browser needs no telling.
 */
export function StrictLayout({ children }: { children: ReactNode }): JSX.Element {
  return <LayoutConformance mode="strict">{children}</LayoutConformance>;
}
