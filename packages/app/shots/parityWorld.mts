/**
 * The world the fidelity gate of decision 0015 photographs, and how each scene is reached: seeded once
 * (a finished task, a failed one, one parked at its gate, one archived). `studio.mts` keeps the app
 * launched on it; `pair.mts` reaches each scene there and grades its picture against the reference one.
 *
 * A scene is reached by what the page SAYS and by what it names itself for a person or a test — its
 * words, a role, a title or accessible name, a `data-testid` — never by a class: the page is the
 * universal shell, whose classes are react-native-web's and Tamagui's and mean nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, type World } from "./world.mjs";

/**
 * The app's page — the universal shell — and the page a specimen is drawn on, as paths of whatever
 * origin the window is on (`app://jaira` as shipped, a dev server or a built client under `studio.mts`).
 * `JAIRA_SHOTS_PAGE=/rn` is for a studio serving a client built before the DOM page went, where the
 * shell stood beside it at `/rn` — how a "before" run of a before-and-after is taken from this tree.
 */
export const PAGE = process.env["JAIRA_SHOTS_PAGE"] ?? "/";
export const SPECIMEN_PAGE = "/specimen-rn";

/**
 * The world the reference pictures were taken in (`pair.mts`): kept where it is — its project's path is
 * in what it draws — and never seeded again, since another seeding draws other ids and times and every
 * scene's golden would then be of a world that is gone. `studio.mts --goldens-world` opens a studio on it.
 */
export const GOLDENS_WORLD = join(import.meta.dirname, ".world-goldens");

export const PARKED = "tighten the changeset lint";
export const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
export const settle = (ms = 1200): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The page has drawn: `#root` has children (the universal page keeps a `#root` for this). */
export const drawn = "window.jaira && document.getElementById('root') && document.getElementById('root').children.length > 0";

export async function launch(world: World, port: number, out: string): Promise<App> {
  const app = await App.launch(world, { out, port });
  await app.until(drawn, "the window to draw");
  return app;
}

export async function start(app: App, title: string, fake: unknown): Promise<string> {
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "feature/plan",
    inputs: { issue: `# ${title}\n\nThe issue this task was raised for.` },
  });
  await app.ipc("task:start", { taskId: made.taskId, fake });
  return made.taskId;
}

/** `port` is the seeding launch's CDP port: studios seeding side by side each need their own. */
/** A TypeScript file in the project, for the Files room's code editor (`files-ts`). */
export const TS_SAMPLE = [
  "/** Which lane a card belongs in. */",
  'export type Lane = "running" | "finished" | "not-started";',
  "",
  "export function laneOfCard(card: { status: string; endedAt?: number }): Lane {",
  '  if (card.status === "running") return "running";',
  '  return card.endedAt !== undefined ? "finished" : "not-started";',
  "}",
  "",
].join("\n");

/** A `tsconfig.json`, which the schema-aware editor recognises by its name (`files-schema`): one field it rejects. */
export const TSCONFIG_SAMPLE = JSON.stringify({ compilerOptions: { target: "ES2022", strict: true, module: 5 }, include: ["src"] }, null, 2);

/** A patch to `lint.ts`, for the Files room's Changes and Side by side renderers (`files-patch-side`). */
export const PATCH_SAMPLE = [
  "--- a/lint.ts",
  "+++ b/lint.ts",
  "@@ -3,5 +3,6 @@",
  " ",
  " export function laneOfCard(card: { status: string; endedAt?: number }): Lane {",
  '   if (card.status === "running") return "running";',
  '-  return card.endedAt !== undefined ? "finished" : "not-started";',
  '+  if (card.endedAt !== undefined) return "finished";',
  '+  return "not-started";',
  " }",
  "",
].join("\n");

/** A page, for the Files room's Rendered view (`files-html`). */
export const HTML_SAMPLE = "<!doctype html>\n<html>\n  <body>\n    <h1>Release notes</h1>\n    <p>Cards now keep their lane.</p>\n  </body>\n</html>\n";

/** A table, for the Files room's table view (`files-csv`): a quoted field with a comma in it, and a short row. */
export const CSV_SAMPLE = ["card,lane,points", 'rebuild the docs site,running,3', '"lint, then test",finished,5', "add dark mode,not-started", ""].join("\n");

/** The files the Files room's scenes open, written into the project by the seed (a world seeded before them needs `--reseed`). */
export function writeSamples(project: string): void {
  writeFileSync(join(project, "lint.ts"), TS_SAMPLE);
  writeFileSync(join(project, "tsconfig.json"), TSCONFIG_SAMPLE);
  writeFileSync(join(project, "change.patch"), PATCH_SAMPLE);
  writeFileSync(join(project, "notes.html"), HTML_SAMPLE);
  writeFileSync(join(project, "cards.csv"), CSV_SAMPLE);
  // A description of `feature/plan`, beside its state file: the Files room's sync panel (`files-sync`).
  mkdirSync(join(project, ".jaira", "workflows", "feature"), { recursive: true });
  writeFileSync(join(project, ".jaira", "workflows", "feature", "plan.md"), DESCRIPTION_SAMPLE);
}

/** What `feature/plan` is for, as its description says — read by the sync panel, rendered under its bar. */
export const DESCRIPTION_SAMPLE = [
  "# Plan a feature",
  "",
  "Turns an issue into a plan somebody can build from.",
  "",
  "- **goals** — what the issue asks for, as a list",
  "- **context** — what the code already does about it",
  "- **critique** — a second reading, and a human review before anything is built",
  "",
].join("\n");

