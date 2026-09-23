/**
 * Photograph every Settings tab as a settings page — the row shape the person picked from t3code.
 *
 *   npx tsx packages/app/shots/settings-tabs.mts
 *
 * Output lands in `shots/out/settings/`. Each tab is opened from the sidebar's own list, drawn tall
 * enough that nothing is below the fold, and photographed whole; then Configuration's accordion is
 * checked the way a person would use it — a section clicked, scrolled to and lit.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "settings");
const WORLD = join(import.meta.dirname, ".world-settings");
const TABS = ["Providers", "Executors", "Toolsets", "Integrations", "Configuration", "Files", "History"] as const;

/** Click the sidebar's own entry for a tab — its text is also the page's title, so not `clickText`. */
const tab = (label: string): string =>
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
      for (const name of TABS) {
        await app.evaluate(tab(name));
        await app.until(`document.querySelector(".set-title")?.textContent === ${JSON.stringify(name)}`, `the ${name} page to draw`);
        await new Promise((r) => setTimeout(r, 700));
        await app.shot(`${name.toLowerCase()}-${theme}`, ".set-page");
      }
    }

    // The accordion over a tab this change converted: Configuration's sections, listed and followed.
    await app.resize(1280, 860);
    await app.evaluate(`(() => { document.documentElement.dataset.theme = "light"; return true; })()`);
    await app.evaluate(tab("Configuration"));
    await app.until(`document.querySelectorAll(".section-parts li").length >= 5`, "Configuration's sections to be listed under the tab");
    await app.evaluate(
      `(() => { const li = [...document.querySelectorAll(".section-parts li")].find((e) => e.textContent.trim() === "Safety policy"); li.click(); return true; })()`,
    );
    await app.until(`document.querySelector(".section-parts li.on")?.textContent.trim() === "Safety policy"`, "Safety policy to light after its click");
    await new Promise((r) => setTimeout(r, 1000));
    await app.shot("configuration-accordion-light");

    // A row's switch: switched on, the row is set here and editable; off, it inherits.
    const sw = `[...document.querySelectorAll(".set-field")].find((f) => f.querySelector(".cfg-label")?.textContent === "Anything else")`;
    const was = await app.evaluate<boolean>(`${sw}.classList.contains("off")`);
    await app.evaluate(`(() => { ${sw}.querySelector(".cfg-switch").click(); return true; })()`);
    await app.until(`${sw}.classList.contains("off") === ${!was}`, "the Anything else row to switch");
    console.log(`the "Anything else" row went from ${was ? "off" : "on"} to ${was ? "on" : "off"}`);
    await app.shot("configuration-switched-light");

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
