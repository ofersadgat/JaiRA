/**
 * The settings' six layers' files (decision 0023, amended 2026-11-18), in the real window, with a real
 * paired machine: another base root on this computer running `jaira serve` (the npm CLI), published on
 * loopback (`JAIRA_REACH=loopback`) in place of a tailnet, and paired the way a person pairs them.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx packages/app/shots/settings-layers.mts
 *
 * The world keeps a permission set in each of the four newer layers (Just you, this machine, the project
 * on this machine, you in the project) and automations in Shared, this machine and Just you — this
 * machine's following the project's, Just you's following the project on this machine's, which has none.
 * Then:
 *
 *   1-tools-project          Settings › project → Tools: the project's permission sets
 *   2-tools-just-you         Settings › Just you → Tools
 *   3-tools-you-in-project   Settings › project › Just you → Tools: every layer's sets
 *   4-automations-just-you   … › Just you → Automations: its own line, then this machine's, then Shared's
 *   5-automations-machine    Settings › desk (this machine) → Automations
 *   6-tools-paired-machine   Settings › mac-mini → Tools: its events status and its automations, read there
 *   7-about-paired-machine   Settings › mac-mini → About
 *   8-files                  the Files view: every layer a root of its own — the project, it on this machine, you
 *                            in it, Just you, this machine — and the project's `feature/review` shadowed by Just you's
 *   8b-editor-copy-menu      a shipped state open in the editor: its top bar's `Elsewhere…`, the four newer layers
 *   8c-tree-menu             that row's own menu in the tree: `Edit a copy elsewhere…` after the two overrides
 *   8d-tree-copy-menu        the menu it opens in its place: the same four, under `Edit a copy`
 *   9-new-task-menu          + New task's workflow menu: `feature/review` as Just you's copy names it, and
 *                            `Hello from Just you`, a workflow SCRIPT kept in Just you
 *   10-new-task              …chosen: the inputs Just you's copy declares
 *   11-script-ran            the script task, started from here, completed
 *
 * Fails on any check. Pictures land in `shots/out/settings-layers/`.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRepositoryIdentity } from "@jaira/persistence";
import { automationStateOf, projectSettingsKey, type MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { pairWithServer, serverOnTailnet } from "./pairLoopback.mjs";
import { clickFirst, clickTitled, drawn, settle } from "./parityWorld.mjs";
import { buildWorld, type World } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "settings-layers");
const WORLD = join(import.meta.dirname, ".world-settings-layers");
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "cli.mjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed += 1;
};

function write(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

const line = (name: string, event: string, branch?: string): Record<string, unknown> => ({
  name,
  when: branch !== undefined ? `on_event('${event}', { branch: '${branch}' })` : `on_event('${event}')`,
  to: name,
  inputs: { event: ".event" },
});

/** A layer's copy of the events workflow above Shared: its lines, then the layer under it's. */
function copyOf(under: string, lines: Array<Record<string, unknown>>): Record<string, unknown> {
  const events = `${under}/workflows/system/events`;
  return {
    $ref: events,
    transitions: [...lines, { $ref: `...${events}.transitions` }],
    children: { $ref: `${events}.children`, ...Object.fromEntries(lines.map((l) => [l["name"] as string, { async: true }])) },
  };
}

/** A small prompt state: its label, and the one input it declares. */
const review = (label: string, input: string): Record<string, unknown> => ({
  label,
  inputs: { [input]: { schema: { type: "string" }, description: `What to ${input === "focus" ? "focus on" : "review"}` } },
  outputs: { text: { schema: { type: "string" }, binding: ".operation.output.text" } },
  operation: { kind: "prompt", prompt: "Review it.", model: "anthropic/claude-sonnet-5", output: { text: { schema: { type: "string" } } } },
});

