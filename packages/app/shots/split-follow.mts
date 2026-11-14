/**
 * The split and an artifact being published again (the person's rulings of 2026-11-14):
 *
 *   1. a pane opened from a publish's card goes on to a later publish of it in the same run (before the
 *      person speaks), as the card does;
 *   2. a card's place button is lit only where that artifact stands at the version the card shows;
 *      pressed unlit, it puts that version there, on the artifact's own path (its conversation › it);
 *   3. a version picked off the card's menu stays where it is put (it does not follow);
 *   4. moved to another place, it leaves the one it was in, whatever version stood there;
 *   5. the side panel's button pressed where it is lit closes the side panel.
 *
 * A real agent (claude-cli/haiku by default) publishes one small page, waits, and publishes it again.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-follow.mts [--model claude-cli/haiku]
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Split follow check";
const PAGE = "Follow test";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "split-follow");
const WORLD = join(import.meta.dirname, ".world-split-follow");
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));
const PANE = (i: number): string => `[data-pane="${String(i)}"]`;
const HEAD = (i: number): string => `[data-pane-head="${String(i)}"]`;
const PANEL = '[role="complementary"]';
/** Where the conversation's card is: the Tasks room shows the conversation in the side panel. */
const CARD = PANEL;

const page = (body: string): string => `<!doctype html><title>${PAGE}</title><h1>${body}</h1>`;
const ASK = [
  `Do exactly these steps, one at a time, saying nothing between them:`,
  `1. Call show_artifact with content ${JSON.stringify(page("One"))} and file_path "follow-test.html".`,
  `2. Call the shell tool with the command: node -e "setTimeout(() => {}, 90000)"`,
  `3. Call show_artifact again with the url the first call answered, and content ${JSON.stringify(page("Two"))}.`,
  `Then say "done" and nothing else.`,
].join("\n");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9283 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const centre = (selector: string, which: "first" | "last" = "first"): Promise<{ x: number; y: number } | null> =>
    app.evaluate<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = all[${which === "first" ? "0" : "all.length - 1"}]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
  const press = async (selector: string, which: "first" | "last" = "first"): Promise<void> => {
    await centre(selector, which);
    await settle(500);
    const at = await centre(selector, which);
    if (at === null) {
      await app.shot(`missing-${selector.replace(/\W+/g, "-").slice(0, 30)}`);
      throw new Error(`nothing matches ${selector}`);
    }
    await app.clickAt(at.x, at.y);
    await settle(1500);
  };
  const crumbs = (head: string): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${head} [role="navigation"] > *`)})].map((c) => c.textContent.replace(/^›/, "").replace(/^[▥◫¶]/, "").trim()).filter(Boolean)`);
  /** The version a view says it shows: its "vN ▾", the last one under `within`. */
  const versionIn = (within: string): Promise<string> =>
    app.evaluate<string>(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(`${within} [title="Which version"]`)})]; return (all.at(-1)?.textContent ?? "").replace("▾", "").trim(); })()`);
  /** Whether the last card's button in the conversation is lit. */
  const cardLit = (label: string): Promise<boolean> =>
    app.evaluate<boolean>(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(`${CARD} [aria-label="${label}"]`)})]; return all.at(-1)?.getAttribute("aria-pressed") === "true"; })()`);
  const published = async (taskId: string): Promise<number> => {
    const list = await app.ipc<Array<{ kind: string; version: number }>>("artifact:published", { taskId });
    return list.find((a) => a.kind === "page")?.version ?? 0;
  };

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1700, 980);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", inputs: { message: ASK } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: FULL } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    for (let i = 0; (await published(made.taskId)) < 1; i++) {
      if (i > 480) throw new Error("no page published in four minutes");
      await settle(500);
    }
    // The conversation, opened by its title wherever it is listed.
    await app.clickText(TITLE);
    await settle(3000);
    if ((await count('[aria-label="Unfold the panel"]')) > 0) await press('[aria-label="Unfold the panel"]');
    await app.shot("opened", undefined, false);
    check((await count(`${CARD} [aria-label="Open in a split"]`)) > 0, "the conversation, its publish's card in the side panel");
    check((await published(made.taskId)) === 1, "the agent is waiting between its two publishes");

    // (2) Split from v1's card: the artifact's own path, the card's Split lit.
    await press(`${CARD} [aria-label="Open in a split"]`, "last");
    await settle(2500);
    await app.shot("v1-in-split", undefined, false);
    const path1 = await crumbs(HEAD(1));
    check(JSON.stringify(path1) === JSON.stringify([TITLE, PAGE]), `the split stands on the artifact's own path (${path1.join(" › ")})`);
    check((await versionIn(PANE(1))) === "v1", `the split shows v1 (${await versionIn(PANE(1))})`);
    check(await cardLit("Open in a split"), "v1's card lights Split");

    // (1) The second publish, in the same run: the split goes on to it.
    for (let i = 0; (await published(made.taskId)) < 2; i++) {
      if (i > 240) throw new Error("no second publish in two minutes");
      await settle(500);
    }
    await settle(6000);
    await app.shot("v2-followed", undefined, false);
    check((await versionIn(PANE(1))) === "v2", `the split went on to v2 (${await versionIn(PANE(1))})`);
    check(JSON.stringify(await crumbs(HEAD(1))) === JSON.stringify([TITLE, PAGE]), "…in place, no step added to its path");
    check((await versionIn(CARD)) === "v2" && (await cardLit("Open in a split")), `the conversation's one card is v2's, its Split lit (${await versionIn(CARD)})`);

    // (3) v1 picked off the card's menu: another version, so Split is not lit; pressed, the split shows v1.
    await press(`${CARD} [title="Which version"]`, "last");
    await settle(800);
    const v1Item = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((e) => e.textContent.trim().startsWith("v1")); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (v1Item === null) throw new Error("no v1 in the version menu");
    await app.clickAt(v1Item.x, v1Item.y);
    await settle(2500);
    check((await versionIn(CARD)) === "v1" && !(await cardLit("Open in a split")), "the card turned to v1: Split no longer lit");
    await press(`${CARD} [aria-label="Open in a split"]`, "last");
    await settle(2500);
    await app.shot("v1-picked-in-split", undefined, false);
    check((await versionIn(PANE(1))) === "v1" && (await cardLit("Open in a split")), `pressed, the split shows v1 and Split is lit (${await versionIn(PANE(1))})`);
    check(JSON.stringify(await crumbs(HEAD(1))) === JSON.stringify([TITLE, PAGE]), `…on the artifact's own path (${(await crumbs(HEAD(1))).join(" › ")})`);

    // (4) To the side panel (where the card is): it leaves the split, the panel shows it.
    await press(`${CARD} [aria-label="Open in the side panel"]`, "last");
    await settle(2500);
    await app.shot("in-panel", undefined, false);
    const splitTop = (await crumbs(HEAD(1))).at(-1);
    check(splitTop !== PAGE, `the split no longer shows it (${String(splitTop)})`);
    check((await count(`${PANEL} [aria-label="Open in the side panel"][aria-pressed="true"]`)) === 1, "the side panel shows it, its Side panel lit");
    // (5) Pressed again where it is lit: the side panel closes.
    await press(`${PANEL} [aria-label="Open in the side panel"][aria-pressed="true"]`);
    await settle(2000);
    await app.shot("panel-closed", undefined, false);
    check((await count(`${PANEL} [aria-label="Open in the side panel"]`)) === 0, "pressed again where lit, the side panel closed");
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "\nall checks passed" : `\n${String(failures.length)} failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

void main();
