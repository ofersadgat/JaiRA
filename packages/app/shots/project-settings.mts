/**
 * A project's way to its settings, and the events task's automations in its panel (the person's notes,
 * 2026-09-25), in the real app:
 *
 *  - every event is on with nothing stated in any layer (the built-in layer switches them on);
 *  - the project's row in the sidebar grows a ⚙ at its right end under the pointer, and none without;
 *  - the ⚙ opens Settings on that project's layer, whose segment on the switch wears the project's name;
 *  - the events task's panel has an Automations tab — Settings' Automations editor, for its project.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/project-settings.mts
 *
 * Needs `npm --workspace @jaira/app run build` first. Output lands in `shots/out/project-settings/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld, type World } from "./world.mjs";
import { automationStateText, sharedSeedOf, writeEventsDoc, type AutomationLine } from "../src/renderer/automationsModel";

const OUT = join(import.meta.dirname, "out", "project-settings");
const WORLD = join(import.meta.dirname, ".world-project-settings");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const lines: AutomationLine[] = [{ name: "plan_failed", event: "task.failed", filter: {}, steps: [{ kind: "notify", text: "A planning run failed" }] }];

/** Shared's events workflow with one automation, so the project's events task runs; no `events` setting anywhere. */
function seedWorld(): World {
  const world = buildWorld(WORLD);
  const base = join(world.home, "workflows", "system");
  mkdirSync(join(base, "events"), { recursive: true });
  writeFileSync(join(base, "events.json"), `${JSON.stringify(writeEventsDoc(sharedSeedOf(undefined), lines), null, 2)}\n`);
  for (const one of lines) writeFileSync(join(base, "events", `${one.name}.json`), automationStateText(one.name, one.steps));
  return world;
}

async function eventsTaskId(app: App): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const tasks = await app.ipc<Array<{ taskId: string; system?: string; status: string }>>("task:list", {});
    const found = tasks.find((t) => t.system === "events" && t.status === "running");
    if (found !== undefined) return found.taskId;
    await sleep(250);
  }
  throw new Error("the events task never ran");
}

async function main(): Promise<void> {
  const world = seedWorld();
  const spoke: string[] = [];
  const app = await App.launch(world, { out: OUT, port: 9247 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    const theme = await app.theme();

    const effective = await app.ipc<{ effective: { events?: Record<string, { enabled: boolean }> } }>("config:read", { project: world.project });
    spoke.push(`events in effect with nothing stated: ${JSON.stringify(Object.fromEntries(Object.entries(effective.effective.events ?? {}).map(([k, v]) => [k, v.enabled])))}`);

    // The ⚙: absent until the pointer is on the row.
    const gear = `(() => { const b = document.querySelector(".side-project-settings"); return b ? getComputedStyle(b).display : "(none)"; })()`;
    spoke.push(`gear before hover: ${await app.evaluate<string>(gear)}`);
    const row = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(".side-project-row").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await app.hover(row.x, row.y);
    spoke.push(`gear on hover: ${await app.evaluate<string>(gear)} · ${await app.evaluate<string>(`document.querySelector(".side-project-settings")?.getAttribute("aria-label") ?? ""`)}`);
    await app.shot(`row-hover-${theme}`, ".side-nav");

    // The click: Settings, on the project's layer, named.
    await app.evaluate(`(() => { document.querySelector(".side-project-settings").click(); return true; })()`);
    await app.until(`document.querySelector(".layer-picker") !== null`, "Settings to open");
    await sleep(600);
    spoke.push(
      `switch: ${await app.evaluate<string>(`[...document.querySelectorAll(".layer-picker button")].map((b) => (b.classList.contains("layer-on") ? "[" + b.textContent + "]" : b.textContent)).join(" | ")`)}`,
    );
    spoke.push(`lead: ${await app.evaluate<string>(`document.querySelector(".set-lead")?.innerText ?? ""`)}`);
    await app.shot(`settings-${theme}`);

    // The events task's panel: its Automations tab.
    const taskId = await eventsTaskId(app);
    // Opened the way a person opens it: Settings → Tools → Automations → Open its conversation.
    await app.clickText("Tools");
    await app.until(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Open its conversation" && !b.disabled)`, "the automations to know the events task");
    spoke.push(`events task: ${taskId}`);
    await app.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => b.textContent === "Open its conversation").click(); return true; })()`);
    await app.until(`[...document.querySelectorAll(".ctx-panel button")].some((b) => (b.getAttribute("aria-label") ?? b.getAttribute("title") ?? b.textContent ?? "").includes("Automations"))`, "the events task's panel");
    await app.evaluate(`(() => { const tab = [...document.querySelectorAll(".ctx-panel [role=tab], .ctx-panel button")].find((b) => (b.getAttribute("aria-label") ?? b.getAttribute("title") ?? b.textContent ?? "").includes("Automations")); tab?.click(); return !!tab; })()`);
    await app.until(`document.querySelector(".ctx-panel .au-row") !== null`, "the automations to draw in the panel");
    await sleep(600);
    spoke.push(`panel tabs: ${await app.evaluate<string>(`[...document.querySelectorAll(".ctx-panel .sp-tabs button, .ctx-panel [role=tab]")].map((t) => t.getAttribute("aria-label") ?? t.getAttribute("title") ?? t.textContent).join(", ")`)}`);
    spoke.push(`panel lines: ${await app.evaluate<string>(`[...document.querySelectorAll(".ctx-panel .au-row input")].map((i) => i.value).join(", ")`)}`);
    spoke.push(`panel says: ${await app.evaluate<string>(`document.querySelector(".ctx-panel .sp-body")?.innerText.replace(/\\s+/g, " ").slice(0, 400) ?? ""`)}`);
    await app.shot(`events-panel-${theme}`);
    await app.shot(`events-panel-only-${theme}`, ".ctx-panel");
  } finally {
    await app.close();
  }
  console.log(spoke.join("\n"));
  if (app.complaints.length > 0) console.log(`complaints:\n  ${app.complaints.join("\n  ")}`);
}

void main();
