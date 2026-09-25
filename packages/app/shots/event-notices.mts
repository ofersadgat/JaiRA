/**
 * Event notices in the inbox strip (decision 0010 §4; the approved mockup's option A), in the real
 * app, posted by a REAL events run:
 *
 *  - Shared's events workflow has two automations, on `task.failed` and `task.finished`, each one
 *    "tell me" step (`notify`); the project runs them through its own events task;
 *  - a planning run parks at its gate (so "Awaiting you" has something in it), a second one fails and
 *    a deploy finishes — two notices, the newest shown with "+1";
 *  - × reads it and the older one takes its place; a click opens the events task at that firing;
 *  - a restart starts the strip without notices (main keeps them for the process; the events
 *    conversation is their record), and the dark pass posts fresh ones.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/event-notices.mts
 *
 * Needs `npm --workspace @jaira/app run build` first. Output lands in `shots/out/event-notices/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld, type World } from "./world.mjs";
import { automationStateText, sharedSeedOf, writeEventsDoc, type AutomationLine } from "../src/renderer/automationsModel";

const OUT = join(import.meta.dirname, "out", "event-notices");
const WORLD = join(import.meta.dirname, ".world-event-notices");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

/** A function operation that settles at once — no model is asked anything. */
const noop = { kind: "function", function: "changeset-review-status", input: { decisions: { binding: { json: [] } } } };
/** A workflow that runs one quick step and finishes. */
const deploy = {
  "release/deploy": {
    label: "Deploy",
    children: { run: { state: "release/deploy/run" } },
    sequence: ["run"],
    transitions: [{ to: "terminate.success", when: ".children.run.outcome === 'success'" }],
  },
  "release/deploy/run": { label: "Run", outputs: { settled: { schema: { type: "boolean" } } }, operation: noop },
};

const lines: AutomationLine[] = [
  { name: "plan_failed", event: "task.failed", filter: {}, steps: [{ kind: "notify", text: "A planning run failed — its conversation says why" }] },
  { name: "deploy_done", event: "task.finished", filter: {}, steps: [{ kind: "notify", text: "Deploy finished" }] },
];

function seedWorld(): World {
  const world = buildWorld(WORLD);
  for (const [id, state] of Object.entries(deploy)) {
    const file = join(world.project, ".jaira", "workflows", `${id}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  }
  // Switched on in this project; the automations are Shared's, which a project with no copy runs.
  writeFileSync(join(world.project, ".jaira", "settings.json"), JSON.stringify({ events: { "task.finished": { enabled: true }, "task.failed": { enabled: true } } }, null, 2));
  const base = join(world.home, "workflows", "system");
  mkdirSync(join(base, "events"), { recursive: true });
  writeFileSync(join(base, "events.json"), `${JSON.stringify(writeEventsDoc(sharedSeedOf(undefined), lines), null, 2)}\n`);
  for (const one of lines) writeFileSync(join(base, "events", `${one.name}.json`), automationStateText(one.name, one.steps));
  return world;
}

async function start(app: App, title: string, workflow: string, fake?: unknown): Promise<void> {
  const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow, ...(workflow === "feature/plan" ? { inputs: { issue: `# ${title}\n\nThe issue.` } } : {}) });
  await app.ipc("task:start", { taskId: made.taskId, ...(fake !== undefined ? { fake } : {}) });
}

/** The project's events task, running — its guards armed a beat after. */
async function eventsListening(app: App): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const tasks = await app.ipc<Array<{ system?: string; status: string }>>("task:list", {});
    if (tasks.some((t) => t.system === "events" && t.status === "running")) {
      await sleep(1500);
      return;
    }
    await sleep(250);
  }
  throw new Error("the events task never ran");
}

async function noticesAtLeast(app: App, n: number): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if ((await app.ipc<unknown[]>("notices:list")).length >= n) return;
    await sleep(250);
  }
  // What the service said is what explains a notice that never came — a refused start, a failed load.
  const logs = await app.ipc<{ entries: Array<{ level: string; source: string; message: string }> }>("log:list", { limit: 40 });
  const tasks = await app.ipc<Array<{ title: string; system?: string; status: string }>>("task:list", {});
  throw new Error(
    `fewer than ${n} notices were posted\n  tasks: ${tasks.map((t) => `${t.title}=${t.status}`).join(", ")}\n  ${logs.entries.filter((e) => e.source === "events" || e.level !== "info").map((e) => `${e.level} ${e.source}: ${e.message}`).join("\n  ")}`,
  );
}

