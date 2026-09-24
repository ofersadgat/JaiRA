/**
 * The side panel in the real app — one panel per room, from a stack (the panel rulings, 2026-09-24).
 *
 *   npx tsx packages/app/shots/panels.mts
 *
 * Three scripted runs (one done, one failed, one parked at its gate), then the panel in each place it
 * stands: a task's tabs, its Steps with a step's card, the fold to a rail, a state in the Files view,
 * a conversation adopted into the main view with its context beside it, and a pinned stack with a
 * new selection waiting on the offer bar. Output lands in `shots/out/panels/`.
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "panels");
const WORLD = join(import.meta.dirname, ".world-panels");
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function start(app: App, title: string, fake: unknown): Promise<string> {
  const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}\n\nThe issue.` } });
  await app.ipc("task:start", { taskId: made.taskId, fake });
  return made.taskId;
}

/** Click the first element matching a selector — the panel's own controls have no words to find. */
const click = (app: App, selector: string): Promise<boolean> =>
  app.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9247, width: 1440, height: 900 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await start(app, "add dark mode", happyRules());
    await start(app, "rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await start(app, "tighten the changeset lint", blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");

    // Tasks: a card → the task, on its Conversation tab.
    await app.clickText("Tasks");
    await pause(600);
    await app.clickText("add dark mode");
    await app.until(`!!document.querySelector(".ctx-panel .sp-head")`, "the task's panel");
    await pause(900);
    await app.shot("1-task-conversation");

    // Steps.
    await app.evaluate(`[...document.querySelectorAll(".sp-tab")].find((t) => t.title === "Steps")?.click()`);
    await pause(700);
    await app.shot("2-task-steps");

    // A step → its card under the index.
    await app.evaluate(`[...document.querySelectorAll(".ctx-panel .rail-mark-go")].at(-1)?.click()`);
    await pause(900);
    await app.shot("3-step-card");

    // Outputs and Configuration.
    await app.evaluate(`[...document.querySelectorAll(".sp-tab")].find((t) => t.title === "Outputs")?.click()`);
    await pause(600);
    await app.shot("4-task-outputs");
    await app.evaluate(`[...document.querySelectorAll(".sp-tab")].find((t) => t.title === "Configuration")?.click()`);
    await pause(1200);
    await app.shot("5-task-configuration");

    // Fold to the rail, and back.
    await click(app, '.sp-controls [title="Fold the panel to a rail"]');
    await pause(500);
    await app.shot("6-folded-rail");
    await click(app, '[title="Unfold the panel"]');
    await pause(400);

    // The parked task: its conversation, with the gate in it.
    await app.clickText("tighten the changeset lint");
    await pause(1200);
    await app.shot("7-parked-task");

    // ⇤ — its conversation into the main view; the panel becomes its context (Steps · Produced · …).
    await click(app, '.sp-verbs [aria-label="Show the conversation in the main view"]');
    await app.until(`!!document.querySelector('.ctx-panel [data-kind="convo"]')`, "the conversation's context", 60);
    await pause(1500);
    await app.shot("8-convo-context");

    // A letterhead's name in the main conversation → that step's card in the panel's Steps.
    await app.evaluate(`[...document.querySelectorAll(".run-convo .lh-name.pickable")].at(0)?.click()`);
    await pause(900);
    await app.shot("8b-letterhead-pick");

    // ⇥ back, pin, and select another card: it waits on the offer bar.
    await click(app, '.sp-verbs [aria-label="Give the conversation back to the panel"]');
    await pause(1200);
    await click(app, '.sp-controls [aria-pressed="false"]');
    await pause(300);
    await app.clickText("add dark mode");
    await pause(900);
    await app.shot("9-pinned-offer");
    await pause(1500);
    await app.shot("9b-pinned-own-run");

    // Pinned is the WINDOW's: another room shows the same panel.
    await app.clickText("Files");
    await pause(900);
    await app.shot("9c-pinned-in-files");
    await click(app, '.sp-controls [aria-pressed="true"]');
    await app.clickText("Tasks");
    await pause(600);

    // A column → its state: Run (the form over its history) · Checks · Configuration.
    await app.evaluate(`[...document.querySelectorAll("section.column")].at(-1)?.click()`);
    await app.until(`!!document.querySelector('.ctx-panel [data-kind="state"]')`, "the state's panel", 40);
    await pause(900);
    await app.shot("10-state-run");
    await app.evaluate(`[...document.querySelectorAll(".sp-tab")].find((t) => t.title === "Checks")?.click()`);
    await pause(600);
    await app.shot("11-state-checks");

    // ⇤ — the state into the Files view: Configuration goes, the editor is its configuration.
    await click(app, '.sp-verbs [aria-label="Open in the Files view"]');
    await pause(1800);
    await app.shot("12-files-state");

    // Copy-on-edit: a built-in state, edited where it is shown, becomes a copy in Shared.
    try {
      // The BUILT IN section's rows — the last of each name in the tree.
      const row = (name: string): string =>
        `(() => { const items = [...document.querySelectorAll(".tree-item")]; const hit = items.filter((e) => (e.textContent ?? "").trim().replace(/^[^a-zA-Z0-9_.]+/, "").replace(/[+]$/, "") === ${JSON.stringify(name)}).at(-1); if (!hit) return items.map((e) => e.textContent.trim()).slice(0, 60).join("|"); hit.click(); return "ok"; })()`;
      for (const name of ["workflows", "chat", "agent.json"]) {
        const said = await app.evaluate<string>(row(name));
        if (said !== "ok") throw new Error(`no row ${name}: ${said}`);
        await pause(600);
      }
      await pause(900);
      await app.shot("13-builtin");
      await app.evaluate(`(() => { const el = document.querySelector(".pane.editor input"); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, el.value + " (mine)"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await pause(2500);
      await app.shot("14-builtin-copied");
    } catch (e) {
      console.log(`  (built-in scene skipped: ${(e as Error).message})`);
    }

    // Copy-on-edit for a shipped file that is not a state: opening it copies nothing; typing does.
    try {
      const said = await app.evaluate<string>(`(() => { const items = [...document.querySelectorAll(".tree-item")]; const hit = items.filter((e) => (e.textContent ?? "").trim().replace(/^[^a-zA-Z0-9_.]+/, "") === "README.md").at(-1); if (!hit) return "none"; hit.click(); return "ok"; })()`);
      if (said !== "ok") throw new Error("no built-in README.md");
      await pause(2500);
      const before = await app.evaluate<boolean>(`window.jaira.invoke("file:read", { layer: "base", path: "README.md" }).then((d) => d.exists)`);
      console.log(`  README copied on open: ${before}`);
      await app.shot("15-builtin-readme");
      await app.evaluate(`(() => { const el = document.querySelector(".pane.editor textarea, .pane.editor [contenteditable=true], .file-edit textarea, [contenteditable=true]"); if (!el) return "no editor"; el.focus(); document.execCommand("insertText", false, "Mine. "); return "typed"; })()`);
      await pause(3000);
      const after = await app.evaluate<boolean>(`window.jaira.invoke("file:read", { layer: "base", path: "README.md" }).then((d) => d.exists)`);
      console.log(`  README copied after typing: ${after}`);
      await app.shot("16-builtin-readme-copied");
    } catch (e) {
      console.log(`  (README scene skipped: ${(e as Error).message})`);
    }

    const complaints = app.complaints.filter((line) => !line.includes("Autofill"));
    if (complaints.length > 0) console.log(`complaints:\n${complaints.join("\n")}`);
  } finally {
    await app.close();
  }
}

await main();
