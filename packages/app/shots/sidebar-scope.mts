/**
 * The project panel's title as a breadcrumb that narrows the panel (the sidebar mockups, boards 49–50),
 * the chat list's column head (board 24), and rows that no longer name their project. A project of two
 * workspaces — two clones of one repository on this machine — with a conversation in each.
 *
 * Passes when: the title offers a machine and a workspace; the rows say nothing of the project and
 * name the second workspace; choosing that workspace leaves its conversation alone and the title says
 * so; letting it go brings both back; the column head sorts by name and groups by workspace; When says
 * each conversation's last message (newest first), a press and hold on it (or a right-click) offers
 * Created instead, and a message sent moves its conversation to the top; the title's machine and
 * workspace marks are line icons centred on the row.
 *
 * Scripted answers (`fake`), so nothing is spent.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/sidebar-scope.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string) => { prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void };
const OUT = join(import.meta.dirname, "out", "sidebar-scope");
const MIN = 60_000;
const WORLD = join(import.meta.dirname, ".world-sidebar-scope");
const ORIGIN = "https://github.com/example/lighthouse.git";

/** The centre of the visible element labelled `label`, whose own text is `text`, or a menu item reading `text`. */
const centreOf = (how: "text" | "label" | "item", text: string): string => `(() => {
  const want = ${JSON.stringify(text)};
  const all = ${
    how === "label"
      ? `[...document.querySelectorAll('[aria-label]')].filter((e) => e.getAttribute('aria-label') === want)`
      : how === "item"
        ? `[...document.querySelectorAll('[role="menuitem"]')].filter((e) => e.innerText.split('\\n')[0].trim() === want)`
        : `[...document.querySelectorAll('div, span')].filter((e) => e.innerText !== undefined && e.innerText.trim() === want && ![...e.children].some((c) => c.innerText && c.innerText.trim() === want))`
  };
  const e = all.find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`;

/** Whether a visible element carries this accessible name. */
const labelled = (label: string): string => `${centreOf("label", label)} !== null`;

const git = (dir: string, ...args: string[]): void => void execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", windowsHide: true });

