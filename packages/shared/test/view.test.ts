/**
 * An address step as a path segment — the one spelling the journal's paths and the panels' addresses
 * share, so the rail that reads both puts them in the same place.
 */
import { describe, expect, it } from "vitest";
import { addressSegment, segmentKey } from "../src/view";

describe("an address step as a path segment", () => {
  it("spells a fan-out element with its index, and an ordinary entry without", () => {
    expect(addressSegment({ childKey: "build", occurrence: 0 })).toBe("build");
    expect(addressSegment({ childKey: "build", occurrence: 0, element: 0 })).toBe("build[0]");
    expect(addressSegment({ childKey: "build", occurrence: 2, element: 11 })).toBe("build[11]");
  });

  it("reads the key back off a segment, and leaves a key alone", () => {
    expect(segmentKey("build[0]")).toBe("build");
    expect(segmentKey("build")).toBe("build");
    expect(segmentKey("a[b]")).toBe("a[b]");
  });
});
