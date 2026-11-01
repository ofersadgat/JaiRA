/**
 * A design asked for in words, and where a published artifact can be looked at (decision 0020 §2-§3).
 *
 * A real agent (claude-cli/sonnet by default - this rig spends a little). The person never types `/design`:
 * they ask for a mock-up, as they did on 2026-11-01, when the agent wrote a plain page and the publish was
 * folded into the work summary, drawn nowhere. Passes when:
 *   - the agent's first artifact call is the Design type's quickstart, and a canvas with an artboard comes of it;
 *   - with every step left folded, the conversation draws the artifact;
 *   - ⇤ puts it over the main view, tall, the thread still mounted under it, and back takes it away;
 *   - "on its own" puts it on the side panel's stack, filling it, and the panel's own Back returns;
 *   - Produced offers both;
 *   - a report asked for next is a page (a design only for a design), and it fills the main view too.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/artifactViews.mts [--model claude-cli/haiku] [--task <id>]
 *
 * `--task` opens the conversation the last run left in this world, without another turn of the agent:
 * what comes after the canvas, for when that is what is being fixed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Mock up a settings screen";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/sonnet";
const OUT = join(import.meta.dirname, "out", "artifact-views");
const WORLD = join(import.meta.dirname, ".world-artifact-views");
const kept = arg("--task");

/** Every tool allowed: the rig is about the artifact, not about asking. */
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));

const TO_MAIN = "Show this artifact in the main view";
const TO_PANEL = "Open it on its own, in the side panel";
const OUT_OF_MAIN = "Back out of this artifact";

interface Published {
  id: string;
  kind: string;
}

