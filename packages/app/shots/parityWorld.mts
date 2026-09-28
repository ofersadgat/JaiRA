/**
 * The world every fidelity gate of decision 0015 photographs, and how each scene is reached: seeded once
 * (a finished task, a failed one, one parked at its gate, one archived), then launched once per look.
 * `parity.mts` runs the gates; `studio.mts` keeps one launched for iterating on a copy.
 */
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, type World } from "./world.mjs";

export const PARKED = "tighten the changeset lint";
export const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
export const settle = (ms = 1200): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The page has drawn: `#root` has children (the `/rn` page keeps a `#root` for this). */
export const drawn = "window.jaira && document.getElementById('root') && document.getElementById('root').children.length > 0";

export async function launch(world: World, port: number, out: string): Promise<App> {
  // The One client is the window's default renderer; the other pages are reached by navigation.
  process.env.JAIRA_RENDERER = "one";
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

export async function seed(world: World, out: string): Promise<void> {
  const app = await launch(world, 9239, out);
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
 * The scenes. Each is reached from a freshly loaded page, and each is photographed on BOTH pages before
 * the next begins: reaching a scene can change what the next one shows (opening a task marks its
 * unseen counts seen), so the two pictures of a pair must be taken from the same state, back to back.
 */
export interface Scene {
  readonly name: string;
  /** Photographed in every look, not only the two base ones. */
  readonly everyLook?: boolean;
  /** Selector to frame, or the whole window. */
  readonly of?: string;
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
      // By its words, not its class: the `/rn` page draws the same foot with no classes at all.
      await app.clickText("1 archived");
      await app.until(says("retire the old lint"), "the archived card to show");
    },
  },
  { name: "settings", reach: (app) => app.clickText("Settings") },
  {
    // A real Monaco drawing a real sample through the TextMate grammars (WASM): the part of the
    // renderer most likely to break under a new origin and a new content policy.
    name: "file-types",
    of: ".ft",
    reach: async (app) => {
      await app.clickText("Settings");
      await app.clickText("Appearance");
      // Scrolled into view, and again on every try, for the picture rather than for Monaco: `.ft` sits
      // in the settings pane's own scroll container, which a capture paints only where it is scrolled
      // to, and the page lays out after the preview mounts, undoing a scroll made before that. Monaco
      // draws an editor below the fold perfectly well; what it cannot draw in is a hidden window,
      // which is what used to leave this editor empty (see `launch` in the driver).
      await app.until(`document.querySelector(".ft-preview-body") !== null`, "the preview to mount");
      await app.until(
        `(document.querySelector(".ft-preview-body").scrollIntoView({ block: "center" }),
          [...document.querySelectorAll(".ft-preview-body .view-lines span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)"))`,
        "the preview's editor to colour itself",
      );
      // Then the section's top, which is what the picture frames: centred on the preview, `.ft` is
      // about as tall as the window and its upper half lay above the fold, unpainted on both pages.
      await app.evaluate(`document.querySelector(".ft").scrollIntoView({ block: "start" })`);
      await app.until(
        `(() => { const top = document.querySelector(".ft").getBoundingClientRect().top; return top >= 0 && top < innerHeight / 2; })()`,
        "File types to scroll into view",
      );
    },
  },
];

/**
 * The looks each gate runs in. The first two (the default palette, both modes) take every scene; the
 * rest take the scenes that draw the components copied so far, in the palettes whose rules those
 * components carry by hand (`--quick` skips them).
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
 * Load `path` (`/`, `/rn`) in a look and reach a scene there. The look is written first and read by the load (a page
 * reads its configuration once), and the pointer is parked in the corner so no hover is carried over.
 */
export async function goTo(app: App, path: string, to: { look?: Look; scene?: Scene } = {}): Promise<void> {
  const step = (what: string): void => {
    if (process.env["JAIRA_SHOTS_TRACE"] !== undefined) console.log(`    [${path}] ${what}`);
  };
  step("look");
  if (to.look !== undefined) await app.preferLook(to.look);
  // Against wherever the window is: `app://jaira` as shipped, the dev server under `studio.mts`.
  const url = (await app.evaluate<string>("location.protocol + '//' + location.host")) + path;
  step("navigate");
  await app.navigate(url);
  step("draw");
  await app.until(drawn, `${url} to draw`);
  await app.hover(2, 2);
  step("scene");
  if (to.scene !== undefined) await to.scene.reach(app);
  step("reached");
  await settle();
}
