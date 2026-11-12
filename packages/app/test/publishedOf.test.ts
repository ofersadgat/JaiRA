/**
 * A call that published an artifact (decision 0020) is drawn as that artifact: `publishedOf` reads which
 * one, and at which version, off what `show_artifact` returned, and `toolLineOf` shows it under the line.
 */
import { describe, expect, it } from "vitest";
import { keptUnderSummary, publishedOf, replacedPublishes, toolLineOf } from "../src/renderer/transcriptRows";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";

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

  it("never summarises a published artifact away: the row is a piece of the answer", () => {
    // As the conversation of 2026-11-01 recorded it, ten minutes into a stretch of work: no `action`, and
    // the answer in a text block. Folded into the summary's chips it was drawn nowhere.
    const published = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { file_path: "C:\\x\\live-status-bar.html", icon: "image" }, result: [{ type: "text", text: JSON.stringify(result) }] } as unknown as ToolEntry;
    expect(keptUnderSummary(published)).toBe(true);
    // A canvas's create call, its long answer still a placeholder.
    const lazy = [{ type: "text", text: { $lazy: { size: 35_000, preview: '{"answer":"Created', hash: "h" } } }];
    expect(keptUnderSummary({ ...published, args: { action: "publish", type_url: "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd", title: "x" }, result: lazy } as unknown as ToolEntry)).toBe(true);
  });

  it("leaves in the summary a publish that was refused, and a call that published nothing", () => {
    const call = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { file_path: "C:\\x\\page.html" } } as unknown as ToolEntry;
    const refused = { ...call, result: [{ type: "text", text: JSON.stringify({ error: "Not published: page.html is not UTF-8 text." }) }] } as unknown as ToolEntry;
    expect(keptUnderSummary(refused)).toBe(false);
    expect(toolLineOf(refused, false, false).shown).not.toBe("published");
    expect(keptUnderSummary({ ...call, args: { action: "quickstart", intent: "design" }, result: { answer: "Quickstart for a design." } } as unknown as ToolEntry)).toBe(false);
    expect(keptUnderSummary({ ...call, args: { action: "read", url: result.artifact.url }, result } as unknown as ToolEntry)).toBe(false);
  });

  it("draws a call that listed the task's artifacts as the list, and a list of the Design System type as nothing", () => {
    const listed = { kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args: { action: "list" }, result: { answer: "- Video picker (mine) — canvas" } } as unknown as ToolEntry;
    expect(toolLineOf(listed, false, false).shown).toBe("publishedList");
    expect(toolLineOf({ ...listed, args: { action: "list", type: "Design System" } } as ToolEntry, false, false).shown).toBeUndefined();
  });
});

describe("replacedPublishes", () => {
  // As t-u53tqqcs0y recorded it (2026-11-12): the canvas created, its index published, then one option per
  // publish, a thought or a line of narration between each.
  const url = "artifact://t-1/@a-k3";
  const publish = (version: number, args: Record<string, unknown> = { url, files: {} }): ToolEntry =>
    ({ kind: "tool", name: "mcp__dai__show_artifact", summary: "", ok: true, args, result: [{ type: "text", text: JSON.stringify({ answer: "…", artifact: { ...result.artifact, version } }) }] }) as unknown as ToolEntry;
  const thought = { kind: "thought", text: "" } as unknown as TranscriptEntry;
  const says = (text: string, role = "assistant") => ({ kind: "message", role, text }) as unknown as TranscriptEntry;

  it("leaves the card on the last publish of an artifact when thoughts, narration and other calls come between", () => {
    const create = { ...publish(1, { type_url: "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd", title: "x" }), result: [{ type: "text", text: { $lazy: { size: 36_000, preview: `{"answer":"Created a new Artifact at ${url} (version 1) from the Artifact type …`, hash: "h" } } }] } as unknown as ToolEntry;
    const read = { kind: "tool", name: "mcp__dai__read_file", summary: "", ok: true, args: { path: "a.ts" }, result: "…" } as unknown as ToolEntry;
    const [v2, v3, v4, v5] = [publish(2), publish(3), publish(4), publish(5)];
    const entries = [says("make the panel", "user"), create, read, says("Reading the code."), v2, says("Now the options."), v3, thought, v4, says("Option 3:"), v5];
    const replaced = replacedPublishes(entries);
    expect([create, v2, v3, v4, v5].map((e) => replaced.has(e))).toEqual([true, true, true, true, false]);
    // A replaced publish is a step like any other: its line, no card, folded into the summary.
    expect(keptUnderSummary(v3, { replaced })).toBe(false);
    expect(toolLineOf(v3, false, false, { replaced }).shown).toBeUndefined();
    expect(keptUnderSummary(v5, { replaced })).toBe(true);
    expect(toolLineOf(v5, false, false, { replaced }).shown).toBe("published");
  });

  it("keeps the card on a publish the person spoke after, or answered a question about", () => {
    const [v1, v2, v3] = [publish(1), publish(2), publish(3)];
    const asked = { kind: "tool", name: "AskUserQuestion", summary: "", ok: true, args: { questions: [{ question: "Which?", options: [] }] }, result: "…" } as unknown as ToolEntry;
    const replaced = replacedPublishes([v1, says("darker", "user"), v2, asked, v3]);
    expect([v1, v2, v3].map((e) => replaced.has(e))).toEqual([false, false, false]);
  });

  it("is replaced only by a publish of the same artifact that published", () => {
    const mine = publish(1);
    const other = publish(1, { url: "artifact://t-1/@a-zz", files: {} });
    other.result = [{ type: "text", text: JSON.stringify({ answer: "…", artifact: { ...result.artifact, url: "artifact://t-1/@a-zz", id: "a-zz" } }) }] as never;
    const refused = { ...publish(2), result: [{ type: "text", text: JSON.stringify({ error: "Not published: …" }) }] } as unknown as ToolEntry;
    const running = { ...publish(2), ok: undefined, result: undefined } as unknown as ToolEntry;
    expect(replacedPublishes([mine, other]).size).toBe(0);
    expect(replacedPublishes([mine, refused]).size).toBe(0);
    expect(replacedPublishes([mine, running]).size).toBe(0);
  });
});
