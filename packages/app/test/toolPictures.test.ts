/**
 * A picture a tool handed back — a screenshot, a picture off the clipboard (decision 0019) — drawn under
 * its call, out of whichever envelope it travelled in.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import type { ToolEntry } from "../src/renderer/transcript";
import { hasPicture, pictureOf, toolLineOf } from "../src/renderer/transcriptRows";

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

  // A real screenshot is 300–500 KB of base64: the view hands it over as a placeholder (decision 0018 §6).
  it("is still a picture's line while its data is a placeholder, and draws once the data is fetched", () => {
    const lazy = { $lazy: { size: 382668, preview: "iVBORw0KGgo", hash: "02669fe87be7db2a24e1f79ade6e9b8dcc89dc6e9cba76d5ae132e2e2ed97d9d" } };
    const result: JsonValue = [
      { type: "text", text: '{"path":"system/screenshot.png"}' },
      { type: "image", source: { type: "base64", media_type: "image/png", data: lazy } },
      { type: "text", text: "[Image: source: …]" },
    ];
    expect(hasPicture(result)).toBe(true);
    expect(pictureOf(result)).toBeUndefined();
    const entry = { kind: "tool", name: "mcp__jaira__screenshot", summary: "", callId: "c2", ok: true, result } as unknown as ToolEntry;
    expect(toolLineOf(entry, false, false).shown).toBe("picture");
    expect(hasPicture({ $images: [{ mimeType: "image/png", data: lazy }] })).toBe(true);
    expect(hasPicture([{ type: "image", source: { media_type: "text/plain", data: lazy } }])).toBe(false);
  });
});
