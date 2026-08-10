/**
 * The LLM configuration element's summary — the line a collapsed row shows.
 *
 * It exists because the rail's whole value is being able to see what a configuration says WITHOUT
 * opening it. A summary that quietly omitted a setting would be worse than none: it would say
 * "provider defaults" over a config that pins temperature to 1.5.
 */
import { describe, expect, it } from "vitest";
import { summariseLlmConfig } from "../src/renderer/llmConfigForm";

describe("summarising a call configuration", () => {
  it("says so plainly when a configuration states nothing", () => {
    expect(summariseLlmConfig({})).toBe("provider defaults");
  });

  it("names each sampling knob that is actually set", () => {
    expect(summariseLlmConfig({ temperature: 0, topP: 0.9 })).toBe("temperature 0 · topP 0.9");
  });

  it("reports temperature 0, which is a value and not an absence", () => {
    // The bug this guards: a falsy check would drop `0`, which is the single most likely setting for
    // a classifier — and the row would read "provider defaults" over a config that pins it.
    expect(summariseLlmConfig({ temperature: 0 })).toContain("temperature 0");
  });

  it("leads with reasoning, since it changes which other knobs are even legal", () => {
    expect(summariseLlmConfig({ reasoning: { effort: "high" } })).toBe("reasoning high");
    expect(summariseLlmConfig({ reasoning: { budgetTokens: 4096 } })).toBe("reasoning 4096t");
  });

  it("counts what it has no dedicated control for, rather than hiding it", () => {
    // The form keeps unknown keys in a JSON escape hatch; the summary has to admit they are there,
    // or a config would look simpler than it is.
    expect(summariseLlmConfig({ providerOptions: { anthropic: {} } })).toBe("+1 more");
    expect(summariseLlmConfig({ temperature: 0.2, providerOptions: {}, sessionId: "x" })).toBe(
      "temperature 0.2 · +2 more",
    );
  });

  it("reports the output ceiling, which is the main lever on what a call costs", () => {
    expect(summariseLlmConfig({ maxOutputTokens: 512 })).toBe("≤512 tokens");
  });
});
