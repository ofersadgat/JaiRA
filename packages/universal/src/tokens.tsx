import type { JSX, ReactNode } from "react";

/**
 * Tokens on WEB (decision 0013): every value is the CSS variable itself.
 *
 * The browser resolves it against the palette, scheme and subtree the DOM app has applied — the same
 * cascade the CSS beside a copy reads — so a copy cannot drift from it, and a palette switch reaches it
 * with no code at all. `tokens.native.tsx` is the same API over the replayed cascade.
 */
export interface Tokens {
  /** `--name`. */
  v(name: string): string | number;
  /** `--name` scaled, for sizes: `calc(var(--size-data) * 0.8)`. */
  scaled(name: string, factor: number): string | number;
  /** `color-mix(in srgb, var(--name) pct%, transparent)`: a tint of a colour token. */
  tint(name: string, pct: number): string;
}

const WEB: Tokens = {
  v: (name) => `var(--${name})`,
  scaled: (name, factor) => `calc(var(--${name}) * ${factor})`,
  tint: (name, pct) => `color-mix(in srgb, var(--${name}) ${pct}%, transparent)`,
};

export function useTokens(): Tokens {
  return WEB;
}

/** On web the DOM already scopes (`.sidebar` sets its own variables); nothing to add. */
export function TokenScope({ children }: { scope: string; children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function TokenRoot({ children }: { palette: string; scheme: "light" | "dark"; children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
