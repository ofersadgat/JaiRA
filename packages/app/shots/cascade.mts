/**
 * What `styles.css` actually does to an element, as Chromium decided it (decision 0015): for the element
 * a selector names and the ones inside it, every declaration that WON, with the rule it came from.
 *
 *   npx tsx packages/app/shots/cascade.mts '<selector>' [--depth 3] [--scene board] [--look dark] [--inherited] [--ua] [--page dom|rn] [--path specimen-dom?name=markdown] [--port 9301]
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
const NOISE = /^(animation|transition|caret-color|text-wrap-mode|font-size-adjust|word-wrap|-webkit-app-region|app-region)$|^(animation|transition)-/;

/** Which longhands each shorthand sets — explicit, because a prefix lies (`flex-direction` is not `flex`'s). */
const SHORTHANDS: Record<string, RegExp> = {
  flex: /^flex-(grow|shrink|basis)$/,
  "flex-flow": /^flex-(direction|wrap)$/,
  padding: /^padding-(top|right|bottom|left)$/,
  margin: /^margin-(top|right|bottom|left)$/,
  inset: /^(top|right|bottom|left)$/,
  border: /^border-(top|right|bottom|left)(-(width|style|color))?$|^border-(width|style|color)$|^border-image(-.*)?$/,
  "border-top": /^border-top-(width|style|color)$/,
  "border-right": /^border-right-(width|style|color)$/,
  "border-bottom": /^border-bottom-(width|style|color)$/,
  "border-left": /^border-left-(width|style|color)$/,
  "border-width": /^border-(top|right|bottom|left)-width$/,
  "border-style": /^border-(top|right|bottom|left)-style$/,
  "border-color": /^border-(top|right|bottom|left)-color$/,
  "border-radius": /^border-(top|bottom)-(left|right)-radius$/,
  background: /^background-(image|position(-x|-y)?|size|repeat|attachment|origin|clip|color)$/,
  font: /^(font-(style|variant(-.*)?|weight|stretch|size|family|optical-sizing|kerning|feature-settings|variation-settings|size-adjust)|line-height)$/,
  overflow: /^overflow-(x|y)$/,
  gap: /^(row|column)-gap$/,
  "place-items": /^(align|justify)-items$/,
  "place-content": /^(align|justify)-content$/,
  "place-self": /^(align|justify)-self$/,
  "white-space": /^(white-space-collapse|text-wrap-mode)$/,
  "text-decoration": /^text-decoration-(line|style|color|thickness)$/,
  outline: /^outline-(width|style|color)$/,
  "list-style": /^list-style-(type|position|image)$/,
  "grid-template": /^grid-template-(rows|columns|areas)$/,
  "grid-area": /^grid-(row|column)-(start|end)$/,
  "grid-row": /^grid-row-(start|end)$/,
  "grid-column": /^grid-column-(start|end)$/,
};

/** The shorthand in `names` (one rule's properties) that `longhand` is part of, if any. */
function shorthandOf(longhand: string, names: Set<string>): string | undefined {
  for (const [short, longs] of Object.entries(SHORTHANDS)) if (names.has(short) && longs.test(longhand)) return short;
  return undefined;
}

/** Every property's winner over rules given in ascending cascade order (as CDP returns them). */
function winners(matches: readonly RuleMatch[], inline: CssProperty[] | undefined, only?: Set<string>): Map<string, Winner> {
  const out = new Map<string, Winner>();
  let rule = 0;
  const take = (p: CssProperty, from: string, line: number | undefined, names: Set<string>): void => {
    if (p.disabled === true || p.parsedOk === false || NOISE.test(p.name)) return;
    // CDP lists a shorthand's longhands after it, EMPTY when the shorthand holds a `var()` (it cannot
    // expand one). They still override every earlier rule's longhands, so they count — as the shorthand.
    if (p.value === "" && shorthandOf(p.name, names) === undefined) return;
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
  const app = await App.connect(Number(arg("--port") ?? STUDIO_PORT), { out: join(import.meta.dirname, "parity", "rn") });
  try {
    const scene = arg("--scene");
    const look = arg("--look");
    const path = arg("--path");
    if (path !== undefined) {
      // Any page, by its path without the leading slash (Git Bash rewrites one): `specimen-dom?name=markdown`.
      await app.navigate((await app.evaluate<string>("location.protocol + '//' + location.host")) + "/" + path);
      await app.until("document.readyState === 'complete' && document.body.children.length > 0", path);
      await new Promise((r) => setTimeout(r, 500));
    } else if (scene !== undefined || look !== undefined || arg("--page") !== undefined) {
      await goTo(app, arg("--page") === "rn" ? "/rn" : "/", {
        ...(look !== undefined ? { look: parseLook(look) } : {}),
        ...(scene !== undefined ? { scene: SCENES.find((s) => s.name === scene) as Scene } : {}),
      });
    }
    await app.cdp("DOM.enable");
    await app.cdp("CSS.enable");
    // Number the elements, so each can be found by a selector CDP understands, depth-first.
    const listed = await app.evaluate<{ id: number; level: number; label: string; box: string; text: string; font: string; computed: string }[] | null>(`(() => {
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
        // For an element with words of its own: the font they are actually drawn in, all of it
        // resolved — what a copy's Text has to say in full, since nothing is inherited on native.
        let font = "";
        if (own !== "") {
          const c = getComputedStyle(el);
          font = c.fontSize + "/" + c.lineHeight + " " + c.fontFamily.split(",")[0] + " " + c.fontWeight + (c.fontStyle !== "normal" ? " " + c.fontStyle : "") + " " + c.color + (c.letterSpacing !== "normal" ? " ls " + c.letterSpacing : "") + (c.textTransform !== "none" ? " " + c.textTransform : "");
        }
        // A universal element (on /rn) has no rules worth reading, only atomic classes: its computed box is the news.
        let computed = "";
        if (/is_(View|Text)/.test(cls) || el.getAttribute("role") === "button") {
          const c = getComputedStyle(el);
          const four = (p) => [c[p + "Top"], c[p + "Right"], c[p + "Bottom"], c[p + "Left"]].map((v) => v.replace("px", "")).join(" ");
          const bw = [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].map((v) => v.replace("px", "")).join(" ");
          computed = c.display + " " + c.flexDirection + " | pad " + four("padding") + " | mar " + four("margin") + " | border " + bw + " " + c.borderTopStyle + " " + c.borderTopColor + " | bg " + c.backgroundColor + (c.textAlign !== "start" ? " | align " + c.textAlign : "");
        }
        const cls2 = cls.replace(/\.(_[\w-]+|is_View|is_Text)/g, "");
        out.push({ id: n++, level, label: el.tagName.toLowerCase() + cls2 + (cls2 !== cls ? " (tamagui)" : "") + (attrs ? " [" + attrs + "]" : ""), box: Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width * 100) / 100 + "×" + Math.round(r.height * 100) / 100, text: own.slice(0, 60), font, computed });
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
      if (el.font !== "") console.log(`${indent}    = ${el.font}`);
      if (el.computed !== "") console.log(`${indent}    ~ ${el.computed}`);
      // A copy already drawn by Tamagui: its classes are its props, so its rules are no news.
      if (el.label.includes("(tamagui)")) continue;
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
