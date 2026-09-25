/**
 * A model's reasoning levels in a few words, from its catalog row (decision 0009) — the hint beside a
 * model in a picker, and the summary in a Catalog row. Its own module because both the model list
 * (`modelRoutes`) and the catalog views (`modelCatalog`) read it, and they import each other's other half.
 */
import { acceptanceOf, ModelInfo, REASONING_EFFORTS } from "@declarative-ai/llm";

/** A model's levels in a few words — `low–ultra, default low`, `low, medium, high, max`, `no thinking level`. */
export function levelsSummary(key: string, table: ModelInfo = ModelInfo.instance): string | undefined {
  const schema = table.parameters(key);
  if (schema === undefined) return undefined;
  const gate = acceptanceOf(schema);
  if (!gate.acceptsReasoning) return "no thinking level";
  if (gate.efforts === undefined) return "levels unknown";
  if (gate.efforts.length === 0) return gate.acceptsBudget === false ? "no thinking level" : "a thinking budget, no level";
  // A run of consecutive levels reads as a range; a gap (sonnet on claude 2.1.142 has no xhigh) is spelled out.
  const at = gate.efforts.map((e) => REASONING_EFFORTS.indexOf(e));
  const contiguous = at.every((v, i) => i === 0 || v === at[i - 1]! + 1);
  const span = gate.efforts.length === 1 ? gate.efforts[0]! : contiguous ? `${gate.efforts[0]}–${gate.efforts.at(-1)}` : gate.efforts.join(", ");
  return gate.defaultEffort !== undefined ? `${span}, default ${gate.defaultEffort}` : span;
}
