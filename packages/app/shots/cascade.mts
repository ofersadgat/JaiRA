/**
 * What `styles.css` actually does to an element, as Chromium decided it (decision 0015): for the element
 * a selector names and the ones inside it, every declaration that WON, with the rule it came from.
 *
 *   npx tsx packages/app/shots/cascade.mts '<selector>' [--depth 3] [--scene board] [--look dark] [--inherited] [--ua] [--page /rn]
 *
 * Attaches to the app `studio.mts` keeps running. A universal copy has no cascade: every rule it carries,
 * it carries by hand, and working out which of forty matching rules wins — specificity, source order,
 * a palette's override, `:last-child` — is where copying a component used to spend its time. This reads
 * the answer instead. Run it once per look a component's rules depend on (`--look classic-dark`).
 *
 * Printed per element: its tag, classes and box; each winning declaration with the selector that set it
 * and the line in the sheet; `::before`/`::after` with their content; with `--inherited`, the text styles
 * it inherits (font, colour, line-height) and from which rule. User-agent rules are left out unless
 * `--ua` asks for them.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { STUDIO_PORT, goTo, parseLook, type Scene } from "./parityWorld.mjs";
import { SCENES } from "./parityWorld.mjs";

interface CssProperty {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  implicit?: boolean;
  parsedOk?: boolean;
}
interface CssRule {
  selectorList: { text: string; selectors: { text: string }[] };
  origin: string;
  style: { cssProperties: CssProperty[]; range?: { startLine: number } };
}
interface RuleMatch {
  rule: CssRule;
  matchingSelectors: number[];
}
interface Matched {
  inlineStyle?: { cssProperties: CssProperty[] };
  matchedCSSRules?: RuleMatch[];
  pseudoElements?: { pseudoType: string; matches: RuleMatch[] }[];
  inherited?: { inlineStyle?: { cssProperties: CssProperty[] }; matchedCSSRules: RuleMatch[] }[];
}

/** The properties a child inherits and a copy has to set on its own `Text`. */
const INHERITED = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
  "white-space",
  "word-break",
  "overflow-wrap",
  "font-variant-numeric",
  "font-feature-settings",
  "text-decoration-line",
  "visibility",
  "cursor",
]);

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const selector = process.argv[2];
if (selector === undefined || selector.startsWith("--")) {
  console.log("usage: cascade.mts '<selector>' [--depth N] [--scene name] [--look light|dark|<palette>[-wash]-<theme>] [--inherited] [--ua] [--nth N]");
  process.exit(2);
}
const depth = Number(arg("--depth") ?? 2);
const withUa = process.argv.includes("--ua");
const withInherited = process.argv.includes("--inherited");
const nth = Number(arg("--nth") ?? 0);

type Winner = { value: string; important: boolean; from: string; line?: number; implicit: boolean; rule: number; shorthand?: string };

/** What is never a component's business: the studio's own "hold still" rule, and `* { box-sizing }`. */
const NOISE = /^(animation|transition|caret-color)/;

/** The shorthand in `names` that `longhand` is part of: `padding` for `padding-top`, `border` for `border-top-color`. */
function shorthandOf(longhand: string, names: Set<string>): string | undefined {
  const parts = longhand.split("-");
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join("-");
    if (names.has(head)) return head;
  }
  // `border-top-color` is also `border-color`'s, `border-top-left-radius` is `border-radius`'s.
  const tail = parts.slice(-1)[0];
  if (parts[0] === "border" && tail !== undefined && names.has(`border-${tail}`)) return `border-${tail}`;
  if (longhand.endsWith("-radius") && names.has("border-radius")) return "border-radius";
  if (longhand.startsWith("overflow-") && names.has("overflow")) return "overflow";
  if ((longhand === "row-gap" || longhand === "column-gap") && names.has("gap")) return "gap";
  if (["top", "right", "bottom", "left"].includes(longhand)) return names.has("inset") ? "inset" : undefined;
  return undefined;
}

/** Every property's winner over rules given in ascending cascade order (as CDP returns them). */
function winners(matches: readonly RuleMatch[], inline: CssProperty[] | undefined, only?: Set<string>): Map<string, Winner> {
  const out = new Map<string, Winner>();
  let rule = 0;
  const take = (p: CssProperty, from: string, line: number | undefined, names: Set<string>): void => {
    // CDP lists a shorthand's longhands after it, some with empty values: those are not declarations.
    if (p.disabled === true || p.parsedOk === false || p.value === "" || NOISE.test(p.name)) return;
    if (from === "*" && p.name === "box-sizing") return;
    if (only !== undefined && !only.has(p.name)) return;
    const prior = out.get(p.name);
    const important = p.important === true;
    if (prior !== undefined && prior.important && !important) return;
    const shorthand = shorthandOf(p.name, names);
    out.set(p.name, { value: p.value.replace(/\s*!important$/, ""), important, from, ...(line !== undefined ? { line } : {}), implicit: p.implicit === true, rule, ...(shorthand !== undefined ? { shorthand } : {}) });
  };
  for (const m of matches) {
    if (!withUa && m.rule.origin === "user-agent") continue;
    rule++;
    const from = m.matchingSelectors.map((i) => m.rule.selectorList.selectors[i]?.text ?? "?").join(", ");
    const line = m.rule.style.range === undefined ? undefined : m.rule.style.range.startLine + 1;
    const names = new Set(m.rule.style.cssProperties.map((p) => p.name));
    for (const p of m.rule.style.cssProperties) take(p, from, line, names);
  }
  rule++;
  const inlineNames = new Set((inline ?? []).map((p) => p.name));
  for (const p of inline ?? []) take(p, "style=\"…\"", undefined, inlineNames);
  return out;
}

