/**
 * What a right-click inside an artifact frame offers (`renderer/pointerMenu.tsx`).
 *
 * The frame branch is the one worth pinning down and the one a test can reach. A sandboxed artifact
 * has an opaque origin, so nothing in the renderer can look at what was clicked — the whole decision
 * is made from the description the browser process forwards, which makes it a pure function of a
 * value and the only part of this feature that is testable without a window.
 *
 * The other branch reads the DOM and cannot run here. What it shares with this one is the shape of
 * the answer: an empty list means "show nothing", which is a real outcome rather than a failure to
 * decide.
 */
import { describe, expect, it } from "vitest";
import type { FrameContextMenu } from "@jaira/shared";
import { itemsForFrame } from "../src/renderer/pointerMenu";

/** A right-click on ordinary content, which every case here varies one thing from. */
function clicked(over: Partial<FrameContextMenu> = {}): FrameContextMenu {
  return {
    x: 100,
    y: 200,
    selectionText: "",
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...over,
  };
}

const labels = (menu: FrameContextMenu): string[] => itemsForFrame(menu).map((item) => item.label);

describe("a right-click inside an artifact frame", () => {
  it("offers nothing over content with nothing to act on", () => {
    expect(itemsForFrame(clicked())).toEqual([]);
  });

  it("offers to copy a selection", () => {
    expect(labels(clicked({ selectionText: "the answer" }))).toEqual(["Copy"]);
  });

  it("ignores a selection that is only whitespace", () => {
    expect(labels(clicked({ selectionText: "  \n " }))).toEqual([]);
  });

  it("offers the picture, the file and the address over an image", () => {
    expect(labels(clicked({ mediaType: "image", srcURL: "https://example.test/a.png" }))).toEqual([
      "Copy image",
      "Save image as…",
      "Copy image address",
    ]);
  });

  it("offers no address for an image that IS its own bytes", () => {
    // A `data:` URL is the picture rather than a place it lives — pasting it somewhere is pasting
    // base64 into whatever was expecting a link.
    expect(labels(clicked({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" }))).toEqual([
      "Copy image",
      "Save image as…",
    ]);
  });

  it("still offers to copy an image the browser gave no source for", () => {
    // The bitmap is copied by POSITION, so it does not need a URL — which is the whole reason that
    // verb goes back to main rather than being done here.
    expect(labels(clicked({ mediaType: "image" }))).toEqual(["Copy image"]);
  });

  it("prefers the picture over the selection and the link around it", () => {
    const menu = clicked({ mediaType: "image", srcURL: "https://example.test/a.png", selectionText: "caption", linkURL: "https://example.test/" });
    expect(labels(menu)).toEqual(["Copy image", "Save image as…", "Copy image address"]);
  });

  it("offers the edit verbs over a field, and says which of them would do anything", () => {
    const menu = clicked({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
    expect(labels(menu)).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    // Shown disabled rather than dropped: a menu whose items move about is a menu you have to read.
    expect(itemsForFrame(menu).map((item) => item.disabled)).toEqual([true, true, false, false]);
  });

  it("offers to save a clip, which has no bitmap to copy", () => {
    expect(labels(clicked({ mediaType: "video", srcURL: "https://example.test/a.mp4" }))).toEqual(["Save video as…"]);
    expect(labels(clicked({ mediaType: "audio", srcURL: "https://example.test/a.mp3" }))).toEqual(["Save audio as…"]);
  });

  it("puts a selection and the link it sits in together, with a rule between them", () => {
    const menu = clicked({ selectionText: "read this", linkURL: "https://example.test/" });
    expect(labels(menu)).toEqual(["Copy", "Copy link"]);
    expect(itemsForFrame(menu)[1]?.separator).toBe(true);
  });

  it("does not draw a rule above the first item", () => {
    expect(itemsForFrame(clicked({ linkURL: "https://example.test/" }))[0]?.separator).toBe(false);
  });
});