export async function seed(world: World, out: string, port = 9239): Promise<void> {
  writeSamples(world.project);
  const app = await launch(world, port, out);
  try {
    await start(app, "add dark mode", happyRules());
    await start(app, "rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await app.until(says("failed"), "the failed task");
    await start(app, PARKED, blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");
    // An archived task (main, 2026-09-27): held at the foot of the Finished lane, faded, wearing the
    // pill of how it finished — the card copy has to draw that too.
    const retired = await start(app, "retire the old lint", happyRules());
    await app.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "the task to archive to finish");
    await app.ipc("task:archive", { taskIds: [retired] });
    await app.until(says("1 archived"), "the archived task to be held at the foot");
  } finally {
    await app.close();
  }
}

/**
 * The scenes. Each is reached from a freshly loaded page. Reaching a scene can change what a later one
 * shows (opening a task marks its unseen counts seen; some scenes make what they show the first time
 * they run), so the reference pictures were taken in a world that had seen every scene once.
 */
export interface Scene {
  readonly name: string;
  /** Photographed in every look, not only the two base ones (`--scene main`). */
  readonly everyLook?: boolean;
  /**
   * For a scene whose golden is ACCEPTED from this page (`pair.mts --accept`): a page expression giving
   * the boxes (`{ name, x, y, width, height }[]`) of what the world keeps changing under it, besides the
   * sidebar's counts — painted out of every comparison. The older goldens hold theirs already.
   */
  readonly volatile?: string;
  reach(app: App): Promise<void>;
}

export const SCENES: readonly Scene[] = [
  { name: "board", everyLook: true, reach: async (app) => void (await app.until(says("Awaiting you"), "the gate to still be parked")) },
  { name: "task", everyLook: true, reach: (app) => app.clickText(PARKED) },
  {
    // The parked task opened from the inbox strip rather than its card: the same panel, reachable on a
    // page whose board is not copied yet (the strip is).
    name: "gate",
    reach: async (app) => {
      await app.until(says("Review the critique result."), "the strip to offer the gate");
      await app.clickText("Review the critique result.");
      await app.until(says("Answering this continues the task."), "the gate to open in the panel");
    },
  },
  {
    // The Finished lane's foot opened: the archived card, faded, "archived … ago", its finishing pill.
    name: "archived",
    everyLook: true,
    reach: async (app) => {
      await app.until(says("1 archived"), "the archived foot");
      await app.clickText("1 archived");
      await app.until(says("retire the old lint"), "the archived card to show");
    },
  },
  {
    // A card in the air (decision 0005): "add dark mode" picked up and held over Session, not dropped —
    // the columns that would take it dashed, Session filled, the host's dry run in its drop preview. Real
    // DOM drag events on the card and the heading, by their words, which the board's handlers take.
    name: "board-drag",
    reach: async (app) => {
      await app.until(says("add dark mode"), "the card to lift");
      const fire = (text: string, types: string[]): string => `(() => {
        const e = [...document.querySelectorAll("*")].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent === ${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0);
        if (!e) throw new Error("nothing says " + ${JSON.stringify(text)});
        window.__drag ??= new DataTransfer();
        for (const type of ${JSON.stringify(types)}) e.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__drag }));
        return true;
      })()`;
      await app.evaluate(fire("add dark mode", ["dragstart"]));
      await settle(800);
      await app.evaluate(fire("Session", ["dragenter", "dragover"]));
      await app.until(says("Drop to"), "the drop preview");
    },
  },
  // The parked task's run, drilled from its card (a double-click): the Tasks room's middle column is the
  // run's executions as cards, one column per child the workflow declares (`RunView`).
  { name: "run", reach: (app) => drillParked(app) },
  // …and its other reading, the title bar's "Conversation": the run's conversation in the middle column.
  {
    name: "run-convo",
    reach: async (app) => {
      await drillParked(app);
      await clickFirst(app, "Conversation");
      await app.until(says("Produced"), "the run's conversation, and its context in the panel");
      await settle(1500);
    },
  },
  // A LEAF of the run walked into (its Goals card, double-clicked): a state that holds a conversation,
  // so under it stands the run's composer (`ChatComposer`) rather than the activity strip.
  {
    name: "run-leaf",
    reach: async (app) => {
      await drillParked(app);
      const hit = await app.evaluate<boolean>(`(() => {
        const own = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "Goals");
        const card = own.find((e) => { const r = e.getBoundingClientRect(); return r.left > 260 && r.top > 60 && r.right < innerWidth - 420; });
        if (!card) return false;
        card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
        return true;
      })()`);
      if (!hit) throw new Error("no goals card to walk into");
      await app.until(`[...document.querySelectorAll("textarea")].length > 0`, "the run's composer");
      await settle(1500);
    },
  },
  // The run's conversation with the pointer on a knot of its rail: the lane lit in every row it crosses,
  // and its name following the pointer (`.rail-tip`).
  {
    name: "run-rail-hover",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "run-convo")!.reach(app);
      const at = await lastKnot(app);
      await app.hover(at.x, at.y);
      await settle(600);
    },
  },
  // …and that knot clicked: its lane folds, and the row says so in place of what it held (`.rail-rolled`).
  {
    name: "run-knot-fold",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "run-convo")!.reach(app);
      const at = await lastKnot(app);
      await app.hover(at.x, at.y);
      await app.clickAt(at.x, at.y);
      // By its text, not its words on screen: the tag is set upper case.
      await app.until(`document.body.textContent.includes("rolled up")`, "the lane to roll up");
      await app.hover(2, 2);
      await settle(800);
    },
  },
  // …and that knot right-clicked: the lane's menu, the entered row's two verbs.
  {
    name: "run-lane-menu",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "run-convo")!.reach(app);
      const at = await lastKnot(app);
      await app.hover(at.x, at.y);
      await app.evaluate(`(() => {
        const el = document.elementFromPoint(${at.x}, ${at.y});
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${at.x}, clientY: ${at.y}, button: 2 }));
      })()`);
      await app.until(says("Fork before"), "the lane's menu");
      await settle(500);
    },
  },
  // …and a step of the Steps index beside it pressed: the step's card in the panel, and the conversation
  // taken to where the run entered that state (a bookmark), the index marking where the reader now is.
  {
    name: "run-bookmark",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "run-convo")!.reach(app);
      const hit = await app.evaluate<boolean>(`(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "goals" && e.getBoundingClientRect().left > innerWidth - 420);
        if (!el) return false;
        (el.closest("button, [role=button]") ?? el).click();
        return true;
      })()`);
      if (!hit) throw new Error("no goals step in the index");
      await app.until(says("How it ran"), "the step's card");
      await settle(1800);
    },
  },
  // A task that ADOPTED another, opened in the panel: its conversation, where the adoption's line
  // unfolds the adopted task's own history under it (read by that task's id). Made the first time.
  {
    name: "task-adopted",
    reach: async (app) => {
      await adopted(app);
      await clickFirst(app, "Tasks");
      await app.until(says(ADOPTER), `${ADOPTER} on the board`);
      await clickFirst(app, ADOPTER);
      await app.until(`document.body.textContent.includes("adopted")`, "the adoption's line in the panel");
      await app.until(says("Extract goals from"), "the adopted history to unfold");
      await settle(1800);
      // From its top: the history arrives after the page first pinned to its end, and the desktop's
      // follow waits for the task's own rows to change before it moves again.
      await scrollPanel(app, 0);
    },
  },
  // The parked task's panel PINNED, and another task selected: the panel keeps the parked task, whose run
  // the store no longer holds — its conversation read by its own id (`OwnRun`).
  {
    name: "task-pinned",
    reach: async (app) => {
      await app.clickText(PARKED);
      await app.until(says("Answering this continues the task."), "the task to open in the panel");
      await clickTitled(app, ["Pin — keep this while you select other things"]);
      await app.until(says("add dark mode"), "the finished task on the board");
      await app.evaluate(`(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "add dark mode" && e.getBoundingClientRect().left > 260 && e.getBoundingClientRect().right < innerWidth - 420);
        (el.closest("button, [role=button]") ?? el).click();
      })()`);
      await settle(2500);
      await app.until(says("Answering this continues the task."), "the pinned task's gate, read by its own run");
      await settle(1200);
    },
  },
  // …and at its end: the last of the adopted history, and the rows after the line.
  {
    name: "task-adopted-end",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "task-adopted")!.reach(app);
      await scrollPanel(app, 1e9);
    },
  },
  // The parked task's other tabs in the panel: Steps, Changes, Outputs (`{}`) and Configuration (an icon).
  ...(
    [
      ["task-steps", "Steps"],
      ["task-changes", "Changes"],
      ["task-outputs", "Outputs"],
      ["task-config", "Configuration"],
    ] as const
  ).map(
    ([name, tab]): Scene => ({
      name,
      reach: async (app) => {
        await app.clickText(PARKED);
        await app.until(says("Answering this continues the task."), "the task to open in the panel");
        // By the tab's own name, which the labelled tab says and an icon tab carries as its title.
        await app.evaluate(`(() => {
          const want = ${JSON.stringify(tab)};
          const tab = [...document.querySelectorAll('[role="tab"], button')].find((e) => e.textContent.trim() === want || e.getAttribute("title") === want || e.getAttribute("aria-label") === want || (e.textContent.trim().startsWith(want) && e.getAttribute("role") === "tab"));
          if (!tab) throw new Error("no tab " + want);
          tab.click();
        })()`);
        await settle(1200);
      },
    }),
  ),
  // A task whose gate was answered: the question as it was answered, in its state's panel (a settled
  // gate), and the record behind its toggle. Made here the first time it is reached.
  {
    name: "task-answered",
    reach: async (app) => {
      await answered(app);
      // The room the window was last left in is remembered: the board first.
      await clickFirst(app, "Tasks");
      await app.until(says(ANSWERED), `${ANSWERED} on the board`);
      await clickFirst(app, ANSWERED);
      await app.until(says("Show the record"), "the settled gate in the panel");
      await settle(1500);
    },
  },
  // The finished task and the failed one, opened in the panel: their conversations, the pieces a run
  // that is over draws (settled gates, failed states, what could not be entered).
  ...(
    [
      ["task-done", "add dark mode"],
      ["task-failed", "rework the sync lint"],
    ] as const
  ).map(
    ([name, title]): Scene => ({
      name,
      reach: async (app) => {
        await app.until(says(title), `${title} on the board`);
        await clickFirst(app, title);
        await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(title)} && e.getBoundingClientRect().left > innerWidth - 420)`, `${title} to open in the panel`);
        await settle(1500);
      },
    }),
  ),
  // The parked task's Steps with a step picked: the index over the step's card.
  {
    name: "task-step-card",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "task-steps")!.reach(app);
      await app.evaluate(`(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "goals" && e.getBoundingClientRect().left > innerWidth - 420);
        (el.closest("button, [role=button]") ?? el).click();
      })()`);
      await app.until(says("How it ran"), "the step's card");
      await settle(1200);
    },
  },
  // The title bar's "+ New task": the New-task form in the panel, nothing picked yet.
  {
    name: "new-task",
    reach: async (app) => {
      await app.until(says("New task"), "the New task button");
      await clickFirst(app, "+ New task");
      await app.until(says("Its inputs appear here."), "the New-task form");
      await settle(800);
    },
  },
  // A column of the board clicked: the state it stands for, described in the panel (its Run tab).
  {
    name: "state",
    reach: async (app) => {
      await clickFirst(app, await planColumn(app));
      await app.until(says("Checks"), "the state to open in the panel");
      await settle(800);
    },
  },
  // …and its Configuration tab: the state's own file in the panel's workflow editor (`StatePanel`),
  // the form over it — editable, with the JSON tab beside it.
  {
    name: "state-config",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "state")!.reach(app);
      await app.evaluate(`(() => {
        const tab = [...document.querySelectorAll('[role="tab"], button')].find((e) => (e.textContent.trim() === "Configuration" || e.getAttribute("title") === "Configuration" || e.getAttribute("aria-label") === "Configuration") && e.getBoundingClientRect().left > innerWidth - 420);
        if (!tab) throw new Error("no Configuration tab");
        tab.click();
      })()`);
      await app.until(says("Open in the editor"), "the state's configuration");
      await settle(1500);
    },
  },
  // A workflow's state files opened in the Files room (the seeded world's `.jaira/workflows/…`): a
  // leaf's `.json` in the authoring form (the workflow editor), and a composite's, on its Graph tab —
  // the state graph.
  ...(
    [
      ["files-state", "goals.json", null],
      ["files-state-json", "goals.json", "JSON"],
      ["files-plan", "plan.json", "Form"],
      ["files-graph", "plan.json", "Graph"],
    ] as const
  ).map(
    ([name, file, tab]): Scene => ({
      name,
      reach: async (app) => {
        await app.clickText("Files");
        await app.until(says(".jaira"), "the Files drawer");
        // The project's tree comes first (the built-in root below it has a `workflows` too), and a folder
        // is clicked only while its row's caret says it is folded: the tree remembers what was unfolded.
        const open = [".jaira", "workflows", "feature", ...(file === "plan.json" ? [] : ["plan"]), file];
        for (const step of open) {
          await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(step)})`, `${step} in the tree`);
          await app.evaluate(`(() => {
            const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(step)});
            const row = el.closest("button, a, [role=button], li") ?? el;
            if (!${JSON.stringify(step.endsWith(".json"))} && row.textContent.includes("▾")) return;
            row.click();
          })()`);
          await settle(400);
        }
        await app.until(says("Graph") + " && " + says("default & description"), `${file} to open in the editor`);
        if (tab !== null) {
          await app.evaluate(`(() => {
            const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(tab)});
            (el.closest("button, [role=button]") ?? el).click();
          })()`);
          await app.until(says(tab === "Graph" ? "drag to pan" : tab === "JSON" ? "Schema" : "default & description"), `the ${tab} tab`);
        }
        await settle(1500);
        // The panel beside the editor is still on the task an earlier scene opened, scrolled where that
        // scene left it — which depends on what ran before this one. From its top, whatever ran.
        await scrollPanel(app, 0);
      },
    }),
  ),
  // The same forms scrolled to a table further down — its heading at the top of the scroller, to a
  // device pixel: a reading's children and their wiring, the editable form's children and
  // transitions, a leaf's operation block.
  ...(
    [
      ["task-config-children", "task-config", "Children"],
      ["state-config-children", "state-config", "Children"],
      ["files-state-operation", "files-state", "Operation"],
      ["files-plan-children", "files-plan", "Children"],
    ] as const
  ).map(
    ([name, from, heading]): Scene => ({
      name,
      reach: async (app) => {
        await SCENES.find((s) => s.name === from)!.reach(app);
        const find = `[...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(heading)} && e.getBoundingClientRect().left > 250)`;
        await app.until(`${find} !== undefined`, `the ${heading} heading`);
        await app.evaluate(`(() => {
          const el = ${find};
          let box = el.parentElement;
          while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
          box.scrollTop = Math.round((el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8) * devicePixelRatio) / devicePixelRatio;
        })()`);
        await settle(500);
      },
    }),
  ),
  { name: "settings", reach: (app) => app.clickText("Settings") },
  // Each Settings page (`settings` opens on Connections), reached from the sidebar's sections list.
  ...(
    [
      ["appearance", "Appearance"],
      ["machines", "Machines"],
      ["models", "Models"],
      ["tools", "Tools"],
      ["runs", "Runs"],
      ["data", "Data & history"],
      ["about", "About"],
    ] as const
  ).map(
    ([id, label]): Scene => ({
      name: `settings-${id}`,
      reach: async (app) => {
        await app.clickText("Settings");
        await clickFirst(app, label);
        await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(label)} && e.getBoundingClientRect().left > 250)`, `the ${label} page`);
      },
    }),
  ),
  // Appearance on the personal layer: the "Which rows" choice under the lead, and "What you changed"
  // leaving nothing on the page.
  {
    name: "settings-appearance-you",
    reach: async (app) => {
      await app.clickText("Settings");
      await clickFirst(app, "Appearance");
      await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === "Appearance" && e.getBoundingClientRect().left > 250)`, "the Appearance page");
      await clickFirst(app, "Just you");
      await app.until(says("What you changed"), "the Just you view");
    },
  },
  // Appearance scrolled to one of its sections, its heading at the top of the page — the viewport
  // photographs only what is scrolled into view, and the page is several windows tall.
  ...(["Board", "Conversation", "Text", "File types"] as const).map(
    (heading): Scene => ({
      name: `settings-appearance-${heading.toLowerCase().replace(" ", "-")}`,
      reach: async (app) => {
        await app.clickText("Settings");
        await clickFirst(app, "Appearance");
        await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === "Appearance" && e.getBoundingClientRect().left > 250)`, "the Appearance page");
        const find = `[...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(heading)} && e.getBoundingClientRect().left > 250)`;
        await app.until(`${find} !== undefined`, `the ${heading} heading`);
        // To a device pixel, as the reference page was scrolled: `scrollIntoView` lands a fraction off.
        await app.evaluate(`(() => {
          const el = ${find};
          let box = el.parentElement;
          while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
          box.scrollTop = Math.round((el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) * devicePixelRatio) / devicePixelRatio;
        })()`);
        await settle(300);
      },
    }),
  ),
  // The other rooms, each reached from the sidebar (decision 0015's universal copies are checked in them).
  { name: "files", reach: (app) => app.clickText("Files") },
  // A file opened from the Files drawer: the address bar, the viewer over the editor (decision 0015's
  // Files copy). `open` is the path down the tree; a folder is clicked only while what is under it is
  // not showing, since the tree remembers what was unfolded and a second click would fold it again.
  ...(
    [
      ["files-markdown", ["plan_doc.md"], "The Plan"],
      ["files-readme", ["README.md"], "an edit copies it to Shared"],
      ["files-json", ["permission-sets", "chat", "ask-first.json"], "read_file"],
      // The code editor (Monaco, an island).
      ["files-ts", ["lint.ts"], "Revert"],
      // A type with no grammar: the plain box (`textarea.code-editor`), the configuration editor's too.
      ["files-plain", [".jaira", ".gitignore"], "Revert"],
      // A document held to a schema: the verdict, the hint, a violation, and "Add missing fields".
      ["files-schema", ["tsconfig.json"], "Add missing fields"],
      // A patch as the change it describes (`PatchView`), and a CSV as its table (`TableView`).
      ["files-patch", ["change.patch"], "@@ -3,5 +3,6 @@"],
      ["files-csv", ["cards.csv"], "lint, then test"],
      // A workflow's description: the sync panel's bar (never synced, so no recommendation) over the rendering.
      ["files-sync", [".jaira", "workflows", "feature", "plan.md"], "Turns an issue into a plan somebody can build from."],
    ] as const
  ).map(
    ([name, open, shows]): Scene => ({
      name,
      reach: async (app) => {
        await app.clickText("Files");
        await app.until(says(open[0]), "the Files drawer");
        for (const [i, step] of open.entries()) {
          const next = open[i + 1];
          if (next !== undefined && (await app.evaluate<boolean>(says(next)))) continue;
          await clickFirst(app, step);
          if (next !== undefined) await app.until(says(next), `${step} to unfold`);
        }
        await app.until(says(shows), `${open.at(-1)} to open`);
      },
    }),
  ),
  // A folder, as the Files panel lists one: a file opened, then the root crumb of its address (the last
  // ".jaira" on the page — the tree's row comes first).
  {
    name: "files-folder",
    reach: async (app) => {
      await app.clickText("Files");
      await app.until(says("plan_doc.md"), "the Files drawer");
      await clickFirst(app, "plan_doc.md");
      await app.until(says("The Plan"), "plan_doc.md to open");
      await app.clickText(".jaira");
      await app.until(`!document.body.innerText.includes("The Plan")`, "the folder to open");
    },
  },
  // The ⓘ at the end of a plain file's address, open: its facts in a float under it.
  {
    name: "files-facts",
    reach: async (app) => {
      await app.clickText("Files");
      await app.until(says("plan_doc.md"), "the Files drawer");
      await clickFirst(app, "plan_doc.md");
      await app.until(says("The Plan"), "plan_doc.md to open");
      await app.evaluate(`document.querySelector('[title="About this"], [aria-label="About this"]').click()`);
      await app.until(says("the file"), "the facts to open");
    },
  },
  // A file's right-click menu in the Files drawer (a long press on a phone).
  {
    name: "files-menu",
    reach: async (app) => {
      await app.clickText("Files");
      await app.until(says("plan_doc.md"), "the Files drawer");
      await app.evaluate(`(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "plan_doc.md");
        const box = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 8), button: 2 }));
      })()`);
      await app.until(says("Rename…"), "the menu to open");
    },
  },
  // …and its "Rename…": the dialog asking for the new path.
  {
    name: "files-rename",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "files-menu")!.reach(app);
      await clickFirst(app, "Rename…");
      await app.until(says("Rename 'plan_doc.md'"), "the dialog to open");
      await app.until(`document.activeElement?.tagName === "INPUT"`, "the field to take the caret");
      await app.evaluate(`document.activeElement.style.caretColor = "transparent"`);
    },
  },
  // The Files row's two verbs: find (the filter field over the tree), and `+` → "New file…" (the row a
  // name is typed into, at the top of the root the drawer stands in).
  ...(
    [
      ["files-find", "find in files", null],
      ["files-new", "new file, folder or workflow", "New file…"],
    ] as const
  ).map(
    ([name, act, item]): Scene => ({
      name,
      reach: async (app) => {
        await app.clickText("Files");
        await app.until(says("plan_doc.md"), "the Files drawer");
        await app.evaluate(`document.querySelector('[aria-label=${JSON.stringify(act)}]').click()`);
        if (item !== null) {
          await app.until(says(item), "the new menu");
          await clickFirst(app, item);
        }
        await app.until(`document.activeElement?.tagName === "INPUT"`, "the field to take the caret");
        // The caret blinks, so it is hidden: both pictures have none. (A blur would drop the draft.)
        await app.evaluate(`document.activeElement.style.caretColor = "transparent"`);
      },
    }),
  ),
  { name: "chat", reach: (app) => app.clickText("Chat") },
  {
    // A conversation open in the Chat room: a message and its answer (a fake model's, in markdown), the
    // composer under them, the project's Chat drawer listing it and its name in the title bar. Made
    // here the first time it is reached rather than in `seed`, so a studio seeded before it existed
    // has it too; the same conversation is opened after that.
    name: "conversation",
    reach: async (app) => {
      await conversation(app);
      await app.clickText("Chat");
      await app.until(says(CONVERSATION), "the conversation to be listed");
      await app.clickText(CONVERSATION);
      await app.until(says("It checks that"), "the answer to be drawn");
    },
  },
  {
    // A conversation with work in it: the fake model reads, searches, runs a failing command and a
    // passing one, and answers — the tool rows and the work summary above the answer (decision 0015's
    // transcript copy). Made the first time it is reached, as `conversation` is.
    name: "conversation-tools",
    reach: async (app) => {
      await conversation(app, TOOLS_CONVERSATION);
      await app.clickText("Chat");
      await app.until(says(TOOLS_CONVERSATION), "the conversation to be listed");
      await app.clickText(TOOLS_CONVERSATION);
      await app.until(says("One rule now covers"), "the answer to be drawn");
      await settle(800);
    },
  },
  {
    // The same conversation with its "Every step" open under the summary.
    name: "conversation-steps",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "conversation-tools")!.reach(app);
      await clickFirst(app, "Every step");
      await app.until(says("scrollbar-styling"), "every step to open");
      await settle(600);
    },
  },
  {
    // …with the pointer on one of its summary's chips: the rows it counts, in a hover card.
    name: "conversation-chip-card",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "conversation-tools")!.reach(app);
      const at = await app.evaluate<{ x: number; y: number }>(`(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "2 files");
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await app.hover(at.x, at.y);
      await app.until(says("2 lines"), "the chip's card");
      await settle(600);
    },
  },
  {
    // …and one of its rows opened: the call's arguments and result under it.
    name: "conversation-row",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "conversation-steps")!.reach(app);
      await clickFirst(app, "Web fetch");
      await app.until(says("scrollbar-width and scrollbar-color"), "the row to open");
      await settle(600);
    },
  },
  // The conversation's composer with one of its chips' cards open (a button titled "<Label>: <value>"),
  // and the context ring's card.
  ...(
    [
      ["composer-model", '[title^="Model: "]', "Model"],
      ["composer-thinking", '[title^="Thinking: "]', "Thinking"],
      ["composer-permissions", '[title^="Permissions: "]', "Permissions"],
      ["composer-tools", '[title^="Tools: "]', "Tools"],
      ["composer-context", '[title^="No reading yet"], [title^="This conversation"]', "Context"],
    ] as const
  ).map(
    ([name, chip, heading]): Scene => ({
      name,
      reach: async (app) => {
        await SCENES.find((s) => s.name === "conversation")!.reach(app);
        await app.until(`document.querySelector(${JSON.stringify(chip)}) !== null`, `the ${heading} chip`);
        await app.evaluate(`document.querySelector(${JSON.stringify(chip)}).click()`);
        await app.until(`[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(heading)}).length > 0`, `the ${heading} card`);
        await settle(800);
      },
    }),
  ),
  {
    // A conversation whose answer is a page that RUNS: `show_artifact` with `interactive`, drawn under its
    // call in the frame the record grants it (`jaira-artifact:`), its script already at work. Made the
    // first time it is reached, as `conversation` is; `artifact-prompt` presses its button.
    name: "conversation-artifact",
    reach: async (app) => {
      await artifactConversation(app);
      await app.clickText("Chat");
      await app.until(says(ARTIFACT_CONVERSATION), "the conversation to be listed");
      await app.clickText(ARTIFACT_CONVERSATION);
      await app.until(says(ARTIFACT_ANSWER), "the answer to be drawn");
      await app.until(`[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith("jaira-artifact:"))`, "the page to be granted a frame");
      // The prompt an earlier `artifact-prompt` put in the box is kept with the conversation: emptied, as
      // a person would, so every scene from here starts from the same box.
      const kept = await app.evaluate<boolean>(`(() => { const a = [...document.querySelectorAll("textarea")].find((a) => a.value === ${JSON.stringify(ARTIFACT_PROMPT)}); if (!a) return false; a.focus(); a.select(); return true; })()`);
      if (kept) {
        await app.press("Backspace", 8);
        await app.until(`![...document.querySelectorAll("textarea")].some((a) => a.value !== "")`, "the box to empty");
        await app.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      }
      await settle(1200);
    },
  },
  {
    // …and its button pressed: what the page posts lands in the composer, to be read and sent (or not).
    name: "artifact-prompt",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "conversation-artifact")!.reach(app);
      const at = await app.evaluate<{ x: number; y: number }>(`(() => {
        const r = [...document.querySelectorAll("iframe")].find((f) => f.src.startsWith("jaira-artifact:")).getBoundingClientRect();
        return { x: r.left + ${ARTIFACT_BUTTON.x}, y: r.top + ${ARTIFACT_BUTTON.y} };
      })()`);
      await app.clickAt(at.x, at.y);
      await app.until(`[...document.querySelectorAll("textarea")].some((a) => a.value === ${JSON.stringify(ARTIFACT_PROMPT)})`, "the page's prompt in the composer");
      await app.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await settle(600);
    },
  },
  {
    // The conversation's Produced tab with the page picked: its row says it `runs`, and it runs there
    // too, on the task's own grant (the panel has no composer, so nothing it posts goes anywhere).
    name: "artifact-produced",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "conversation-artifact")!.reach(app);
      await clickFirst(app, "Produced");
      await app.until(says(ARTIFACT_PATH), "the Produced tab to list the page");
      await clickTitled(app, [ARTIFACT_PATH]);
      await app.until(`[...document.querySelectorAll("iframe")].filter((f) => f.src.startsWith("jaira-artifact:")).length >= 2`, "the picked page to be granted a frame");
      await settle(1200);
    },
  },
  {
    // …opened on its own in the panel (the Preview card): the page full bleed, its grant come with it.
    name: "artifact-preview",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "artifact-produced")!.reach(app);
      await clickTitled(app, ["Open it on its own, in this panel"]);
      await app.until(`document.querySelector('[title="Hold it — keep it in Held"], [aria-label="Hold it — keep it in Held"]') !== null && [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith("jaira-artifact:") && f.getBoundingClientRect().height > 400)`, "the page, on its own in the panel");
      await settle(1500);
    },
  },
  {
    // The same conversation from the root's "All conversations" drawer: its rows carry their project's chip.
    name: "all-conversations",
    reach: async (app) => {
      await conversation(app);
      await app.clickText("All conversations");
      await app.until(says(CONVERSATION), "the conversation to be listed at the root");
    },
  },
  {
    name: "logs",
    reach: async (app) => {
      await app.clickText("Settings");
      await app.clickText("Logs");
    },
  },
  {
    // The Debug room before a run: the self-test's stages, its files, the run buttons and the task panel.
    name: "debug",
    reach: async (app) => {
      await app.clickText("Settings");
      // By its words as written (the footer row draws them uppercase), once the Settings panel is up.
      await app.until(`document.getElementById("root").textContent.includes("Debug")`, "the Debug row");
      await app.clickText("Debug");
      await app.until(says("Workflow self-test"), "the Debug room");
    },
  },
  {
    // The Components room: every surface a run can park at, a row each.
    name: "gallery",
    reach: async (app) => {
      await app.clickText("Settings");
      // By its words as written (the footer row draws them uppercase), once the Settings panel is up.
      await app.until(`document.getElementById("root").textContent.includes("Components")`, "the Components row");
      await app.clickText("Components");
      await app.until(says("Every row to"), "the Components room");
      // Every card's form is laid out from its measured width (react-native-web's onLayout, a frame or
      // more behind): let the page settle — and hold still: a row is scrolled to by where it stands, and
      // on a busy machine an editor that mounted after the pause moved every row under it (a scene 18 or
      // 54px out, 70,000 pixels).
      await settle(2500);
      await app.settled();
    },
  },
  {
    // A real Monaco drawing a real sample through the TextMate grammars (WASM): the part of the
    // renderer most likely to break under a new origin and a new content policy.
    name: "file-types",
    reach: async (app) => {
      await app.clickText("Settings");
      await app.clickText("Appearance");
      // Scrolled into view, and again on every try, for the picture rather than for Monaco: the section sits
      // in the settings pane's own scroll container, which a capture paints only where it is scrolled
      // to, and the page lays out after the preview mounts, undoing a scroll made before that. Monaco
      // draws an editor below the fold perfectly well; what it cannot draw in is a hidden window,
      // which is what used to leave this editor empty (see `launch` in the driver).
      // The section by its `testID`, the preview by its `code` island.
      const FT = `document.querySelector("[data-testid=ft]")`;
      const BODY = `document.querySelector("[data-testid=ft] [data-island=code]")`;
      await app.until(`${BODY} !== null`, "the preview to mount");
      await app.until(
        `(${BODY}.scrollIntoView({ block: "center" }),
          [...${BODY}.querySelectorAll(".view-lines span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)"))`,
        "the preview's editor to colour itself",
      );
      // Then the section's top, which is what the picture frames: centred on the preview, the section is
      // about as tall as the window and its upper half lay above the fold, unpainted.
      await app.evaluate(`${FT}.scrollIntoView({ block: "start" })`);
      // Centring the preview also scrolled its own box: what is centred is the island, the surface's own
      // 200 in the preview's 190, and the box moved by half the difference. Put back, as the reference
      // page's stood (there the box itself was what was centred).
      await app.evaluate(`(() => { for (let e = ${BODY}.parentElement; e && e !== ${FT}; e = e.parentElement) if (e.scrollTop !== 0) e.scrollTop = 0; })()`);
      await app.until(
        `(() => { const top = ${FT}.getBoundingClientRect().top; return top >= 0 && top < innerHeight / 2; })()`,
        "File types to scroll into view",
      );
    },
  },
  // The sidebar collapsed to its rail (the `|◂` toggle): the board beside a strip of glyphs.
  {
    name: "sidebar-shut",
    everyLook: true,
    reach: async (app) => {
      await app.until(says("Awaiting you"), "the board");
      await clickTitled(app, ["Hide the sidebar"]);
      await app.until(`!!document.querySelector('[aria-label="Show the sidebar"]')`, "the sidebar to fold to its rail");
    },
  },
  // The parked task open, its side panel folded to its rail (the panel's fold button).
  {
    name: "task-folded",
    everyLook: true,
    reach: async (app) => {
      await app.clickText(PARKED);
      await app.until(`!!document.querySelector('[title="Fold the panel to a rail"], [title="Collapse the panel to a rail"]')`, "the task's panel");
      await clickTitled(app, ["Fold the panel to a rail", "Collapse the panel to a rail"]);
      await app.until(`!!document.querySelector('[title="Unfold the panel"]')`, "the panel to fold to its rail");
    },
  },
  // Settings, then the sidebar collapsed: the page beside the rail (the rail's ⚙ would open the column
  // again, so the page is opened first).
  {
    name: "settings-shut",
    everyLook: true,
    reach: async (app) => {
      await app.clickText("Settings");
      await clickTitled(app, ["Hide the sidebar"]);
      await app.until(`!!document.querySelector('[aria-label="Show the sidebar"]')`, "the sidebar to fold to its rail");
    },
  },
  // The shell's own floats: the board's right-click menus and what they ask, and the card the Settings
  // row's pills open.
  // A card's right-click (a long press on a phone): the parked task's verbs.
  { name: "card-menu", reach: (app) => boardMenu(app, PARKED, "Copy task id") },
  // …a finished task's: re-run as a fresh copy, Cancel disabled, Archive.
  { name: "card-menu-done", reach: (app) => boardMenu(app, "add dark mode", "Archive") },
  // A column's: the place, and every task standing in it (a caption, the group verbs).
  { name: "column-menu", reach: async (app) => boardMenu(app, await planColumn(app), "Describe") },
  // Right-clicking inside a multi-selection (a click, then a ctrl-click): the set's verbs, counted.
  {
    name: "selection-menu",
    reach: async (app) => {
      await app.until(says(PARKED), "the parked card");
      for (const [title, ctrlKey] of [[PARKED, false], ["add dark mode", true]] as const) {
        await app.evaluate(`(() => {
          const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(title)} && e.closest(${ON_BOARD}) !== null);
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: ${ctrlKey} }));
        })()`);
        await settle(400);
      }
      await boardMenu(app, "add dark mode", "Copy task ids");
    },
  },
  // …and a card menu's Delete…: the confirmation, over everything.
  {
    name: "card-delete",
    reach: async (app) => {
      await boardMenu(app, "add dark mode", "Delete…");
      await clickFirst(app, "Delete…");
      await app.until(says('Delete "add dark mode"?'), "the confirmation");
      await settle(300);
    },
  },
  // The Settings row's pills: the card of everything that needs attention, beside them.
  {
    name: "health-card",
    reach: async (app) => {
      // By its title or its accessible name.
      const pills = `document.querySelector('[title="What needs attention"], [aria-label="What needs attention"]')`;
      await app.until(`${pills} !== null`, "the Settings row's pills");
      await app.evaluate(`${pills}.click()`);
      await app.until(says("Dismiss all"), "the needs-attention card");
      await settle(300);
    },
  },
  // The Components room scrolled to one row, its title at the top of the page, and (where named) that
  // row slid to one of its variants by its tab: each gate and dialog a run can put in front of you.
  ...(
    [
      ["gallery-choose", "Choose an option", null],
      ["gallery-choose-comments", "Choose an option", "With a comment"],
      ["gallery-choose-custom", "Choose an option", "With an answer of your own"],
      ["gallery-choose-multiple", "Choose an option", "Several at once"],
      ["gallery-choose-confirm", "Choose an option", "Held until confirmed"],
      ["gallery-choose-steps", "Choose an option", "Several questions, one at a time"],
      ["gallery-choose-follow-up", "Choose an option", "With follow-up questions"],
      ["gallery-choose-typed", "Choose an option", "Typed answers"],
      ["gallery-review", "Review an artifact", null],
      ["gallery-edit", "Edit an artifact", null],
      ["gallery-form", "Fill in a form", null],
      ["gallery-form-defaults", "Fill in a form", "Pre-answered, all optional"],
      ["gallery-form-custom", "Fill in a form", "An enum with a way out"],
      ["gallery-confirm", "Confirm an action", null],
      ["gallery-confirm-defaults", "Confirm an action", "Defaults"],
      ["gallery-confirm-remote", "Confirm an action", "Before anything leaves the machine"],
      ["gallery-reviews", "Review a set of artifacts", null],
      ["gallery-tool-call", "Approve a tool call, for a function", null],
      ["gallery-tool-call-input", "Approve a tool call, for a function", "A tool that is not the shell"],
      ["gallery-unknown", "A gate JaiRA does not know", null],
      ["gallery-approval", "Approve a command", null],
      ["gallery-approval-function", "Approve a command", "Parts a function decided"],
      ["gallery-approval-empty", "Approve a command", "A line nobody took apart"],
      ["gallery-approval-input", "Approve a command", "Structured input"],
      ["gallery-question", "Answer an agent's question", null],
      ["gallery-question-steps", "Answer an agent's question", "Several, in steps"],
      ["gallery-question-multiple", "Answer an agent's question", "Pick several"],
    ] as const
  ).map(
    ([name, row, variant]): Scene => ({
      name,
      reach: async (app) => {
        await SCENES.find((s) => s.name === "gallery")!.reach(app);
        await galleryRow(app, row);
        if (variant !== null) {
          await app.evaluate(`(() => {
            const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(variant)});
            (el.closest("button, [role=button]") ?? el).click();
          })()`);
          // The row's track slides to it (animated).
          await settle(1500);
          await galleryRow(app, row);
        }
      },
    }),
  ),
  // An approval's answer menu, open: its caret pressed on the Components room's first command approval.
  {
    name: "gallery-approval-menu",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "gallery-approval")!.reach(app);
      await app.evaluate(`document.querySelector('[aria-label^="Allow: what it covers"]').click()`);
      await app.until(says("Allow once"), "the answer menu");
      await settle(400);
    },
  },
  // A config in its JSON view: the Components room's first form card, its Form | JSON switch on JSON —
  // the schema editor with the schema locked to the surface's (its text an island).
  {
    name: "gallery-form-json",
    reach: async (app) => {
      await SCENES.find((s) => s.name === "gallery-form")!.reach(app);
      await app.evaluate(`(() => {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let title = null;
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent === "Fill in a form") { title = n; break; }
        const all = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "JSON");
        const el = all.find((e) => title.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
        (el.closest("button, [role=button]") ?? el).click();
      })()`);
      await app.until(says("Add missing fields"), "the JSON editor");
      await settle(1200);
      await galleryRow(app, "Fill in a form");
    },
  },
];

