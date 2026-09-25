/**
 * The settings fixes of 2026-09-25, in the real app:
 *
 *  - a theme picked on Shared SHOWS, although the personal layer said another — the change is taken
 *    out of every stronger layer (`clearedAbove`), where it used to snap straight back;
 *  - no settings row has an on/off switch any more: Appearance and Runs draw what is in effect, with a
 *    ↺ where the page's layer states it;
 *  - the permission-set card lists its lines plain, with an outlined minus, and its rail's buckets fold;
 *  - Connections' local servers have a Scan again.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/settings-fixes.mts
 *
 * Needs `npm --workspace @jaira/app run build` first. Output lands in `shots/out/settings-fixes/`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "settings-fixes");
const WORLD = join(import.meta.dirname, ".world-settings-fixes");

const page = (label: string): string =>
  `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  // The bug's own starting point: the personal layer states a palette the Shared page cannot see.
  mkdirSync(world.home, { recursive: true });
  const personal = join(world.home, "personal-settings.json");
  writeFileSync(personal, JSON.stringify({ appearance: { palette: "pastel-rail", statusWash: true } }, null, 2));

  const app = await App.launch(world, { out: OUT, port: 9241 });
  const spoke: string[] = [];
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await app.resize(1280, 1400);
    await app.evaluate(page("Appearance"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Appearance"`, "Appearance to draw");
    await app.until(`document.documentElement.dataset.palette === "pastel-rail"`, "the personal palette to paint");
    await app.clickText("Shared (all projects)");
    await sleep(600);
    const switches = (await app.evaluate(`document.querySelectorAll(".set-page .set-name .switch, .set-page .set-section-name .switch").length`)) as number;
    spoke.push(`layer switches on Appearance: ${switches}`);
    await app.shot("appearance-before", ".set-page");

    // Pick Zinc on the Shared page.
    await app.evaluate(`(() => { const b = [...document.querySelectorAll(".theme-card")].find((e) => e.textContent.includes("Zinc")); b?.click(); return !!b; })()`);
    await sleep(2500);
    const painted = (await app.evaluate(`document.documentElement.dataset.palette ?? "classic"`)) as string;
    const left = JSON.parse(readFileSync(personal, "utf8")) as { appearance?: Record<string, unknown> };
    spoke.push(`after picking Zinc on Shared: window paints ${painted}; personal layer now ${JSON.stringify(left)}`);
    await app.shot("appearance-after-zinc", ".set-page");

    await app.evaluate(page("Runs"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Runs"`, "Runs to draw");
    await sleep(800);
    await app.shot("runs", ".set-page");

    await app.evaluate(page("Tools"));
    await app.until(`document.querySelector(".set-config") !== null`, "the permission sets to draw");
    await sleep(800);
    await app.shot("tools-permission-set", ".set-config");
    // Fold the other bucket open, then photograph the rail.
    await app.evaluate(`(() => { const b = [...document.querySelectorAll(".set-rail-fold")].find((e) => e.getAttribute("aria-expanded") === "false"); b?.click(); return !!b; })()`);
    await sleep(400);
    await app.shot("tools-rail-opened", ".set-config .llm-rail");

    await app.evaluate(page("Connections"));
    await app.until(`document.querySelector(".conn-probe") !== null`, "the local servers to be asked");
    await sleep(800);
    await app.evaluate(`(() => { document.querySelector(".conn-probe")?.scrollIntoView({ block: "center" }); return true; })()`);
    await app.evaluate(`(() => { const b = [...document.querySelectorAll(".conn-probe-when button")].find((e) => e.textContent.includes("Scan again")); b?.click(); return !!b; })()`);
    await sleep(150);
    spoke.push(`scan head right after the click: ${(await app.evaluate(`document.querySelector(".conn-probe-when")?.textContent`)) as string}`);
    await sleep(3000);
    await app.shot("connections-local", ".conn-probe");
  } finally {
    await app.close();
  }
  console.log(spoke.join("\n"));
}

void main();
