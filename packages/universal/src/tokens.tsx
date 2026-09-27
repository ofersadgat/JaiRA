import { useEffect, useState, type JSX, type ReactNode } from "react";

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
  /** `color-mix(in srgb, a pct%, b)`, where `a` and `b` are what `v()` returned or a CSS colour. */
  mix(a: string | number, pct: number, b: string | number): string;
}

/**
 * The look a palette-level RULE depends on (`:root[data-palette] .card`, `:root[data-wash] …`): which
 * palette, which scheme, and the status wash. Variables need none of this — `v()` already follows
 * them — but a copy that carries a palette's rule by hand has to know when it applies.
 */
export interface Look {
  /** `classic` when the root has no `data-palette`. */
  palette: string;
  scheme: "light" | "dark";
  wash: boolean;
}

const WEB: Tokens = {
  v: (name) => `var(--${name})`,
  scaled: (name, factor) => `calc(var(--${name}) * ${factor})`,
  tint: (name, pct) => `color-mix(in srgb, var(--${name}) ${pct}%, transparent)`,
  mix: (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`,
};

const readLook = (): Look => {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  return {
    palette: root?.getAttribute("data-palette") ?? "classic",
    scheme: root?.getAttribute("data-theme") === "dark" ? "dark" : "light",
    wash: root?.hasAttribute("data-wash") ?? false,
  };
};

/** On web, the root's attributes, which `applyAppearance` writes and this watches. */
export function useLook(): Look {
  const [look, setLook] = useState(readLook);
  useEffect(() => {
    const watch = new MutationObserver(() => setLook(readLook()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette", "data-theme", "data-wash"] });
    return () => watch.disconnect();
  }, []);
  return look;
}

export function useTokens(): Tokens {
  return WEB;
}

/** On web the DOM already scopes (`.sidebar` sets its own variables); nothing to add. */
export function TokenScope({ children }: { scope: string; children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function TokenRoot({ children }: { palette: string; scheme: "light" | "dark"; wash?: boolean; children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
