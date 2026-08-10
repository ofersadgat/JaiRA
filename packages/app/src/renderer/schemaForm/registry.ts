/**
 * The `$type` → component registry. Ported from findmyprompt's `schemaForm/registry.ts`.
 *
 * A registry hit renders with that dedicated widget — which owns its own labels and layout — and a
 * miss falls through to the generic structural renderer. That fall-through is the property worth
 * keeping: a schema whose shape nobody has written a widget for is still editable, so the form is
 * never silently lossy.
 *
 * `llm-config` is the one rich leaf JaiRA has: an `LlmConfiguration` is a discriminated union
 * (sampling XOR reasoning) with cross-field rules the structural renderer cannot express, so it gets
 * the same treatment findmyprompt gives `SearchSpace`.
 */
import { LlmConfigWidget } from "./widgets/LlmConfigWidget";
import type { Widget } from "./types";

const REGISTRY: Record<string, Widget> = {
  "llm-config": LlmConfigWidget,
};

export function widgetFor(type: string | undefined): Widget | undefined {
  return type ? REGISTRY[type] : undefined;
}
