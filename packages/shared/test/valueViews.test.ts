/**
 * Which views a value has, and how big a change is.
 *
 * The two halves of `valueViews.ts` are the two things a rendering surface must not decide for
 * itself: what a value IS, and how much of it moved. Both are here because both are pure, and
 * because the failure mode of getting either wrong is silent — a markdown answer shown as text is
 * merely ugly, but a `+12 −3` that disagrees with the diff under it is a lie about the change.
 */
import { describe, expect, it } from "vitest";
import {
  artifactOf,
  changeStats,
  changesOf,
  isCodeMime,
  looksLikeHtml,
  looksLikeMarkdown,
  mediaKindOf,
  mediaSrcOf,
  totalStats,
  viewsFor,
  editorKindOf,} from "../src/valueViews";

describe("which views apply", () => {
  it("reads a structured value two ways: highlighted, and as what was actually serialised", () => {
    // It used to offer only `json`, on the grounds that an object has one honest rendering. That was
    // true while `json` WAS the raw text. It is not any more — the JSON view is a viewer, with the
    // schema's own descriptions ghosted beside the keys — so the serialization underneath it is a
    // second reading, and the same reversibility argument that keeps `text` under every rendered
    // string applies to it.
    expect(viewsFor({ verdict: "gaps", count: 3 })).toEqual(["json", "text"]);
    expect(viewsFor(42)).toEqual(["json", "text"]);
  });

  it("offers a form for a value whose schema describes named members", () => {
    // The most legible reading of a value somebody wrote a shape for is the shape.
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    // Behind the coloured value rather than in front of it — see `viewsFor` on why the record is
    // the lead reading and the form is the alternative.
    expect(viewsFor({ verdict: "gaps" }, { schema })).toEqual(["json", "form", "text"]);
    // …and not for a schema that describes a string, which has no members to lay out.
    expect(viewsFor("words", { schema: { type: "string" } })).toEqual(["text"]);
  });

  it("keeps the source available behind every rendering", () => {
    // The whole point of a toggle: a rendering is a CLAIM about what the model wrote, and the way
    // you check one is to look at the thing itself.
    expect(viewsFor("# Title\n\n- one\n- two")).toEqual(["markdown", "text"]);
    expect(viewsFor("plain words")).toEqual(["text"]);
  });

  it("believes a declared media type over the sniffer", () => {
    // A single dash is not two structural marks, so the sniffer would decline — and the slot said so.
    const hint = { schema: { type: "string", contentMediaType: "markdown" } };
    expect(viewsFor("- just one bullet", hint)).toEqual(["markdown", "text"]);
    expect(viewsFor("anything at all", { mime: "text/html" })).toEqual(["html", "code", "text"]);
  });

  it("puts the file view first when the value is a set of files, and keeps the JSON behind it", () => {
    const edits = [{ path: "workflows/a.json", action: "create", text: "{}" }];
    expect(viewsFor(edits)).toEqual(["changes", "json", "text"]);
  });

  it("offers a code view for text with a grammar, and not for text without one", () => {
    expect(viewsFor("const a = 1;\n", { mime: "text/x-typescript" })).toEqual(["code", "text"]);
    // Plain text has no grammar to colour, and markdown has a renderer that beats highlighting it.
    expect(viewsFor("just words", { mime: "text/plain" })).toEqual(["text"]);
    expect(viewsFor("# Title", { mime: "text/markdown" })).toEqual(["markdown", "text"]);
    // HTML earns all three: rendered says what it looks like, code says what it says.
    expect(viewsFor("<p>hi</p>", { mime: "text/html" })).toEqual(["html", "code", "text"]);
  });

  it("reads a structured DOCUMENT as data too, under the source rather than in front of it", () => {
    // The gap this closed: a YAML or JSON document had colours and nothing else, so a file whose
    // whole content is data could not be read as data. See `structured.ts` on why the parsed form
    // goes underneath — it drops comments, block scalars and anchors, and a lossy rendering does not
    // get to be the default.
    expect(viewsFor("a: 1\n", { mime: "application/yaml" })).toEqual(["code", "data", "text"]);
    expect(viewsFor('{"a": 1}', { mime: "application/json" })).toEqual(["code", "data", "text"]);
    // A vendor type inherits it, which is the whole reason resolution walks the fallback chain.
    expect(viewsFor("id: plan\n", { mime: "application/vnd.jaira.workflow+yaml" })).toEqual(["code", "data", "text"]);
    // …and a schema makes the fields readable as fields, on the same terms as a value that arrived
    // already parsed.
    const schema = { type: "object", properties: { a: { type: "number" } } };
    expect(viewsFor("a: 1\n", { mime: "application/yaml", schema })).toEqual(["code", "data", "form", "text"]);
  });

  it("leads with the table for a delimited file, because its source is a transport", () => {
    // The asymmetry with YAML above is the one judgement in that branch: a wall of commas is to a
    // table what unrendered markdown is to a document, and nobody opens a CSV to admire the commas.
    // No `code` between them, and that is the other half of the fix: nothing can colour a CSV, so
    // the button that claimed to would have shown text identical to `text`. See `isCodeMime`.
    expect(viewsFor("a,b\n1,2\n", { mime: "text/csv" })).toEqual(["table", "text"]);
    expect(viewsFor("a\tb\n", { mime: "text/tab-separated-values" })).toEqual(["table", "text"]);
  });

  it("offers the data reading on the declared type alone, broken document included", () => {
    // Deliberate, and the opposite of how `media` is offered. A document that will not parse is
    // exactly when the reading earns its place — the view names the line it broke on — and a button
    // that disappeared at the first syntax error would hide the one answer it has.
    expect(viewsFor("a:\n\t- 1\n", { mime: "application/yaml" })).toContain("data");
    // Nothing is SNIFFED into it, though: every plain text file is also a valid YAML document, so a
    // sniffer would offer this everywhere and mean nothing by it.
    expect(viewsFor("a: 1\n")).toEqual(["text"]);
    expect(viewsFor("a: 1\n", { mime: "text/plain" })).toEqual(["text"]);
  });

  it("leads with the patch reading for a diff, and stops it reading as a bullet list", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " a", "-b", "+c", ""].join("\n");
    // No `code` either — Monaco ships no diff grammar, so the reading and the source are all
    // there is. See `isCodeMime`, which now asks the grammar table instead of guessing.
    expect(viewsFor(patch, { mime: "text/x-diff" })).toEqual(["patch", "text"]);
    // The bug the suppression exists for: a removed line begins `-` at the start of a line, which is
    // markdown's bullet mark exactly, so a patch scored two marks and led with the markdown view.
    expect(viewsFor(patch)).toEqual(["patch", "text"]);
    expect(viewsFor(patch)).not.toContain("markdown");
  });

  it("sniffs a patch only on the hunk mark, and never over a declared plain type", () => {
    // The mark is what earns the exception — see `viewsFor`. Prose that merely talks about diffs is
    // not one, and "this really is just text" has to keep meaning that.
    expect(viewsFor("we rewrote it, +3 −1, see the diff")).toEqual(["text"]);
    expect(viewsFor(["@@ -1 +1 @@", "-a", "+b", ""].join("\n"), { mime: "text/plain" })).toEqual(["text"]);
  });

  it("renders a drawing first and keeps its source underneath", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`;
    // The rendering leads because "what does this look like" is what you ask of a drawing; `code`
    // and `text` are what answer "why is it wrong". Exactly ONE rendered view — SVG is markup, so
    // the HTML sniffer recognises it too, and two buttons showing the same picture is one too many.
    expect(viewsFor(svg, { mime: "image/svg+xml" })).toEqual(["media", "code", "text"]);
  });

  it("still believes an author who declares HTML over markup that would also render as a picture", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`;
    expect(viewsFor(svg, { mime: "text/html" })).toEqual(["html", "code", "text"]);
  });

  it("offers media only when a player has something to point at", () => {
    // The type alone is not enough — an image slot holding a description is not an image.
    expect(viewsFor("not a picture", { mime: "image/png" })).toEqual(["text"]);
    expect(viewsFor("https://example.test/a.png", { mime: "image/png" })[0]).toBe("media");
    expect(viewsFor({ uri: "https://example.test/a.mp4" }, { mime: "video/mp4" })).toEqual(["media", "json", "text"]);
  });
});

