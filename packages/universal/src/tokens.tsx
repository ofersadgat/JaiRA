import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from "react";
import { ReplayRoot, ReplayScope, useReplayLook, useReplayTokens, type RootLook } from "./tokensReplay";

/**
 * Tokens on WEB (decision 0015). `tokens.native.tsx` is the same API for a phone.
 *
 * Under {@link Replayed} a web page reads the replayed cascade (`tokensReplay.tsx`), as native does. The
 * app's page and the specimens' are both drawn so: they load no `styles.css`, and every colour and size
 * on them is worked out in code.
 *
 * Outside it every value is the CSS variable itself (`var(--line)`), for the browser to resolve against
 * the palette and scheme on the root — which takes a page whose stylesheet declares the variables.
 */
export interface Tokens {
  /**
   * Whether these are the replayed cascade (native, and a web page under `Replayed`) — values are
   * numbers and colours — rather than the CSS variables themselves. A component writes sizes the same
   * either way; this is for the few places the two need different shapes (`letterSpacing`).
   */
  readonly replayed: boolean;
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
 * The look beyond the variables: which palette, which scheme, and the board's surface options.
 * Variables need none of this — `v()` already follows them — but a component that draws differently
 * under a palette or an option (a card under a named palette, a washed card) has to know which it is in.
 */
export interface Look {
  /** `classic` when the root has no `data-palette`. */
  palette: string;
  scheme: "light" | "dark";
  /** `data-wash`: cards tinted by their status. */
  wash: boolean;
  /** `data-buckets`: columns as boxes, or as a heading over a line. */
  buckets: "box" | "line";
  /** `data-lanes`: lanes coloured. */
  lanes: boolean;
}

const WEB: Tokens = {
  replayed: false,
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
    buckets: root?.getAttribute("data-buckets") === "line" ? "line" : "box",
    lanes: root?.hasAttribute("data-lanes") ?? false,
  };
};

/** Whether this subtree reads the replayed cascade rather than the CSS variables. */
const ReplayedContext = createContext(false);

/** The native path, in a browser. Put a {@link TokenRoot} inside it to say which look. */
export function Replayed({ children }: { children: ReactNode }): JSX.Element {
  return <ReplayedContext.Provider value={true}>{children}</ReplayedContext.Provider>;
}

/**
 * Replayed, the {@link TokenRoot}'s look. Otherwise the root's attributes, which `applyAppearance`
 * writes and this watches.
 */
export function useLook(): Look {
  const replayed = useContext(ReplayedContext);
  const replay = useReplayLook();
  const [look, setLook] = useState(readLook);
  useEffect(() => {
    if (replayed) return undefined;
    const watch = new MutationObserver(() => setLook(readLook()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette", "data-theme", "data-wash", "data-buckets", "data-lanes"] });
    return () => watch.disconnect();
  }, [replayed]);
  return replayed ? replay : look;
}

export function useTokens(): Tokens {
  const replayed = useContext(ReplayedContext);
  const replay = useReplayTokens();
  return replayed ? replay : WEB;
}

/**
 * A subtree whose variables override the root's (`sidebar`). Replayed, the scope is recorded; outside
 * `Replayed` nothing is, the cascade being the browser's.
 */
export function TokenScope({ scope, children }: { scope: string; children: ReactNode }): JSX.Element {
  const replayed = useContext(ReplayedContext);
  return replayed ? <ReplayScope scope={scope}>{children}</ReplayScope> : <>{children}</>;
}

export function TokenRoot({ children, ...look }: RootLook & { children: ReactNode }): JSX.Element {
  const replayed = useContext(ReplayedContext);
  return replayed ? <ReplayRoot {...look}>{children}</ReplayRoot> : <>{children}</>;
}
