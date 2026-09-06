/**
 * What a type is called.
 *
 * Pure, and worth testing for one reason: this is the only module in the app whose output is read by
 * a person rather than by a function, so its failures are invisible to every other test. A wrong
 * view id breaks a rendering and something notices; a chip reading `text/x-typescript` where it
 * should read `TypeScript` breaks nothing and is simply what the product looks like from then on.
 */
import { describe, expect, it } from "vitest";
import { OFFERED_TYPES, typeNameOf } from "../src/typeNames";
import { viewsFor } from "../src/valueViews";

describe("naming a type", () => {
  it("uses the name of the thing, spelled the way the thing spells it", () => {
    expect(typeNameOf("text/markdown").label).toBe("Markdown");
    expect(typeNameOf("text/x-typescript").label).toBe("TypeScript");
    expect(typeNameOf("text/html").label).toBe("HTML");
    expect(typeNameOf("application/json").label).toBe("JSON");
  });

  it("groups by family rather than giving every language its own glyph", () => {
    // The rule the icon set depends on: these are four different names and one picture.
    for (const mime of ["text/x-typescript", "text/javascript", "text/x-python", "text/css"]) {
      expect(typeNameOf(mime).family).toBe("code");
    }
    expect(typeNameOf("text/markdown").family).toBe("prose");
    expect(typeNameOf("application/yaml").family).toBe("data");
    expect(typeNameOf("text/csv").family).toBe("table");
  });

  it("names a vendor type after the syntax underneath it, unless it says otherwise", () => {
    // One entry for markdown names every dialect of it — the reason resolution walks the chain, and
    // still what an unregistered vendor type gets.
    expect(typeNameOf("text/vnd.acme.notes+markdown").label).toBe("Markdown");
    expect(typeNameOf("application/vnd.acme.thing+json").label).toBe("JSON");
    // JaiRA's own four are named, and the reason is that a control started listing types by name
    // for a person to set a preference against: three rows all called "JSON" is a list nobody can
    // use, and what distinguishes them is exactly what the vendor type says.
    expect(typeNameOf("text/vnd.jaira.workflow-description+markdown").label).toBe("Workflow description");
    expect(typeNameOf("application/vnd.jaira.workflow+json").label).toBe("Workflow (JSON)");
    // The FAMILY still comes from the syntax, which is what keeps one glyph per kind of thing: a
    // workflow description is prose and a workflow is data, whoever wrote them.
    expect(typeNameOf("text/vnd.jaira.workflow-description+markdown").family).toBe("prose");
    expect(typeNameOf("application/vnd.jaira.workflow+json").family).toBe("data");
  });

  it("accepts the short spellings a slot actually authors", () => {
    expect(typeNameOf("markdown").label).toBe("Markdown");
    expect(typeNameOf("json").label).toBe("JSON");
  });

  it("ignores parameters and case, which arrive on real headers", () => {
    expect(typeNameOf("TEXT/Markdown; charset=utf-8").label).toBe("Markdown");
  });

  it("names a whole top-level type when there is no entry for the member", () => {
    expect(typeNameOf("image/avif")).toEqual({ label: "Image", family: "media" });
    expect(typeNameOf("audio/flac").family).toBe("media");
  });

  it("falls back to the type itself rather than inventing a name", () => {
    // A guess presented as a fact is exactly what the control exists to let somebody correct.
    expect(typeNameOf("application/vnd.nobody-registered").label).toBe("application/vnd.nobody-registered");
  });

  it("answers for nothing at all, because a message with no declared type still needs a word", () => {
    expect(typeNameOf(undefined).label).toBe("Plain text");
    expect(typeNameOf("").label).toBe("Plain text");
  });
});

describe("what may be asserted", () => {
  it("offers only types that produce a reading", () => {
    // The promise the menu makes: pick one of these and something changes on screen. A type whose
    // only view is `text` is the one you were already looking at.
    for (const mime of OFFERED_TYPES) {
      const views = viewsFor("some text", { mime });
      expect(views.length, `${mime} offers nothing beyond its source`).toBeGreaterThan(mime === "text/plain" ? 0 : 1);
    }
  });

  it("names every type it offers", () => {
    for (const mime of OFFERED_TYPES) {
      expect(typeNameOf(mime).label, mime).not.toBe(mime);
    }
  });

  it("leads with the pair almost every correction moves between", () => {
    expect(OFFERED_TYPES.slice(0, 2)).toEqual(["text/markdown", "text/plain"]);
  });
});