/**
 * What the board calls the planning workflow's column: "Planning", its label, until `task-adopted` has
 * written `ship`, which mounts it as a child — from then on it is no root, and its column goes by its
 * id. A scene that clicks the column must find it in a world of either age.
 */
async function planColumn(app: App): Promise<string> {
  const column = (name: string): string => `[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(name)})`;
  await app.until(`${column("Planning")} || ${column("feature/plan")}`, "the board");
  return (await app.evaluate<boolean>(column("Planning"))) ? "Planning" : "feature/plan";
}

/** Scroll the Components page so the row titled `title` stands just under its sticky bar, to a device pixel. */
async function galleryRow(app: App, title: string): Promise<void> {
  await app.evaluate(`(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let el = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent === ${JSON.stringify(title)}) { el = n.parentElement; break; }
    if (!el) throw new Error("no gallery row " + ${JSON.stringify(title)});
    let box = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    box.scrollTop = Math.round((el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 120) * devicePixelRatio) / devicePixelRatio;
  })()`);
  await settle(600);
}

/** The Tasks room's middle column, by its test id. */
const ON_BOARD = JSON.stringify('[data-testid="board-column"]');

/**
 * Right-click the board's `text` (a card's title or a column's name) where the board draws it, and wait
 * for the menu to say `shows`.
 */
