/**
 * A conversation's permission stack after the app restarts, on REAL data (the person, 2026-11-09: "it
 * isnt showing any permission layers"). A scratch copy of this machine's database and of this project's
 * `.jaira/` — never the live one — opened by the built app, with one conversation's kept composer
 * settings put back to what they were before (`--settings`). Reports what the composer's stack reads as
 * the window comes back, and again once the conversation is opened from the Chat room.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/chat-stack-restart.mts <taskId> [--settings '<json>'] [--project <dir>]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";

const require = createRequire(import.meta.url);
const Database = require(require.resolve("better-sqlite3", { paths: [join(import.meta.dirname, "..", "..", "persistence")] })) as typeof import("better-sqlite3");

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const TASK = process.argv[2];
if (TASK === undefined || TASK.startsWith("--")) throw new Error("name the conversation's task id");
const SETTINGS = arg("--settings");
const SOURCE = resolve(arg("--project") ?? join(import.meta.dirname, "..", "..", ".."));
const OUT = join(import.meta.dirname, "out", "chat-stack-restart");
const WORLD = join(import.meta.dirname, ".world-chat-stack-restart");
const BAR = '[role="group"][aria-label="Permissions"]';

async function main(): Promise<void> {
  const home = join(WORLD, "home");
  const project = join(WORLD, "project");
  const realHome = join(homedir(), ".jaira");
  if (resolve(WORLD) === resolve(realHome)) throw new Error("refusing to touch the live home");
  if (existsSync(WORLD)) rmSync(WORLD, { recursive: true, force: true });
  mkdirSync(join(home, "system"), { recursive: true });
  const live = new Database(join(realHome, "system", "jaira.db"), { readonly: true, fileMustExist: true });
  await live.backup(join(home, "system", "jaira.db"));
  live.close();
  for (const file of ["machine.json", "machine.key", "workspace.id"]) {
    if (existsSync(join(realHome, "system", file))) cpSync(join(realHome, "system", file), join(home, "system", file));
  }
  mkdirSync(join(project, ".jaira"), { recursive: true });
  for (const part of ["settings.json", "workflows", "system"]) {
    if (existsSync(join(SOURCE, ".jaira", part))) cpSync(join(SOURCE, ".jaira", part), join(project, ".jaira", part), { recursive: true });
  }
  const id = readFileSync(join(project, ".jaira", "system", "workspace.id"), "utf8").trim();
  const copy = new Database(join(home, "system", "jaira.db"));
  copy.prepare(`UPDATE workspaces SET dir = ? WHERE id = ?`).run(resolve(project), id);
  copy.close();
  const taskFile = join(project, ".jaira", "system", "tasks", `${TASK}.json`);
  const meta = JSON.parse(readFileSync(taskFile, "utf8")) as Record<string, unknown>;
  if (SETTINGS !== undefined) {
    const settings = JSON.parse(SETTINGS) as Record<string, unknown>;
    if (Object.keys(settings).length === 0) delete meta["chatSettings"];
    else meta["chatSettings"] = settings;
    writeFileSync(taskFile, `${JSON.stringify(meta, null, 2)}\n`);
  }
  const title = String(meta["title"]).slice(0, 30);
  console.log(`chat-stack-restart: ${TASK} "${title}" kept settings ${JSON.stringify(meta["chatSettings"] ?? null)}`);

  const app = await App.launch({ home, project, userData: join(WORLD, "user-data") }, { out: OUT, port: 9271 });
  const bar = (): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(BAR)})].map((el) => (el.innerText ?? "").replace(/\\s+/g, " ").trim())`);
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 860);
    await settle(3000);
    await app.shot("1-restored");
    console.log(`chat-stack-restart: restored at ${await app.evaluate<string>("location.hash")}; stack bars: ${JSON.stringify(await bar())}`);
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(title);
    await settle(4000);
    await app.shot("2-opened");
    console.log(`chat-stack-restart: opened from the Chat room; stack bars: ${JSON.stringify(await bar())}`);
    const after = JSON.parse(readFileSync(taskFile, "utf8")) as { chatSettings?: unknown };
    console.log(`chat-stack-restart: kept settings now ${JSON.stringify(after.chatSettings ?? null)}`);
    if (!process.argv.includes("--ask")) return;
    // As the person's composer was: nothing kept, so the bottom layer is read from the frozen pin.
    const MODEL = "claude-cli/haiku";
    await app.ipc("chat:settings", { taskId: TASK, overrides: { model: MODEL } });
    await app.clickText("Chat");
    await settle(800);
    await app.clickText(title);
    await settle(4000);
    console.log(`chat-stack-restart: nothing kept; stack bars: ${JSON.stringify(await bar())}`);
    await app.shot("3-nothing-kept");
    const pending = async (): Promise<Array<{ taskId?: string }>> => (await app.ipc<Array<{ taskId?: string }>>("approval:pending", undefined)).filter((p) => p.taskId === TASK);
    const askDrawn = (): Promise<boolean> => app.evaluate<boolean>(`/\\bAllow\\b/.test(document.body.innerText) && /\\bDeny\\b/.test(document.body.innerText)`);
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: TASK });
    const line = "Use your shell tool to run exactly this line, once, and nothing else: hostname\nDo not pass a cwd. Then reply with its output, or, if it was not run, with the reason you were given, word for word. Do not use any other tool, and do not try again.";
    // The call the conversation left waiting comes back with it; a line is asked only when nothing waits.
    if ((await pending()).length === 0) await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify({ taskId: TASK, instanceId: thread.instanceId, message: line, overrides: { model: MODEL } })}), true`);
    for (let i = 0; (await pending()).length === 0; i++) {
      if (i > 240) throw new Error("no ask in two minutes");
      await settle(500);
    }
    await settle(2500);
    await app.shot("4-asked");
    console.log(`chat-stack-restart: asked; drawn ${await askDrawn()}; stack bars: ${JSON.stringify(await bar())}`);
    const press = async (selector: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) throw new Error(`nothing at ${selector}`);
      await app.pointer(at.x, at.y);
      await settle(300);
      await app.clickAt(at.x, at.y);
      await settle(2500);
    };
    const pressText = async (text: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const hits = [...document.body.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)})); const el = hits.at(-1); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) throw new Error(`nothing reads "${text}"; the page ends ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-700))}`);
      await app.pointer(at.x, at.y);
      await settle(300);
      await app.clickAt(at.x, at.y);
      await settle(800);
    };
    for (const channel of ["permissionSets:stack", "permissionSets:tree"]) {
      const probe = await app.ipc<unknown>(channel, { taskId: TASK, project, permissionSet: { layers: ["$/permission-sets/chat/ask-first"] } }).then((v) => JSON.stringify(v).slice(0, 400), (e: unknown) => `THREW ${String(e)}`);
      console.log(`chat-stack-restart: ${channel} under the pin's old name: ${probe}`);
    }
    await app.evaluate(`(() => { window.__seen = []; new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) { const t = (n.innerText || n.textContent || "").slice(0, 60); if (t.trim() !== "") window.__seen.push(performance.now().toFixed(0) + " + " + t.replace(/\\s+/g, " ")); } for (const m of list) for (const n of m.removedNodes) { const t = (n.innerText || n.textContent || "").slice(0, 60); if (t.trim() !== "") window.__seen.push(performance.now().toFixed(0) + " - " + t.replace(/\\s+/g, " ")); } }).observe(document.body, { childList: true, subtree: true }); })(), true`);
    const el = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(`${BAR} [aria-label="Permissions"]`)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    console.log(`chat-stack-restart: the shield at ${JSON.stringify(el)}; under it ${await app.evaluate<string>(`document.elementFromPoint(${el.x}, ${el.y})?.outerHTML.slice(0, 200) ?? "nothing"`)}`);
    await press(`${BAR} [aria-label="Permissions"]`);
    console.log(`chat-stack-restart: drawn and taken away after the press: ${JSON.stringify(await app.evaluate<string[]>("window.__seen.slice(0, 30)"))}`);
    await app.shot("5-add", undefined, false);
    console.log(`chat-stack-restart: removals: ${JSON.stringify(await app.evaluate<string[]>("window.__seen.filter((s) => s.includes(' - ')).slice(0, 40)"))}`);
    console.log(`chat-stack-restart: why full.json is not seen: ${await app.evaluate<string>(`(() => {
      const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent || "").trim() === "full");
      if (!el) return "no element";
      const out = [];
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        if (s.opacity !== "1" || s.visibility !== "visible" || s.display === "none" || s.position === "fixed" || s.position === "absolute" || n.parentElement === document.body) out.push(n.tagName + " op=" + s.opacity + " vis=" + s.visibility + " disp=" + s.display + " pos=" + s.position + " rect=" + [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " z=" + s.zIndex);
      }
      return out.join(" | ");
    })()`)}`);
    // `+`'s list: pressing a set's row lays it on top (2026-11-14).
    await pressText("full");
    await settle(4000);
    await app.shot("6-after-add", undefined, false);
    const kept = JSON.parse(readFileSync(taskFile, "utf8")) as { chatSettings?: unknown };
    console.log(`chat-stack-restart: after +full: still asks ${(await pending()).length}; drawn ${await askDrawn()}; stack bars: ${JSON.stringify(await bar())}`);
    console.log(`chat-stack-restart: kept ${JSON.stringify(kept.chatSettings ?? null).slice(0, 300)}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
