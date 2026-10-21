/**
 * A picture a tool handed back — a screenshot, a picture off the clipboard (decision 0018) — drawn under
 * its call, out of whichever envelope it travelled in.
 */
import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../src/renderer/transcript";
import { pictureOf, toolLineOf } from "../src/renderer/transcriptRows";

const PNG = "iVBORw0KGgo=";

describe("pictureOf", () => {
  it("finds the picture in MCP's image content, an agent's own Anthropic block, and a value's $images", () => {
    expect(pictureOf([{ type: "text", text: "{}" }, { type: "image", data: PNG, mimeType: "image/png" }])).toBe(`data:image/png;base64,${PNG}`);
    expect(pictureOf([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } }])).toBe(`data:image/jpeg;base64,${PNG}`);
    expect(pictureOf({ width: 2, $images: [{ mimeType: "image/png", data: PNG }] })).toBe(`data:image/png;base64,${PNG}`);
  });

  it("finds none where there is none, or what is there is no picture", () => {
    expect(pictureOf(undefined)).toBeUndefined();
    expect(pictureOf("text")).toBeUndefined();
    expect(pictureOf([{ type: "text", text: "x" }])).toBeUndefined();
    expect(pictureOf([{ type: "image", data: PNG, mimeType: "text/plain" }])).toBeUndefined();
    expect(pictureOf({ $images: [{ mimeType: "image/png", data: "" }] })).toBeUndefined();
  });

  it("is what a call's line draws under it", () => {
    const entry: ToolEntry = { kind: "tool", name: "mcp__dai__screenshot", summary: "", callId: "c1", ok: true, result: [{ type: "text", text: "{}" }, { type: "image", data: PNG, mimeType: "image/png" }] } as ToolEntry;
    expect(toolLineOf(entry, false, false).shown).toBe("picture");
  });
});