async function boardMenu(app: App, text: string, shows: string): Promise<void> {
  await app.until(says(text), `${text} on the board`);
  await app.evaluate(`(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(text)} && e.closest(${ON_BOARD}) !== null);
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 8), button: 2 }));
  })()`);
  await app.until(says(shows), "the menu to open");
  await settle(300);
}

/** The task the `task-answered` scene opens: parked at its gate, and answered. */
export const ANSWERED = "answer the critique";

/** The task the `task-adopted` scene opens: a `ship` task that adopted a finished planning task. */
export const ADOPTER = "ship the adopted plan";
const ADOPTEE = "plan to be adopted";
/** `ship`: a workflow that mounts the planning workflow as its one child — what an adoption needs. */
const SHIP = {
  label: "Ship",
  environment: { kind: "prompt", model: "planner" },
  inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } },
  children: { plan: { state: "feature/plan", inputs: { issue: ".inputs.issue" } } },
  sequence: ["plan"],
};
/** Scroll the side panel's scroller (the tallest one in it) to `y`. */
async function scrollPanel(app: App, y: number): Promise<void> {
  await app.evaluate(`(() => {
    const boxes = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.getBoundingClientRect().left > innerWidth - 420);
    const box = boxes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (box) box.scrollTop = ${y};
  })()`);
  await settle(900);
}

