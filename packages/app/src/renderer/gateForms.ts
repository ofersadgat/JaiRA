/**
 * What a `fill_form` gate opens holding — the gate's form
 * (`packages/universal/src/components/floats/GateBodies.tsx`) starts on it — and a settled gate's
 * recorded answer as a record.
 */
import type { FormField } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { seedFor } from "./schemaForm/model";
import type { Schema } from "./schemaForm/types";

/**
 * What a `fill_form` opens holding: every field with a `default` pre-answered with it, every other
 * required field at an empty value of its type, and the optional ones without a default not set.
 *
 * A gate's `default` is not the run's. On a state's input, a default is what the engine sends when
 * nothing is; on a gate, nothing fills a field the person did not answer, so the default is the
 * ANSWER the form starts on — "answering is confirming or overruling", and submitting untouched sends
 * it.
 */
export function formStartsWith(fields: readonly FormField[], schema: Schema): Record<string, unknown> {
  const out = seedFor(schema) as Record<string, unknown>;
  for (const field of fields) if (field.default !== undefined) out[field.name] = structuredClone(field.default);
  return out;
}

/** The recorded value as a record, or nothing. */
export function recordOf(settled: { value?: JsonValue | undefined } | undefined): Record<string, JsonValue> {
  const value = settled?.value;
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
