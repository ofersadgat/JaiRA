/**
 * Asking the main process whether a form's values would be accepted.
 *
 * Kept out of `SchemaForm.tsx` on purpose: the form only DRAWS complaints it is handed, which is what
 * lets a view test render it with no main process behind it. The hosts — the Run panel, New task, a
 * `fill_form` gate — hold a check and pass its errors down.
 */
import { useEffect, useRef, useState } from "react";
import type { JsonValue } from "@declarative-ai/json";
import { invoke } from "../store";
import { fieldErrorsOf, type CheckError, type FieldError, type FormCheck } from "./model";
import type { Schema } from "./types";

/** One value to check, and where on the form its complaints belong. */
export interface CheckItem {
  /** The form path this value sits at — a slot's name, or `""` for a form that is one value. */
  path: string;
  schema: Schema;
  value: JsonValue;
}

export type { FormCheck } from "./model";

/**
 * Which fields of a form someone has edited — so a complaint waits under a box until it has been
 * typed in, and is said only beside the button until then.
 *
 * `scope` starts it over: a panel that moves to another state is a different form.
 */
export function useTouched(scope: string): { touched: (path: string) => boolean; touch: (path: string) => void } {
  const [held, setHeld] = useState<{ scope: string; paths: ReadonlySet<string> }>({ scope, paths: new Set() });
  const paths = held.scope === scope ? held.paths : new Set<string>();
  return {
    touched: (path) => paths.has(path),
    touch: (path) => {
      if (paths.has(path)) return;
      setHeld((prev) => ({ scope, paths: new Set([...(prev.scope === scope ? prev.paths : []), path]) }));
    },
  };
}

/** How long typing has to pause before the form is checked — short enough to feel like it is live. */
const SETTLE_MS = 120;

/**
 * The verdict on a set of values, kept current as they change.
 *
 * `local` complaints are the ones the form knows without asking (a required slot with nothing in it)
 * and are merged in front. While a new check is out, the last answer stands and `pending` says it may
 * be stale: a button that flickered between "fix this" and nothing on every keystroke would be worse
 * than one that waits a beat. An answer to values that have since changed is dropped.
 */
export function useSchemaCheck(items: readonly CheckItem[], local: readonly FieldError[] = []): FormCheck {
  const key = JSON.stringify(items);
  const [state, setState] = useState<{ key: string; errors: FieldError[] } | null>(null);
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (items.length === 0) {
      setState({ key, errors: [] });
      return;
    }
    const timer = setTimeout(() => {
      invoke("schema:check", { checks: items.map((item) => ({ key: item.path, schema: item.schema as JsonValue, value: item.value })) })
        .then((response) => {
          if (latest.current !== key) return;
          const errors: FieldError[] = [];
          response.results.forEach((result, i) => {
            const item = items[i]!;
            if (result.compileError !== undefined) {
              errors.push({ path: item.path, message: `this schema can't be checked: ${result.compileError}` });
            }
            errors.push(...fieldErrorsOf(result.errors as CheckError[], item.value, item.path));
          });
          setState({ key, errors });
        })
        .catch((e: unknown) => {
          if (latest.current !== key) return;
          setState({ key, errors: [{ path: "", message: `could not be checked: ${(e as Error).message}` }] });
        });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `key` IS the items, by value — the array itself is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    pending: state?.key !== key,
    answered: state !== null,
    errors: [...local, ...(state?.errors ?? [])],
  };
}
