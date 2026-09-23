/**
 * Photograph every palette, in both themes, over a real board and a real conversation.
 *
 *   npx tsx packages/app/shots/palettes.mts
 *
 * Output lands in `shots/out/palettes/`. The palettes and the board's three options are ATTRIBUTES
 * on the root (`applySurface`), so after one real click proves the Appearance pane writes them, the
 * rest are set straight onto the root of the running app: the stylesheet is what is under test, and
 * a relaunch per palette would photograph the same CSS twelve times slower.
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { PALETTES, defaultAppearance, surfaceOf, type Appearance, type Palette } from "@jaira/shared";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "palettes");
const WORLD = join(import.meta.dirname, ".world-palettes");
const PARKED = "tighten the changeset lint";

const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function start(app: App, title: string, fake: unknown): Promise<void> {
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "feature/plan",
    inputs: { issue: `# ${title}\n\nThe issue this task was raised for.` },
  });
  await app.ipc("task:start", { taskId: made.taskId, fake });
}

/** The root's attributes for a palette and its options, exactly as `applySurface` writes them. */
async function paint(app: App, theme: "light" | "dark", patch: Partial<Appearance>): Promise<void> {
  const a = { ...defaultAppearance(), ...patch };
  const s = surfaceOf(a);
  const attrs: Record<string, string | null> = {
    theme,
    palette: a.palette === "classic" ? null : a.palette,
    buckets: s.buckets === "line" ? "line" : null,
    lanes: s.laneColors ? "on" : null,
    wash: s.statusWash ? "on" : null,
  };
  await app.evaluate(
    `(() => { const d = document.documentElement.dataset; const a = ${JSON.stringify(attrs)};
      for (const [k, v] of Object.entries(a)) { if (v === null) delete d[k]; else d[k] = v; } return true; })()`,
  );
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9231 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await start(app, "add dark mode", happyRules());
    await start(app, "rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await app.until(says("failed"), "the failed task");
    await start(app, PARKED, blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");

    // The default, untouched: what a fresh install paints.
    const fresh = await app.evaluate<string | undefined>("document.documentElement.dataset.palette");
    console.log(`fresh install paints: ${fresh ?? "(classic)"}`);

    const themes = ["light", "dark"] as const;
    for (const theme of themes) {
      for (const palette of PALETTES) {
        await paint(app, theme, { palette });
        await app.shot(`board-${palette}-${theme}`);
      }
      // The options, over palettes that do not have them by default.
      await paint(app, theme, { palette: "classic", buckets: "line", laneColors: true });
      await app.shot(`board-classic-line-lanes-${theme}`);
      await paint(app, theme, { palette: "ink", statusWash: true, buckets: "box" });
      await app.shot(`board-ink-box-wash-${theme}`);
      await paint(app, theme, { palette: "contrast", statusWash: true, laneColors: true });
      await app.shot(`board-contrast-lanes-wash-${theme}`);
    }

    await app.clickText(PARKED);
    for (const theme of themes) {
      for (const palette of PALETTES as readonly Palette[]) {
        await paint(app, theme, { palette });
        await app.shot(`task-${palette}-${theme}`);
      }
    }

    // One real click: the pane writes the attribute, through the store, onto the root.
    await paint(app, "light", {});
    await app.clickText("Settings");
    await app.clickText("Appearance");
    await app.until(says("Lane colours"), "the theme fields to draw");
    await app.clickText("Blueprint");
    await app.until(`document.documentElement.dataset.palette === "blueprint"`, "the Blueprint card to repaint the window");
    await app.shot("settings-blueprint-light");
    await app.clickText("Ink rail");
    await app.until(`document.documentElement.dataset.palette === "ink"`, "the Ink rail card to repaint the window");

    // The accordion: the open tab's sections under it, and a click on one scrolls there and lights it.
    const part = (label: string): string =>
      `(() => { const li = [...document.querySelectorAll(".section-parts li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
    await app.until(`document.querySelectorAll(".section-parts li").length >= 5`, "the Appearance sections to be listed under the tab");
    await app.evaluate(part("Conversation"));
    await app.until(`document.querySelector(".section-parts li.on")?.textContent.trim() === "Conversation"`, "Conversation to light after its click");
    await app.until(
      `(() => { const s = document.querySelector('[data-part="conversation"]'), b = document.querySelector(".settings-body"); return Math.abs(s.getBoundingClientRect().top - b.getBoundingClientRect().top) < 40; })()`,
      "the Conversation section to reach the top of the page",
    );
    await app.shot("settings-accordion-light");
    // Scrolling by hand moves the light with it.
    await app.evaluate(`(() => { const b = document.querySelector(".settings-body"); b.scrollTop = 0; return true; })()`);
    await new Promise((r) => setTimeout(r, 1200));
    await app.until(`document.querySelector(".section-parts li.on")?.textContent.trim() === "Mode"`, "Mode to light again at the top of the page");

    // The whole page, tall enough that nothing is below the fold.
    await app.resize(1280, 4200);
    await app.shot("appearance-ink-light", ".set-page");
    await paint(app, "dark", { palette: "zinc" });
    await app.shot("appearance-zinc-dark", ".set-page");
    await paint(app, "dark", {});
    await app.shot("appearance-ink-dark", ".set-page");
    await app.resize(1280, 860);

    if (app.complaints.length > 0) {
      console.log(`\n${app.complaints.length} thing(s) spoke up:`);
      for (const c of app.complaints.slice(0, 10)) console.log(`  ${c}`);
      process.exitCode = 1;
    }
    console.log(`\nwrote ${OUT}`);
  } finally {
    await app.close();
  }
}

await main();
