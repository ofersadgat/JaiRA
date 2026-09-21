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

  it("draws no switches and no shape chips in a READING — it is not asking anything", () => {
    const html = draw(STATE, DOC, { reading: true });
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("sf-pick");
  });

  it("keeps drawing the whole shape where the form is a form", () => {
    // `reading` is NOT `disabled`. A locked settings pane — a project layer you may look at but not
    // edit — is disabled and still has to answer "what could be set here", so hiding unset members
    // there would be hiding the thing somebody opened it to find out.
    const locked = draw(STATE, {}, { disabled: true });
    expect(locked).toContain("transitions");
  });
});

/**
 * A form somebody fills in — a state's inputs, as the Run panel draws them.
 *
 * The real `feature` inputs, because they are the ones that broke: an `enum` slot drawn as a JSON box
 * refused `significant`, and a bounded number was never checked against its bounds.
 */
describe("a form somebody fills in", () => {
  const FEATURE: Schema = {
    type: "object",
    properties: {
      issue: { type: "string", contentMediaType: "text/markdown", minLength: 1 },
      severity_threshold: { type: "string", enum: ["blocker", "significant", "minor", "note"], default: "significant" },
      threshold_rank: { type: "integer", default: 2 },
      ask_below: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
    },
    required: ["issue"],
  };
  const keys = { labels: "keys" as const };

  it("puts a switch before every member that may be left out, and none before a required one", () => {
    const html = draw(FEATURE, { issue: "" }, keys);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="set severity_threshold"');
    expect(html).not.toContain('aria-label="set issue"');
  });

  it("says what a switched-off member gets instead of drawing a box for it", () => {
    const html = draw(FEATURE, { issue: "" }, keys);
    expect(html).toContain("not set — the default applies: significant");
    expect(html).toContain("not set — the default applies: 0.8");
  });

  it("draws a switched-on enum as a box with the allowed values to pick from, not a JSON box", () => {
    const html = draw(FEATURE, { issue: "", severity_threshold: "minor" }, keys);
    expect(html).toContain("<datalist");
    for (const option of ["blocker", "significant", "minor", "note"]) expect(html).toContain(`value="${option}"`);
    expect(html).toContain('value="minor"');
    expect(html).toContain("one of 4");
  });

  it("says what a bounded number allows beside its name", () => {
    expect(draw(FEATURE, { issue: "", ask_below: 1.5 }, keys)).toContain("number · 0 to 1");
  });

  it("shows a complaint under its field once the field has been touched, and not before", () => {
    const errors = [{ path: "ask_below", message: "must be at most 1" }];
    const untouched = draw(FEATURE, { issue: "", ask_below: 1.5 }, { ...keys, errors, touched: () => false });
    const touched = draw(FEATURE, { issue: "", ask_below: 1.5 }, { ...keys, errors, touched: (p) => p === "ask_below" });
    expect(untouched).not.toContain("must be at most 1");
    expect(touched).toContain("must be at most 1");
  });

  it("draws a choice of shapes as chips after the name, with the chosen shape's fields under it", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        anchor: {
          anyOf: [
            { title: "path", type: "string" },
            { title: "path + line", type: "object", required: ["path", "line"], properties: { path: { type: "string" }, line: { type: "integer" } } },
            { type: "null" },
          ],
        },
      },
    };
    const html = draw(schema, { anchor: { path: "runForm.ts", line: 221 } }, keys);
    expect(html).toContain("sf-pick");
    expect(html).toContain(">path + line<");
    expect(html).toContain(">none<");
    expect(html).toContain('value="runForm.ts"');
    expect(draw(schema, { anchor: null }, keys)).toContain("sends null");
  });

  it("opens a list at closed rows that read as their first values — unless a row has a problem in it", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        criteria: { type: "array", items: { type: "object", properties: { id: { type: "string" }, statement: { type: "string" } } } },
      },
      required: ["criteria"],
    };
    const value = { criteria: [{ id: "AC-1", statement: "Pause survives an app restart" }, { id: "AC2", statement: "" }] };
    const html = draw(schema, value, { ...keys, errors: [{ path: "criteria[1].id", message: "must match ^AC-\d+$" }] });
    expect(html).toContain("AC-1 · Pause survives an app restart");
    // Row 1 is troubled, so it is open: its box is drawn rather than its summary.
    expect(html).toContain('value="AC2"');
    expect(html).not.toContain('value="AC-1"');
  });

  it("draws a free-key object as key and value rows you can add to", () => {
    const schema: Schema = { type: "object", properties: { env: { type: "object", additionalProperties: { type: "string" } } }, required: ["env"] };
    const html = draw(schema, { env: { NODE_OPTIONS: "--max-old-space-size=4096" } }, keys);
    expect(html).toContain('value="NODE_OPTIONS"');
    expect(html).toContain('value="--max-old-space-size=4096"');
    expect(html).toContain("+ add key");
  });

  it("reads a LAYER's switch from what the layer states, and names what a switched-off field inherits", () => {
    const settings: Schema = { type: "object", properties: { enabled: { type: "boolean" }, path: { type: "string" } } };
    const html = draw(settings, { enabled: true, path: "workflows" }, { path: "memo", isSet: (p) => p === "memo.enabled" });
    expect(html).toContain('aria-label="enabled is set here — switch off to inherit it"');
    expect(html).toContain('aria-label="set path here"');
    // The switch IS the mark: the "set here" tag is not drawn beside it as well.
    expect(html).not.toContain("cfg-set");
    expect(html).toContain("not set here — inherits workflows");
  });

  it("marks how a recorded value was settled, after its type — and says nothing where nothing was recorded", () => {
    const schema: Schema = { type: "object", properties: { feature: { type: "string" }, patterns: { type: "string" }, units: { type: "string" }, old: { type: "string" } } };
    const settled = { feature: { via: "bound" as const, note: "bound — from Product · brief" }, patterns: { via: "inferred" as const, confidence: 0.78 }, units: { via: "asked" as const } };
    const html = draw(schema, { feature: "f", patterns: "p", units: "u", old: "o" }, { ...keys, provenance: (path) => settled[path as keyof typeof settled] });
    expect(html).toContain('<span class="prov prov-bound" title="bound — from Product · brief">bound</span>');
    expect(html).toContain('<span class="prov prov-inferred">inferred</span><span class="conf">0.78</span>');
    expect(html).toContain('<span class="prov prov-asked">asked</span>');
    expect(html.match(/class="prov /g)).toHaveLength(3);
  });

  it("offers a member somewhere else its value can come from, and draws the pick instead of a box", () => {
    const schema: Schema = { type: "object", properties: { brief: { type: "string" }, tone: { type: "string" } }, required: ["brief", "tone"] };
    const sources = (picked: string | undefined) => ({
      label: "from a task…",
      optionsFor: (path: string) => (path === "brief" ? [{ id: "t-1#brief", label: "Product · brief", note: "the brief" }] : []),
      picked: (path: string) => (path === "brief" ? picked : undefined),
      pick: () => undefined,
    });
    // Offered and not taken: the chip, and the member's own box still.
    const typed = draw(schema, { brief: "typed", tone: "plain" }, { ...keys, sources: sources(undefined) });
    expect(typed.match(/from a task…/g)).toHaveLength(1);
    expect(typed).toContain('value="typed"');
    // Taken: the box is gone, the picker and what the source holds are in its place.
    const taken = draw(schema, { tone: "plain" }, { ...keys, sources: sources("t-1#brief") });
    expect(taken).toContain('<option value="t-1#brief" selected="">Product · brief</option>');
    expect(taken).toContain('<div class="sf-absent">the brief</div>');
    expect(taken).toContain('class="cfg-chip on"');
    expect(taken).toContain('value="plain"');
    // A reading offers nothing.
    expect(draw(schema, { brief: "b", tone: "t" }, { ...keys, reading: true, sources: sources(undefined) })).not.toContain("from a task…");
  });
});