async function adopted(app: App): Promise<void> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const at = project !== undefined ? { project } : {};
  const tasks = await app.ipc<Array<{ title: string; taskId: string; status: string }>>("task:list", at);
  if (tasks.some((t) => t.title === ADOPTER)) return;
  await app.ipc("workflow:write", { stateId: "ship", layer: "project", ...at, text: JSON.stringify(SHIP, null, 2) });
  let taskId = tasks.find((t) => t.title === ADOPTEE)?.taskId;
  if (taskId === undefined) taskId = await start(app, ADOPTEE, happyRules());
  for (let i = 0; i < 60; i++) {
    const now = await app.ipc<Array<{ taskId: string; status: string }>>("task:list", at);
    if (now.find((t) => t.taskId === taskId)?.status === "completed") break;
    await settle(500);
  }
  const result = await app.ipc<{ ok: boolean; refusal?: { message: string } }>("task:adopt", { taskId, workflow: "ship", title: ADOPTER, ...at, fake: happyRules() });
  if (!result.ok) throw new Error(`the adoption was refused: ${result.refusal?.message ?? "?"}`);
  await settle(2500);
}
async function answered(app: App): Promise<void> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const tasks = await app.ipc<Array<{ title: string }>>("task:list", project !== undefined ? { project } : {});
  if (tasks.some((t) => t.title === ANSWERED)) return;
  const taskId = await start(app, ANSWERED, blockedAtTheGate());
  let requestId: string | undefined;
  for (let i = 0; i < 60 && requestId === undefined; i++) {
    const pending = await app.ipc<Array<{ requestId: string; taskId: string }>>("interaction:pending", undefined);
    requestId = pending.find((p) => p.taskId === taskId)?.requestId;
    if (requestId === undefined) await settle(500);
  }
  if (requestId === undefined) throw new Error("the answered task never parked at its gate");
  await app.ipc("interaction:submit", { requestId, value: { decision: "request_changes" } });
  await settle(2500);
}

