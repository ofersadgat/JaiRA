/**
 * Photograph every Settings page — the reorganisation of 2026-09-23: two sidebar groups with a glyph
 * per page, the layer switch in every head's top-right corner, Connections' rows with their boxes on
 * the right, and Tools' permission sets over the Functions table.
 *
 *   npx tsx packages/app/shots/settings-tabs.mts
 *
 * Output lands in `shots/out/settings/`. Each page is opened from the sidebar's own list, drawn tall
 * enough that nothing is below the fold, and photographed whole; then the sidebar with Tools' sections
 * listed under it, a Functions row opened (smart, with the prompt it ships with), and a Runs row's
 * switch flipped the way a person would.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "settings");
const WORLD = join(import.meta.dirname, ".world-settings");
const PAGES = ["Connections", "Models", "Tools", "Runs", "Files", "Data & history", "settings.json", "Appearance"] as const;

/** Click the sidebar's own entry for a page — its label is also the page's title, so not `clickText`. */
const page = (label: string): string =>
  `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9232 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await app.resize(1280, 3400);
    for (const theme of ["light", "dark"] as const) {
      await app.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      for (const name of PAGES) {
        await app.evaluate(page(name));
        if (name !== "Appearance") await app.until(`document.querySelector(".set-title")?.textContent === ${JSON.stringify(name)}`, `the ${name} page to draw`);
        await new Promise((r) => setTimeout(r, 900));
        await app.shot(`${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${theme}`, ".set-page");
      }
    }

    // The window at an ordinary size: the sidebar's two groups, Tools' sections under it, and a
    // Functions row opened — smart, whose defaults show the prompt it ships with.
    await app.resize(1280, 900);
    await app.evaluate(`(() => { document.documentElement.dataset.theme = "light"; return true; })()`);
    await app.evaluate(page("Tools"));
    await app.until(`document.querySelectorAll(".section-parts li").length >= 2`, "Tools' sections to be listed under it");
    await app.evaluate(
      `(() => { const b = [...document.querySelectorAll(".fx-list-head")].find((e) => e.textContent.includes("smart")); b?.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    await app.evaluate(`(() => { document.querySelector(".fx-list .open")?.scrollIntoView({ block: "center" }); return true; })()`);
    await new Promise((r) => setTimeout(r, 600));
    await app.shot("tools-smart-light");

    // A row's switch on Runs: switched on, the row is set here and editable; off, it inherits.
    await app.evaluate(page("Runs"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Runs"`, "the Runs page to draw");
    const sw = `[...document.querySelectorAll(".set-field")].find((f) => f.querySelector(".cfg-label")?.textContent === "Environment")`;
    const was = await app.evaluate<boolean>(`${sw}.classList.contains("off")`);
    await app.evaluate(`(() => { ${sw}.querySelector(".cfg-switch").click(); return true; })()`);
    await app.until(`${sw}.classList.contains("off") === ${!was}`, "the Environment row to switch");
    console.log(`the "Environment" row went from ${was ? "off" : "on"} to ${was ? "on" : "off"}`);
    await app.shot("runs-switched-light");

    if (app.complaints.length > 0) {
      console.log(`\n${app.complaints.length} thing(s) spoke up:`);
      for (const c of app.complaints.slice(0, 10)) console.log(`  ${c}`);
    }
    console.log(`\nwrote ${OUT}`);
  } finally {
    await app.close();
  }
}

await main();
