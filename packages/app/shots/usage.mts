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

    // A popover is drawn over everything — the top bar too — even in a window too short for it: its
    // corners and middle are the popover's own pixels, and it stays inside the window.
    const onTop = `(() => {
      const f = document.querySelector("body > .um-float");
      if (!f) return "no popover in the body";
      const r = f.getBoundingClientRect();
      const points = [[r.left + 12, r.top + 6], [r.right - 12, r.top + 6], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 12, r.bottom - 6], [r.right - 12, r.bottom - 6]];
      const covered = points.filter(([x, y]) => !f.contains(document.elementFromPoint(x, y))).length;
      return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), window: [innerWidth, innerHeight], covered });
    })()`;
    await app.resize(1280, 560);
    await new Promise((r) => setTimeout(r, 500));
    await app.evaluate(`document.querySelector(".um-num")?.click()`);
    await app.until(`!!document.querySelector("body > .um-float .um-acctpop")`, "the account popover to open");
    await new Promise((r) => setTimeout(r, 300));
    console.log(`account popover: ${await app.evaluate<string>(onTop)}`);
    await app.shot("chat-account-popover");
    await app.press("Escape", 27);
    // The context ring is drawn only once a conversation is open.
    if (await app.evaluate<boolean>(`!!document.querySelector(".um-meter")`)) {
      await app.evaluate(`document.querySelector(".um-meter").click()`);
      await app.until(`!!document.querySelector("body > .um-float .um-pop-context")`, "the context popover to open");
      await new Promise((r) => setTimeout(r, 300));
      console.log(`context popover: ${await app.evaluate<string>(onTop)}`);
      await app.shot("chat-context-popover");
      await app.press("Escape", 27);
    }

    await app.clickText("Settings");
    const page = (label: string): string =>
      `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
    await app.resize(1280, 1400);
    await app.evaluate(page("Connections"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Connections"`, "Connections to draw");
    await new Promise((r) => setTimeout(r, 1200));
    await app.shot("connections", ".set-page");
    await app.evaluate(`document.querySelector(".um-c-ringbtn")?.click()`);
    await app.until(`!!document.querySelector("body > .um-float .um-acctpop")`, "a sign-in card's popover to open");
    await new Promise((r) => setTimeout(r, 300));
    console.log(`sign-in card popover: ${await app.evaluate<string>(onTop)}`);
    await app.shot("connections-popover");
    await app.press("Escape", 27);
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
