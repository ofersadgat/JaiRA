/**
 * Writing a state's configuration back into its workflow script (the person, 2026-11-24: a script's
 * configuration "should be in copy on change mode"). What a form can change of a script is what its code
 * spells as a value — the label, the description, an input's default — and an edit to anything else is
 * refused with a reason rather than dropped.
 */
import { describe, expect, it } from "vitest";
import { scriptWithEdits } from "../src/index";

const SCRIPT = `export const meta = {
  name: "Session",
  description: "A conversation.",
};

export default async function session(
  message: string,
  approval: "propose" | "auto" | "accept" = "propose",
  limit: number,
): Promise<void> {}
`;

const BEFORE = {
  label: "Session",
  description: "A conversation.",
  inputs: {
    message: { schema: { type: "string" } },
    approval: { schema: { type: "string", enum: ["propose", "auto", "accept"] }, optional: true, default: "propose" },
    limit: { schema: { type: "number" } },
  },
  operation: { function: "x" },
};

const edit = (after: (doc: typeof BEFORE) => unknown) => scriptWithEdits("session.ts", SCRIPT, BEFORE, after(structuredClone(BEFORE)));

describe("a script's configuration, written into its code", () => {
  it("writes an input's default into its parameter's", () => {
    const done = edit((doc) => ({ ...doc, inputs: { ...doc.inputs, approval: { ...doc.inputs.approval, default: "auto" } } }));
    expect(done.text).toContain(`approval: "propose" | "auto" | "accept" = "auto",`);
    expect(done.text?.replace(`= "auto"`, `= "propose"`)).toBe(SCRIPT);
  });

  it("gives a parameter with none a default, which makes the input optional", () => {
    const done = edit((doc) => ({ ...doc, inputs: { ...doc.inputs, limit: { ...doc.inputs.limit, optional: true, default: 3 } } }));
    expect(done.text).toContain("limit: number = 3,");
  });

  it("writes the label and the description into meta", () => {
    const done = edit((doc) => ({ ...doc, label: "Chat", description: "Talk, \"politely\"." }));
    expect(done.text).toContain(`name: "Chat",`);
    expect(done.text).toContain(`description: "Talk, \\"politely\\".",`);
  });

  it("changes nothing when nothing changed", () => {
    expect(edit((doc) => doc).text).toBe(SCRIPT);
  });

  it("refuses what the code does — an operation, an input's type, an input added — and says where to change it", () => {
    expect(edit((doc) => ({ ...doc, operation: { function: "y" } })).error).toMatch(/'operation' comes from what the script's code does/);
    expect(edit((doc) => ({ ...doc, inputs: { ...doc.inputs, limit: { schema: { type: "string" } } } })).error).toMatch(/'limit''s schema comes from the script's code/);
    expect(edit((doc) => ({ ...doc, inputs: { ...doc.inputs, extra: { schema: {} } } })).error).toMatch(/'extra' is a parameter of the script — add it there/);
    expect(edit((doc) => ({ ...doc, inputs: { ...doc.inputs, approval: { schema: doc.inputs.approval.schema, optional: true } } })).error).toMatch(/default is its parameter's — remove it in the script/);
  });
});
