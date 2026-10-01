import { createTamagui, createTokens } from "@tamagui/core";

/**
 * Tamagui, configured to bring no look of its own (decision 0015).
 *
 * No themes and no colour tokens: Tamagui would publish them as CSS variables named after their keys
 * (`--accent`), redefining the app's own inside every subtree it wraps. Colours come from `useTokens`
 * instead (`tokens.tsx`). What Tamagui brings is the component model, `styled()`, and one tree that
 * renders on web and natively.
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
