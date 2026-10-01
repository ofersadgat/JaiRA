/**
 * The way from a project to its settings (the person, 2026-09-25): a ⚙ at the right end of the
 * project's row in the sidebar, and a layer switch whose project segment wears the project's NAME
 * rather than "This project".
 *
 * What is held here is the switch's words, which are `layerSegmentOf`'s. The ⚙ on the row, and which
 * segment is the one that is on, are the universal tree's to draw.
 */
import { describe, expect, it } from "vitest";
import { layerSegmentOf } from "../src/renderer/layerLabels";

describe("the settings layer switch", () => {
  it("names the project on its project segment", () => {
    expect(layerSegmentOf("project", "app")).toEqual({ label: "app", title: "app only" });
    // Only that segment: the other two say what they always said, whichever project is open.
    expect(["you", "base"].map((layer) => layerSegmentOf(layer as "you" | "base", "app").label)).toEqual(["Just you", "Shared (all projects)"]);
  });

  it("says This project when it is not told which", () => {
    expect(layerSegmentOf("project")).toEqual({ label: "This project", title: "this project only" });
  });
});
