/**
 * Photograph the Logs page — the one screen whose subject is the app itself.
 *
 *   npm --workspace @jaira/app run shots:logs
 *
 * Separate from `run.mts` because it needs a different world: that one seeds three runs to fill a
 * BOARD, and this one needs a log with something in it, which is a different thing to arrange and
 * would ruin the board shots if it were arranged in the same pass (a run traced at `debug` writes a
 * line per state, so those pictures would be taken against a different history every time).
 *
 * Nothing here is a fixture. Every entry photographed is one this launch actually wrote — the
 * shell's own startup line, the projects it opened, a scripted run's trace, and a real uncaught
 * error — and the policy that lets the trace be written at all is turned up through the CONTROL
 * that turns it up, not through a back door. That order is the point: the run happens after, so the
 * picture is evidence that the setting changed what was recorded.
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out");
/** Git-ignored beside the pictures: a scratch project, rebuilt from nothing on every run. */
const WORLD = join(import.meta.dirname, ".world-logs");

const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

/**
 * Set a `<select>` the way a person does.
 *
 * Through the native value setter and a bubbling `change`, because React tracks the value on the
 * DOM node and ignores an assignment it did not see — a plain `el.value = x` moves the box and
 * changes nothing behind it, which would make this rig photograph a lie.
 */
const choose = (selector: string, value: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9333 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await app.clickText("Logs");

    // Keep `debug`, through the Configure panel — before the run, so what follows is recorded
    // BECAUSE of this and the picture says something true.
    await app.clickText("Configure");
    await app.until(says("No rules"), "the configuration panel to draw");
    await app.evaluate(choose(".log-config-head select", "debug"));
    await app.shot("logs-config");

    const made = await app.ipc<{ taskId: string }>("task:create", {
      title: "add dark mode",
      workflow: "feature/plan",
      inputs: { issue: "# add dark mode\n\nThe issue this task was raised for." },
    });
    await app.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
    await app.until(says("entered feature/plan/critique"), "the run's own trace to arrive");

    await app.clickText("Configure");
    await app.shot("logs-list");

    /**
     * A row opened, on an entry that HAS something under it — the state the collapsed list cannot
     * show, and the one this whole panel was missing.
     *
     * The failure is real: a throw in the renderer reaches the window's own error handler, which
     * records it as a `crash` with its stack, exactly as an accidental one would. Staging the entry
     * instead would be photographing a fixture.
     */
    await app.evaluate(`(() => { setTimeout(() => { throw new Error("a demonstration failure"); }, 0); return true; })()`);
    await app.until(says("a demonstration failure"), "the crash to be recorded");
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll(".log-row")].find((r) => r.textContent.includes("a demonstration failure"));
      row?.click();
      return true;
    })()`);
    await app.shot("logs-expanded");
    console.log("logs-config, logs-list, logs-expanded");
  } finally {
    await app.close();
  }
}

await main();
