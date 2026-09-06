/**
 * Photograph the app in the states worth looking at.
 *
 *   npm --workspace @jaira/app run shots
 *
 * Output lands in `shots/out/`, which is git-ignored: these are evidence for a comparison against
 * the visual reference (`shots/reference/the-shell.html`, SHELL.md §10), not an artifact of the
 * build, and a committed PNG goes stale the first time a hairline moves.
 *
 * ## Every state here is one the app actually reached
 *
 * There are no fixtures. A scene says how to REACH a state — start this task, wait for that, click
 * there — and the app draws whatever it draws. The runs are scripted (`fake`), so the whole set
 * costs nothing and touches no provider, but they are otherwise ordinary runs: real snapshot, real
 * journal, real projection, real panes at the width panes actually have.
 *
 * The parked gate is the clearest case of what that buys. Nothing here describes a gate. A task is
 * started whose critique comes back `blocked`, the engine transitions into `human_review`, the app
 * registers the interactive function and routes it to the renderer, and the window says "Awaiting
 * you" because that is what the app does when a run is waiting on a person.
 *
 * ## Two launches, one world
 *
 * The theme is read at startup and owned by the renderer afterwards, so each pass opens the app
 * again rather than repainting it. The world is built once and kept: the second pass photographs the
 * same tasks, and the gate is still parked — which it is because `pending_interactions` is durable,
 * so the dark pass doubles as a demonstration that a question survives the process that asked it.
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld, type World } from "./world.mjs";

const OUT = join(import.meta.dirname, "out");
/** Git-ignored beside the pictures: a scratch project, rebuilt from nothing on every run. */
const WORLD = join(import.meta.dirname, ".world");

/** A task, made and started the way the renderer makes and starts one. */
async function start(app: App, title: string, fake: unknown): Promise<void> {
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "feature/plan",
    inputs: { issue: `# ${title}\n\nThe issue this task was raised for.` },
  });
  await app.ipc("task:start", { taskId: made.taskId, fake });
}

/** What the window says, flattened — the cheapest true signal that a state has been reached. */
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

/** The task whose run is parked, and therefore the one worth opening. */
const PARKED = "tighten the changeset lint";

/**
 * Fill the world with runs.
 *
 * Three, chosen because they are the three shapes a board has to draw: one that finished, one that
 * failed, and one that is waiting on a person. The failure is real rather than staged — the scripted
 * rules answer the first call and nothing else, so the second prompt finds no reply, which the
 * engine classifies and records like any other permanent failure.
 */
async function seed(app: App): Promise<void> {
  await start(app, "add dark mode", happyRules());
  await start(app, "rework the sync lint", [happyRules()[0]]);
  await app.until(says("done"), "the completed task");
  await app.until(says("failed"), "the failed task");
  await start(app, PARKED, blockedAtTheGate());
  await app.until(says("Awaiting you"), "the run to park at its gate");
}

/** One pass over the world, in whatever theme this launch opened in. */
async function pass(world: World, port: number, fresh: boolean, last: boolean): Promise<string[]> {
  const app = await App.launch(world, { out: OUT, port });
  try {
    // The bridge AND a committed tree. Either alone is reached before the app can be asked anything:
    // the preload runs before React does, and an empty root is also what a page that threw during
    // render looks like.
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    if (fresh) await seed(app);
    else await app.until(says("Awaiting you"), "the gate to still be parked after a restart");

    const theme = await app.theme();
    console.log(`${theme}:`);
    await app.shot(`board-${theme}`);

    // The task itself, which is where the gate is answered rather than merely announced.
    await app.clickText(PARKED);
    await app.shot(`task-${theme}`);

    // Answering, which is the one picture no still of a resting state can contain — and the reason
    // this rig drives the app rather than only launching it. Last, and once: an answer advances the
    // run, so every picture of the question has to already be taken. The parked shots above are in
    // both themes; this one is in whichever theme goes last. Taken here, while the task is still the
    // open one, rather than after Settings has replaced the board it was reached from.
    if (last) {
      await app.clickText("request_changes");
      await app.until(`!${says("Awaiting you")}`, "the gate to close");
      await app.shot(`answered-${theme}`);
    }

    // Tall enough to paint a settings pane whole — one of them is taller than the window, and its own
    // scroll container means `captureBeyondViewport` has nothing to capture below the fold. Done
    // BEFORE the section mounts: resizing with Monaco already live sets off a ResizeObserver storm
    // that the app reports as an uncaught error.
    await app.resize(1280, 1500);
    await app.clickText("Settings");
    await app.shot(`settings-${theme}`);

    /**
     * Appearance, and File types framed on its own.
     *
     * Two pictures rather than one, because they are two subjects at two widths: the section above
     * is a column of labels and controls capped at 560, and File types is a tree beside a stage
     * beside a live preview that takes the room. Framed with a selector rather than shot whole for
     * the same reason — a full-window picture of a settings screen is mostly the window.
     *
     * The preview inside it is a REAL editor drawing a real sample, so it is the one scene here that
     * has to be waited for: Monaco and the grammar arrive after the click, and a picture taken in
     * between is of an empty box.
     */
    await app.clickText("Appearance");
    await app.until(says("what opens a file"), "the File types section to draw");
    // Text the CSS does not transform: `innerText` reflects `text-transform`, so a label styled
    // uppercase is matched by its uppercase form and a wait written against the DOM text silently
    // never fires. This one sits in a plain button.
    await app.until(says("the read-only view"), "the renderer menu to draw");
    await app.until(
      `(() => {
        const at = document.querySelector(".ft-preview-body .monaco-editor .view-lines");
        if (at === null) return false;
        return [...at.querySelectorAll("span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)");
      })()`,
      "the preview's editor to colour itself",
    );
    await app.shot(`appearance-${theme}`, ".cfg-pane.ap");
    await app.shot(`file-types-${theme}`, ".ft");
    await app.resize(1280, 860);

    // What the next launch opens in. Left on `light` by the last pass, so a run leaves the world the
    // way it found it.
    await app.preferTheme(theme === "light" ? "dark" : "light");
    return app.complaints;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  console.log("building the world");
  const world = buildWorld(WORLD);

  // Distinct ports: an endpoint from the pass before can still be closing, and a second attach to a
  // dying one hangs rather than failing.
  const complaints = [...(await pass(world, 9229, true, false)), ...(await pass(world, 9230, false, true))];

  if (complaints.length > 0) {
    console.log(`\n${complaints.length} thing(s) spoke up during the run:`);
    for (const complaint of complaints.slice(0, 10)) console.log(`  ${complaint}`);
    process.exitCode = 1;
  }
  console.log(`\nwrote ${OUT}`);
}

await main();
