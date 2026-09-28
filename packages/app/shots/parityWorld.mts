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

/** `port` is the seeding launch's CDP port: studios seeding side by side each need their own. */
export async function seed(world: World, out: string, port = 9239): Promise<void> {
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
  ...(["Board", "Conversation", "Text"] as const).map(
    (heading): Scene => ({
      name: `settings-appearance-${heading.toLowerCase()}`,
      reach: async (app) => {
        await app.clickText("Settings");
        await clickFirst(app, "Appearance");
        await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === "Appearance" && e.getBoundingClientRect().left > 250)`, "the Appearance page");
        const find = `[...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(heading)} && e.getBoundingClientRect().left > 250)`;
        await app.until(`${find} !== undefined`, `the ${heading} heading`);
        // To a device pixel, measured the same way on both pages: `scrollIntoView` lands a fraction apart.
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
    // has it too; the same conversation is opened on both pages after that.
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
    },
  },
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

/** The conversation the `conversation` scene opens. */
export const CONVERSATION = "explain the sync lint";

/**
 * The conversation, made once in the world's project: a chat task (`chat/session`, as the Chat view
 * starts one) whose first message is its run, answered by a fake model. A no-op once it exists.
 */
async function conversation(app: App): Promise<void> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  if (project === undefined) throw new Error("the world has no project to talk in");
  const tasks = await app.ipc<Array<{ title: string }>>("task:list", { project });
  if (tasks.some((t) => t.title === CONVERSATION)) return;
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title: CONVERSATION,
    workflow: "chat/session",
    inputs: { message: "What does the sync lint check?" },
    project,
  });
  await app.ipc("task:start", {
    taskId: made.taskId,
    project,
    fake: [{ output: "It checks that **every state** a workflow names exists:\n\n- the `sequence` entries\n- each transition's `to`\n\nRun it with `jaira lint`." }],
  });
  await settle(1500);
}

/**
 * Click the FIRST element in the page whose own text is exactly `text` (`clickText` takes the last that
 * contains it) — the sidebar's row, not a page's sentence that mentions the same word.
 */
async function clickFirst(app: App, text: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(text)});
    if (!el) return false;
    (el.closest("button, a, [role=button], li") ?? el).click();
    return true;
  })()`);
  if (!hit) throw new Error(`nothing to click reading "${text}"`);
  await settle(250);
}

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
  // Patient: the dev server is shared between studios, and one rebuilding for another copier's edit
  // holds every page for several seconds.
  await app.until(drawn, `${url} to draw`, 240);
  await app.hover(2, 2);
  step("scene");
  if (to.scene !== undefined) await to.scene.reach(app);
  step("reached");
  await settle();
}