/** The layer files the pictures are about — each of the six holding something. */
function seedLayers(world: World): void {
  const home = world.home;
  const jaira = join(world.project, ".jaira");
  const key = projectSettingsKey(readRepositoryIdentity(world.project), world.project);
  // Permission sets in the four newer layers.
  write(join(home, "personal", "permission-sets", "my-everyday.json"), { description: "What I let through anywhere", "git status": "allow", "git log": "allow" });
  write(join(home, "machine", "permission-sets", "build-box.json"), { description: "This machine builds", "npm run build": "allow" });
  write(join(jaira, "local", "permission-sets", "checkout-local.json"), { description: "This checkout on this machine", "make check": "allow" });
  write(join(home, "projects", key, "permission-sets", "mine-in-project.json"), { description: "Mine, in this project", "npm test": "allow" });
  // Automations: Shared's whole copy; this machine's and Just you's splicing what is under them.
  write(join(home, "workflows", "system", "events.json"), { $ref: "$SYSTEM/workflows/system/events", transitions: [line("push_main", "git.pushed", "main")], children: { push_main: { async: true } } });
  write(join(home, "workflows", "system", "events", "push_main.json"), automationStateOf("push_main", [{ kind: "notify", text: "main moved" }]));
  write(join(home, "machine", "workflows", "system", "events.json"), copyOf("$JAIRA", [line("nightly_build", "git.pushed", "release/*")]));
  write(join(home, "machine", "workflows", "system", "events", "nightly_build.json"), automationStateOf("nightly_build", [{ kind: "notify", text: "a release branch moved" }]));
  write(join(home, "personal", "workflows", "system", "events.json"), copyOf("$PROJECTMACHINE", [line("tell_me", "merge_request.opened")]));
  write(join(home, "personal", "workflows", "system", "events", "tell_me.json"), automationStateOf("tell_me", [{ kind: "notify", text: "a merge request opened" }]));
  // An ordinary workflow, in the project and in Just you: Just you's is the one read.
  write(join(jaira, "workflows", "feature", "review.json"), review("Review — this project's", "issue"));
  write(join(home, "personal", "workflows", "feature", "review.json"), review("Review — just mine", "focus"));
  // A workflow SCRIPT, in Just you only: compiled as a project's is.
  mkdirSync(join(home, "personal", "workflows"), { recursive: true });
  writeFileSync(
    join(home, "personal", "workflows", "hello.ts"),
    `export const meta = { name: "Hello from Just you", description: "Say hello." };

export default async function hello(who: string) {
  const line = await llm("Say hello to " + who);
  return { line };
}
`,
    "utf8",
  );
}

/** Click the menu item whose text begins with `label`. */
async function pick(app: App, label: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]')].find((e) => (e.textContent ?? '').trim().startsWith(${JSON.stringify(label)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!hit) throw new Error(`no menu item reading ${label}`);
  await settle(700);
}

/** Settings' path from Shared: each part chosen from its `+` menu, in turn. */
async function pathTo(app: App, parts: readonly string[]): Promise<void> {
  await clickTitled(app, ["Shared: every project, every machine, everyone"]).catch(() => undefined);
  for (const part of parts) {
    await clickTitled(app, ["Narrow these settings"]);
    await pick(app, part);
  }
  await settle(1200);
}

/** A Settings page, from the sidebar's sections. */
async function page(app: App, label: string): Promise<void> {
  await clickFirst(app, label);
  await app.until(`[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(label)} && e.getBoundingClientRect().left > 250)`, `the ${label} page`);
  await settle(1500);
}

