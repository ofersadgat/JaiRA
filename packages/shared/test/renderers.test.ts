/**
 * Which views offer a choice of renderer, and when.
 *
 * The rule being guarded is that both entries must be genuine renderings of the same thing. An
 * "editable or not" pair is not that — a `<textarea>` and a `<pre>` over the same raw text draw
 * identical characters — and offering one made the menu a read/write switch in renderer clothing.
 * Code is the only view where two real renderers exist: an editor, and the tokenizer with no editor
 * behind it.
 */
import { describe, expect, it } from "vitest";
import { renderersFor, type ViewId } from "../src/valueViews";

const EVERY: ViewId[] = [
  "text",
  "json",
  "data",
  "table",
  "patch",
  "form",
  "markdown",
  "html",
  "code",
  "media",
  "changes",
];

describe("renderersFor", () => {
  it("offers the pair on code alone", () => {
    const offered = EVERY.filter((view) => renderersFor(view, "text/x-typescript", true).length > 1);
    expect(offered).toEqual(["code"]);
  });

  it("offers nothing on Source, where the two would draw the same characters", () => {
    expect(renderersFor("text", "text/x-typescript", true)).toEqual([]);
  });

  it("offers nothing on a value that cannot be changed, because the code view is what it already is", () => {
    expect(renderersFor("code", "text/x-typescript", false)).toEqual([]);
  });

  it("offers nothing for a type Monaco cannot colour — both renderers use its grammars", () => {
    expect(renderersFor("code", "text/plain", true)).toEqual([]);
    expect(renderersFor("code", undefined, true)).toEqual([]);
  });

  it("puts Monaco first, so the default is the editor it was before the choice existed", () => {
    expect(renderersFor("code", "text/x-typescript", true)[0]).toBe("monaco");
  });
});
