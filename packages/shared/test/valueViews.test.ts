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
  changeStats,
  changesOf,
  isCodeMime,
  looksLikeHtml,
  looksLikeMarkdown,
  mediaKindOf,
  mediaSrcOf,
  totalStats,
  viewsFor,
} from "../src/valueViews";

describe("which views apply", () => {
  it("offers only JSON for an ordinary value — nothing to toggle to", () => {
    expect(viewsFor({ verdict: "gaps", count: 3 })).toEqual(["json"]);
    expect(viewsFor(42)).toEqual(["json"]);
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
    expect(viewsFor(edits)).toEqual(["changes", "json"]);
  });

  it("offers a code view for text with a grammar, and not for text without one", () => {
    expect(viewsFor("const a = 1;\n", { mime: "text/x-typescript" })).toEqual(["code", "text"]);
    // Plain text has no grammar to colour, and markdown has a renderer that beats highlighting it.
    expect(viewsFor("just words", { mime: "text/plain" })).toEqual(["text"]);
    expect(viewsFor("# Title", { mime: "text/markdown" })).toEqual(["markdown", "text"]);
    // HTML earns all three: rendered says what it looks like, code says what it says.
    expect(viewsFor("<p>hi</p>", { mime: "text/html" })).toEqual(["html", "code", "text"]);
  });

  it("offers media only when a player has something to point at", () => {
    // The type alone is not enough — an image slot holding a description is not an image.
    expect(viewsFor("not a picture", { mime: "image/png" })).toEqual(["text"]);
    expect(viewsFor("https://example.test/a.png", { mime: "image/png" })[0]).toBe("media");
    expect(viewsFor({ uri: "https://example.test/a.mp4" }, { mime: "video/mp4" })).toEqual(["media", "json"]);
  });
});

describe("media", () => {
  it("names the player a type wants, and leaves SVG to the text views", () => {
    expect(mediaKindOf("image/png")).toBe("image");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("text/plain")).toBeUndefined();
    // Markup with a source worth reading — treating it as an opaque picture takes that away.
    expect(mediaKindOf("image/svg+xml")).toBeUndefined();
  });

  it("takes a URL as it is and wraps raw base64 in a data URI", () => {
    expect(mediaSrcOf("data:image/png;base64,AAAA", "image/png")).toBe("data:image/png;base64,AAAA");
    expect(mediaSrcOf({ url: "https://example.test/a.png" }, "image/png")).toBe("https://example.test/a.png");
    const b64 = "A".repeat(40);
    expect(mediaSrcOf(b64, "image/png")).toBe(`data:image/png;base64,${b64}`);
    // A short word is not base64 no matter what the type claims.
    expect(mediaSrcOf("hello", "image/png")).toBeUndefined();
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
