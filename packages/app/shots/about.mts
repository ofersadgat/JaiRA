/**
 * Photograph Settings → About and Settings' warnings and errors (decision 0011 §4–§6): the sidebar's
 * Settings row with its pills and the card they open, the About page (Updates, Plugins, the notices,
 * searched and opened), and Connections opening on its Needs attention section — in both modes.
 *
 *   npm --workspace @jaira/app run build && npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/about.mts [out-dir]
 *
 * A development build does not update itself, so the Updates section says so; the plugins are this
 * build's manifest against the world's empty store. The board is seeded the one way a real machine
 * gets there: `system/health.json` remembers that every agent once worked, so the probes at start that
 * find one failing raise it as an error.
 *
 * Output lands in `shots/out/about/` unless a directory is named.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = process.argv[2] ?? join(import.meta.dirname, "out", "about");
const WORLD = join(import.meta.dirname, ".world-about");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(join(world.home, "system"), { recursive: true });
  writeFileSync(join(world.home, "system", "health.json"), `${JSON.stringify({ worked: ["executor:claude-code", "executor:claude-cli", "executor:codex"], dismissed: [] })}\n`);
  const app = await App.launch(world, { out: OUT, port: 9234 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.resize(1280, 900);
    // The probes run at start; what they find is on the board a moment later.
    await sleep(4000);
    const board = await app.ipc<Array<{ id: string; level: string; page: string }>>("health:list", undefined);
    console.log(`board: ${board.map((item) => `${item.level} ${item.id} (${item.page})`).join(", ") || "empty"}`);
    await app.shot("sidebar");

    // The Settings row's pills open everything they count.
    const opened = await app.evaluate<boolean>(`(() => { const p = [...document.querySelectorAll(".side-foot .pills[role=button]")].at(-1); p?.click(); return !!p; })()`);
    if (opened) {
      await app.until(`!!document.querySelector(".prob-card")`, "the card to open");
      await sleep(300);
      await app.shot("card");
      await app.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true; })()`);
      await sleep(200);
    } else console.log("no pills on the Settings row: nothing on the board");

    await app.clickText("Settings");
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Connections")); li?.click(); return !!li; })()`);
    await sleep(800);
    await app.shot("connections");

    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("About")); li?.click(); return !!li; })()`);
    await app.until(`document.querySelectorAll(".lic-row").length > 100`, "the notices to load");
    await sleep(400);
    const last = await app.evaluate<string>(`[...document.querySelectorAll(".sections > li:not(.parts)")].at(-1)?.textContent.trim() ?? ""`);
    const parts = await app.evaluate<string>(`[...document.querySelectorAll(".section-parts li")].map((e) => e.textContent).join(" | ")`);
    console.log(`last page: ${last}; its sections: ${parts}`);
    for (const theme of ["light", "dark"] as const) {
      await app.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(400);
      await app.shot(`about-${theme}`);
    }
    await app.evaluate(`(() => { document.documentElement.dataset.theme = "light"; return true; })()`);

    // Plugins: scrolled to, and a build's ⋯ menu is not there until one is installed — the rows as offered.
    await app.evaluate(`(() => { document.querySelector('[data-part="plugins"]')?.scrollIntoView({ block: "start" }); return true; })()`);
    await sleep(300);
    await app.shot("plugins");

    // The notices, searched as a person would: React's own setter, so React sees the input event.
    await app.evaluate(`(() => {
      const input = document.querySelector(".lic-search");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "react-dom");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await app.until(`document.querySelectorAll(".lic-row").length === 1`, "the search to narrow to react-dom");
    await app.evaluate(`(() => { document.querySelector(".lic-toggle")?.click(); document.querySelector('[data-part="notices"]')?.scrollIntoView({ block: "start" }); return true; })()`);
    await app.until(`!!document.querySelector(".lic-notice")`, "the notice to open");
    await sleep(300);
    await app.shot("notices-search");
  } finally {
    await app.close();
  }
}

await main();
