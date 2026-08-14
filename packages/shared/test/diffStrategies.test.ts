/**
 * The strategy registry (CHANGESETS.md §7): a structural change is applied as a text edit and the
 * structural view is re-derived from the text — so the tests' invariant everywhere is that applying
 * ALL hunks reproduces `after` (or its parse), and applying a SUBSET yields a valid document that
 * contains exactly the accepted changes.
 */
import { describe, expect, it } from "vitest";
import { DIFF_STRATEGIES, diffStrategyFor } from "../src/diffStrategies";
import { WORKFLOW_JSON, WORKFLOW_YAML } from "../src/mime";

describe("the registry (§7.1)", () => {
  it("resolves along the mime fallback chain, most specific first", () => {
    expect(diffStrategyFor(WORKFLOW_JSON).id).toBe("structural-json");
    expect(diffStrategyFor("application/json").id).toBe("structural-json");
    expect(diffStrategyFor(WORKFLOW_YAML).id).toBe("structural-yaml");
    expect(diffStrategyFor("text/markdown").id).toBe("text-lines");
    expect(diffStrategyFor("application/x-anything").id).toBe("text-lines");
  });
});

describe("structural JSON (§7.2)", () => {
  // Authored formatting a parse/stringify round-trip would destroy: key order, spacing, a trailing
  // newline. Preserving it is the point — jsonc-parser writes minimal edits.
  const before = `{
  "label": "Plan the work",
  "operation": { "prompt": "old prompt" },
  "sequence": ["a", "b"]
}
`;

  it("reports one row per structural change, labelled by pointer", () => {
    const after = JSON.stringify(
      {
        label: "Plan the work",
        operation: { prompt: "new prompt" },
        sequence: ["a", "b", "c"],
        limits: { max_iterations: 3 },
      },
      null,
      2,
    );
    const hunks = DIFF_STRATEGIES.json.hunks(before, after);
    const labels = hunks.map((h) => h.label).sort();
    expect(labels).toEqual(["/limits", "/operation/prompt", "/sequence"]);
  });

  it("applies ALL hunks format-preservingly: untouched text keeps its authored spelling", () => {
    const after = `{"label":"Plan the work","operation":{"prompt":"new prompt"},"sequence":["a","b"]}`;
    const hunks = DIFF_STRATEGIES.json.hunks(before, after);
    const applied = DIFF_STRATEGIES.json.apply(before, hunks);
    // Semantically the after…
    expect(JSON.parse(applied)).toEqual(JSON.parse(after));
    // …but the authored shape survives — this is what "reports every state file as wholly
    // rewritten" (§7.2) must never happen.
    expect(applied).toContain(`"label": "Plan the work"`);
  });

  it("applies a SUBSET: the accepted change lands, the rejected one does not", () => {
    const after = `{"label":"Renamed","operation":{"prompt":"new prompt"},"sequence":["a","b"]}`;
    const hunks = DIFF_STRATEGIES.json.hunks(before, after);
    const prompt = hunks.find((h) => h.label === "/operation/prompt")!;
    const applied = DIFF_STRATEGIES.json.apply(before, [prompt]);
    const parsed = JSON.parse(applied) as { label: string; operation: { prompt: string } };
    expect(parsed.operation.prompt).toBe("new prompt");
    expect(parsed.label).toBe("Plan the work");
  });

  it("treats a differing array as ONE change — element churn is not independently decidable", () => {
    const after = before.replace(`["a", "b"]`, `["b", "a", "c"]`);
    const hunks = DIFF_STRATEGIES.json.hunks(before, after);
    expect(hunks.map((h) => h.label)).toEqual(["/sequence"]);
  });

  it("falls back to text when either side is not JSON — a half-written file still diffs", () => {
    const hunks = DIFF_STRATEGIES.json.hunks("{ not json", "{ not json either");
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0]?.op).toBeUndefined();
  });

  it("removes two adjacent keys cleanly when both removals are accepted", () => {
    const doc = `{ "a": 1, "b": 2, "c": 3 }`;
    const after = `{ "c": 3 }`;
    const hunks = DIFF_STRATEGIES.json.hunks(doc, after);
    expect(JSON.parse(DIFF_STRATEGIES.json.apply(doc, hunks))).toEqual({ c: 3 });
  });
});

