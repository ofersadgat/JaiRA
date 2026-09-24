/**
 * The tool table and its categories.
 *
 * What this suite is really defending is EXHAUSTIVENESS. The bug the table exists to fix was not a
 * wrong answer, it was a missing one: an agent's `Glob` was a tool nothing had a name for, so nothing
 * had an opinion about it and the gate could only escalate or wave it through. Every assertion below
 * is a way of asking "is anything undecided?"
 */
import { describe, expect, it } from "vitest";
import {
  categoryModeOf,
  TOOL_CATEGORIES,
  TOOL_SPECS,
  TOOL_SPEC_BY_NAME,
  toolsInCategory,
  type ToolMode,
} from "../src/toolVocabulary";

describe("the table", () => {
  it("gives every tool a category the menu can draw", () => {
    const known = new Set(TOOL_CATEGORIES.map((c) => c.id));
    for (const spec of TOOL_SPECS) {
      expect(known.has(spec.category), `'${spec.name}' is in category '${spec.category}', which no menu draws`).toBe(true);
    }
  });

  it("names each tool once", () => {
    expect(new Set(TOOL_SPECS.map((s) => s.name)).size).toBe(TOOL_SPECS.length);
  });

  it("covers the capabilities an agent actually reached for", () => {
    // The list from a real run: the sync's `read-only` state watched these go by ungoverned because
    // nothing here had a name for them.
    for (const name of ["read_file", "glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search"]) {
      expect(TOOL_SPEC_BY_NAME.has(name), `no spec for '${name}'`).toBe(true);
    }
  });
});

describe("the table is the STANDARD list, and nothing else", () => {
  it("carries no agent's names, no `readOnly` and no profile", () => {
    // Decision 0007 §3 and §1: which built-in is which standard tool is what an agent EXECUTOR
    // declares (`agentTools.ts`), and what a tool may do is what a permission set says about it.
    for (const spec of TOOL_SPECS) {
      expect(Object.keys(spec), spec.name).not.toContain("natives");
      expect(Object.keys(spec), spec.name).not.toContain("readOnly");
    }
  });
});

describe("categories are derived, never stored", () => {
  const modes = (map: Record<string, ToolMode>) => (tool: string) => map[tool] ?? "ask";

  it("reads as its children's mode when they all agree", () => {
    const all: Record<string, ToolMode> = Object.fromEntries(toolsInCategory("files").map((s) => [s.name, "allow" as ToolMode]));
    expect(categoryModeOf("files", modes(all))).toBe("allow");
  });

  it("reads as nothing — `custom` — the moment they disagree", () => {
    // Not a mode: "these disagree" is a different statement from any of the four, and collapsing it
    // to one would make the row lie about what pressing it would preserve.
    const mixed: Record<string, ToolMode> = Object.fromEntries(toolsInCategory("files").map((s) => [s.name, "allow" as ToolMode]));
    mixed["write_file"] = "deny";
    expect(categoryModeOf("files", modes(mixed))).toBeUndefined();
  });

  it("groups every tool under exactly one heading", () => {
    const counted = TOOL_CATEGORIES.flatMap((c) => toolsInCategory(c.id));
    expect(counted).toHaveLength(TOOL_SPECS.length);
  });
});
