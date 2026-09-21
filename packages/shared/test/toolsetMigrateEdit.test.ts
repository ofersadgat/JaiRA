/**
 * A state file's list and block rewritten as a toolset, as TEXT (decision 0007 step 7).
 *
 * What is worth proving about text: that the rewrite lands where it should and parses to exactly
 * the document the rewrite describes, and that every line it did not mean to change — comments,
 * order, indentation, line endings, an em dash — is still there byte for byte.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseJsoncText, rewriteToolsBlocksText, rewriteToolsBlocksValue, unifiedDiff, type ToolsBlockRewrite } from "../src/toolsetMigrateEdit";

const STATE = `{
  "label": "Draft — the first pass",
  "operation": {
    "kind": "prompt",
    "tools": [
      "read_file"
    ],
    "permissions": {
      "profile": "read-only",
      "tools": {
        "read_file": "allow"
      },
      "scopes": [
        { "path": "docs/**", "tools": { "read_file": "allow" } }
      ]
    },
    "output": { "draft": { "schema": { "type": "string" } } }
  }
}
`;

const MAP = { read_file: "allow", glob: "ask", other: "deny" };
const at = (tools: ToolsBlockRewrite["tools"], path: string[] = ["operation"]): ToolsBlockRewrite[] => [{ at: path, tools }];

describe("JSON", () => {
  it("replaces the list with a map where it stands, removes what a map says instead, and keeps `scopes`", () => {
    const out = rewriteToolsBlocksText(STATE, "json", at(MAP));
    expect(JSON.parse(out)).toEqual(rewriteToolsBlocksValue(JSON.parse(STATE), at(MAP)));
    expect(JSON.parse(out).operation).toEqual({
      kind: "prompt",
      tools: MAP,
      permissions: { scopes: [{ path: "docs/**", tools: { read_file: "allow" } }] },
      output: { draft: { schema: { type: "string" } } },
    });
    // Laid out as its neighbours are, and every line it did not mean to change is still there.
    expect(out).toContain(`    "tools": {\n      "read_file": "allow",\n      "glob": "ask",\n      "other": "deny"\n    },\n    "permissions": {\n      "scopes": [`);
    expect(out).toContain(`"label": "Draft — the first pass"`);
    expect(out).toContain(`        { "path": "docs/**", "tools": { "read_file": "allow" } }`);
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("writes a reference as a bare string, and drops a `permissions` block left with nothing in it", () => {
    const text = `{\n  "operation": {\n    "tools": ["read_file"],\n    "permissions": { "profile": "read-only", "default": "ask" },\n    "kind": "prompt"\n  }\n}\n`;
    const out = rewriteToolsBlocksText(text, "json", at("$/toolsets/chat/read-only"));
    expect(out).toBe(`{\n  "operation": {\n    "tools": "$/toolsets/chat/read-only",\n    "kind": "prompt"\n  }\n}\n`);
  });

  it("drops a trailing `permissions` without leaving the comma it was owed", () => {
    const text = `{\n  "environment": {\n    "kind": "prompt",\n    "tools": ["bash"],\n    "permissions": {\n      "profile": "full"\n    }\n  }\n}\n`;
    const out = rewriteToolsBlocksText(text, "json", at({ $ref: "$/toolsets/chat/ask-first", bash: "allow" }, ["environment"]));
    expect(out).toBe(`{\n  "environment": {\n    "kind": "prompt",\n    "tools": {\n      "$ref": "$/toolsets/chat/ask-first",\n      "bash": "allow"\n    }\n  }\n}\n`);
  });

  it("ADDS `tools` ahead of `permissions` when the block had modes and no list", () => {
    const text = `{\n  "operation": {\n    "kind": "prompt",\n    "permissions": {\n      "tools": { "read_file": "allow" },\n      "scopes": []\n    }\n  }\n}\n`;
    const out = rewriteToolsBlocksText(text, "json", at("$/toolsets/chat/ask-first"));
    expect(out).toBe(`{\n  "operation": {\n    "kind": "prompt",\n    "tools": "$/toolsets/chat/ask-first",\n    "permissions": {\n      "scopes": []\n    }\n  }\n}\n`);
  });

  it("keeps CRLF, tabs and comments (JSONC), and rewrites a child mount's block", () => {
    const text = [
      "{",
      "\t// who may do what",
      '\t"children": {',
      '\t\t"draft": {',
      '\t\t\t"environment": {',
      '\t\t\t\t"tools": ["read_file"], // the list',
      '\t\t\t\t"permissions": { "default": "ask" }',
      "\t\t\t}",
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\r\n");
    const rewrites = at(MAP, ["children", "draft", "environment"]);
    const out = rewriteToolsBlocksText(text, "json", rewrites);
    expect(out).toContain("\t// who may do what\r\n");
    expect(out).toContain('\t\t\t\t"tools": {\r\n\t\t\t\t\t"read_file": "allow",\r\n\t\t\t\t\t"glob": "ask",\r\n\t\t\t\t\t"other": "deny"\r\n\t\t\t\t}');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).not.toContain("permissions");
    const parsed = parseJsoncText(out);
    expect(parsed.ok && parsed.value).toEqual(rewriteToolsBlocksValue((parseJsoncText(text) as { value: unknown }).value, rewrites));
  });

  it("keeps a byte-order mark, and a file written on one line stays on one line", () => {
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}{"operation":{"tools":["read_file"],"permissions":{"profile":"read-only"}}}`;
    const out = rewriteToolsBlocksText(text, "json", at(MAP));
    expect(out).toBe(`${bom}{"operation":{"tools":{ "read_file": "allow", "glob": "ask", "other": "deny" }}}`);
  });

  it("is a no-op with nothing to rewrite, and names a block that is not there", () => {
    expect(rewriteToolsBlocksText(STATE, "json", [])).toBe(STATE);
    expect(() => rewriteToolsBlocksText(STATE, "json", at(MAP, ["environment"]))).toThrow(/no block at environment/);
  });
});

describe("YAML", () => {
  const YAML_STATE = [
    "# Draft — the first pass",
    "label: Draft",
    "operation:",
    "  kind: prompt",
    "  tools:",
    "    - read_file",
    "  permissions:",
    "    profile: read-only # the old way",
    "    tools:",
    "      read_file: allow",
    "    scopes:",
    "      - path: docs/**",
    "        tools: { read_file: allow }",
    "  prompt: |",
    "    Write the draft — carefully.",
    "",
  ].join("\n");

  it("rewrites the block and keeps comments, order, block scalars and the em dash", () => {
    const out = rewriteToolsBlocksText(YAML_STATE, "yaml", at(MAP));
    expect(parseYaml(out)).toEqual(rewriteToolsBlocksValue(parseYaml(YAML_STATE), at(MAP)));
    expect(out).toContain("# Draft — the first pass\n");
    expect(out).toContain("  tools:\n    read_file: allow\n    glob: ask\n    other: deny\n  permissions:\n    scopes:\n");
    expect(out).toContain("  prompt: |\n    Write the draft — carefully.\n");
    expect(out).not.toContain("profile");
  });

  it("writes a reference, and drops an emptied `permissions`", () => {
    const text = "operation:\n  tools: [read_file]\n  permissions:\n    profile: read-only\n  kind: prompt\n";
    const out = rewriteToolsBlocksText(text, "yaml", at("$/toolsets/chat/read-only"));
    expect(parseYaml(out)).toEqual({ operation: { tools: "$/toolsets/chat/read-only", kind: "prompt" } });
  });
});

describe("the diff a dry run prints", () => {
  it("shows only the lines near a change, a hunk per place", () => {
    const out = rewriteToolsBlocksText(STATE, "json", at("$/toolsets/chat/read-only"));
    const diff = unifiedDiff(STATE, out);
    expect(diff[0]).toMatch(/^@@ line \d+ @@$/);
    expect(diff).toContain('-    "tools": [');
    expect(diff).toContain('+    "tools": "$/toolsets/chat/read-only",');
    expect(diff).toContain('-      "profile": "read-only",');
    expect(diff.some((line) => line.includes("Draft"))).toBe(false);
    expect(unifiedDiff(STATE, STATE)).toEqual([]);
  });
});
