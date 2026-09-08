/** One-off: the guard reads at their new weight, against the solid bindings. */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(process.cwd(), "shots", "out", "graph");
const dir = join(process.cwd(), "shots", "out", "graph-world");
const world = buildWorld(dir);
const from = join(homedir(), ".jaira", "workflows");
const to = join(world.project, ".jaira", "workflows");
mkdirSync(to, { recursive: true });
for (const name of readdirSync(from)) {
  if (name === "feature" || name === "feature.json") cpSync(join(from, name), join(to, name), { recursive: true });
}
mkdirSync(OUT, { recursive: true });
const app = await App.launch(world, { out: OUT, port: 9411 });
try {
  await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
  await app.resize(1700, 1000);
  await app.clickText("Files");
  await app.clickText(".jaira");
  await app.until("document.body.innerText.includes('workflows')", "the .jaira folder");
  await app.clickText("workflows");
  await app.until("document.body.innerText.includes('feature.json')", "the workflows folder");
  await app.clickText("feature.json");
  await app.until("document.body.innerText.includes('Graph')", "the editor tabs");
  await app.clickText("Graph");
  await app.until("document.querySelector('.sg-lines') !== null", "the drawing");
  await app.shot("guards", ".sg");
} finally {
  await app.close();
}