/** Post one failure notice and then one finished notice, the way an automation does. */
async function postTwo(app: App, round: string): Promise<void> {
  const before = (await app.ipc<unknown[]>("notices:list")).length;
  await start(app, `rework the sync lint ${round}`, "feature/plan", [happyRules()[0]]);
  await noticesAtLeast(app, before + 1);
  // A second apart, so the two are told apart by age as well as by order.
  await sleep(1000);
  await start(app, `Deploy 0.14.${round}`, "release/deploy");
  await noticesAtLeast(app, before + 2);
  await app.until(`document.querySelector(".strip-notice") !== null`, "the notice to draw");
  await sleep(500);
}

const noticeSays = `document.querySelector(".strip-notice")?.innerText ?? "(no notice)"`;

async function main(): Promise<void> {
  const world = seedWorld();
  const spoke: string[] = [];

  // Light: seed, photograph, dismiss, open.
  let app = await App.launch(world, { out: OUT, port: 9245 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Tasks");
    await start(app, "tighten the changeset lint", "feature/plan", blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");
    await eventsListening(app);
    await postTwo(app, "1");
    const theme = await app.theme();
    spoke.push(`${theme}: notice says ${JSON.stringify(await app.evaluate<string>(noticeSays))}`);
    spoke.push(`${theme}: awaiting pill ${await app.evaluate<string>(`document.querySelector(".strip .pill-n")?.textContent ?? "(none)"`)}`);
    spoke.push(`${theme}: item label ${await app.evaluate<string>(`document.querySelector(".strip-notice-open")?.getAttribute("aria-label") ?? ""`)}`);
    await app.shot(`window-${theme}`);
    await app.shot(`strip-${theme}`, ".strip");

    // × reads it, and the older one takes its place.
    await app.evaluate(`(() => { document.querySelector(".strip-dismiss")?.click(); return true; })()`);
    await sleep(400);
    spoke.push(`${theme}: after × the notice says ${JSON.stringify(await app.evaluate<string>(noticeSays))}`);
    await app.shot(`strip-dismissed-${theme}`, ".strip");

    // The click: the events task, opened at the firing that told.
    await app.evaluate(`(() => { document.querySelector(".strip-notice-open")?.click(); return true; })()`);
    await sleep(2500);
    spoke.push(`${theme}: after the click the notice is ${JSON.stringify(await app.evaluate<string>(noticeSays))}`);
    await app.shot(`opened-${theme}`);
    await app.preferTheme(theme === "light" ? "dark" : "light");
    // Closed the way a person closes it, so the service suspends the events task for the next start
    // to resume. The driver's own close kills the process, which leaves the events task's row
    // `running` with no run behind it — and the supervisor leaves a `running` row alone.
    await app.evaluate(`(() => { window.close(); return true; })()`).catch(() => undefined);
    await sleep(4000);
  } finally {
    await app.close();
  }

  // Dark: a restart starts the strip without notices; fresh ones post as before.
  app = await App.launch(world, { out: OUT, port: 9246 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Tasks");
    await app.until(says("Awaiting you"), "the gate to still be parked after a restart");
    const theme = await app.theme();
    await sleep(1000);
    spoke.push(`${theme}: after the restart the notice is ${JSON.stringify(await app.evaluate<string>(noticeSays))}`);
    await app.shot(`strip-after-restart-${theme}`, ".strip");
    await eventsListening(app);
    await postTwo(app, "2");
    spoke.push(`${theme}: notice says ${JSON.stringify(await app.evaluate<string>(noticeSays))}`);
    await app.shot(`window-${theme}`);
    await app.shot(`strip-${theme}`, ".strip");
    await app.preferTheme("light");
  } finally {
    await app.close();
  }
  console.log(spoke.join("\n"));
  if (app.complaints.length > 0) console.log(`complaints:\n  ${app.complaints.join("\n  ")}`);
}

void main();
