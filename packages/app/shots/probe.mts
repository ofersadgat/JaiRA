/**
 * Look inside a page of the parity world (decision 0015), for working out why a pair differs.
 *
 *   npx tsx packages/app/shots/probe.mts <url> "<expression>"
 *
 * Opens the world `parity.mts` last built (`shots/.world-parity`), navigates to `url` (`app://jaira/`,
 * `app://jaira/universal`), waits for the board, and prints the expression's value.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";

const [url = "app://jaira/universal", expression = "document.title"] = process.argv.slice(2);
process.env.JAIRA_RENDERER = "one";
const dir = join(import.meta.dirname, ".world-parity");
const world = { home: join(dir, "home"), project: join(dir, "project"), userData: join(dir, "user-data") };
const app = await App.launch(world, { out: join(import.meta.dirname, "parity"), port: 9295 });
try {
  if (process.env.PROBE_HOLD === "1") await app.holdStill(Date.UTC(2026, 8, 27, 21, 0, 0));
  await app.navigate(url);
  await app.until("document.getElementById('root')?.children.length > 0 && document.body.innerText.includes('Planning')", "the board");
  await new Promise((r) => setTimeout(r, 1500));
  console.log(await app.evaluate<unknown>(expression));
} finally {
  await app.close();
}