/** Scroll the page so a section's heading is at the top. */
async function scrollTo(app: App, heading: string): Promise<void> {
  // The heading, not a row of the same word (a tool group named `Events` in a set's editor, in its own
  // scrolling box): of the matches, the one set largest — the first of those.
  const find = `[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(heading)} && e.getBoundingClientRect().left > 330 && e.getBoundingClientRect().left < innerWidth && e.checkVisibility({ opacityProperty: true, visibilityProperty: true })).sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0]`;
  await app.until(`${find} !== undefined`, `the ${heading} heading`);
  // Again until it stays: a section above that finishes reading moves it.
  for (let i = 0; i < 4; i += 1) {
    const top = await app.evaluate<number>(`(() => {
      const el = ${find};
      let box = el.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (box) box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
      else el.scrollIntoView({ block: "start" });
      return Math.round(el.getBoundingClientRect().top);
    })()`);
    await settle(900);
    const now = await app.evaluate<number>(`Math.round(${find}.getBoundingClientRect().top)`);
    if (Math.abs(now - top) < 2 && now < 200) return;
  }
  console.log(`  the ${heading} heading did not come to the top`);
}

/**
 * Whether `words` is IN THE WINDOW, where a picture shows it — not merely on the page: a leaf whose text
 * is `words` (or, with `part`, holds it), or an input holding it, wholly inside the window right of
 * `left` (the settings' column, unless a menu over the tree is asked about), visible, what the window
 * draws at its middle, and — with `whole` — not cut off with an ellipsis.
 */
async function shown(app: App, words: string, { part = false, left = 330, whole = false }: { part?: boolean; left?: number; whole?: boolean } = {}): Promise<boolean> {
  return app.evaluate<boolean>(`[...document.querySelectorAll("*")].some((e) => {
    const said = e.tagName === "INPUT" || e.tagName === "TEXTAREA" ? e.value : e.children.length === 0 ? e.textContent : null;
    if (said === null || !(${String(part)} ? said.includes(${JSON.stringify(words)}) : said === ${JSON.stringify(words)})) return false;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.top < 0 || r.bottom > innerHeight || r.left < ${String(left)} || r.right > innerWidth) return false;
    // Against its drawn width, not clientWidth: an inline run reports 0 for both of those.
    if (${String(whole)} && e.scrollWidth > Math.ceil(r.width) + 1) return false;
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return hit !== null && (hit === e || e.contains(hit) || hit.contains(e));
  })`);
}

/** What the page says — as written, not as drawn: a heading set in capitals is matched as written. */
const text = (app: App): Promise<string> =>
  app.evaluate<string>("(document.body.textContent ?? '') + ' ' + [...document.querySelectorAll('input, textarea')].map((e) => e.value).join(' ')");
const holds = (words: string): string => `(document.body.textContent ?? "").includes(${JSON.stringify(words)})`;