describe("structural YAML (§7.1)", () => {
  const before = `# authored comment
label: Plan the work
operation:
  prompt: old prompt
sequence:
  - a
  - b
`;

  it("reports pointer-labelled rows and applies through the Document API, keeping comments", () => {
    const afterDoc = { label: "Plan the work", operation: { prompt: "new prompt" }, sequence: ["a", "b"] };
    const after = `label: Plan the work\noperation:\n  prompt: new prompt\nsequence:\n  - a\n  - b\n`;
    const hunks = DIFF_STRATEGIES.yaml.hunks(before, after);
    expect(hunks.map((h) => h.label)).toEqual(["/operation/prompt"]);
    const applied = DIFF_STRATEGIES.yaml.apply(before, hunks);
    expect(applied).toContain("# authored comment");
    expect(applied).toContain("prompt: new prompt");
    void afterDoc;
  });

  it("applies a subset only", () => {
    const after = `label: Renamed\noperation:\n  prompt: new prompt\nsequence:\n  - a\n  - b\n`;
    const hunks = DIFF_STRATEGIES.yaml.hunks(before, after);
    const prompt = hunks.find((h) => h.label === "/operation/prompt")!;
    const applied = DIFF_STRATEGIES.yaml.apply(before, [prompt]);
    expect(applied).toContain("label: Plan the work");
    expect(applied).toContain("prompt: new prompt");
  });
});

describe("text lines (§7.3) — Monaco's own differ", () => {
  it("yields line hunks whose full application reproduces the after text exactly", () => {
    const before = "one\ntwo\nthree\nfour\n";
    const after = "one\nTWO\nthree\nfour\nfive\n";
    const hunks = DIFF_STRATEGIES.text.hunks(before, after);
    expect(hunks.length).toBe(2);
    expect(DIFF_STRATEGIES.text.apply(before, hunks)).toBe(after);
  });

  it("a subset applies independently — accept the first change, reject the second", () => {
    const before = "one\ntwo\nthree\n";
    const after = "ONE\ntwo\nTHREE\n";
    const hunks = DIFF_STRATEGIES.text.hunks(before, after);
    expect(DIFF_STRATEGIES.text.apply(before, [hunks[0]!])).toBe("ONE\ntwo\nthree\n");
  });

  it("labels hunks with @@ positions in the before text", () => {
    const hunks = DIFF_STRATEGIES.text.hunks("a\nb\n", "a\nB\n");
    expect(hunks[0]?.label).toMatch(/^@@ -2,1 \+1 @@$/);
  });

  it("survives files with no trailing newline, empty sides, and pure insertions", () => {
    for (const [before, after] of [
      ["no newline at end", "no newline at end either"],
      ["", "created\n"],
      ["gone\n", ""],
      ["a\nb\n", "a\nINSERTED\nb\n"],
      ["a\r\nb\r\n", "a\r\nB\r\n"], // CRLF rides inside the line; offsets must still be exact
    ] as const) {
      const hunks = DIFF_STRATEGIES.text.hunks(before, after);
      expect(DIFF_STRATEGIES.text.apply(before, hunks)).toBe(after);
    }
  });

  /**
   * THE TRIPWIRE. The strategy deep-imports monaco's internal diff module — deliberately
   * unversioned rather than pinned: when a monaco upgrade moves or reshapes
   * `editor/common/diff/linesDiffComputers.js`, this test fails and names why, and the fix is to
   * update the import and `monacoDiff.d.ts`, not to hold the package back.
   */
  it("is the exact differ Monaco renders with — the deep import resolves and computes", async () => {
    const { linesDiffComputers } = await import("monaco-editor/editor/common/diff/linesDiffComputers.js");
    const result = linesDiffComputers.getDefault().computeDiff(["one", "two"], ["one", "TWO"], {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 1000,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      original: { startLineNumber: 2, endLineNumberExclusive: 3 },
      modified: { startLineNumber: 2, endLineNumberExclusive: 3 },
    });
    // …and the legacy computer is still there for a caller that wants VS Code's older algorithm.
    expect(linesDiffComputers.getLegacy().computeDiff(["a"], ["b"], {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 1000,
    }).changes).toHaveLength(1);
  });
});
