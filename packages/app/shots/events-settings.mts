/**
 * Settings → Tools → Events and Automations (decision 0010 §2, §4; mockup B.1–B.2), in the real app,
 * over a project that is a real git repository whose `origin` is on github.com:
 *
 *  - Events on This project: origin's events with the connection badge, `git.push` on with its
 *    branches and status line, and JaiRA's own events;
 *  - the same page with a second remote on a host no connection answers — the muted badge and the
 *    disabled switches;
 *  - Automations on This project: the project's own lines first, then Shared's through its `$ref`
 *    copy, one ignored, with the flags;
 *  - Automations on Shared.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/events-settings.mts
 *
 * Needs `npm --workspace @jaira/app run build` first. Output lands in `shots/out/events-settings/`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";
import { sharedSeedOf, writeEventsDoc, type AutomationLine } from "../src/renderer/automationsModel";

const OUT = join(import.meta.dirname, "out", "events-settings");
const WORLD = join(import.meta.dirname, ".world-events-settings");

const page = (label: string): string =>
  `(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (li) li.click(); return !!li; })()`;
const layer = (label: string): string =>
  `(() => { const b = [...document.querySelectorAll(".layer-picker button, .set-head-aside button")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b; })()`;
const reveal = (part: string): string => `(() => { const el = document.querySelector('[data-part="${part}"]'); el?.scrollIntoView({ block: "start" }); return !!el; })()`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

const line = (name: string, event: string, filter: AutomationLine["filter"], steps: AutomationLine["steps"]): AutomationLine => ({ name, event, filter, steps });

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  // A real repository, its origin on GitHub.
  git(world.project, "init", "-q");
  git(world.project, "remote", "add", "origin", "https://github.com/ofersadgat/JaiRA.git");

  // What is switched on, in this project's own settings.
  const projectSettings = join(world.project, ".jaira", "settings.json");
  writeFileSync(
    projectSettings,
    JSON.stringify({ events: { "git.push": { enabled: true, branches: ["main", "release/*"] }, "git.merge_request.opened": { enabled: true } } }, null, 2),
  );

  // Shared's automations, and this project's copy: its own lines, then Shared's minus push_main.
  const shared = [
    line("push_main", "git.push", { branch: "main" }, [{ kind: "start", workflow: "feature/plan", inputs: { issue: { event: "payload.commits[0].message" } } }]),
    line("mr_opened", "git.merge_request.opened", {}, [
      { kind: "start", workflow: "feature/plan", inputs: { issue: { event: "payload.merge_request.title" } } },
      { kind: "notify", text: "Review started" },
    ]),
    line("push_any", "git.push", {}, [{ kind: "start", workflow: "feature/plan", inputs: { issue: { event: "payload.commits[0].message" } } }]),
  ];
  const own = [
    line("push_main_docs", "git.push", { branch: "main" }, [
      { kind: "start", workflow: "feature/plan", inputs: { issue: { event: "payload.commits[0].message" } } },
      { kind: "notify", text: "Planning started for the push to main" },
    ]),
    line("checks_red", "git.checks.failed", { branch: "main" }, [{ kind: "notify", text: "Checks failed on main" }]),
  ];
  const baseEvents = join(world.home, "workflows", "system");
  mkdirSync(baseEvents, { recursive: true });
  writeFileSync(join(baseEvents, "events.json"), `${JSON.stringify(writeEventsDoc(sharedSeedOf(undefined), shared), null, 2)}\n`);
  const projectEvents = join(world.project, ".jaira", "workflows", "system");
  mkdirSync(projectEvents, { recursive: true });
  writeFileSync(join(projectEvents, "events.json"), `${JSON.stringify(writeEventsDoc({}, own, { ignored: ["push_main"] }), null, 2)}\n`);

  const app = await App.launch(world, { out: OUT, port: 9243 });
  const spoke: string[] = [];
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await app.resize(1280, 4200);
    await app.evaluate(page("Tools"));
    await app.until(`document.querySelector(".set-title")?.textContent === "Tools"`, "Tools to draw");
    await app.evaluate(layer("This project"));
    await app.until(`document.querySelector('[data-part="events"] .ev-group') !== null`, "the events to draw");
    await app.until(`document.querySelector('[data-part="automations"] .au-row') !== null`, "the automations to draw");
    await sleep(1500);
    spoke.push(`sidebar parts: ${(await app.evaluate(`[...document.querySelectorAll("[data-part]")].map((e) => e.dataset.part).join(", ")`)) as string}`);
    await app.evaluate(reveal("events"));
    await sleep(300);
    await app.shot("events-project", '[data-part="events"]');
    await app.evaluate(reveal("automations"));
    await sleep(300);
    await app.shot("automations-project", '[data-part="automations"]');

    await app.evaluate(layer("Shared (all projects)"));
    await sleep(1500);
    await app.evaluate(reveal("events"));
    await app.shot("events-shared", '[data-part="events"]');
    await app.evaluate(reveal("automations"));
    await app.shot("automations-shared", '[data-part="automations"]');

    // A second remote, on a host nobody signed in to: the muted badge and the disabled switch.
    git(world.project, "remote", "add", "mirror", "https://git.example.org/ofer/JaiRA.git");
    await app.evaluate(layer("This project"));
    await sleep(3000);
    await app.evaluate(reveal("events"));
    await app.shot("events-two-remotes", '[data-part="events"]');
  } finally {
    await app.close();
  }
  console.log(spoke.join("\n"));
}

void main();
