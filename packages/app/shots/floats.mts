/**
 * Floats in the real app: every one drawn over what is around it, never under it or cut off by it.
 *
 *   npx tsx packages/app/shots/floats.mts
 *
 * The case that made the float layer (popover.tsx): the composer's Tools card, a category unfolded,
 * and the mode picker of the LAST tool in it — which, drawn inside the category, was cut off by the
 * card's own scroll. Then the Tools and Model cards themselves, and a font menu in Appearance. Each
 * is checked the same way: it is a child of `<body>`, it is inside the window, and its
 * corners and middle are its own pixels (`elementFromPoint`), so nothing is painted over it. The run
 * fails if any is not. Output lands in `shots/out/floats/`.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "floats");
const WORLD = join(import.meta.dirname, ".world-floats");

/** The newest float in `<body>` matching `selector`: in the body, inside the window, on top at five points. */
const onTop = (selector: string): string => `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const f = all[all.length - 1];
  if (!f) return JSON.stringify({ problem: "nothing matches ${selector.replace(/"/g, "'")}" });
  const r = f.getBoundingClientRect();
  const points = [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6]];
  const covered = points.filter(([x, y]) => !f.contains(document.elementFromPoint(x, y))).length;
  if (getComputedStyle(f).visibility === "hidden") return JSON.stringify({ problem: "hidden — its anchor is scrolled out of view" });
  const inside = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  return JSON.stringify({ inBody: f.parentElement === document.body, inside, covered, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9247 });
  const problems: string[] = [];
  const check = async (what: string, selector: string): Promise<void> => {
    const seen = JSON.parse(await app.evaluate<string>(onTop(selector))) as { problem?: string; inBody?: boolean; inside?: boolean; covered?: number };
    console.log(`${what}: ${JSON.stringify(seen)}`);
    if (seen.problem !== undefined || seen.inBody !== true || seen.inside !== true || seen.covered !== 0) problems.push(`${what}: ${JSON.stringify(seen)}`);
  };
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    // Short, so a float near the bottom has to find room — the shape of the bug.
    await app.resize(1280, 640);
    await app.clickText("Chat");
    await app.until(`!!document.querySelector(".cx-chip")`, "the composer's chips");

    // The Tools card, a category unfolded, and the picker of its last tool.
    await app.evaluate(`[...document.querySelectorAll(".cx-chip")].find((c) => (c.title || "").startsWith("Tools"))?.click()`);
    await app.until(`!!document.querySelector("body > .float.cx-pop .cx-cat-fold")`, "the Tools card to open");
    await check("the Tools card", "body > .float.cx-pop");
    await app.evaluate(`[...document.querySelectorAll("body > .float.cx-pop .cx-cat-fold")].pop().click()`);
    await app.until(`!!document.querySelector("body > .float.cx-pop .cx-cat.open .cx-tool-mode")`, "a category to unfold");
    await app.evaluate(`(() => { const modes = [...document.querySelectorAll("body > .float.cx-pop .cx-cat.open .cx-cat-body .cx-tool-mode")]; const last = modes.pop(); last.scrollIntoView({ block: "nearest" }); last.click(); })()`);
    await app.until(`!!document.querySelector("body > .float.cx-submenu")`, "the tool's mode picker to open");
    await new Promise((r) => setTimeout(r, 300));
    await check("a tool's mode picker, last row of an unfolded category", "body > .float.cx-submenu");
    await app.shot("tools-mode-picker");
    // A press inside the picker is not a press outside the card: both stay open.
    await app.evaluate(`document.querySelector("body > .float.cx-submenu .cx-opt-hint").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    const both = await app.evaluate<boolean>(`!!document.querySelector("body > .float.cx-submenu") && !!document.querySelector("body > .float.cx-pop")`);
    console.log(`a press inside the picker keeps both open: ${both}`);
    if (!both) problems.push("a press inside the picker closed it or the card");
    // Escape closes the innermost only.
    await app.press("Escape", 27);
    await new Promise((r) => setTimeout(r, 200));
    const innermost = await app.evaluate<string>(`JSON.stringify([!!document.querySelector("body > .float.cx-submenu"), !!document.querySelector("body > .float.cx-pop")])`);
    console.log(`after Escape [picker, card]: ${innermost}`);
    if (innermost !== "[false,true]") problems.push(`Escape should close the picker only, got ${innermost}`);
    await app.press("Escape", 27);

    // The Model card — opened from a chip whose wrapper re-declares a token, the way the sidebar and
    // the editors re-declare theirs: the card in <body> must paint with the chip's value, not the page's.
    await app.evaluate(`[...document.querySelectorAll(".cx-chip")].find((c) => (c.title || "").startsWith("Model")).parentElement.style.setProperty("--panel", "rgb(1, 2, 3)")`);
    await app.evaluate(`[...document.querySelectorAll(".cx-chip")].find((c) => (c.title || "").startsWith("Model"))?.click()`);
    await app.until(`!!document.querySelector("body > .float.cx-pop")`, "the Model card to open");
    await new Promise((r) => setTimeout(r, 300));
    await check("the Model card", "body > .float.cx-pop");
    const painted = await app.evaluate<string>(`getComputedStyle(document.querySelector("body > .float.cx-pop")).backgroundColor`);
    console.log(`the card paints with its anchor's --panel: ${painted}`);
    if (painted !== "rgb(1, 2, 3)") problems.push(`the Model card lost its anchor's --panel (painted ${painted})`);
    await app.evaluate(`[...document.querySelectorAll(".cx-chip")].find((c) => (c.title || "").startsWith("Model")).parentElement.style.removeProperty("--panel")`);
    await app.shot("model-card");
    await app.press("Escape", 27);

    // Appearance → a font menu.
    await app.clickText("Settings");
    const page = (label: string): string =>
      `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
    await app.evaluate(page("Appearance"));
    await app.until(`!!document.querySelector(".face-add")`, "Appearance to draw");
    // Scrolled into view first: a float whose anchor is scrolled out of its pane hides until it is back.
    await app.evaluate(`(() => { const b = document.querySelector(".face-add"); b.scrollIntoView({ block: "center", behavior: "instant" }); b.click(); })()`);
    await app.until(`!!document.querySelector("body > .float.face-menu")`, "the font menu to open");
    await new Promise((r) => setTimeout(r, 300));
    await check("the font menu", "body > .float.face-menu");
    await app.shot("font-menu");
  } finally {
    await app.close();
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} float(s) not on top:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nevery float is in <body>, inside the window, and on top");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
