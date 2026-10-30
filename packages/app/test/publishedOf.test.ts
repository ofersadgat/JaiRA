/**
 * A call that published an artifact (decision 0020) is drawn as that artifact: `publishedOf` reads which
 * one, and at which version, off what `show_artifact` returned, and `toolLineOf` shows it under the line.
 */
import { describe, expect, it } from "vitest";
import { publishedOf, toolLineOf } from "../src/renderer/transcriptRows";
import type { ToolEntry } from "../src/renderer/transcript";

const result = {
  answer: "Updated the Artifact at artifact://t-1/@a-k3 (Version 2, …)",
  artifact: { url: "artifact://t-1/@a-k3", id: "a-k3", version: 2, kind: "canvas", type: "design", title: "Video picker", entry: "project/canvas.json" },
};

describe("publishedOf", () => {
  it("reads the artifact, its task off its url, and its version", () => {
    expect(publishedOf(result)).toEqual({ taskId: "t-1", id: "a-k3", url: "artifact://t-1/@a-k3", version: 2, kind: "canvas", type: "design", title: "Video picker", entry: "project/canvas.json" });
  });

  it("is nothing for a refusal, an answer with no artifact, or one that does not name a published artifact", () => {
    expect(publishedOf({ error: "Not published: …" })).toBeUndefined();
    expect(publishedOf({ answer: "Quickstart for a design." })).toBeUndefined();
    expect(publishedOf({ artifact: { ...result.artifact, url: "artifact://t-1/notes.md" } })).toBeUndefined();
    expect(publishedOf({ artifact: { ...result.artifact, kind: "svg" } })).toBeUndefined();
  });

  it("is what a show_artifact line shows unasked", () => {
    const entry = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { action: "publish" }, result } as unknown as ToolEntry;
    expect(toolLineOf(entry).shown).toBe("published");
  });
});
