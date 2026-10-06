/**
 * A tool's large result reaches the window as a placeholder, and is fetched when its row is opened
 * (decision 0018 §6).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/lazy.mts
 *
 * A conversation in a world of its own, its record given a `Read` call whose result is 20 KB, the
 * window's threshold set to a phone's (4 KB, `JAIRA_LAZY_OVER`).
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import type { World } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "lazy");
const WORLD = join(tmpdir(), "jaira-shots-lazy");
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string) => { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close(): void };
const lines = Array.from({ length: 800 }, (_, i) => `LINE-${String(i).padStart(4, "0")} of the file the agent read`).join("\n");

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") };
  initProject(world.project, world.home);
  process.env["JAIRA_LAZY_OVER"] = "4096";
  const app = await App.launch(world, { out: OUT, port: 9253 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 860);
    const project = (await app.ipc<Array<{ project: string; kind: string }>>("project:list", {})).find((p) => p.kind === "user")!.project;
    const made = await app.ipc<{ taskId: string }>("task:create", { title: "Read the big file", workflow: "chat/session", inputs: { message: "Read big.txt" }, project });
    await app.ipc("task:start", { taskId: made.taskId, project, fake: [{ output: "I read it." }] });
    await app.until(says("Read the big file"), "the conversation to be listed");
    await settle(1500);
    // The record, given the call and its 20 KB answer — what an agent's would hold.
    const db = new Database(join(world.home, "system", "jaira.db"));
    const row = db.prepare(`SELECT id, result_json FROM operation_records WHERE task_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`).get(made.taskId) as { id: string; result_json: string };
    const result = JSON.parse(row.result_json) as { messages?: unknown[] };
    if (!Array.isArray(result.messages)) throw new Error("the record holds no messages to add a call to");
    result.messages.splice(result.messages.length - 1, 0,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "Read", input: { file_path: "C:/big.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: lines }] },
    );
    db.prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`).run(JSON.stringify(result), row.id);
    db.close();

    const thread = await app.ipc<unknown>("chat:thread", { taskId: made.taskId });
    const text = JSON.stringify(thread);
    console.log("thread:", text.length, "bytes;", (text.match(/"\$lazy"/g) ?? []).length, "placeholders;", text.includes("LINE-0500") ? "the deep line is in it" : "the deep line is not in it");

    await app.clickText("Chat");
    await app.until(says("Read the big file"), "the conversation in the Chat list");
    await app.clickText("Read the big file");
    await app.until(says("big.txt"), "the Read call's row", 120);
    await settle(1000);
    const shownBefore = await app.evaluate<boolean>(says("LINE-0500"));
    await app.shot("closed");
    await app.clickText("big.txt");
    await app.until(says("LINE-0500"), "the result's deep line, fetched when the row opened", 120);
    await app.shot("opened");
    // (What the window asked cannot be counted from the page: Electron's bridge is frozen.)
    if (!text.includes('"$lazy"') || text.includes("LINE-0500")) throw new Error("the thread came whole");
    if (shownBefore) throw new Error("the deep line was on screen before the row was opened");
    console.log("lazy: the 20 KB result came as a placeholder, and was fetched when its row was opened");
  } finally {
    await app.close();
  }
}

await main();
