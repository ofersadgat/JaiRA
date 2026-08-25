/**
 * Which turn of a call IS its structured output.
 *
 * An operation can declare a JSON output and still be answered in TEXT: a model with no
 * structured-output tool writes the JSON as its message, and upstream binds it. The conversation
 * showed only the message, so a state that produced four labelled fields rendered as a paragraph of
 * `{"matched": false, …}` run through a markdown renderer.
 *
 * The whole of the fix is a matching rule, and the whole of the risk is that the rule guesses. It
 * does not: a turn is named only when its text parses AND equals what the record bound. These are
 * the cases where a looser rule would have been wrong.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import type { SessionTurn } from "@jaira/shared";
import { structuredOutputOf } from "../src/main/service";

const SCHEMA: JsonValue = {
  type: "object",
  properties: { matched: { type: "boolean" }, match_reason: { type: "string" } },
  required: ["matched", "match_reason"],
};

const OUTPUT = { matched: false, match_reason: "the catalog is empty" };

/** A record as the store holds one: the row wraps an `LlmOutput`, whose `value` is what was bound. */
const record = (
  bound: JsonValue | undefined,
  /** `null` for a record whose request pinned no output slot at all. */
  output: JsonValue | null = { name: "output", kind: "json", schema: SCHEMA },
  toolCalls?: JsonValue,
) => ({
  value: {
    value: { ...(bound !== undefined ? { value: bound } : {}), messages: [], ...(toolCalls !== undefined ? { toolCalls } : {}) },
  } as JsonValue,
  ...(output !== null ? { request: { kind: "prompt", output } as JsonValue } : {}),
});

const turns = (...said: Array<[string, string]>): SessionTurn[] => said.map(([role, text]) => ({ role, text }));

describe("finding the turn that is a structured output", () => {
  it("names the assistant turn whose text is the bound value, and carries the slot with it", () => {
    const found = structuredOutputOf(record(OUTPUT), turns(["user", "go"], ["assistant", JSON.stringify(OUTPUT)]));
    // The schema is what decides how it is drawn; the name is what it is drawn UNDER.
    expect(found).toEqual({ turn: 1, value: OUTPUT, schema: SCHEMA, name: "output" });
  });

  it("does not care how the model spaced it — the comparison is of values, not of bytes", () => {
    // What a model actually writes: spaces after the colons, and no trailing newline discipline.
    const written = '{"matched": false, "match_reason": "the catalog is empty"}\n';
    expect(structuredOutputOf(record(OUTPUT), turns(["assistant", written]))?.turn).toBe(0);
  });

  it("takes the LAST match, because the answer is the last thing a call says", () => {
    const said = turns(["assistant", JSON.stringify(OUTPUT)], ["user", "again"], ["assistant", JSON.stringify(OUTPUT)]);
    expect(structuredOutputOf(record(OUTPUT), said)?.turn).toBe(2);
  });

  it("refuses a turn that merely LOOKS like the output", () => {
    // The shape is right and the value is not — a model quoting its own answer back with one field
    // changed. A rule that matched on "declares JSON, parses as JSON" would relabel this as the
    // output, and the reader would be shown a value the binding never accepted.
    const near = JSON.stringify({ matched: true, match_reason: "the catalog is empty" });
    expect(structuredOutputOf(record(OUTPUT), turns(["assistant", near]))).toBeUndefined();
  });

  it("refuses prose that WRAPS the output, rather than digging the JSON out of it", () => {
    // Replacing the message is only safe because there is nothing in the text that is not in the
    // value. Here there is: the sentence around it, which would be silently dropped.
    const wrapped = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify(OUTPUT)}\n\`\`\``;
    expect(structuredOutputOf(record(OUTPUT), turns(["assistant", wrapped]))).toBeUndefined();
  });

  it("refuses a USER turn, however exactly it matches", () => {
    // A conversation replaying an earlier answer as input is an ordinary shape, and an instruction
    // rendered as this state's output would attribute the model's answer to the person.
    expect(structuredOutputOf(record(OUTPUT), turns(["user", JSON.stringify(OUTPUT)]))).toBeUndefined();
  });

  it("says nothing for a record that kept only its messages", () => {
    // A scripted fake, or a value-mode core whose payload was projected away inside the call. There
    // is no bound value to check against, and a rendering that cannot be checked is not offered.
    expect(structuredOutputOf(record(undefined), turns(["assistant", JSON.stringify(OUTPUT)]))).toBeUndefined();
  });

  it("leaves a TEXT output alone", () => {
    // A `kind: "text"` output binds to the string the model wrote, so every assistant turn of such a
    // call matches trivially — and the structured rendering of a string is markdown, which is what a
    // message already gets. Nothing to gain, and the fence renderer to lose.
    const bound = "# A heading\n\nand a paragraph.";
    expect(structuredOutputOf(record(bound, { name: "output", kind: "text" }), turns(["assistant", bound]))).toBeUndefined();
  });

  it("still names the turn when the request pinned no schema", () => {
    const found = structuredOutputOf(record(OUTPUT, { name: "plan_doc", kind: "json" }), turns(["assistant", JSON.stringify(OUTPUT)]));
    expect(found).toEqual({ turn: 0, value: OUTPUT, name: "plan_doc" });
  });

  it("finds an ARRAY output, which is structured too", () => {
    const bound = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(structuredOutputOf(record(bound), turns(["assistant", JSON.stringify(bound)]))?.value).toEqual(bound);
  });
});

