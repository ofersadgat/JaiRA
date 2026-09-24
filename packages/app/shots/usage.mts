/**
 * The usage readings in the real app — the composer's number and ring, Settings → Connections' weekly
 * rings, and Settings → Runs' "When usage runs out" — photographed over a board seeded from disk.
 *
 *   npx tsx packages/app/shots/usage.mts
 *
 * The world's shared root gets a `system/limits.json` before the app starts, so what is drawn is what
 * the app LOADED — the same file a restart reads. Output lands in `shots/out/usage/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "usage");
const WORLD = join(import.meta.dirname, ".world-usage");

const at = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
const state = (reading: unknown): unknown => ({ reading, updatedAt: new Date(Date.now() - 180_000).toISOString(), lastSentAt: null, refreshing: false });

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(join(world.home, "system"), { recursive: true });
  writeFileSync(
    join(world.home, "system", "limits.json"),
    JSON.stringify({
      version: 1,
      accounts: {
        claude: state({
          route: "claude-cli",
          plan: "max",
          windows: [
            { id: "five_hour", label: "5-hour", minutes: 300, usedPercent: 62, resetsAt: at(1.2) },
            { id: "seven_day", label: "Weekly", minutes: 10080, usedPercent: 33, resetsAt: at(94) },
            { id: "seven_day_opus", label: "Weekly · Opus", minutes: 10080, usedPercent: 71, resetsAt: at(94), model: "opus" },
          ],
          status: "ok",
          source: "query",
          at: new Date().toISOString(),
          complete: true,
        }),
        codex: state({
          route: "codex-cli",
          plan: "plus",
          windows: [
            { id: "primary", label: "5-hour", minutes: 300, usedPercent: 2, resetsAt: at(3) },
            { id: "secondary", label: "Weekly", minutes: 10080, usedPercent: 33, resetsAt: at(120) },
          ],
          status: "ok",
          source: "file",
          at: new Date().toISOString(),
          complete: true,
        }),
      },
    }),
  );
  const app = await App.launch(world, { out: OUT, port: 9245 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.resize(1280, 900);
    // The board, as main loaded it.
    const view = await app.evaluate<string>(`window.jaira.invoke("limits:read").then((v) => JSON.stringify(v.accounts.map((a) => [a.key, a.reading && a.reading.windows.length])))`);
    console.log(`board: ${view}`);

    await app.clickText("Chat");
    await new Promise((r) => setTimeout(r, 1500));
    await app.shot("chat-composer");

    await app.clickText("Settings");
    const page = (label: string): string =>
      `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
    await app.resize(1280, 1400);
    await app.evaluate(page("Connections"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Connections"`, "Connections to draw");
    await new Promise((r) => setTimeout(r, 1200));
    await app.shot("connections", ".set-page");
    await app.evaluate(page("Runs"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Runs"`, "Runs to draw");
    await new Promise((r) => setTimeout(r, 900));
    await app.shot("runs", ".set-page");
    console.log("done");
  } finally {
    await app.close();
  }
}

await main();
