/**
 * What a cross-project surface calls a project it only has the directory of.
 *
 * Three of them reduced a path to a segment by splitting on `/` alone — the inbox strip's fallback
 * chip, the root conversation list's project chip, and the sidebar's "which folder is this in". A
 * Windows path has no `/`, so each of them "reduced" `C:\\UbuntuCode\\JaiRA` to the whole of itself
 * and printed an absolute path into a chip — or, for the segment above, to nothing at all.
 *
 * One function, both separators, and these are the cases that were wrong.
 */
import { describe, expect, it } from "vitest";
import { parentName, projectName } from "../src/renderer/projects";

describe("projectName", () => {
  it("names a Windows path by its last segment", () => {
    expect(projectName("C:\\UbuntuCode\\JaiRA")).toBe("JaiRA");
  });

  it("names a POSIX path the same way", () => {
    expect(projectName("/w/checkouts/atlas")).toBe("atlas");
  });

  it("ignores a trailing separator rather than answering with nothing", () => {
    expect(projectName("/w/checkouts/atlas/")).toBe("atlas");
    expect(projectName("C:\\UbuntuCode\\JaiRA\\")).toBe("JaiRA");
  });

  it("answers with the empty string for no project at all", () => {
    expect(projectName(null)).toBe("");
  });
});

describe("parentName", () => {
  it("names the folder a project sits in, on either platform", () => {
    expect(parentName("C:\\UbuntuCode\\JaiRA")).toBe("UbuntuCode");
    expect(parentName("/w/checkouts/atlas")).toBe("checkouts");
  });

  it("has nothing to say about a path with nothing above it", () => {
    // A root is not inside anything, and inventing a segment for it would be inventing a fact.
    expect(parentName("/atlas")).toBe("");
    expect(parentName("")).toBe("");
  });
});
