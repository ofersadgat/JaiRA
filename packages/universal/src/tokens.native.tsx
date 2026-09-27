import { createContext, useContext, useMemo, type JSX, type ReactNode } from "react";
import { evaluate, resolveAt, type TokenValue, type Where } from "./cssTokens";
import type { Look, Tokens } from "./tokens";

/**
 * Tokens on NATIVE (decision 0013): `styles.css`'s cascade replayed for where the component stands.
 * The same API as `tokens.tsx`, which on web returns the CSS variables themselves.
 */
const WhereContext = createContext<Where & { wash: boolean }>({ palette: "ink", scheme: "light", scopes: [], wash: false });

export function TokenRoot({ palette, scheme, wash = false, children }: { palette: string; scheme: "light" | "dark"; wash?: boolean; children: ReactNode }): JSX.Element {
  const where = useMemo(() => ({ palette, scheme, scopes: [], wash }), [palette, scheme, wash]);
  return <WhereContext.Provider value={where}>{children}</WhereContext.Provider>;
}

export function useLook(): Look {
  const { palette, scheme, wash } = useContext(WhereContext);
  return { palette, scheme, wash };
}

/** Inside `.sidebar` and its like, whose variables override the root's for everything within. */
export function TokenScope({ scope, children }: { scope: string; children: ReactNode }): JSX.Element {
  const outer = useContext(WhereContext);
  const where = useMemo(() => ({ ...outer, scopes: [...(outer.scopes ?? []), scope] }), [outer, scope]);
  return <WhereContext.Provider value={where}>{children}</WhereContext.Provider>;
}

const cache = new Map<string, Record<string, TokenValue>>();

export function useTokens(): Tokens {
  const where = useContext(WhereContext);
  const key = `${where.palette}|${where.scheme}|${(where.scopes ?? []).join(",")}`;
  return useMemo(() => {
    let values = cache.get(key);
    if (values === undefined) {
      values = resolveAt(where);
      cache.set(key, values);
    }
    const all = values;
    const v = (name: string): TokenValue => all[name] ?? "";
    return {
      v,
      scaled: (name, factor) => Number(v(name)) * factor,
      tint: (name, pct) => String(evaluate(`color-mix(in srgb, ${String(v(name))} ${pct}%, transparent)`, () => undefined)),
      mix: (a, pct, b) => String(evaluate(`color-mix(in srgb, ${String(a)} ${pct}%, ${String(b)})`, () => undefined)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
