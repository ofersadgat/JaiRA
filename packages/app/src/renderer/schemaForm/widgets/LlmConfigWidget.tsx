/**
 * `$type: "llm-config"` — the call configuration, as a registered widget.
 *
 * The registry's rich-leaf case, and the reason the registry exists at all: an `LlmConfiguration` is
 * a discriminated union (sampling XOR reasoning) with a cross-field rule the structural renderer
 * cannot express — it would happily render temperature beside reasoning and let a project save a
 * config the parser upstream refuses. So this owns its own layout, exactly as findmyprompt's
 * `SearchSpace` owns the search space.
 */
import type { JSX } from "react";
import { LlmConfigForm, type LlmConfigDoc } from "../../llmConfigForm";
import type { WidgetProps } from "../types";

export function LlmConfigWidget({ value, onChange, ctx }: WidgetProps): JSX.Element {
  return (
    <LlmConfigForm
      value={(value ?? {}) as LlmConfigDoc}
      disabled={ctx.disabled === true}
      onChange={(next) => onChange(Object.keys(next).length === 0 ? undefined : next)}
    />
  );
}
