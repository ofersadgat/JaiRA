/**
 * Photograph Settings → Licenses: the page at the foot of the sidebar's list, in both modes; the
 * search narrowed to one package; and a row opened onto its notice.
 *
 *   npm --workspace @jaira/app run build && npx tsx packages/app/shots/licenses.mts
 *
 * Output lands in `shots/out/licenses/`.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "licenses");
const WORLD = join(import.meta.dirname, ".world-licenses");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9233 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await app.resize(1280, 900);
    await app.evaluate(
      `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === "Licenses"); li?.click(); return !!li; })()`,
    );
    await app.until(`document.querySelectorAll(".lic-row").length > 100`, "the notices to load");
    const count = await app.evaluate<string>(`document.querySelector(".lic-count")?.textContent ?? ""`);
    const last = await app.evaluate<string>(`[...document.querySelectorAll(".sections > li")].at(-1)?.textContent.trim() ?? ""`);
    console.log(`count: ${count}; last sidebar row: ${last}`);
    for (const theme of ["light", "dark"] as const) {
      await app.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await new Promise((r) => setTimeout(r, 500));
      await app.shot(`page-${theme}`);
    }
    await app.evaluate(`(() => { document.documentElement.dataset.theme = "light"; return true; })()`);

    // Search as a person would: React's own setter, so React sees the input event.
    await app.evaluate(`(() => {
      const input = document.querySelector(".lic-search");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "react-dom");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await app.until(`document.querySelectorAll(".lic-row").length === 1`, "the search to narrow to react-dom");
    await app.evaluate(`(() => { document.querySelector(".lic-toggle")?.click(); return true; })()`);
    await app.until(`!!document.querySelector(".lic-notice")`, "the notice to open");
    await new Promise((r) => setTimeout(r, 300));
    console.log(`search: ${await app.evaluate<string>(`document.querySelector(".lic-count")?.textContent ?? ""`)}`);
    await app.shot("search-open");
  } finally {
    await app.close();
  }
}

await main();
