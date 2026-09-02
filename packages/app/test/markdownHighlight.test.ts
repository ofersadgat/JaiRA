/**
 * A fenced block inside the markdown EDITOR, coloured — the surface a `.md` file actually opens in.
 *
 * `text/markdown` registers an editor and no viewer, so this live-preview is what somebody sees when
 * they click a document in the Files tree. Colouring a fence in it needs THREE things, and any two
 * of them look exactly like none:
 *
 *  1. a grammar for the language (`shared/grammars.ts` names it, `PARSERS` loads it),
 *  2. a {@link LOOK} that paints the tags that grammar emits, and
 *  3. a `LanguageDescription` stable enough to finish loading.
 *
 * Each was missing in turn, and each time the block stayed grey with nothing reporting a problem.
 * So these tests assert PAINT through the real nested parse rather than any one of the three.
 *
 * ## Reading a mixed-language tree
 *
 * `tree.iterate` does NOT descend into a nested grammar — the sub-tree hangs off a mount, and a
 * plain walk of the outer tree shows a flat `CodeText` leaf whether or not the nested parse ran.
 * `highlightTree` follows mounts, which is why it is what these assert on. Checking the wrong one
 * cost an afternoon: it reported the feature broken after it had been fixed.
 */
import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightTree } from "@lezer/highlight";
import { LOOK, fenceLanguage } from "../src/renderer/markdownEditor";

/** Every class painted over a markdown document, nested fences included. */
async function painted(doc: string, ...load: string[]): Promise<Array<[string, string]>> {
  // The editor loads these as it meets them; a test has to wait, because a parse that begins before
  // the grammar arrives leaves the fence alone — see `describe()` on why the instance must be stable.
  for (const lang of load) await fenceLanguage(lang)!.load();
  const tree = markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }).language.parser.parse(doc);
  const out: Array<[string, string]> = [];
  highlightTree(tree, LOOK, (from, to, classes) => out.push([doc.slice(from, to), classes]));
  return out;
}

const classOf = (marks: Array<[string, string]>, text: string): string | undefined =>
  marks.find(([t]) => t === text)?.[1];

describe("a fenced block in a document", () => {
  it("colours YAML inside markdown", async () => {
    const marks = await painted("# Title\n\n```yaml\nid: plan\n# which model\nmodel: opus\n```\n", "yaml");
    expect(classOf(marks, "id")).toContain("tok-key");
    expect(classOf(marks, "model")).toContain("tok-key");
    expect(classOf(marks, "# which model")).toContain("tok-comment");
    expect(classOf(marks, ":")).toContain("tok-punct");
  });

  it("colours JSON inside markdown, in the same palette", async () => {
    // The same `tok-*` classes `jsonHighlight.ts` and `yamlHighlight.ts` paint with, so one document
    // does not change colour depending on which surface is showing it.
    const marks = await painted('```json\n{"model": "opus", "count": 3, "on": true}\n```\n', "json");
    expect(classOf(marks, '"model"')).toContain("tok-key");
    expect(classOf(marks, '"opus"')).toContain("tok-string");
    expect(classOf(marks, "3")).toContain("tok-number");
    expect(classOf(marks, "true")).toContain("tok-literal");
  });

  it("colours the other grammars it claims", async () => {
    for (const [lang, body] of [
      ["ts", "const a: number = 1; // note"],
      ["html", "<p class='a'>hi</p>"],
      ["css", "a { color: red; }"],
    ] as const) {
      const marks = await painted("```" + lang + "\n" + body + "\n```\n", lang);
      // Something inside the fence is painted — the block is not one grey slab.
      expect(marks.filter(([t]) => body.includes(t)).length, lang).toBeGreaterThan(0);
    }
  });

  it("leaves a plain YAML scalar unpainted, because the grammar does not type it", async () => {
    // Not an omission in LOOK. A plain scalar is untyped in YAML until a schema resolves it, so
    // `lang-yaml` emits no tag for `plan`, `3` or `true` — unlike JSON, where the syntax says.
    // Written down because it looks like a missing mapping and adding one would paint nothing.
    const marks = await painted("```yaml\ncount: 3\nflag: true\n```\n", "yaml");
    expect(classOf(marks, "3")).toBeUndefined();
    expect(classOf(marks, "true")).toBeUndefined();
  });

  it("does not recolour the document's own syntax", async () => {
    // The nested tags were ADDED to this style, not swapped in — and one of them overreached:
    // markdown's own marks carry `tags.meta`, so mapping that painted every `#` and every ``` in
    // the document as a literal. Headings and emphasis must still be what they were.
    const marks = await painted("# Title\n\nSome **bold** text.\n\n```yaml\na: 1\n```\n", "yaml");
    expect(classOf(marks, "# Title")).toBe("cm-h1");
    expect(marks.some(([, c]) => c.includes("cm-strong"))).toBe(true);
    expect(classOf(marks, "```")).toBeUndefined();
  });
});
