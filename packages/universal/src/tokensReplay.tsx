import { createContext, useContext, useMemo, type JSX, type ReactNode } from "react";
import { evaluate, resolveAt, type TokenValue, type Where } from "./cssTokens";
import type { Look, Tokens } from "./tokens";

/**
 * Tokens REPLAYED (decision 0015): `styles.css`'s cascade worked out for where a component stands, with
 * no browser to do it. Native always reads these (`tokens.native.tsx`). On web they are what a page
 * under `Replayed` reads (`tokens.tsx`) — the app's page is one: it loads no `styles.css`, and every
 * colour and size on it comes from here, as on a phone.
 */
export interface ReplayWhere extends Where {
  readonly wash: boolean;
  readonly buckets: "box" | "line";
  readonly lanes: boolean;
  /**
   * What `applyAppearance` writes inline on `:root` (the person's fonts and sizes): it beats every
   * `:root` rule in the stylesheet, so it is applied over the root level of the replay.
   */
  readonly overrides: Readonly<Record<string, string>>;
}

const DEFAULT: ReplayWhere = { palette: "ink", scheme: "light", scopes: [], wash: false, buckets: "box", lanes: false, overrides: {} };
const WhereContext = createContext<ReplayWhere>(DEFAULT);

export interface RootLook {
  palette: string;
  scheme: "light" | "dark";
  wash?: boolean;
  buckets?: "box" | "line";
  lanes?: boolean;
  overrides?: Readonly<Record<string, string>>;
}

export function ReplayRoot({ palette, scheme, wash = false, buckets = "box", lanes = false, overrides, children }: RootLook & { children: ReactNode }): JSX.Element {
  const key = overrides === undefined ? "" : JSON.stringify(overrides);
  const where = useMemo(
    () => ({ palette, scheme, scopes: [], wash, buckets, lanes, overrides: overrides ?? {} }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette, scheme, wash, buckets, lanes, key],
  );
  return <WhereContext.Provider value={where}>{children}</WhereContext.Provider>;
}

export function useReplayLook(): Look {
  const { palette, scheme, wash, buckets, lanes } = useContext(WhereContext);
  return { palette, scheme, wash, buckets, lanes };
}

/** Inside a scope (`sidebar` and its like), whose variables override the root's for everything within. */
export function ReplayScope({ scope, children }: { scope: string; children: ReactNode }): JSX.Element {
  const outer = useContext(WhereContext);
  const where = useMemo(() => ({ ...outer, scopes: [...(outer.scopes ?? []), scope] }), [outer, scope]);
  return <WhereContext.Provider value={where}>{children}</WhereContext.Provider>;
}

const cache = new Map<string, Record<string, TokenValue>>();

export function useReplayTokens(): Tokens {
  const where = useContext(WhereContext);
  const key = `${where.palette}|${where.scheme}|${(where.scopes ?? []).join(",")}|${JSON.stringify(where.overrides)}`;
  return useMemo(() => {
    let values = cache.get(key);
    if (values === undefined) {
      values = resolveAt(where, undefined, where.overrides);
      cache.set(key, values);
    }
    return replayTokens(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function replayTokens(all: Record<string, TokenValue>): Tokens {
  const v = (name: string): TokenValue => all[name] ?? "";
  return {
    replayed: true,
    v,
    scaled: (name, factor) => Number(v(name)) * factor,
    tint: (name, pct) => String(evaluate(`color-mix(in srgb, ${String(v(name))} ${pct}%, transparent)`, () => undefined)),
    mix: (a, pct, b) => String(evaluate(`color-mix(in srgb, ${String(a)} ${pct}%, ${String(b)})`, () => undefined)),
  };
}
