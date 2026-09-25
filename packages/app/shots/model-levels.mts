/**
 * Photograph decision 0009's surfaces in the real app — the Catalog section as this machine's sources
 * answer it, a source's row opened on its models, a built-in preset's Reasoning drawn from the model it
 * resolves to, and the composer's Thinking chip with the levels of the model in force.
 *
 *   npx tsx packages/app/shots/model-levels.mts
 *
 * Output lands in `shots/out/model-levels/`. The catalog is REAL: the app asks OpenRouter and the
 * agents installed on this machine, so what the pictures show is what this machine reports — a row
 * that says `not configured` is a route this machine has not set up.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "model-levels");
const WORLD = join(import.meta.dirname, ".world-model-levels");

const page = (label: string): string =>
  `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;

/** Click the chevron of the Catalog row whose title is `name`. */
const openRow = (name: string): string =>
  `(() => { const li = [...document.querySelectorAll('[data-part="catalog"] .cfg-row')].find((e) => e.querySelector(".cfg-row-title")?.textContent === ${JSON.stringify(name)}); const b = li?.querySelector(".cfg-chevron"); b?.click(); return !!b; })()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9247 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.resize(1280, 2600);
    await app.clickText("Settings");
    await app.evaluate(page("Models"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Models"`, "the Models page");
    // The first refresh follows the startup check: OpenRouter over the network, and each agent started
    // only to answer what it runs. Waited for, not assumed.
    await app.until(`!!document.querySelector('[data-part="catalog"]') && !document.querySelector('[data-part="catalog"]').innerText.includes("not asked yet")`, "the catalog's first refresh", 400);
    await new Promise((r) => setTimeout(r, 1500));
    await app.shot("catalog", '[data-part="catalog"]');

    const status = await app.evaluate<string>(
      `window.jaira.invoke("catalog:status").then((v) => JSON.stringify(v.sources.map((s) => [s.name, s.state, s.fetched ?? null, s.error ?? null])))`,
    );
    console.log(`catalog: ${status}`);

    if (await app.evaluate<boolean>(openRow("codex-cli-models"))) {
      await new Promise((r) => setTimeout(r, 500));
      await app.shot("catalog-codex-open", '[data-part="catalog"]');
    }
    if (await app.evaluate<boolean>(openRow("claude-cli-models"))) {
      await new Promise((r) => setTimeout(r, 500));
      await app.shot("catalog-claude-open", '[data-part="catalog"]');
    }

    // A built-in preset's Reasoning: the levels of the model `coder` resolves to on this machine.
    const coder = await app.evaluate<string>(`window.jaira.invoke("model:parameters", { model: "coder" }).then((v) => JSON.stringify(v))`);
    console.log(`coder: ${coder}`);
    await app.clickText("coder");
    await new Promise((r) => setTimeout(r, 500));
    await app.clickText("Reasoning");
    await new Promise((r) => setTimeout(r, 1200));
    await app.shot("preset-coder-reasoning", '[data-part="presets"]');

    // The composer's Thinking chip over the model in force.
    await app.resize(1280, 900);
    await app.clickText("Chat");
    await new Promise((r) => setTimeout(r, 1500));
    const opened = await app.evaluate<boolean>(
      `(() => { const b = [...document.querySelectorAll(".cx-chip")].find((e) => (e.getAttribute("title") ?? "").startsWith("Thinking")); b?.click(); return !!b; })()`,
    );
    if (opened) {
      await new Promise((r) => setTimeout(r, 1200));
      await app.shot("composer-thinking");
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