describe("media", () => {
  it("names the player a type wants, SVG included", () => {
    expect(mediaKindOf("image/png")).toBe("image");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("text/plain")).toBeUndefined();
    // SVG renders as a picture now. The source it used to be held back for is not lost — see the
    // views test below, where `code` and `text` sit underneath the rendering.
    expect(mediaKindOf("image/svg+xml")).toBe("image");
  });

  it("takes a URL as it is and wraps raw base64 in a data URI", () => {
    expect(mediaSrcOf("data:image/png;base64,AAAA", "image/png")).toBe("data:image/png;base64,AAAA");
    expect(mediaSrcOf({ url: "https://example.test/a.png" }, "image/png")).toBe("https://example.test/a.png");
    const b64 = "A".repeat(40);
    expect(mediaSrcOf(b64, "image/png")).toBe(`data:image/png;base64,${b64}`);
    // A short word is not base64 no matter what the type claims.
    expect(mediaSrcOf("hello", "image/png")).toBeUndefined();
  });

  it("points an SVG at its own source, percent-encoded", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/></svg>`;
    // `#` would truncate the URI as a fragment if this were pasted in raw — the encoding is what
    // makes an ordinary fill colour survive the trip.
    expect(mediaSrcOf(svg, "image/svg+xml")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    // A type claiming SVG over something that is not markup gets no player, like every other type.
    expect(mediaSrcOf("just a description", "image/svg+xml")).toBeUndefined();
  });

  it("knows which text has a grammar worth colouring", () => {
    expect(isCodeMime("application/json")).toBe(true);
    expect(isCodeMime("application/vnd.jaira.workflow+json")).toBe(true);
    expect(isCodeMime("text/plain")).toBe(false);
    expect(isCodeMime("text/markdown")).toBe(false);
    expect(isCodeMime("image/png")).toBe(false);
  });

  describe("sniffing, which offers and never decides", () => {
    it("wants two structural marks before calling a string markdown", () => {
      // One bullet is every stack trace and every hand-typed list; two marks is a document.
      expect(looksLikeMarkdown("- a lone bullet")).toBe(false);
      expect(looksLikeMarkdown("# Heading\n\n- a bullet")).toBe(true);
      expect(looksLikeMarkdown("")).toBe(false);
    });

    it("wants a real element before calling a string HTML", () => {
      expect(looksLikeHtml("a < b and c > d")).toBe(false);
      expect(looksLikeHtml("Array<string> is a type")).toBe(false);
      expect(looksLikeHtml("<div><p>hi</p></div>")).toBe(true);
      expect(looksLikeHtml("<!doctype html><title>x</title>")).toBe(true);
    });
  });
});