/** Click the `nth` element whose own text is exactly `words` (a tree row: its name). */
async function clickNth(app: App, words: string, nth: number): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(words)})[${nth}];
    if (!el) return false;
    (el.closest("button, a, [role=button], [role=treeitem], li") ?? el).click();
    return true;
  })()`);
  if (!hit) throw new Error(`no ${nth + 1}th ${words}`);
  await settle(500);
}

async function main(): Promise<void> {
  process.env["JAIRA_REACH"] = "loopback";
  const world = buildWorld(WORLD);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: world.project, stdio: "ignore" });
  seedLayers(world);
  const other = join(WORLD, "other-home");
  rmSync(other, { recursive: true, force: true });
  mkdirSync(other, { recursive: true });
  // The other machine's shared root is a repository with a remote, so its events status says something
  // this machine's (none) does not; and it keeps an automation in its own layer — this machine's there,
  // which stays on it (Shared's would follow the person here, and the newer copy win on both).
  execFileSync("git", ["init", "-q"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:example/mini-root.git"], { cwd: other, stdio: "ignore" });
  write(join(other, "machine", "workflows", "system", "events.json"), copyOf("$JAIRA", [line("mini_push", "git.pushed", "main")]));
  write(join(other, "machine", "workflows", "system", "events", "mini_push.json"), automationStateOf("mini_push", [{ kind: "notify", text: "the mini moved" }]));
  const jaira = (...args: string[]): string => execFileSync(process.execPath, [CLI, "--home", other, ...args], { encoding: "utf8", env: process.env });
  const server = spawn(process.execPath, [CLI, "--home", other, "serve"], { env: process.env, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        if (JSON.parse(jaira("server", "status")).running === true) break;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    jaira("machine", "rename", "mac-mini");
    serverOnTailnet(jaira);

    const app = await App.launch(world, { out: OUT, port: 9293 });
    try {
      await app.until(drawn, "the window to draw");
      await app.resize(1400, 1000);
      await app.ipc("machines:rename", { label: "desk" });
      await pairWithServer(app, jaira);
      let online = false;
      for (let i = 0; i < 80 && !online; i += 1) {
        const view = await app.ipc<MachinesView>("machines:view", undefined);
        online = view.machines.some((m) => m.label === "mac-mini" && m.state === "online");
        if (!online) await sleep(250);
      }
      check(online, "mac-mini is paired and online");

      await app.clickText("Settings");
      await settle(800);
      await page(app, "Tools");

      await pathTo(app, ["project"]);
      await scrollTo(app, "Permission sets");
      await app.shot("1-tools-project");
      let said = await text(app);
      check(!["my-everyday", "build-box", "checkout-local", "mine-in-project"].some((name) => said.includes(name)), "the project's page lists only the project's, Shared's and the built-in sets — none of the layers over it");

      await pathTo(app, ["Just you"]);
      await scrollTo(app, "Permission sets");
      await app.shot("2-tools-just-you");
      said = await text(app);
      check(said.includes("my-everyday") && !said.includes("checkout-local") && !said.includes("mine-in-project"), "Just you's page lists Just you's set, and none of a project's layers");

      await pathTo(app, ["project", "Just you"]);
      await scrollTo(app, "Permission sets");
      await app.shot("3-tools-you-in-project");
      said = await text(app);
      check(["my-everyday", "build-box", "checkout-local", "mine-in-project"].every((name) => said.includes(name)), "you in the project sees every layer's set");

      // A personal view opens on what you changed: the sections a layer keeps files in are drawn there.
      check(said.includes("What you changed") && !said.includes("Nothing is set just for you"), "you in the project's What you changed draws the sets it keeps");
      await pathTo(app, ["Just you"]);
      // A page is read again for a new path: until it is, it shows the last path's lines.
      const lines = (want: string[], not: string[] = []): string =>
        `(() => { const v = [...document.querySelectorAll("input")].map((e) => e.value); return ${JSON.stringify(want)}.every((w) => v.includes(w)) && !${JSON.stringify(not)}.some((w) => v.includes(w)); })()`;
      await app.until(lines(["tell_me", "nightly_build", "push_main"]), "Just you's automations to be read", 160).catch(() => undefined);
      await scrollTo(app, "Automations");
      // The window as drawn: a capture beyond it lays the page out again and scrolls it back to the top.
      await app.shot("4-automations-just-you", undefined, false);
      said = await text(app);
      check(said.includes("tell_me") && said.includes("nightly_build") && said.includes("push_main") && said.includes("From This machine") && said.includes("From Shared"), "Just you's automations: its own line, then this machine's, then Shared's");

      await pathTo(app, ["desk"]);
      await app.until(lines(["nightly_build", "push_main"], ["tell_me"]), "this machine's automations to be read", 160).catch(() => undefined);
      await scrollTo(app, "Automations");
      // The window as drawn: a capture beyond it lays the page out again and scrolls it back to the top.
      await app.shot("5-automations-machine", undefined, false);
      said = await text(app);
      check((await shown(app, "nightly_build")) && said.includes("push_main") && !said.includes("tell_me"), "this machine's automations: its own line, then Shared's — not Just you's — in the picture");

      await pathTo(app, ["mac-mini"]);
      await scrollTo(app, "Events");
      await settle(2500);
      // The window as drawn, not the page grown to its whole length: a capture beyond the window lays the
      // page out again at that height, and the settings' scroll goes back to the top.
      await app.shot("6-tools-paired-machine", undefined, false);
      check((await shown(app, "Events")) && (await shown(app, "origin", { part: true })), "the paired machine's events status: its root's remote, read there — in the picture");
      // Read on the other machine, layer by layer: waited for, then scrolled to.
      // A sync arriving there re-reads the section (its watcher sees the layer folder appear), so this
      // is waited for again after the scroll, and the scroll made again if the page was drawn anew.
      const miniPush = `[...document.querySelectorAll("input")].some((e) => e.value === "mini_push")`;
      for (let tries = 0; tries < 3; tries += 1) {
        await app.until(miniPush, "the paired machine's automations to be read", 160);
        await scrollTo(app, "Automations");
        await settle(1500);
        if (await shown(app, "mini_push")) break;
        console.log("  the paired machine's automations were read again — scrolling to them again");
      }
      await app.shot("6b-automations-paired-machine", undefined, false);
      check((await shown(app, "Automations")) && (await shown(app, "mini_push")), "the paired machine's automations, read there — in the picture");

      await page(app, "About");
      await settle(2000);
      await app.shot("7-about-paired-machine");

      // The Files view, standing on the project.
      await clickTitled(app, ["Shared: every project, every machine, everyone"]).catch(() => undefined);
      await app.clickText("project");
      await settle(800);
      await app.clickText("Files");
      await app.until(holds("Just you"), "the Just you root in the Files view", 60);
      // The project's `.jaira/workflows/feature/`, and Just you's `workflows/feature/`; the project on
      // this machine's permission sets.
      await clickNth(app, ".jaira", 0);
      await clickNth(app, "workflows", 0);
      await clickNth(app, "feature", 0);
      // Every layer's permission sets but what ships.
      const sets = await app.evaluate<number>(`[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "permission-sets").length`);
      for (let i = 0; i < sets - 1; i += 1) await clickNth(app, "permission-sets", i);
      // Just you's root: its `workflows/` is the next unopened one.
      const youWorkflows = await app.evaluate<number>(`(() => {
        const all = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "workflows");
        const you = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent ?? "").toUpperCase() === "JUST YOU");
        return all.findIndex((e) => you !== undefined && (you.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      })()`);
      if (youWorkflows >= 0) {
        await clickNth(app, "workflows", youWorkflows);
        await clickNth(app, "feature", 1);
      }
      await settle(1000);
      await app.shot("8-files");
      said = await text(app);
      check(said.includes("Just you") && said.includes("This machine") && said.includes("You in project") && said.includes("project on this machine"), "the Files view draws every layer as a root of its own");
      check(said.includes("checkout-local.json"), "the Files view reaches the project on this machine's set");
      check(said.includes("shadowed · just you"), "the project's copy of feature/review is shadowed, by Just you's");

      // A shipped state open in the editor: its top bar offers the tree's six — two links, then the four
      // newer layers behind `Elsewhere…`.
      const shippedWorkflows = (await app.evaluate<number>(`[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "workflows").length`)) - 1;
      await clickNth(app, "workflows", shippedWorkflows);
      const chats = (await app.evaluate<number>(`[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "chat").length`)) - 1;
      await clickNth(app, "chat", chats);
      await clickNth(app, "session.json", 0);
      await app.until(holds("Elsewhere…"), "the editor's top bar on a shipped state", 60);
      await settle(1200);
      // The bar's links before the menu opens: while it is up, its layer lies over the rest of the window.
      const cut: string[] = [];
      for (const label of ["Edit a copy in Shared", "Override here", "Elsewhere…"]) if (!(await shown(app, label, { whole: true }))) cut.push(label);
      await clickFirst(app, "Elsewhere…");
      await settle(600);
      await app.shot("8b-editor-copy-menu", undefined, false);
      const elsewhere = ["for you in this project", "for just you", "in this project on this machine", "on this machine"];
      for (const label of elsewhere) if (!(await shown(app, label, { whole: true }))) cut.push(label);
      if (cut.length > 0) console.log(`  not in the window whole: ${cut.join(", ")}`);
      check(cut.length === 0, "the editor's top bar offers every layer the tree's menus do, each read whole");
      await app.press("Escape", 27);
      await settle(400);

      // The tree's own menu on that shipped row — a right-click — and the second menu its `Edit a copy
      // elsewhere…` opens in its place: the same four, under `Edit a copy`, each read whole.
      const rightClicked = await app.evaluate<boolean>(`(() => {
        const el = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "session.json")[0];
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + r.height / 2, button: 2 }));
        return true;
      })()`);
      await settle(600);
      await app.shot("8c-tree-menu", undefined, false);
      const firstMenu = rightClicked && (await shown(app, "Edit a copy elsewhere…", { left: 0, whole: true })) && (await shown(app, "Override here", { left: 0, whole: true }));
      await clickFirst(app, "Edit a copy elsewhere…");
      await settle(600);
      await app.shot("8d-tree-copy-menu", undefined, false);
      let treeWhole = firstMenu && (await shown(app, "Edit a copy", { left: 0 }));
      for (const label of elsewhere) treeWhole = treeWhole && (await shown(app, label, { left: 0, whole: true }));
      check(treeWhole, "the tree's menu offers the same four behind `Edit a copy elsewhere…`, each read whole");
      await app.press("Escape", 27);
      await settle(400);

      // + New task: the workflow menu lists `feature/review` by Just you's copy's label, and its inputs are Just you's.
      await clickFirst(app, "Tasks").catch(() => undefined);
      await settle(800);
      await app.until(holds("New task"), "the New task button");
      await clickFirst(app, "+ New task");
      await app.until(holds("Its inputs appear here."), "the New-task form");
      await settle(800);
      await app.clickText("choose a workflow…");
      await settle(800);
      await app.shot("9-new-task-menu", undefined, false);
      said = await text(app);
      check(said.includes("Review — just mine") && !said.includes("Review — this project's"), "the workflow menu names feature/review by Just you's copy");
      check(said.includes("Hello from Just you"), "the workflow menu lists the script kept in Just you");
      await pick(app, "Review — just mine");
      await settle(1500);
      await app.shot("10-new-task");
      said = await text(app);
      check(said.includes("focus") && !said.includes("What to review"), "the form asks for the inputs Just you's copy declares");

      // The script in Just you, started as a task in this project: it compiles and runs.
      const here = (await app.ipc<Array<{ project: string; kind: string; label: string }>>("project:list", {})).find((p) => p.kind === "user" && p.label === "project")!;
      const made = await app.ipc<{ taskId: string }>("task:create", { title: "say hello", workflow: "hello", inputs: { who: "ada" }, project: here.project });
      await app.ipc("task:start", { taskId: made.taskId, project: here.project, fake: [{ promptIncludes: "ada", output: "hello, ada" }] });
      let status = "";
      for (let i = 0; i < 80 && status !== "completed" && status !== "failed"; i += 1) {
        status = (await app.ipc<Array<{ taskId: string; status: string }>>("task:list", { project: here.project })).find((t) => t.taskId === made.taskId)?.status ?? "";
        if (status !== "completed" && status !== "failed") await sleep(250);
      }
      check(status === "completed", `the script kept in Just you ran to the end (${status})`);
      await settle(1000);
      await app.shot("11-script-ran");
      if (app.complaints.length > 0) {
        console.log(`the window complained:\n${app.complaints.join("\n")}`);
      }
    } catch (e) {
      await app.shot("failed").catch(() => undefined);
      throw e;
    } finally {
      await app.close();
    }
  } finally {
    try {
      jaira("server", "stop");
    } catch {
      server.kill();
    }
  }
  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("passed");
}

await main();
