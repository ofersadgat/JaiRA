/**
 * A screenshot a tool handed back, drawn under its call (decision 0019) — though its base64, hundreds
 * of KB, reaches the window as a `$lazy` placeholder (decision 0018 §6) and is fetched to be drawn.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/screenshot-view.mts [operationRecordId]
 *
 * A conversation in a world of its own, its record replaced by a REAL one from this machine's database
 * (read only), its `$blob` references filled from that database's blobs. Default: t-elvj5dhzoy's
 * 2026-11-06 run (one screenshot, 533 KB of base64).
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import type { World } from "./world.mjs";

const SOURCE = process.argv[2] ?? "5e49074811b8027bfcb933a873c8791e05e450f2bf6a60ceb05caa31ab19b631";
const OUT = join(import.meta.dirname, "out", "screenshot-view");
const WORLD = join(tmpdir(), "jaira-shots-screenshot-view");
type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close(): void };
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string, options?: { readonly?: boolean }) => Db;

/** The real record's entries, every `$blob` put back as the string it stands for. */
function realEntries(): unknown[] {
  const db = new Database(join(homedir(), ".jaira", "system", "jaira.db"), { readonly: true });
  const row = db.prepare("SELECT result_json FROM operation_records WHERE id = ?").get(SOURCE) as { result_json: string };
  const blob = (hash: string): string => (db.prepare("SELECT content FROM blobs WHERE hash = ?").get(hash) as { content: string }).content;
  const fill = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fill);
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "$blob" && typeof o["$blob"] === "string") return blob(o["$blob"]);
    return Object.fromEntries(keys.map((k) => [k, fill(o[k])]));
  };
  const entries = fill((JSON.parse(row.result_json) as { value: { entries: unknown[] } }).value.entries) as unknown[];
  db.close();
  return entries;
}

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") };
  initProject(world.project, world.home);
  const entries = realEntries();
  const pictures = JSON.stringify(entries).split('"type":"image"').length - 1;
  console.log(`the record: ${entries.length} entries, ${pictures} image block(s)`);
  const app = await App.launch(world, { out: OUT, port: 9258 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 950);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const norm = (a: string): string => a.split("\\").join("/").toLowerCase();
    const project = (projects.find((p) => norm(p.project) === norm(world.project)) ?? projects.find((p) => p.kind === "user")!).project;
    const title = "Chat panel designs";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "Chat panel designs" }, project, conversation: true });
    await app.ipc("task:start", { taskId: made.taskId, project, fake: [{ output: "Done." }] });
    await app.until(says(title), "the conversation to be listed");
    await settle(1500);
    const db = new Database(join(world.home, "system", "jaira.db"));
    const row = db.prepare(`SELECT id FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(made.taskId) as { id: string };
    db.prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`).run(JSON.stringify({ value: { entries, finishReason: "stop" } }), row.id);
    db.close();

    await app.clickText("All chats");
    await settle(1500);
    await app.until(says(title), "the conversation in the Chat list");
    await app.clickText(title);
    await settle(2500);
    await app.shot("0-thread-end", undefined, false);
    // The thread opens at its end; the screenshot is near its start.
    await app.evaluate(`(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 200 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 0; })()`);
    await settle(1500);
    await app.shot("0-thread-top", undefined, false);
    // Its phase is folded ("6 steps · 1 min 10 s ⌄"): opened by its tail, as a person would.
    const tail = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^6 steps/.test((e.textContent ?? '').trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    // Another record (a second argument) has no such phase: its end is photographed, and that is all.
    if (tail === null) {
      console.log("screenshot-view: no '6 steps' phase; 0-thread-end is this record's end");
      return;
    }
    await app.clickAt(tail.x, tail.y);
    await settle(1500);

    // The picture: an <img> on a data: address, decoded (naturalWidth), scrolled to and photographed.
    const found = await app.until(
      `(() => [...document.querySelectorAll('img')].some((i) => i.src.startsWith('data:image/') && i.naturalWidth > 0))()`,
      "a decoded screenshot in the thread",
      60,
    ).then(() => true, () => false);
    const facts = await app.evaluate<{ images: Array<{ w: number; h: number; shownW: number; shownH: number }>; fetching: boolean }>(`(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('data:image/'));
      if (imgs[0]) imgs[0].scrollIntoView({ block: 'center' });
      return {
        images: imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, shownW: Math.round(i.getBoundingClientRect().width), shownH: Math.round(i.getBoundingClientRect().height) })),
        fetching: document.body.innerText.includes('fetching the picture'),
      };
    })()`);
    await settle(800);
    await app.shot("1-screenshot-in-thread", undefined, false);
    console.log(`screenshot-view: ${found ? "PASS" : "FAIL"} ${JSON.stringify(facts)}`);
  } finally {
    await app.close();
  }
}

await main();