describe("reading a value as an artifact", () => {
  const ENGINE = { artifact: true, name: "feature.plan#3.plan_doc", format: "text/html", content: "<p>hi</p>" };

  it("takes the engine's registration and a tool's envelope alike", () => {
    expect(artifactOf(ENGINE)).toEqual({ mime: "text/html", content: "<p>hi</p>", name: "feature.plan#3.plan_doc" });
    expect(artifactOf({ mediaType: "text/markdown", content: "# hi" })).toEqual({ mime: "text/markdown", content: "# hi" });
    // A reference with the bytes left behind is still an artifact — that is the large-content case.
    expect(artifactOf({ mediaType: "text/html", uri: "artifact://t1/mockup.html" })).toEqual({
      mime: "text/html",
      uri: "artifact://t1/mockup.html",
    });
  });

  it("unwraps a single-key wrapper, which is what one blob output slot produces", () => {
    expect(artifactOf({ plan_doc: ENGINE })?.content).toBe("<p>hi</p>");
  });

  it("refuses to unwrap when there is something else in the object", () => {
    // Rendering `plan_doc` here would hide `notes` completely, which is worse than showing JSON.
    expect(artifactOf({ plan_doc: ENGINE, notes: ["a"] })).toBeUndefined();
  });

  it("answers undefined for a value that is not an artifact", () => {
    // The shape that would match if a declared type were not required — half the payloads in a
    // transcript carry a `content` string.
    expect(artifactOf({ path: "a.ts", content: "x" })).toBeUndefined();
    expect(artifactOf({ mediaType: "text/html" })).toBeUndefined();
    expect(artifactOf("<p>hi</p>")).toBeUndefined();
    expect(artifactOf({ uri: "https://example.test/a.mp4" })).toBeUndefined();
  });

  it("is read as what it carries, with the envelope kept behind it", () => {
    // The declared type reaches the renderer, so this is the HTML view rather than a JSON dump —
    // and `json` is last, which is where you check what the producer actually handed over.
    expect(viewsFor(ENGINE)).toEqual(["html", "code", "text", "json"]);
    expect(viewsFor({ plan_doc: { artifact: true, name: "x", format: "markdown", content: "- a" } })).toEqual([
      "markdown",
      "text",
      "json",
    ]);
  });

  it("has only the envelope to show when the content did not travel", () => {
    expect(viewsFor({ mediaType: "text/html", uri: "artifact://t1/mockup.html" })).toEqual(["json"]);
  });
});