async function main(): Promise<void> {
  const world = kept !== undefined ? { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") } : buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  writeFileSync(join(world.home, "settings.json"), JSON.stringify({ appearance: { conversation: { workPhases: true, workRows: 5 } } }, null, 2));

  const app = await App.launch(world, { out: OUT, port: 9273 });
  /** The nth button of a name, or fails the rig: `all` is every one on the page at the time. */
  const press = async (label: string, which: "first" | "last" = "first"): Promise<void> => {
    const pick = `(() => { const all = [...document.querySelectorAll(${JSON.stringify(`[aria-label="${label}"]`)})]; return all[${which === "first" ? "0" : "all.length - 1"}] ?? null; })()`;
    const found = await app.evaluate<boolean>(`(() => { const el = ${pick}; if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`);
    if (!found) {
      await app.shot(`no-${label.slice(0, 12).replace(/\W/g, "-")}`);
      throw new Error(`no button "${label}"`);
    }
    // Measured once the scroll has landed: a thread at its live edge scrolls itself back.
    await settle(800);
    const at = await app.evaluate<{ x: number; y: number }>(`(() => { const el = ${pick}; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await app.clickAt(at.x, at.y);
    await settle(1200);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const tallest = (selector: string): Promise<number> => app.evaluate<number>(`Math.max(0, ...[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.getBoundingClientRect().height))`);
  /** What is on the stack's top, by the panel's Back: nothing pushed has none. */
  const panelBack = (): Promise<number> => count(`[role="complementary"] [aria-label="Back"]`);

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1500, 980);
    // A reopened window restores the room it was in, and is still reading its settings for a while.
    if (kept !== undefined) await settle(12_000);
    const made =
      kept !== undefined
        ? { taskId: kept }
        : await app.ipc<{ taskId: string }>("task:create", {
            title: TITLE,
            workflow: "chat/session",
            inputs: { message: "I want a high fidelity mock up of a settings screen for a small todo app. Come up with two different ideas for how it can look." },
          });
    if (kept === undefined) await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: FULL } });
    await app.until(says(TITLE), "the conversation to be listed", 200);

    let canvas: Published | undefined;
    for (let i = 0; ; i++) {
      const list = await app.ipc<Published[]>("artifact:published", { taskId: made.taskId });
      canvas = list.find((a) => a.kind === "canvas");
      if (canvas !== undefined) {
        const files = (await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files;
        if (files["project/canvas.json"] !== undefined && Object.keys(files).some((p) => p.endsWith(".dc.html"))) break;
      }
      if (i > 960) throw new Error(`no canvas with an artboard in eight minutes: ${JSON.stringify(list)}`);
      if (list.some((a) => a.kind === "page")) throw new Error(`asked for a mock-up in words, the agent published a page: ${JSON.stringify(list)}`);
      await settle(500);
    }
    console.log(`in words: canvas ${canvas.id}, not a page`);
    if (kept === undefined) await settle(30_000);

    await app.clickText(TITLE);
    await settle(3000);
    await app.shot("thread");
    // Nothing is opened: the summary must not hide it.
    const folded = await count('[aria-label="Show steps"]');
    const boards = await count('[data-island="canvas"]');
    const verbs = await count(`[aria-label="${TO_MAIN}"]`);
    console.log(`folded: ${String(folded)} summaries, ${String(boards)} boards, ${String(verbs)} ⇤`);
    if (boards === 0 || verbs === 0) throw new Error(`with its steps folded the conversation draws no artifact (boards ${String(boards)}, ⇤ ${String(verbs)})`);

    // ⇤: over the main view, the thread under it. The first: the report comes after the canvas.
    await press(TO_MAIN);
    await settle(2500);
    await app.shot("in-main");
    const main = await tallest('[data-island="canvas"]');
    const composer = await count("textarea");
    console.log(`main view: board ${String(main)} tall, ${String(composer)} composer under it`);
    if (main < 600) throw new Error(`the main view's board is ${String(main)} tall`);
    if (composer === 0) throw new Error("the conversation went from under the artifact");
    await press(OUT_OF_MAIN);
    if ((await count(`[aria-label="${OUT_OF_MAIN}"]`)) !== 0) throw new Error("back left the artifact over the main view");
    console.log("main view: back took it away");

    // On its own in the panel, and the panel's own navigation out of it.
    const pushedBefore = await panelBack();
    await press(TO_PANEL);
    await settle(2500);
    await app.shot("in-panel");
    const inPanel = await tallest('[role="complementary"] [data-island="canvas"]');
    console.log(`panel: board ${String(inPanel)} tall, Back ${String(await panelBack())}`);
    if (inPanel < 500) throw new Error(`the panel's board is ${String(inPanel)} tall`);
    if ((await panelBack()) <= pushedBefore) throw new Error("the artifact is not on the panel's stack: it has no Back");
    // The whole panel: nothing of the entry under it stays, and the way back is the head's.
    if ((await count('[role="complementary"] [role="tablist"]')) !== 0) throw new Error("the tabs of the entry under the artifact are still drawn");
    if (inPanel < 800) throw new Error(`the panel's board is ${String(inPanel)} tall: not the whole panel`);
    await app.evaluate(`document.querySelector('[role="complementary"] [aria-label="Back"]').click()`);
    await settle(1500);
    if ((await tallest('[role="complementary"] [data-island="canvas"]')) >= 500) throw new Error("the panel's Back left the artifact there");
    if ((await count('[role="complementary"] [role="tablist"]')) === 0) throw new Error("back from the artifact, the tabs did not return");
    console.log("panel: Back returned");

    // The Chat room, where the conversation IS the main view and Produced is a tab of its panel.
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(3000);
    await press(TO_MAIN);
    await settle(2500);
    await app.shot("chat-in-main");
    const overThread = await tallest('[data-island="canvas"]');
    const beneath = await count("textarea");
    console.log(`chat: board ${String(overThread)} tall, ${String(beneath)} composer under it`);
    if (overThread < 600 || beneath === 0) throw new Error(`in the Chat room the board is ${String(overThread)} tall, ${String(beneath)} composers under it`);
    await press(OUT_OF_MAIN);

    // Produced: the row opens it, and it offers both. The panel starts folded to its rail.
    const tab = await app.evaluate<boolean>(`(() => { const el = document.querySelector('[title="Produced"]') ?? [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent.includes("Produced")); if (!el) return false; el.click(); return true; })()`);
    if (!tab) throw new Error("no Produced tab");
    await settle(2000);
    await app.shot("produced");
    const row = await app.evaluate<boolean>(`(() => { const el = document.querySelector('[role="complementary"] [title^="open "]'); if (!el) return false; el.click(); return true; })()`);
    if (!row) throw new Error("Produced lists no artifact");
    await settle(2500);
    const offered = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="complementary"] [aria-label]')].map((e) => e.getAttribute("aria-label"))`);
    if (!offered.includes(TO_MAIN) || !offered.includes(TO_PANEL)) throw new Error(`Produced offers ${JSON.stringify(offered)}`);
    await app.shot("produced-open");
    console.log("produced: both offered");

    // What is not a design stays a page, and fills the main view as a frame. A send settles when its turn does.
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    void app.ipc("chat:send", { taskId: made.taskId, instanceId: thread.instanceId, message: "Thanks. Now write a short report, as a single HTML file, of what you decided and why, and publish it. This one is a report, not a design." }).catch(() => undefined);
    let page: Published | undefined;
    for (let i = 0; i < 480 && page === undefined; i++) {
      page = (await app.ipc<Published[]>("artifact:published", { taskId: made.taskId })).find((a) => a.kind === "page");
      await settle(500);
    }
    if (page === undefined) throw new Error("the report was not published as a page");
    if (kept === undefined) await settle(20_000);
    console.log(`report: page ${page.id}`);
    await press(TO_MAIN, "last");
    await settle(2500);
    await app.shot("page-in-main");
    const frame = await tallest('iframe');
    console.log(`main view: page frame ${String(frame)} tall`);
    if (frame < 600) throw new Error(`the main view's page is ${String(frame)} tall`);
    console.log("PASS");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
