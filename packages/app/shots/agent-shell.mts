/**
 * An agent's shell (decision 0030), chosen where the agent is configured: Settings → Connections, the
 * built-in Claude row opened, its `Shell` group. `Live shell` writes `/bin/zsh` to the layer being
 * edited; a path that is not a zsh, bash or sh is refused, naming why; `Emulated` takes the setting out.
 *
 * Free: nothing runs. Passes when each choice lands in `settings.json` as described.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/agent-shell.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "agent-shell");
const WORLD = join(import.meta.dirname, ".world-agent-shell");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9277 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`agent-shell: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const shared = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(world.home, "settings.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const claudeShell = (): unknown => ((shared()["agents"] as Record<string, Record<string, unknown>> | undefined)?.["claudeCode"] ?? {})["shell"];
  const pressLabel = (label: string): Promise<boolean> => app.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')].find((e) => e.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; })()`);
  const pressText = (words: string): Promise<boolean> =>
    app.evaluate<boolean>(`(() => { const hit = [...document.querySelectorAll("button, [role=button]")].find((e) => (e.textContent ?? "").trim() === ${JSON.stringify(words)} && e.getBoundingClientRect().width > 0); if (!hit) return false; hit.click(); return true; })()`);
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 1600);
    await app.clickText("Settings");
    await app.until(says("Agents"), "Settings → Connections", 80);
    check(await pressLabel("open Claude"), "the built-in Claude row opens");
    await app.until(says("Shell"), "the Shell group on the opened row", 40);
    await app.evaluate(`[...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && (e.textContent ?? "").trim() === "Shell").at(-1)?.scrollIntoView({ block: "center" })`);
    await settle(300);
    await app.shot("1-emulated");

    check(await pressText("Live shell"), "Live shell can be chosen");
    for (let i = 0; i < 20 && claudeShell() !== "/bin/zsh"; i++) await settle(250);
    check(claudeShell() === "/bin/zsh", `Live shell writes /bin/zsh to Shared (it wrote ${JSON.stringify(claudeShell())})`);
    await app.until(says("One live shell per conversation"), "the live shell's words", 40);
    await app.shot("2-live");

    // A path that is no zsh, bash or sh is refused, naming why.
    const box = await app.evaluate<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('[aria-label="the path of the live shell: a zsh, bash or sh"]')].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    check(box !== null, "the live shell's path box is there");
    if (box !== null) {
      await app.clickAt(box.x, box.y);
      await app.press("a", 65, { ctrl: process.platform !== "darwin" });
      await app.evaluate(`(() => { const e = document.activeElement; if (e && "select" in e) e.select(); })()`);
      await app.type("/usr/bin/fish");
      await app.press("Enter", 13);
      await app.until(says("must name a zsh, bash or sh"), "the refusal of fish", 40);
      check(claudeShell() === "/bin/zsh", "a refused path is not written");
      await app.shot("3-refused");
    }

    check(await pressText("Emulated"), "Emulated can be chosen again");
    for (let i = 0; i < 20 && claudeShell() !== undefined; i++) await settle(250);
    check(claudeShell() === undefined, `Emulated takes the setting out of Shared (it is ${JSON.stringify(claudeShell())})`);
    await app.shot("4-emulated-again");
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.error(`agent-shell: ${failures.length} failed`);
    process.exitCode = 1;
  } else console.log("passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