describe("reading a value as file changes", () => {
  it("takes a changeset, a bare change list, and a whole-file proposal alike", () => {
    const proposal = [{ path: "a.ts", action: "create", text: "x\n", reason: "R1" }];
    expect(changesOf(proposal)).toEqual([{ id: "c1", path: "a.ts", action: "create", after: "x\n", reason: "R1" }]);
    // The same rows behind the name a sync's output slot gives them.
    expect(changesOf({ edits: proposal })).toHaveLength(1);
    // And a real changeset, whose `source` pins the version the `before` text came from.
    expect(changesOf({ source: "file:/x#sha256=aa", changes: [{ id: "c9", path: "b.ts", action: "update", before: "a", after: "b" }] })).toEqual([
      { id: "c9", path: "b.ts", action: "update", before: "a", after: "b" },
    ]);
  });

  it("answers undefined for a value that is not about files", () => {
    // `undefined` rather than `[]`, because an empty changeset is a real value with a real rendering
    // and must not be confused with a value that was never about files.
    expect(changesOf([{ id: "R1", requirement: "does a thing" }])).toBeUndefined();
    expect(changesOf("some text")).toBeUndefined();
    expect(changesOf([])).toBeUndefined();
    // A path with no content either side is not a change anybody can show.
    expect(changesOf([{ path: "a.ts", action: "update" }])).toBeUndefined();
  });
});

describe("how big a change is", () => {
  it("counts a create as all added and a delete as all removed", () => {
    expect(changeStats({ after: "a\nb\nc\n" })).toEqual({ added: 3, removed: 0 });
    expect(changeStats({ before: "a\nb\n" })).toEqual({ added: 0, removed: 2 });
  });

  it("counts only the lines that actually moved", () => {
    // Common prefix and suffix are not churn — a one-line edit in a long file is one line.
    const before = "1\n2\n3\n4\n5\n";
    const after = "1\n2\nX\n4\n5\n";
    expect(changeStats({ before, after })).toEqual({ added: 1, removed: 1 });
  });

  it("says nothing moved when nothing moved", () => {
    expect(changeStats({ before: "same\n", after: "same\n" })).toEqual({ added: 0, removed: 0 });
  });

  it("counts an insertion as added with nothing removed", () => {
    expect(changeStats({ before: "a\nc\n", after: "a\nb\nc\n" })).toEqual({ added: 1, removed: 0 });
  });

  it("sums a whole proposal for the header figure", () => {
    expect(totalStats([{ after: "a\nb\n" }, { before: "x\n" }])).toEqual({ added: 2, removed: 1 });
  });
});

/**
 * Which editor an artifact gets (decision 0002) — the dispatch that replaced a single textarea.
 *
 * The case that matters is `readonly`: `edit_artifact` used to hand back a textarea whatever it was
 * given, so a PNG arrived as a wall of base64 that a person could edit into nonsense.
 */
