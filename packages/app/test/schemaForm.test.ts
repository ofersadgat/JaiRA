/**
 * The generic form, against the schemas this app actually has.
 *
 * It was ported from a project whose schemas were written FOR a form: flat objects of scalars, every
 * shape spelled out where it is used. `shared/schemas.ts` is not that. Those documents are written
 * for an editor's completion and for validation, so a shape used twice is declared once under
 * `definitions` and referred to — three hundred `$ref`s in the state schema alone — and the maps a
 * state is mostly made of (`inputs`, `outputs`) carry no `properties` at all, because the keys are
 * the author's.
 *
 * Rendered to static markup, like the other view tests here. Three properties are worth holding
 * down, and each one was a defect before it was a test:
 *
 *  - A reference is FOLLOWED, or a member declared once and used twice draws as a heading with
 *    nothing under it.
 *  - A reference that has already been followed on this path is NOT followed again. A JSON Schema
 *    that describes JSON Schema refers to itself, a slot's `schema` member is one, and a renderer
 *    that draws every declared property therefore recursed until the window stopped responding.
 *    That is a hang rather than a crash: nothing throws, so nothing but a test like this catches it.
 *  - A form that READS a document draws what the document says, not what its schema permits.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { schemaById } from "@jaira/shared/browser";
import { SchemaForm } from "../src/renderer/schemaForm/SchemaForm";
import type { Schema, SchemaFormContext } from "../src/renderer/schemaForm/types";

const STATE = schemaById("state")!.document as unknown as Schema;

/** The document a form is a reading OF — a small state, with both kinds of map filled in. */
const DOC = {
  label: "Review the changeset",
  inputs: { changeset: { schema: { type: "object" } } },
  outputs: { verdict: { schema: { type: "string" } } },
  operation: { kind: "prompt", prompt: "Read the diff." },
};

const draw = (schema: Schema, value: unknown, ctx: Partial<SchemaFormContext> = {}): string =>
  renderToStaticMarkup(
    createElement(SchemaForm, { schema, value, onChange: () => undefined, ctx: { path: "", ...ctx } }),
  );

describe("a form built from one of this app's own schemas", () => {
  it("terminates on a schema that refers to itself", () => {
    // The whole test, and it is a timeout rather than an assertion: a slot's `schema` member is a
    // JSON Schema describing JSON Schema, whose `items` refers back to it. Following that for ever
    // is not an exception — it is a render that never returns, which is why this is worth a test of
    // its own rather than a line in another one.
    const html = draw(STATE, DOC, { reading: true });
    expect(html.length).toBeGreaterThan(0);
  });

  it("follows a reference, so a member declared once still draws", () => {
    // `inputs.changeset` is a slot, and a slot is declared under `definitions`. Before references
    // were followed this was an object with no properties: a heading with nothing beneath it.
    expect(draw(STATE, DOC, { reading: true })).toContain("JSON Schema for the value");
  });

  it("draws the members of a MAP, whose keys are the author's", () => {
    // `inputs` and `outputs` have no `properties` — every key is the author's, described by
    // `additionalProperties`. So the names come from the VALUE, which is the only place they exist,
    // and a state file's whole input and output list was invisible until they did.
    const html = draw(STATE, DOC, { reading: true });
    expect(html).toContain("changeset");
    expect(html).toContain("verdict");
  });

  it("reading a document draws what it SAYS, not what its schema permits", () => {
    const reading = draw(STATE, DOC, { reading: true });
    const whole = draw(STATE, DOC, {});
    expect(reading).toContain("label");
    // `transitions`, `children`, `limits` — declared, unstated, and not this document's business.
    expect(reading).not.toContain("transitions");
    expect(whole).toContain("transitions");
    // Which is also why it is much shorter: the point is a reader seeing four fields rather than
    // thirty, and the empty ones being the majority is exactly the problem.
    expect(reading.length).toBeLessThan(whole.length);
  });

  it("keeps drawing the whole shape where the form is a form", () => {
    // `reading` is NOT `disabled`. A locked settings pane — a project layer you may look at but not
    // edit — is disabled and still has to answer "what could be set here", so hiding unset members
    // there would be hiding the thing somebody opened it to find out.
    const locked = draw(STATE, {}, { disabled: true });
    expect(locked).toContain("transitions");
  });
});
