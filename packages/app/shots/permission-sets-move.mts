/**
 * The permission sets left `chat/` (2026-11-05), seen on REAL data: a scratch copy of this machine's
 * database and of a project's `.jaira/`, opened by the built app, which migrates them as it opens.
 *
 * Scratch only — never the live database (`db.backup()` of it into the world's home). Planted beside
 * the copy, in the old layout: a project override `permission-sets/<old>/read-only.json` following what
 * ships, and a standing-layer key for the old bucket. Passes when, after the app opened the copy:
 *  - the override is at the top level, following `$SYSTEM/permission-sets/read-only`;
 *  - the settings key is `""`;
 *  - every conversation's task file names its stack by the new reference — one that had none named
 *    takes the renamed set its pinned snapshot names (`CONVERSATION`, if given);
 *  - no turn request in the copied database names an old reference (migration 32);
 *  - the conversation opened in the window shows its set by the new name in the composer.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/permission-sets-move.mts [projectDir] [conversationWithNoStack]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";

const require = createRequire(import.meta.url);
const Database = require(require.resolve("better-sqlite3", { paths: [join(import.meta.dirname, "..", "..", "persistence")] })) as typeof import("better-sqlite3");

const SOURCE = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "..", ".."));
const NO_STACK = process.argv[3];
const OUT = join(import.meta.dirname, "out", "permission-sets-move");
const WORLD = join(import.meta.dirname, ".world-permission-sets-move");
/** The old folders, spelled in pieces so a sweep that renames references leaves them alone. */
const OLD = ["ch", "at"].join("");
const OLD_REF = `/permission-sets/${OLD}/`;
const OLD_CONTROL_REF = `/permission-sets/${OLD}_control/`;

