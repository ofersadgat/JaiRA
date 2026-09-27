/**
 * The Changes tab proposals (round 4, designs 2 and 3) drawn inside the real app: a chat, its context
 * panel unfolded on Changes, and the panel's body replaced with the mockup's markup — the window, the
 * sidebar, the conversation and the panel's frame are the app's own.
 *
 *   npx tsx packages/app/shots/changes-mock.mts <panel.json>
 *
 * `panel.json` is `{ d2, d3, css }` from the mockup's builder. Output lands in `shots/out/changes-mock/`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "changes-mock");
const WORLD = join(import.meta.dirname, ".world-changes-mock");
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const panel = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { d2: string; d3: string; css: string };

const ASK = "The settings sidebar doesn't scroll when the list is long. Fix it, commit it and open an MR.";
const ANSWER = [
  "The sidebar's nav had `overflow: visible` inside a flex column, so it grew past the window instead of scrolling.",
  "",
  "- `styles.css`: the nav scrolls on its own (`overflow-y: auto; min-height: 0`).",
  "- `settingsLayout.tsx`: the nav keeps a ref so the selected row scrolls into view.",
  "- `sidebarScroll.ts` is now `settingsScroll.ts`, and the old `scrollShim.ts` is gone.",
  "- A test in `settingsScroll.test.ts` covers a list longer than the window.",
  "",
  "Committed as `3f2a1c9`, pushed `fix/settings-scroll`, and opened **!482**. I also started a review task and moved JAI-412 to In Review.",
].join("\n");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9253, width: 1440, height: 1000 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    for (const title of [ASK, "Tidy the composer", "Why do scrollbars disappear?"]) {
      const made = await app.ipc<{ taskId: string }>("task:create", { title: title === ASK ? "Fix the settings sidebar scroll" : title, workflow: "chat/session", inputs: { message: title } });
      await app.ipc("task:start", { taskId: made.taskId, fake: [{ output: title === ASK ? ANSWER : "Done." }] });
    }
    await pause(2500);
    await app.clickText("Chat");
    await pause(1200);
    await app.clickText("Fix the settings sidebar scroll");
    await pause(2000);
    await app.evaluate(`(() => { const b = document.querySelector('[title="Unfold the panel"]'); if (b) b.click(); })()`);
    await pause(700);
    await app.evaluate(`(() => { const t = [...document.querySelectorAll('.sp-tabs .sp-tab[role="tab"]')].find((e) => e.textContent.includes("Changes")); if (t) t.click(); })()`);
    await pause(900);
    // Wider than the default, the way somebody reading a tree of paths would drag it.
    await app.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(panel.css)}; document.head.appendChild(s); })()`);
    for (const key of ["d2", "d3"] as const) {
      const ok = await app.evaluate<boolean>(`(() => {
        const body = document.querySelector(".ctx-panel .sp-body");
        if (!body) return false;
        body.innerHTML = ${JSON.stringify(panel[key])};
        const tab = [...document.querySelectorAll('.sp-tabs .sp-tab')].filter((e) => e.textContent.includes("Changes"));
        for (const t of tab) { let c = t.querySelector(".sp-tab-count"); if (!c) { c = document.createElement("span"); c.className = "sp-tab-count"; t.appendChild(c); } c.textContent = "13"; }
        return true;
      })()`);
      console.log(`${key}: ${ok}`);
      await pause(500);
      // The window's own DOM, scripts stripped, for a headless capture: a window on an idle screen draws
      // no frames, and `Page.captureScreenshot` then waits for one forever.
      const html = await app.evaluate<string>(`(() => {
        const doc = document.documentElement.cloneNode(true);
        doc.querySelectorAll("script").forEach((s) => s.remove());
        return "<!doctype html>" + doc.outerHTML;
      })()`);
      const base = "file:///" + join(import.meta.dirname, "..", "dist", "renderer").replace(/\\/g, "/") + "/";
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${key}.html`), html.replace("<head>", `<head><base href="${base}">`));
      console.log(`  ${key}.html`);
    }
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
