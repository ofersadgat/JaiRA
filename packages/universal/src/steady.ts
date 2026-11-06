import { memo, useRef, type ComponentType, type FunctionComponent, type MemoExoticComponent } from "react";

/**
 * Keeping a component from drawing again when nothing it is given has moved (2026-11-06: of ~7,700
 * components drawn as a task opened on the phone, ~5,900 were handed props that were new objects with the
 * same content — a `spec={{ … }}` written in place, an icon's paths mapped again, a handler made again).
 *
 * - {@link sameContent}: equal as values, a few levels down — for the fields a caller writes in place.
 * - {@link steadyMemo}: `memo` with those fields compared by content, everything else by identity.
 * - {@link useSteadyHandlers}: handlers that keep their identity while always calling the newest one.
 */

const DEPTH = 4;

/**
 * Equal as values: the same thing, or plain objects and arrays whose parts are equal, `depth` levels down.
 * A function or a React element is equal only to itself: a function may close over something else, and an
 * element is what to draw.
 */
export function sameContent(a: unknown, b: unknown, depth = DEPTH): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0 || a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if ("$$typeof" in a || "$$typeof" in b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameContent(a[i], b[i], depth - 1)) return false;
    return true;
  }
  // Only a plain object is compared by its fields: a Map, a Set or a class's instance keeps what it holds
  // where `Object.keys` does not see it, so it is equal only to itself.
  if (Array.isArray(b) || !plain(a) || !plain(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameContent((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1)) return false;
  }
  return true;
}

function plain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Props equal: each the same, but those named in `content`, which are equal by {@link sameContent}. */
export function samePropsBy(content: readonly string[]): (a: object, b: object) => boolean {
  const byContent = new Set(content);
  return (a, b) => {
    const pa = a as Record<string, unknown>;
    const pb = b as Record<string, unknown>;
    const keys = Object.keys(pa);
    if (keys.length !== Object.keys(pb).length) return false;
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(pb, k)) return false;
      const x = pa[k];
      const y = pb[k];
      if (Object.is(x, y)) continue;
      if (byContent.has(k) && sameContent(x, y)) continue;
      return false;
    }
    return true;
  };
}

/** `memo`, the props named in `content` compared by content (a `spec`, a `style`, a list of shapes). */
export function steadyMemo<P extends object>(component: FunctionComponent<P>, content: readonly string[]): MemoExoticComponent<ComponentType<P>> {
  return memo(component as ComponentType<P>, samePropsBy(content));
}

/**
 * The functions of `handlers`, each kept as one function for the life of the component and calling the one
 * handed in on the latest draw — for a row memoized below a parent that makes its handlers again on every
 * draw. For HANDLERS only (called on a press, a change): a function called while drawing (a render prop)
 * must stay what it is, or a row would not draw what its parent now says.
 */
export function useSteadyHandlers<H extends Record<string, ((...args: never[]) => unknown) | undefined>>(handlers: H): H {
  const latest = useRef(handlers);
  latest.current = handlers;
  const made = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(handlers)) {
    if (value === undefined) {
      out[key] = undefined;
      continue;
    }
    let steady = made.current.get(key);
    if (steady === undefined) {
      steady = (...args: unknown[]) => (latest.current[key] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
      made.current.set(key, steady);
    }
    out[key] = steady;
  }
  return out as H;
}
