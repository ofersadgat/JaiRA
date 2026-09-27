import { createTamagui, createTokens } from "@tamagui/core";

/**
 * Tamagui, configured to stay out of the way of `styles.css` (decision 0013).
 *
 * No themes and no colour tokens: Tamagui would publish them as CSS variables named after their keys
 * (`--accent`), redefining the app's own inside every subtree it wraps. Colours come from `useTokens`
 * instead — the CSS variable itself on web, the replayed cascade on native. What Tamagui brings is the
 * component model, `styled()`, and one tree that renders on both.
 */
const tokens = createTokens({ size: {}, space: {}, radius: {}, zIndex: {}, color: {} });

export const config = createTamagui({
  tokens,
  themes: { light: {} },
  fonts: {},
  shorthands: {},
  settings: { disableSSR: true },
});

export type AppConfig = typeof config;
declare module "@tamagui/core" {
  interface TamaguiCustomConfig extends AppConfig {}
}