/** The conversation the `conversation` scene opens. */
export const CONVERSATION = "explain the sync lint";

/**
 * The conversation, made once in the world's project: a chat task (`chat/session`, as the Chat view
 * starts one) whose first message is its run, answered by a fake model. A no-op once it exists.
 */
async function conversation(app: App, title = CONVERSATION): Promise<void> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  if (project === undefined) throw new Error("the world has no project to talk in");
  const tasks = await app.ipc<Array<{ title: string }>>("task:list", { project });
  if (tasks.some((t) => t.title === title)) return;
  const tools = title === TOOLS_CONVERSATION;
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "chat/session",
    inputs: { message: tools ? "Make every scrollbar the same thin rounded one." : "What does the sync lint check?" },
    project,
  });
  await app.ipc("task:start", {
    taskId: made.taskId,
    project,
    fake: tools ? TOOLS_FAKE : [{ output: "It checks that **every state** a workflow names exists:\n\n- the `sequence` entries\n- each transition's `to`\n\nRun it with `jaira lint`." }],
  });
  await settle(1500);
}

/** The conversation the `conversation-tools` scene opens. */
export const TOOLS_CONVERSATION = "tidy the scrollbars";
const SRC = "packages/app/src/renderer";
const use = (id: string, name: string, input: unknown): unknown => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string, error = false): unknown => ({ type: "tool_result", tool_use_id: id, content, ...(error ? { is_error: true } : {}) });
/** Its answer, and the fake model's turn: it thinks, reads, searches, runs a failing check and a passing one. */
const TOOLS_ANSWER = "One rule now covers every scrollbar: a thin rounded thumb in `styles.css`, no track.";
const TOOLS_FAKE = [
  {
    output: TOOLS_ANSWER,
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "Several columns scroll on their own. Check how each draws its scrollbar before touching the stylesheet." }, use("t1", "Grep", { pattern: "scrollbar" }), use("t2", "Read", { file_path: `${SRC}/styles.css` })] },
      { role: "user", content: [result("t1", "styles.css:12: scrollbar-width: thin"), result("t2", "/* the stylesheet */")] },
      { role: "assistant", content: [use("t3", "Read", { file_path: `${SRC}/chatPane.tsx` }), use("t4", "WebFetch", { url: "https://developer.chrome.com/docs/css-ui/scrollbar-styling" })] },
      { role: "user", content: [result("t3", "export function ChatPane() {}"), result("t4", "scrollbar-width and scrollbar-color")] },
      { role: "assistant", content: [use("t5", "Edit", { file_path: `${SRC}/styles.css`, old_string: "a", new_string: "b" }), use("t6", "Bash", { command: "npx vitest run floatLayers.test.ts" })] },
      { role: "user", content: [result("t5", "ok"), result("t6", "1 failed", true)] },
      { role: "assistant", content: [use("t7", "Bash", { command: "npx vitest run floatLayers.test.ts" })] },
      { role: "user", content: [result("t7", "1 passed")] },
      { role: "assistant", content: [{ type: "text", text: TOOLS_ANSWER }] },
    ],
  },
];

