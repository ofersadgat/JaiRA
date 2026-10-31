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

  it("reads the artifact out of what MCP delivered — the value serialized in a text block", () => {
    expect(publishedOf([{ type: "text", text: JSON.stringify(result) }] as never)).toMatchObject({ id: "a-k3", version: 2 });
  });

  it("draws a successful publish as published while its answer is still a placeholder, so the drawing fetches it", () => {
    const lazy = [{ type: "text", text: { $lazy: { size: 35_000, preview: '{"answer":"Created', hash: "h" } } }];
    const entry = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { action: "publish", type_url: "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd", title: "x" }, result: lazy } as unknown as ToolEntry;
    expect(toolLineOf(entry, false, false).shown).toBe("published");
    expect(publishedOf(lazy as never)).toBeUndefined();
    expect(toolLineOf({ ...entry, args: { action: "quickstart", intent: "design" } } as ToolEntry, false, false).shown).not.toBe("published");
    expect(toolLineOf({ ...entry, ok: false } as ToolEntry, false, false).shown).not.toBe("published");
  });

  it("is what a show_artifact line shows unasked", () => {
    const entry = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { action: "publish" }, result } as unknown as ToolEntry;
    expect(toolLineOf(entry, false, false).shown).toBe("published");
  });

  it("draws a call that listed the task's artifacts as the list, and a list of the Design System type as nothing", () => {
    const listed = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { action: "list" }, result: { answer: "- Video picker (mine) — canvas" } } as unknown as ToolEntry;
    expect(toolLineOf(listed, false, false).shown).toBe("publishedList");
    expect(toolLineOf({ ...listed, args: { action: "list", type: "Design System" } } as ToolEntry, false, false).shown).toBeUndefined();
  });
});