/** The column head's sorts, measured: each one's words, and whether the head holds them all on its one line. */
const headFits = `(() => {
  const heads = [...document.querySelectorAll('[aria-label^="Sort by"]')].filter((e) => e.getBoundingClientRect().width > 0);
  const row = heads[0]?.parentElement;
  if (!row) return { fits: false, words: [] };
  const r = row.getBoundingClientRect();
  const words = heads.map((e) => { const b = e.getBoundingClientRect(); return { text: e.innerText.replace(/\\s+/g, ' '), left: Math.round(b.left), right: Math.round(b.right), clipped: e.scrollWidth > e.clientWidth + 1 }; });
  const group = row.firstElementChild?.getBoundingClientRect();
  return { fits: row.scrollWidth <= row.clientWidth + 1 && words.every((w) => !w.clipped && w.right <= r.right + 1) && (group === undefined || group.right <= words[0].left), width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), scroll: row.scrollWidth, client: row.clientWidth, group: group && [Math.round(group.left), Math.round(group.right)], words };
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  // The second clone: its own JaiRA project, the same repository.
  const second = join(WORLD, "lighthouse-2");
  initProject(second, world.home);
  for (const dir of [world.project, second]) {
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", ORIGIN);
  }
  const app = await App.launch(world, { out: OUT, port: 9274 });
  const press = async (how: "text" | "label" | "item", what: string): Promise<void> => {
    const at = await app.evaluate<{ x: number; y: number } | null>(centreOf(how, what));
    if (at === null) throw new Error(`nothing ${how === "label" ? "labelled" : how === "item" ? "in the menu reading" : "reading"} "${what}" on the page`);
    await app.clickAt(at.x, at.y);
    await settle(500);
  };
  const expectLabel = async (label: string, present = true): Promise<void> => {
    if ((await app.evaluate<boolean>(labelled(label))) !== present) throw new Error(`${present ? "no" : "still a"} "${label}" on the page`);
  };
  const expectText = async (text: string, present = true): Promise<void> => {
    if ((await app.evaluate<boolean>(says(text))) !== present) throw new Error(`the page ${present ? "does not say" : "still says"} "${text}"`);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 800);
    await app.ipc("project:open", { dir: second });
    const ids: Record<string, string> = {};
    for (const [project, title, answer] of [
      [world.project, "Plan the lighthouse rota", "Here is a rota."],
      [second, "Check the tide tables", "The tables are current."],
    ] as const) {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", conversation: true, inputs: { message: title }, project });
      // Placed where it was made: a project of several workspaces otherwise puts it wherever there is room.
      await app.ipc("task:start", { taskId: made.taskId, project, runOn: { project }, fake: [{ output: answer }] });
      ids[title] = made.taskId;
    }
    await settle(1500);
    // Backdated, so the When column has something to tell apart: the rota made two days ago and last
    // spoken three hours ago, the tide tables made one day ago and spoken five minutes ago. Made first,
    // spoken last: by its making the rota is the newer of the two only turned round.
    const now = Date.now();
    const db = new Database(join(world.home, "system", "jaira.db"));
    for (const [title, dir, madeAgo, spokeAgo] of [
      ["Plan the lighthouse rota", world.project, 2 * 24 * 60 * MIN, 3 * 60 * MIN],
      ["Check the tide tables", second, 24 * 60 * MIN, 5 * MIN],
    ] as const) {
      const file = join(dir, ".jaira", "system", "tasks", `${ids[title]}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), createdAt: new Date(now - madeAgo).toISOString() }, null, 2) + "\n");
      // The records' change is what tells the window to read the task again (the change log's triggers).
      db.prepare(`UPDATE operation_records SET started_at = ?, ended_at = ? WHERE task_id = ?`).run(now - spokeAgo - 4000, now - spokeAgo, ids[title]);
    }
    db.close();
    // A task that is not a conversation, made and not started: the Tasks tab's, never the Chat tab's.
    await app.ipc("task:create", { title: "Draft the release notes", workflow: "feature/plan", inputs: { issue: "# Draft the release notes" }, project: world.project });
    await settle(800);
    await press("label", "lighthouse");
    await press("text", "Chat");
    await app.until(says("Check the tide tables"), "both workspaces' conversations in the Chat tab", 200);
    await expectText("Plan the lighthouse rota");
    // The title: the project, then a machine half and a workspace half, neither chosen.
    await expectLabel("Machine: all");
    await expectLabel("Workspace: all");
    // The row from the workspace that is not the project's first says which (the engine lists them in
    // an order of its own); the column head is there.
    const tagged = await app.evaluate<boolean>(`${centreOf("text", "lighthouse-2")} !== null || ${centreOf("text", "project")} !== null`);
    if (!tagged) throw new Error("no row names its workspace");
    await expectLabel("Sort by name");
    // When: the last message, newest first, its time on each row.
    await expectLabel("Sort by last message");
    await app.until(says("5 min"), "the tide tables' last message, five minutes ago", 100);
    await expectText("3 h");
    const order = async (): Promise<string[]> =>
      app.evaluate<string[]>(`(() => { const t = document.querySelector('[role="navigation"]')?.innerText ?? ''; return ['Plan the lighthouse rota', 'Check the tide tables'].map((x) => [x, t.indexOf(x)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]); })()`);
    if ((await order())[0] !== "Check the tide tables") throw new Error(`by last message the tide tables come first; drawn ${JSON.stringify(await order())}`);
    await app.shot("1-both-workspaces");
    const chatHead = await app.evaluate<{ fits: boolean }>(headFits);
    console.log("chat head:", JSON.stringify(chatHead));
    if (!chatHead.fits) throw new Error("the chat list's column head does not fit its line");
    // The title's marks, measured: each icon an svg of one size, centred on its half of the pill.
    const marks = await app.evaluate<Array<{ label: string; icon: number; svg: number; mid: number; half: number }>>(`[...document.querySelectorAll('[aria-label^="Machine:"], [aria-label^="Workspace:"]')].map((half) => {
      const svgs = [...half.querySelectorAll('svg')];
      const h = half.getBoundingClientRect();
      const first = svgs[0]?.getBoundingClientRect();
      return { label: half.getAttribute('aria-label'), icon: first ? Math.round(first.width) : 0, svg: svgs.length, mid: first ? Math.round((first.top + first.height / 2) * 10) / 10 : 0, half: Math.round((h.top + h.height / 2) * 10) / 10 };
    })`);
    console.log("title marks:", JSON.stringify(marks));
    for (const m of marks) {
      if (m.svg < 2 || m.icon !== 14 || Math.abs(m.mid - m.half) > 1) throw new Error(`${m.label}: ${m.svg} icons, ${m.icon} wide, centred at ${m.mid} on a half centred at ${m.half}`);
    }
    await app.shot("1a-title", '[role="navigation"]');

    // A press and hold on When offers what it can say instead; Last message is ticked.
    const head = await app.evaluate<{ x: number; y: number } | null>(centreOf("label", "Sort by last message"));
    if (head === null) throw new Error("no When head");
    await app.mouse("mousePressed", head);
    await settle(900);
    await app.mouse("mouseReleased", head, false);
    await settle(400);
    await app.until(`${centreOf("item", "Created")} !== null`, "the When menu to open on a press and hold", 20);
    await expectLabel("Sort by last message");
    await app.shot("1b-when-menu", undefined, false);
    await press("item", "Created");
    await expectLabel("Sort by created");
    await app.until(says("2 d"), "the rota's making, two days ago", 50);
    await expectText("1 d");
    // Still newest first: by its making the tide tables (a day old) come before the rota (two days).
    if ((await order())[0] !== "Check the tide tables") throw new Error(`by making the tide tables come first; drawn ${JSON.stringify(await order())}`);
    await app.shot("1c-created");
    // A right-click opens the same menu; back to the last message.
    const head2 = await app.evaluate<{ x: number; y: number } | null>(centreOf("label", "Sort by created"));
    if (head2 === null) throw new Error("no When head");
    for (const type of ["mousePressed", "mouseReleased"]) await app.cdp("Input.dispatchMouseEvent", { type, x: head2.x, y: head2.y, button: "right", clickCount: 1, buttons: type === "mousePressed" ? 2 : 0 });
    await settle(400);
    await press("item", "Last message");
    await expectLabel("Sort by last message");
    // A message to the rota: it is the newest said now, and stands first.
    const rotaThread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: ids["Plan the lighthouse rota"], project: world.project });
    await app.ipc("chat:send", { taskId: ids["Plan the lighthouse rota"], instanceId: rotaThread.instanceId, message: "Add Sunday.", project: world.project, fake: [{ output: "Sunday added." }] });
    await app.until(`(${JSON.stringify(["Plan the lighthouse rota", "Check the tide tables"])}).length > 0 && (() => { const t = document.querySelector('[role="navigation"]')?.innerText ?? ''; return t.indexOf('Plan the lighthouse rota') < t.indexOf('Check the tide tables'); })()`, "the rota first once it is spoken to", 100);
    await app.shot("1d-spoken-to");

    await press("label", "Workspace: all");
    await app.shot("2-workspace-menu", undefined, false);
    await press("item", "lighthouse-2");
    await app.until(`!(${says("Plan the lighthouse rota")})`, "the first workspace's conversation to leave the list", 100);
    await expectText("Check the tide tables");
    await expectLabel("Workspace: lighthouse-2");
    await expectLabel("Show every machine again");
    await app.shot("3-narrowed");

    await press("label", "Show every machine again");
    await app.until(says("Plan the lighthouse rota"), "both conversations back", 100);
    await expectLabel("Workspace: all");

    await press("label", "Sort by name");
    await press("label", "Grouped by nothing; change");
    await app.shot("4-group-menu", undefined, false);
    await press("item", "Workspace");
    await expectLabel("Grouped by workspace; change");
    await app.shot("5-grouped-by-workspace");

    // A row's own menu: pin it, and it stands first under Pinned; mark it unread.
    await press("label", "Grouped by workspace; change");
    await press("item", "Nothing");
    const row = await app.evaluate<{ x: number; y: number } | null>(centreOf("text", "Check the tide tables"));
    if (row === null) throw new Error("no row for the tide tables");
    await app.hover(row.x, row.y);
    await settle(300);
    await press("label", "Check the tide tables: more");
    await app.shot("6-row-menu", undefined, false);
    await press("item", "Pin to top");
    await app.until(says("Pinned"), "a Pinned section", 100);
    await app.shot("7-pinned");

    // The Tasks tab: the project's tasks (not its conversations) under its own column head, and + offering workflows.
    await press("text", "Tasks");
    await app.until(says("Draft the release notes"), "the task in the Tasks tab", 200);
    await expectLabel("Sort by state");
    await expectLabel("Sort by updated");
    const taskHead = await app.evaluate<{ fits: boolean }>(headFits);
    console.log("tasks head:", JSON.stringify(taskHead));
    if (!taskHead.fits) throw new Error("the Tasks list's column head does not fit its line");
    // Not the conversations: the sidebar lists none (the board beside it may show them as cards).
    const sidebar = await app.evaluate<string | null>(`document.querySelector('[role="navigation"]')?.innerText ?? null`);
    if (sidebar === null || !sidebar.includes("Draft the release notes")) throw new Error("no sidebar listing the task");
    if (sidebar.includes("Plan the lighthouse rota")) throw new Error("the Tasks tab lists a conversation");
    await press("label", "start a task");
    await app.shot("8-tasks-start-menu", undefined, false);
    if ((await app.evaluate(centreOf("item", "feature/plan"))) === null && (await app.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].length`)) === 0) {
      throw new Error("the + offers no workflows");
    }
    await app.press("Escape", 27);
    await app.shot("9-tasks-tab");
    console.log("passed");
  } catch (error) {
    // What the sidebar drew, and the projects and conversations it drew them from.
    console.error(await app.evaluate<string>(`document.querySelector('[role="navigation"]')?.innerText ?? '(no sidebar)'`));
    console.error(JSON.stringify(await app.ipc("project:list", undefined), null, 1).slice(0, 2500));
    await app.shot("failed", undefined, false);
    throw error;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