async function main(): Promise<void> {
  const home = join(WORLD, "home");
  const project = join(WORLD, "project");
  const realHome = join(homedir(), ".jaira");
  if (existsSync(WORLD)) {
    // A world from a previous run: start over, but never anywhere near the live one.
    if (resolve(WORLD) === resolve(realHome)) throw new Error("refusing to clear the live home");
    (await import("node:fs")).rmSync(WORLD, { recursive: true, force: true });
  }
  mkdirSync(join(home, "system"), { recursive: true });
  // The database, as a backup — a consistent copy while the live app may hold it open.
  const live = new Database(join(realHome, "system", "jaira.db"), { readonly: true, fileMustExist: true });
  await live.backup(join(home, "system", "jaira.db"));
  live.close();
  for (const file of ["machine.json", "machine.key", "workspace.id"]) {
    if (existsSync(join(realHome, "system", file))) cpSync(join(realHome, "system", file), join(home, "system", file));
  }
  // The project's `.jaira/`: its settings, workflows and run state (tasks, snapshots).
  mkdirSync(join(project, ".jaira"), { recursive: true });
  for (const part of ["settings.json", "workflows", "system"]) {
    if (existsSync(join(SOURCE, ".jaira", part))) cpSync(join(SOURCE, ".jaira", part), join(project, ".jaira", part), { recursive: true });
  }
  // The copy is this project's workspace id at another path; registered at the scratch path, so the
  // app does not re-id it and the conversations are listed.
  const id = readFileSync(join(project, ".jaira", "system", "workspace.id"), "utf8").trim();
  const copy = new Database(join(home, "system", "jaira.db"));
  copy.prepare(`UPDATE workspaces SET dir = ? WHERE id = ?`).run(resolve(project), id);
  const oldRequests = (copy.prepare(`SELECT count(*) AS n FROM operation_records WHERE request_json LIKE ?`).get(`%${OLD_REF}%`) as { n: number }).n;
  copy.close();
  // Planted in the old layout.
  mkdirSync(join(project, ".jaira", "permission-sets", OLD), { recursive: true });
  writeFileSync(join(project, ".jaira", "permission-sets", OLD, "read-only.json"), `${JSON.stringify({ $ref: `$SYSTEM${OLD_REF}read-only`, shell: "ask" }, null, 2)}\n`);
  const settingsFile = join(project, ".jaira", "settings.json");
  const settings = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(settingsFile, `${JSON.stringify({ ...settings, permissions: { layers: { [OLD]: [] } } }, null, 2)}\n`);
  const tasksDir = join(project, ".jaira", "system", "tasks");
  const conversations = readdirSync(tasksDir)
    .map((name) => JSON.parse(readFileSync(join(tasksDir, name), "utf8")) as { id: string; title: string; workflow: string; chatSettings?: { permissionSet?: unknown } })
    .filter((task) => task.workflow === "chat/session");
  console.log(`permission-sets-move: ${conversations.length} conversations, ${oldRequests} turn requests naming the old folder, before`);

  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`permission-sets-move: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const app = await App.launch({ home, project, userData: join(WORLD, "user-data") }, { out: OUT, port: 9269 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 860);
    await settle(1500);

    const override = join(project, ".jaira", "permission-sets", "read-only.json");
    check(existsSync(override) && JSON.parse(readFileSync(override, "utf8")).$ref === "$SYSTEM/permission-sets/read-only", "the project's override is at the top level, following $SYSTEM/permission-sets/read-only");
    check(!existsSync(join(project, ".jaira", "permission-sets", OLD)), "the old folder is gone");
    const layers = (JSON.parse(readFileSync(settingsFile, "utf8")) as { permissions?: { layers?: Record<string, unknown> } }).permissions?.layers ?? {};
    check(Object.keys(layers).join() === "", `the standing layers' key is "" (saw ${JSON.stringify(Object.keys(layers))})`);
    for (const task of conversations) {
      const text = readFileSync(join(tasksDir, `${task.id}.json`), "utf8");
      const after = JSON.parse(text) as { chatSettings?: { permissionSet?: { layers?: string[] } } };
      const named = after.chatSettings?.permissionSet?.layers ?? [];
      check(!text.includes(OLD_REF) && !text.includes(OLD_CONTROL_REF), `${task.id} names no old reference (${JSON.stringify(named)})`);
      if (task.id === NO_STACK) check(task.chatSettings?.permissionSet === undefined && named[0] === "$/permission-sets/ask-first", `${task.id}, which picked no stack, takes its snapshot's set renamed`);
    }
    const reread = new Database(join(home, "system", "jaira.db"), { readonly: true });
    const left = (reread.prepare(`SELECT count(*) AS n FROM operation_records WHERE request_json LIKE ? OR request_json LIKE ?`).get(`%${OLD_REF}%`, `%${OLD_CONTROL_REF}%`) as { n: number }).n;
    const version = Number(reread.pragma("user_version", { simple: true }));
    reread.close();
    check(left === 0 && version >= 32, `no turn request names an old reference (${left} left, schema ${version})`);

    // A conversation in the window, and its composer.
    const shown = conversations.find((task) => task.id === NO_STACK) ?? conversations[0];
    if (shown !== undefined) {
      await app.clickText("Chat");
      const title = shown.title.slice(0, 30);
      await app.until(says(title), "the conversation in the Chat room", 200);
      await app.clickText(title);
      await settle(3000);
      await app.shot("1-conversation");
      const page = await app.evaluate<string>("document.body.innerText");
      const composer = page.slice(-600);
      console.log(`permission-sets-move: the composer reads ${JSON.stringify(composer.replace(/\s+/g, " ").slice(-300))}`);
      check(!page.includes(`${OLD}/ask-first`) && !page.includes(`${OLD}/read-only`) && !page.includes(`${OLD}/full`), "the page names no set by its old id");
      check(/\b(ask-first|read-only|full|auto)\b/.test(composer), "the composer names the conversation's set");
      // Its segment, and the crumb that is a picker of the sets beside it: the top level's.
      const set = /\b(ask-first|read-only-scratch|read-only|full|auto)\b/.exec(composer)?.[1];
      if (set !== undefined) {
        // The stack may be folded to one chip at this width: the visible one that says the set, pressed
        // with a real pointer (a synthetic click does not open the composer's popovers).
        const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
          const hits = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent?.trim() === ${JSON.stringify(set)});
          const shown = hits.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.top > window.innerHeight / 2);
          const r = shown.at(-1);
          return r === undefined ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (at !== null) {
          await app.hover(at.x, at.y);
          await settle(1200);
        }
        await settle(2500);
        await app.shot("2-pressed");
      }
      // What the stack's popovers are drawn from, asked of the running app as they ask it: the set
      // browser's tree, and the conversation's stack composed.
      const after = JSON.parse(readFileSync(join(tasksDir, `${shown.id}.json`), "utf8")) as { chatSettings?: { permissionSet?: Record<string, unknown> } };
      const tree = await app.ipc<{ scopes: Array<{ scope: string; sets: Array<{ id: string }>; buckets: Array<{ path: string }> }> }>("permissionSets:tree", { project: resolve(project), permissionSet: after.chatSettings?.permissionSet });
      const builtIn = tree.scopes.find((scope) => scope.scope === "built in");
      check(
        builtIn !== undefined && ["ask-first", "auto", "full", "read-only", "read-only-scratch"].every((id) => builtIn.sets.some((each) => each.id === id)) && builtIn.buckets.map((bucket) => bucket.path).join() === "control",
        `the browser's built-in scope holds the presets at the top level and one bucket, control (saw sets ${JSON.stringify(builtIn?.sets.map((each) => each.id))}, buckets ${JSON.stringify(builtIn?.buckets.map((each) => each.path))})`,
      );
      const projectScope = tree.scopes.find((scope) => scope.scope === "project");
      check(projectScope?.sets.some((each) => each.id === "read-only") === true, "the project's moved override is a top-level set of its scope");
      const stack = await app.ipc<{ layers: Array<{ id: string; role: string; scope: string }> }>("permissionSets:stack", { project: resolve(project), taskId: shown.id, permissionSet: after.chatSettings?.permissionSet });
      console.log(`permission-sets-move: the stack is ${JSON.stringify(stack.layers.map((layer) => [layer.id, layer.role, layer.scope]))}`);
      check(stack.layers[0]?.id === "ask-first" && stack.layers[0]?.role === "bottom", "the conversation's stack is ask-first at the bottom, read from its file");
    }
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`permission-sets-move: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("permission-sets-move: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
