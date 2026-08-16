/**
 * The tool table, its categories, and profiles as maps.
 *
 * What this suite is really defending is EXHAUSTIVENESS. The bug the table exists to fix was not a
 * wrong answer, it was a missing one: an agent's `Glob` was a tool nothing had a name for, so no
 * profile had an opinion about it and the gate could only escalate or wave it through. Every
 * assertion below is a way of asking "is anything undecided?"
 */
import { describe, expect, it } from "vitest";
import {
  categoryModeOf,
  logicalOfNative,
  nativeNamesFor,
  profileModeOf,
  TOOL_CATEGORIES,
  TOOL_PROFILES,
  TOOL_PROFILE_BY_ID,
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

describe("native names — the two directions", () => {
  it("maps a built-in back to the logical name a policy is written against", () => {
    // The direction the gate asks in: a callback arrives naming `Glob`, and the authored mode says
    // `glob`. Without this the two never meet.
    expect(logicalOfNative("Glob")).toBe("glob");
    expect(logicalOfNative("Read")).toBe("read_file");
    expect(logicalOfNative("WebFetch")).toBe("web_fetch");
    expect(logicalOfNative("SomethingNobodyModelled")).toBeUndefined();
  });

  it("lists a transport's native names, whole or for a subset", () => {
    expect(nativeNamesFor("claude")).toContain("Bash");
    expect(nativeNamesFor("claude", ["glob", "grep"])).toEqual(["Glob", "Grep"]);
    // A transport with no built-in for a job contributes nothing rather than a placeholder.
    expect(nativeNamesFor("codex")).toEqual([]);
  });
});

describe("profiles as maps", () => {
  it("says something about every tool in the table, under every profile", () => {
    // The property the predicate form could not have: no tool falls through to a default nobody
    // chose, because there is an entry for each.
    for (const profile of TOOL_PROFILES) {
      for (const spec of TOOL_SPECS) {
        expect(Object.hasOwn(profile.tools, spec.name), `'${profile.id}' says nothing about '${spec.name}'`).toBe(true);
      }
    }
  });

  it("keeps read-only meaning read-only", () => {
    const readOnly = TOOL_PROFILE_BY_ID.get("read-only")!;
    expect(profileModeOf(readOnly, "read_file")).toBe("ask");
    expect(profileModeOf(readOnly, "glob")).toBe("ask");
    expect(profileModeOf(readOnly, "write_file")).toBe("deny");
    expect(profileModeOf(readOnly, "bash")).toBe("deny");
  });

  it("answers for a tool it has never heard of, which is the whole point of `other`", () => {
    // `Glob` under its NATIVE name is not in the table — it is a name that turns up at runtime, and
    // before `other` existed the gate had nothing to consult but a guess.
    for (const profile of TOOL_PROFILES) {
      expect(profileModeOf(profile, "mcp__someone__whatever")).toBe(profile.other);
    }
    expect(TOOL_PROFILE_BY_ID.get("read-only")!.other).toBe("ask");
  });

  it("keeps `other` and `default` distinct", () => {
    // Different questions: `default` is what a KNOWN tool with no entry resolves to; `other` is for
    // a name that is not in the table at all. Collapsing them is how "I have not decided about
    // write_file" and "I have never heard of this" came to mean the same thing.
    const readOnly = TOOL_PROFILE_BY_ID.get("read-only")!;
    expect(readOnly.default).toBe("deny");
    expect(readOnly.other).toBe("ask");
    expect(readOnly.default).not.toBe(readOnly.other);
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