function print(map: Map<string, Winner>, indent: string): void {
  // Longhands the engine expanded from a shorthand are shown only when no written declaration of that
  // shorthand is shown beside them.
  // A longhand is folded into its shorthand when the shorthand's winner is the same rule.
  const folded = ([, w]: [string, Winner]): boolean => w.shorthand !== undefined && map.get(w.shorthand)?.rule === w.rule;
  const written = [...map.entries()].filter((e) => !e[1].implicit && !folded(e));
  const implicit = [...map.entries()].filter((e) => e[1].implicit && !folded(e));
  const width = Math.max(0, ...[...written, ...implicit].map(([n, w]) => n.length + w.value.length));
  for (const [name, w] of [...written, ...implicit]) {
    const decl = `${name}: ${w.value}${w.important ? " !important" : ""}`;
    console.log(`${indent}${decl.padEnd(width + 3)}  ← ${w.from}${w.line !== undefined ? `  L${w.line}` : ""}`);
  }
}

async function main(): Promise<void> {
  const app = await App.connect(STUDIO_PORT, { out: join(import.meta.dirname, "parity", "rn") });
  try {
    const scene = arg("--scene");
    const look = arg("--look");
    if (scene !== undefined || look !== undefined) {
      await goTo(app, arg("--page") ?? "/", {
        ...(look !== undefined ? { look: parseLook(look) } : {}),
        ...(scene !== undefined ? { scene: SCENES.find((s) => s.name === scene) as Scene } : {}),
      });
    }
    await app.cdp("DOM.enable");
    await app.cdp("CSS.enable");
    // Number the elements, so each can be found by a selector CDP understands, depth-first.
    const listed = await app.evaluate<{ id: number; level: number; label: string; box: string; text: string }[] | null>(`(() => {
      document.querySelectorAll("[data-cascade]").forEach((e) => e.removeAttribute("data-cascade"));
      const root = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
      if (!root) return null;
      const out = [];
      let n = 0;
      const walk = (el, level) => {
        el.setAttribute("data-cascade", String(n));
        const r = el.getBoundingClientRect();
        const cls = typeof el.className === "string" && el.className !== "" ? "." + el.className.trim().split(/\\s+/).join(".") : "";
        const attrs = [...el.attributes].filter((a) => !["class", "style", "data-cascade"].includes(a.name) && !a.name.startsWith("on") && !a.name.startsWith("data-one")).map((a) => a.name + (a.value === "" ? "" : "=" + JSON.stringify(a.value.slice(0, 40)))).join(" ");
        const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(" ").trim();
        out.push({ id: n++, level, label: el.tagName.toLowerCase() + cls + (attrs ? " [" + attrs + "]" : ""), box: Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width * 100) / 100 + "×" + Math.round(r.height * 100) / 100, text: own.slice(0, 60) });
        if (level < ${depth}) for (const c of el.children) walk(c, level + 1);
      };
      walk(root, 0);
      return out;
    })()`);
    if (listed === null) throw new Error(`nothing matches ${selector}`);
    const doc = await app.cdp<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    for (const el of listed) {
      const { nodeId } = await app.cdp<{ nodeId: number }>("DOM.querySelector", { nodeId: doc.root.nodeId, selector: `[data-cascade="${el.id}"]` });
      const m = await app.cdp<Matched>("CSS.getMatchedStylesForNode", { nodeId });
      const indent = "  ".repeat(el.level);
      console.log(`${indent}${el.label}  (${el.box})${el.text !== "" ? `  "${el.text}"` : ""}`);
      print(winners(m.matchedCSSRules ?? [], m.inlineStyle?.cssProperties), `${indent}    `);
      for (const pseudo of m.pseudoElements ?? []) {
        if (pseudo.pseudoType !== "before" && pseudo.pseudoType !== "after") continue;
        const w = winners(pseudo.matches, undefined);
        if (w.size === 0) continue;
        console.log(`${indent}  ::${pseudo.pseudoType}`);
        print(w, `${indent}      `);
      }
      if (withInherited && el.level === 0) {
        // Nearest ancestor first, as CDP lists them; the first one to set a property is the one in force.
        const found = new Map<string, Winner>();
        for (const level of m.inherited ?? []) {
          for (const [name, w] of winners(level.matchedCSSRules, level.inlineStyle?.cssProperties, INHERITED)) if (!found.has(name)) found.set(name, w);
        }
        if (found.size > 0) {
          console.log(`${indent}  (inherited)`);
          print(found, `${indent}      `);
        }
      }
    }
    await app.evaluate(`document.querySelectorAll("[data-cascade]").forEach((e) => e.removeAttribute("data-cascade"))`);
  } finally {
    await app.close();
  }
}

await main();
