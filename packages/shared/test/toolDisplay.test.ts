import { describe, expect, it } from "vitest";
import { TOOL_SPECS, toolDisplayOf, wordsOf } from "../src/index";

describe("toolDisplayOf", () => {
  it("names JaiRA's own tools by their title, over the bridge or bare", () => {
    expect(toolDisplayOf("mcp__dai__list_merge_requests")).toEqual({ title: "List merge requests", icon: "git" });
    expect(toolDisplayOf("list_merge_requests")).toEqual({ title: "List merge requests", icon: "git" });
    expect(toolDisplayOf("mcp__dai__show_artifact")).toEqual({ title: "Show artifact", icon: "artifact" });
  });

  it("names another server's tool in words, with the server beside it", () => {
    expect(toolDisplayOf("mcp__linear__list_issues")).toEqual({ title: "List issues", server: "linear" });
    // A server that happens to have a tool of a standard name is still somebody else's tool.
    expect(toolDisplayOf("mcp__figma__read_file")).toEqual({ title: "Read file", server: "figma" });
  });

  it("splits an agent's built-in into words and knows no icon for it", () => {
    expect(toolDisplayOf("Read")).toEqual({ title: "Read" });
    expect(toolDisplayOf("WebFetch")).toEqual({ title: "Web fetch" });
    expect(toolDisplayOf("AskUserQuestion")).toEqual({ title: "Ask user question" });
  });

  it("keeps an acronym's case", () => {
    expect(wordsOf("getHTTPStatus")).toBe("Get HTTP status");
    expect(wordsOf("read_PDF")).toBe("Read PDF");
  });

  it("gives every standard tool a title a person reads", () => {
    for (const spec of TOOL_SPECS) {
      expect(spec.title).toMatch(/^[A-Z][a-z]/);
      expect(spec.title).not.toContain("_");
    }
  });
});
