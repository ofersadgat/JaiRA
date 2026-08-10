/**
 * The signature-driven form's resolution rules — ported from findmyprompt along with the form.
 *
 * What is tested here is the RESOLUTION, not the rendering: which widget a node gets, and where a
 * member's label comes from. Those are the two decisions that make the form follow the schema
 * instead of a hand-written copy of it, and they are pure.
 */
import { describe, expect, it } from "vitest";
import { EXECUTOR_STEPS } from "@jaira/shared/browser";
import { presentationFor, prettify } from "../src/renderer/schemaForm/presentation";
import { widgetFor } from "../src/renderer/schemaForm/registry";

describe("the widget registry", () => {
  it("resolves a registered rich leaf, and nothing else", () => {
    // The fall-through is the property worth keeping: a schema nobody has written a widget for is
    // still editable by the structural renderer, so the form is never silently lossy.
    expect(widgetFor("llm-config")).toBeTypeOf("function");
    expect(widgetFor("retry")).toBeUndefined();
    expect(widgetFor(undefined)).toBeUndefined();
  });
});

describe("where a member's label comes from", () => {
  it("prefers the presentation map, which is the only wording written for a reader of the form", () => {
    const pres = presentationFor("retry", "transient", { title: "transient attempts" });
    expect(pres.label).toBe("attempts after a retriable failure");
    expect(pres.tooltip).toContain("429");
  });

  it("falls back to the schema's own title and description", () => {
    const pres = presentationFor("deadline", "maxDurationMs", {
      title: "window (ms)",
      description: "How long the call may take.",
    });
    expect(pres).toEqual({ label: "window (ms)", tooltip: "How long the call may take." });
  });

  it("falls back to the prettified key when neither says anything", () => {
    expect(presentationFor(undefined, "maxBackoffMs", {})).toEqual({ label: "max backoff ms" });
  });

  it("prettifies camelCase and kebab alike", () => {
    expect(prettify("maxOutputTokens")).toBe("max output tokens");
    expect(prettify("model-set")).toBe("model set");
  });
});

/**
 * The bridge that makes the whole arrangement worth it: every field of every step resolves to a
 * label and a control WITHOUT anyone having written a form for it.
 *
 * If this fails, a step has gained a field that renders as a bare prettified key with no hint — which
 * is the drift the shared schema exists to prevent.
 */
describe("every step's schema is renderable", () => {
  it("gives every field of every step a label and a hint", () => {
    for (const step of EXECUTOR_STEPS) {
      const properties = step.schema["properties"] as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties).length).toBeGreaterThan(0);
      for (const [key, sub] of Object.entries(properties)) {
        const pres = presentationFor(step.name, key, sub);
        expect(pres.label.length).toBeGreaterThan(0);
        // A nested object carries its members' hints rather than one of its own.
        if (sub["type"] !== "object") expect(pres.tooltip).toBeTruthy();
      }
    }
  });
});