/** The conversation the `conversation-artifact` scene opens, and what its page says and asks. */
export const ARTIFACT_CONVERSATION = "sketch the lane picker";
const ARTIFACT_ANSWER = "The picker is above: press its button and it asks for the move.";
const ARTIFACT_PATH = "lane-picker.html";
export const ARTIFACT_PROMPT = "Move the card to Finished.";
/** Where the page's button is, from the frame's top-left (inside its 1px edge): placed, so a click can find it. */
const ARTIFACT_BUTTON = { x: 1 + 16 + 110, y: 1 + 64 + 16 };
const ARTIFACT_PAGE = [
  "<!doctype html>",
  '<html><body style="margin:0;font:14px/1.4 sans-serif;color:#222">',
  '<h1 style="margin:0;padding:16px 16px 0;font-size:18px">Lane picker</h1>',
  '<p id="state" style="margin:4px 16px 0">inert</p>',
  '<button id="ask" style="position:absolute;left:16px;top:64px;width:220px;height:32px">Ask to move it to Finished</button>',
  `<script>document.getElementById("state").textContent = "running";document.getElementById("ask").onclick = () => parent.postMessage({ type: "prompt", text: ${JSON.stringify(ARTIFACT_PROMPT)} }, "*");</script>`,
  "</body></html>",
].join("\n");

/**
 * The conversation, made once: the fake model shows an interactive page (`show_artifact`), then answers.
 * A scripted model runs no tool, so the record the tool would have written — the one a grant consults —
 * is put in the artifact map here, through the project's own store opened as a replica (so nothing of the
 * running window's is recovered or claimed).
 */
