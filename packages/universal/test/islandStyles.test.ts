import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoped } from "../src/islands/islandStyles";

/** The desktop's stylesheet as an island takes it (`islands/islandStyles.ts`): scoped, and nothing of it loose. */
describe("the stylesheet an island brings", () => {
  const css = [
    "/* a comment with a { brace */",
    '@font-face { font-family: "DM Sans"; src: url("./fonts/dm.woff2"); }',
    ":root { --bg: #fff; --text: #000; }",
    ':root[data-theme="dark"] { --bg: #000; }',
    '* { box-sizing: border-box; }',
    "body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 var(--font-app); }",
    ':root[data-palette="contrast"] .card { border-width: 1.5px; }',
    ".md-editor { font-family: inherit; }",
    '.cm-code-open[data-lang]::after { content: "}"; }',
    "@keyframes spin { to { transform: rotate(360deg); } }",
    "@media (max-width: 720px) { :root .col { display: none; } }",
  ].join("\n");
  const out = scoped(css);
  const inside = out.slice(out.indexOf("@scope ([data-island]) {"));

  it("puts every rule inside the scope, so no copy is reached by one", () => {
    expect(out).toContain("@scope ([data-island]) {");
    expect(inside).toContain(".md-editor{ font-family: inherit; }");
    expect(out.slice(0, out.indexOf("@scope"))).not.toContain(".md-editor");
  });

  it("makes the island's own box the root: its look selects a palette's variables and rules", () => {
    expect(inside).toContain(":scope{ --bg: #fff; --text: #000; }");
    expect(inside).toContain(':scope[data-theme="dark"]{ --bg: #000; }');
    expect(inside).toContain(':scope[data-palette="contrast"] .card{ border-width: 1.5px; }');
    expect(inside).toContain("@media (max-width: 720px){ :scope .col { display: none; } }");
    expect(out).not.toContain(":root");
  });

  it("gives the box what a component inherits from the body, and not the body's ground", () => {
    expect(inside).toContain(":scope{ color: var(--text); font: 13px/1.5 var(--font-app)}");
    expect(inside).not.toContain("background: var(--bg)");
    expect(inside).not.toContain("margin: 0");
  });

  it("leaves the faces to the page and the keyframes outside, where an animation finds them", () => {
    expect(out).not.toContain("@font-face");
    expect(out.slice(0, out.indexOf("@scope"))).toContain("@keyframes spin{ to { transform: rotate(360deg); } }");
  });

  it("is not thrown by a brace in a string or a comment", () => {
    expect(inside).toContain('.cm-code-open[data-lang]::after{ content: "}"; }');
  });

  it("takes the real stylesheet whole: one scope, closed, with nothing but keyframes before it", () => {
    const real = scoped(readFileSync(join(import.meta.dirname, "..", "..", "app", "src", "renderer", "styles.css"), "utf8"));
    const before = real.slice(0, real.indexOf("@scope ([data-island]) {"));
    expect(before.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").trim()).toBe("");
    expect(real).not.toContain(":root");
    expect(real).not.toContain("@font-face");
    expect(real.trimEnd().endsWith("}")).toBe(true);
    // Balanced: the scanner closed every rule it opened.
    let depth = 0;
    for (const c of real.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    expect(depth).toBe(0);
  });

  it("holds no rule that neither an island nor the tokens can use", () => {
    // `scripts/pruneCss.mjs --check` lists them and fails: a rule for a class no island component carries
    // is either dead or its class is missing from that script's list.
    const check = (): string => execFileSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "pruneCss.mjs"), "--check"], { encoding: "utf8", stdio: "pipe" });
    expect(check).not.toThrow();
  });
});