/**
 * The other way a model hands one over: a tool call whose arguments ARE the value.
 *
 * An agent transport terminates with a value by calling a tool with it, and the acknowledgement it
 * gets back ("Structured output provided successfully") carries no information — so the transcript
 * showed a collapsed grey row, a meaningless result, and the answer behind a triangle.
 */
describe("finding the tool call that delivered a structured output", () => {
  const call = (id: string, toolName: string, input: JsonValue): JsonValue => ({ toolCallId: id, toolName, input });

  it("names the call whose arguments are the bound value", () => {
    const row = record(OUTPUT, null, [call("toolu_1", "StructuredOutput", OUTPUT)]);
    expect(structuredOutputOf(row, turns(["user", "go"]))).toEqual({ callId: "toolu_1", value: OUTPUT });
  });

  it("does not look at the tool's NAME", () => {
    // The name belongs to whichever transport ran, and a name test would answer wrongly the first
    // time one was added. The arguments are the evidence — see `producedArtifact` on the same point.
    const row = record(OUTPUT, null, [call("toolu_1", "some_other_transports_name", OUTPUT)]);
    expect(structuredOutputOf(row, turns())?.callId).toBe("toolu_1");
  });

  it("leaves the intermediate calls of the loop alone", () => {
    const calls = [call("c1", "read_file", { path: "a.ts" }), call("c2", "StructuredOutput", OUTPUT), call("c3", "bash", { command: "ls" })];
    expect(structuredOutputOf(record(OUTPUT, null, calls), turns())?.callId).toBe("c2");
  });

  it("refuses a call whose arguments are merely CLOSE to the output", () => {
    const near = { matched: true, match_reason: "the catalog is empty" };
    expect(structuredOutputOf(record(OUTPUT, null, [call("c1", "StructuredOutput", near)]), turns())).toBeUndefined();
  });

  it("prefers the MESSAGE when both would match", () => {
    // A shape that should not arise, and the message wins because it is what a reader is looking at.
    const row = record(OUTPUT, null, [call("c1", "StructuredOutput", OUTPUT)]);
    const found = structuredOutputOf(row, turns(["assistant", JSON.stringify(OUTPUT)]));
    expect(found).toEqual({ turn: 0, value: OUTPUT });
  });

  it("skips a call the record kept no id for, which nothing could be attached to", () => {
    const row = record(OUTPUT, null, [{ toolName: "StructuredOutput", input: OUTPUT } as JsonValue]);
    expect(structuredOutputOf(row, turns())).toBeUndefined();
  });

  it("carries the slot's schema and name onto a call, exactly as onto a message", () => {
    const row = record(OUTPUT, { name: "verdict", kind: "json", schema: SCHEMA }, [call("c1", "StructuredOutput", OUTPUT)]);
    expect(structuredOutputOf(row, turns())).toEqual({ callId: "c1", value: OUTPUT, schema: SCHEMA, name: "verdict" });
  });
});