async function artifactConversation(app: App): Promise<void> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  if (project === undefined) throw new Error("the world has no project to talk in");
  const tasks = await app.ipc<Array<{ title: string; taskId: string }>>("task:list", { project });
  let taskId = tasks.find((t) => t.title === ARTIFACT_CONVERSATION)?.taskId;
  if (taskId === undefined) {
    const envelope = { path: ARTIFACT_PATH, mediaType: "text/html", bytes: Buffer.byteLength(ARTIFACT_PAGE, "utf8"), uri: "", interactive: true, content: ARTIFACT_PAGE };
    const made = await app.ipc<{ taskId: string }>("task:create", { title: ARTIFACT_CONVERSATION, workflow: "chat/session", inputs: { message: "Sketch a lane picker I can click." }, project });
    taskId = made.taskId;
    envelope.uri = `artifact://${taskId}/${ARTIFACT_PATH}`;
    const fake = [
      {
        output: ARTIFACT_ANSWER,
        messages: [
          { role: "assistant", content: [use("a1", "show_artifact", { path: ARTIFACT_PATH, content: ARTIFACT_PAGE, interactive: true })] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: [{ type: "text", text: JSON.stringify(envelope) }] }] },
          { role: "assistant", content: [{ type: "text", text: ARTIFACT_ANSWER }] },
        ],
      },
    ];
    await app.ipc("task:start", { taskId, project, fake });
    await settle(1500);
  }
  const { openProject } = await import("@jaira/persistence");
  const store = openProject(project, { baseDir: join(dirname(project), "home"), replica: true });
  try {
    store.artifacts.put({ taskId, logicalPath: ARTIFACT_PATH, content: ARTIFACT_PAGE, hash: "scene", bytes: Buffer.byteLength(ARTIFACT_PAGE, "utf8"), format: "text/html", interactive: true, createdAt: 1 });
  } finally {
    store.close();
  }
}

/**
 * Drill the parked task's run: a double-click on its card in the board (the middle column — not the
 * inbox strip's or the sidebar's mention of it), as a person opens a run.
 */
async function drillParked(app: App): Promise<void> {
  await app.until(says(PARKED), "the parked card");
  const hit = await app.evaluate<boolean>(`(() => {
    const want = ${JSON.stringify(PARKED)};
    const own = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === want);
    const card = own.find((e) => { const r = e.getBoundingClientRect(); return r.left > 260 && r.bottom < innerHeight - 60; });
    if (!card) return false;
    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    return true;
  })()`);
  if (!hit) throw new Error("no parked card to drill");
  await app.until(says("not reached") + " || " + says("Human Review"), "the run to open");
  await settle(800);
}

/** The centre of the lowest knot on the middle column's rail in view — a fork's knot (r 4.5), an `<svg>` circle. */
async function lastKnot(app: App): Promise<{ x: number; y: number }> {
  const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
    const knots = [...document.querySelectorAll("circle")]
      .filter((c) => c.getAttribute("r") === "4.5" && c.getAttribute("opacity") === null)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.left > 260 && r.right < innerWidth - 420 && r.top > 60 && r.bottom < innerHeight - 120);
    const last = knots.sort((a, b) => a.top - b.top).at(-1);
    return last ? { x: Math.round(last.left + last.width / 2), y: Math.round(last.top + last.height / 2) } : null;
  })()`);
  if (at === null) throw new Error("no knot on the rail in view");
  return at;
}

/**
 * Click the FIRST element in the page whose own text is exactly `text` (`clickText` takes the last that
 * contains it) — the sidebar's row, not a page's sentence that mentions the same word.
 */
export async function clickFirst(app: App, text: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(text)});
    if (!el) return false;
    (el.closest("button, a, [role=button], li") ?? el).click();
    return true;
  })()`);
  if (!hit) throw new Error(`nothing to click reading "${text}"`);
  await settle(250);
}

/** Click the first control whose title or accessible name is one of `titles`. */
export async function clickTitled(app: App, titles: readonly string[]): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    for (const want of ${JSON.stringify(titles)}) {
      const el = document.querySelector('[title=' + JSON.stringify(want) + '], [aria-label=' + JSON.stringify(want) + ']');
      if (el) { el.click(); return true; }
    }
    return false;
  })()`);
  if (!hit) throw new Error(`nothing to click titled ${titles.join(" or ")}`);
  await settle(400);
}

/**
 * The folds the scenes above change (the sidebar's, the Tasks panel's), put back open before a scene is
 * reached, so a scene that folded one does not leave the next one folded. Written before the page loads,
 * which reads them once.
 */
const SCENE_FOLDS = ["shell.sidebar", "panel.tasks"] as const;
async function unfoldForScene(app: App): Promise<void> {
  const settings = await app.ipc<{ ui?: { open?: Record<string, boolean> } & Record<string, unknown> }>("settings:read", {});
  const ui = settings.ui ?? {};
  const open = ui.open ?? {};
  if (SCENE_FOLDS.every((key) => open[key] !== false)) return;
  const next = { ...open };
  for (const key of SCENE_FOLDS) delete next[key];
  await app.ipc("settings:write", { ui: { ...ui, open: next } });
}

/**
 * The looks the gate runs in (`pair.mts --every-look`): the default palette in both modes, then the
 * palettes whose rules the components carry by hand (`--quick` skips those).
 */
export interface Look {
  theme: "light" | "dark";
  palette: string;
  wash: boolean;
}
export const LOOKS: readonly Look[] = [
  { theme: "light", palette: "ink", wash: false },
  { theme: "dark", palette: "ink", wash: false },
  ...(process.argv.includes("--quick")
    ? []
    : ([
        { theme: "light", palette: "classic", wash: false },
        { theme: "dark", palette: "classic", wash: true },
        { theme: "light", palette: "contrast", wash: false },
        { theme: "dark", palette: "pastel", wash: false },
        { theme: "light", palette: "blueprint", wash: false },
        { theme: "light", palette: "ink", wash: true },
      ] as const)),
];
export const lookName = (l: Look): string => (l.palette === "ink" && !l.wash ? l.theme : `${l.palette}${l.wash ? "-wash" : ""}-${l.theme}`);


/** The CDP port `studio.mts` keeps its app on, for the rigs that attach to it. */
export const STUDIO_PORT = 9300;

/** `light`, `dark`, or `<palette>[-wash]-<theme>` (the names {@link lookName} gives pictures). */
export function parseLook(name: string): Look {
  if (name === "light" || name === "dark") return { theme: name, palette: "ink", wash: false };
  const m = /^([a-z-]+?)(-wash)?-(light|dark)$/.exec(name);
  if (m === null) throw new Error(`not a look: ${name} (light, dark, or <palette>[-wash]-<theme>)`);
  return { theme: m[3] as "light" | "dark", palette: m[1]!, wash: m[2] !== undefined };
}

/**
 * Load `path` ({@link PAGE}) in a look and reach a scene there. The look is written first and read by the
 * load (a page reads its configuration once), and the pointer is parked in the corner so no hover is carried over.
 */
export async function goTo(app: App, path: string, to: { look?: Look; scene?: Scene } = {}): Promise<void> {
  const step = (what: string): void => {
    if (process.env["JAIRA_SHOTS_TRACE"] !== undefined) console.log(`    [${path}] ${what}`);
  };
  step("look");
  if (to.look !== undefined) await app.preferLook(to.look);
  if (to.scene !== undefined) await unfoldForScene(app);
  // Against wherever the window is: `app://jaira` as shipped, the dev server under `studio.mts`.
  const url = (await app.evaluate<string>("location.protocol + '//' + location.host")) + path;
  step("navigate");
  await app.navigate(url);
  step("draw");
  // Patient: the dev server is shared between studios, and one rebuilding for another copier's edit
  // holds every page for several seconds.
  await app.until(drawn, `${url} to draw`, 240);
  await app.hover(2, 2);
  // A panel a scene pinned (`task-pinned`) stays pinned in the running app across pages, and a pinned
  // panel ignores the selection every later scene opens a task by: let it go first.
  if (to.scene !== undefined) {
    const unpinned = await app.evaluate<boolean>(`(() => {
      const el = document.querySelector('[title="Unpin — let a new selection replace this"], [aria-label="Unpin — let a new selection replace this"]');
      if (el) el.click();
      return el !== null;
    })()`);
    if (unpinned) await settle(400);
  }
  step("scene");
  if (to.scene !== undefined) await to.scene.reach(app);
  step("reached");
  await settle();
}