describe("editorKindOf", () => {
  it("refuses to edit anything a player would render", () => {
    for (const mime of ["image/png", "image/svg+xml", "video/mp4", "audio/mpeg"]) {
      expect(editorKindOf(mime, "")).toBe("readonly");
    }
  });

  it("gives JSON its own editor, vendor types included", () => {
    expect(editorKindOf("application/json", "{}")).toBe("json");
    expect(editorKindOf("application/vnd.jaira.workflow+json", "{}")).toBe("json");
  });

  it("gives markdown its own, and lets the DECLARED type beat the text", () => {
    expect(editorKindOf("text/markdown", "no hashes here")).toBe("markdown");
    // Declared as plain text, so the markdown-looking body does not overrule it.
    expect(editorKindOf("text/plain", "# a heading\n\n- a list")).toBe("text");
  });

  it("sniffs only when nothing declared a type", () => {
    expect(editorKindOf(undefined, "# a heading\n\n- a list")).toBe("markdown");
    expect(editorKindOf(undefined, "just a sentence")).toBe("text");
  });

  it("falls through to the plain editor for source, which is its own presentation", () => {
    expect(editorKindOf("text/x-typescript", "const a = 1;")).toBe("text");
  });
});

describe("counting markdown marks", () => {
  it("reads a sentence with a bullet list under it as the document it is", () => {
    // The case the old rule missed, and the commonest thing anybody actually types. Three bullets
    // and nothing else is one KIND of mark, so requiring two kinds read it as plain text.
    expect(looksLikeMarkdown("Two things:\n\n- did the check pass?\n- what did it say?")).toBe(true);
    expect(looksLikeMarkdown("1. read it\n2. fix it")).toBe(true);
  });

  it("still refuses a single stray mark, which is what the rule was written for", () => {
    expect(looksLikeMarkdown("at Object.<anonymous> - /w/p/a.ts:12")).toBe(false);
    expect(looksLikeMarkdown("- just one bullet")).toBe(false);
    expect(looksLikeMarkdown("plain words with an * in them")).toBe(false);
  });

  it("still takes two marks of different kinds", () => {
    expect(looksLikeMarkdown("# Title\n\n- one")).toBe(true);
  });
});

describe("code is not a document, whatever its comments look like", () => {
  /** A doc-commented C++ file, which is where the sniffer used to go wrong. */
  const cpp = [
    "#include <iostream>",
    "",
    "/**",
    " * Adds two numbers.",
    " * @param a the first",
    " * @param b the second",
    " */",
    "int add(int a, int b) {",
    "  return a + b;",
    "}",
  ].join("\n");

  it("does not read a doc comment's continuation lines as a bullet list", () => {
    // ` * text` IS the bullet mark, and two of them is every C++, Java, JS and TS header ever
    // written. Read as markdown, the comment became a list and the code under it became prose.
    expect(looksLikeMarkdown(cpp)).toBe(false);
  });

  it("still reads a document that merely QUOTES a block comment", () => {
    // The marks outside the comment are untouched — only the ones inside it stop counting.
    expect(looksLikeMarkdown("# How to log\n\n- wrap it in `/* … */`\n- ship it")).toBe(true);
  });

  it("offers code rather than markdown once the type is declared", () => {
    // The robust half: a declared type beats the sniffer, so a `.cpp` payload never depends on
    // what its comments happen to look like.
    expect(viewsFor(cpp, { mime: "text/x-c++src" })).toEqual(["code", "text"]);
  });
});

describe("asserting a type is a correction that has to land", () => {
  it("gives a declared diff its reading even when the text does not announce itself", () => {
    // `text/x-diff` is in OFFERED_TYPES, so "no, this IS a diff" is something a person says about a
    // value the sniffer read as prose. Gating the reading on the sniffer made that control do
    // nothing — caught by `typeNames.test.ts`, which holds every offered type to producing a reading.
    expect(viewsFor("some text", { mime: "text/x-diff" })).toEqual(["patch", "text"]);
    // The view itself still declines gracefully: a parse that finds no patch falls back to Source.
    expect(viewsFor("some text", { schema: { type: "string", contentMediaType: "diff" } })).toEqual([
      "patch",
      "text",
    ]);
  });
});
