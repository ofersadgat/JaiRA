/**
 * The Changes tab over a real project: the app opened on a COPY of a project's `.jaira`, a chat
 * picked by its title, its context panel unfolded on Changes. Nothing is injected — the panel is the
 * built one, reading `task:changes`.
 *
 *   npx tsx packages/app/shots/changes-real.mts <project copy> <chat title>
 *
 * The window's DOM is written out (scripts stripped, `<base>` at the built renderer) rather than
 * captured over CDP: a window on an idle screen draws no frames, and `Page.captureScreenshot` then
 * waits forever. Photograph the `.html` with a headless browser. Output: `shots/out/changes-real/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";

const OUT = join(import.meta.dirname, "out", "changes-real");
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [project, title] = [process.argv[2]!, process.argv[3]!];
  const world = { home: join(project, "..", "home"), project };
  mkdirSync(world.home, { recursive: true });
  const app = await App.launch(world, { out: OUT, port: 9254, width: 1440, height: 1000 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await pause(2000);
    await app.clickText("Chat");
    await pause(1200);
    await app.clickText(title);
    await pause(2500);
    await app.evaluate(`(() => { const b = document.querySelector('[title="Unfold the panel"]'); if (b) b.click(); })()`);
    await pause(700);
    await app.evaluate(`(() => { const t = [...document.querySelectorAll('.sp-tabs .sp-tab[role="tab"]')].find((e) => e.textContent.includes("Changes")); if (t) t.click(); })()`);
    await pause(2500);
    console.log(`panel: ${await app.evaluate<string>(`(document.querySelector(".chg")?.innerText ?? "(no .chg)").slice(0, 600)`)}`);
    const html = await app.evaluate<string>(`(() => {
      const doc = document.documentElement.cloneNode(true);
      doc.querySelectorAll("script").forEach((s) => s.remove());
      return "<!doctype html>" + doc.outerHTML;
    })()`);
    const base = "file:///" + join(import.meta.dirname, "..", "dist", "renderer").replace(/\\/g, "/") + "/";
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "window.html"),
      html.replace("<head>", `<head><base href="${base}">`).replace("</head>", "<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>"),
    );
    console.log("  window.html");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
