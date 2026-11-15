/**
 * A subagent drawn the way a run the conversation started is (`subagentModel.ts`): its line under the
 * Agent call, opened in place, walked into with the title a breadcrumb, a nested one walked into after.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/subagent-view.mts [taskId]
 *
 * A conversation in a world of its own, its record replaced by a REAL one from this machine's database
 * (read only) with that run's subagent files folded in as a close now folds them, and its approvals put
 * beside the calls that asked. Default: t-wdxyhs1w6w (a background agent that started the agent doing
 * the work, 2026-11-12).
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { captureNativeSession, foldIntoEntries, mergeHostCalls } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import type { World } from "./world.mjs";

const SOURCE = process.argv[2] ?? "t-wdxyhs1w6w";
/** One record of it, by id: the turn with the background agents (2026-11-13) is no longer its latest. */
const RECORD = process.argv[3] ?? "a368cb9cee15afe7e8fb65dfae81731603f7a0858eb6b25b7248227a44444db8";
const OUT = join(import.meta.dirname, "out", "agent-rail");
const WORLD = join(tmpdir(), "jaira-shots-agent-rail");
type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close(): void };
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string, options?: { readonly?: boolean }) => Db;

type Entry = Record<string, unknown> & { content?: unknown };
const parts = (e: Entry): Array<Record<string, unknown>> => (Array.isArray(e.content) ? (e.content as Array<Record<string, unknown>>) : []);
const isHost = (e: Entry): boolean => parts(e).some((p) => (p["type"] === "tool_use" && /^(approve_tool_call|check_permission)$/.test(String(p["name"]))) || (p["type"] === "tool_result" && /^(approve|check)_/.test(String(p["tool_use_id"]))));

/** The real record's entries, as a close under this build would store them. */
async function realEntries(): Promise<unknown[]> {
  const db = new Database(join(homedir(), ".jaira", "system", "jaira.db"), { readonly: true });
  const row = (RECORD !== undefined ? db.prepare("SELECT result_json, provider_session_id, started_at FROM operation_records WHERE id = ?").get(RECORD) : db.prepare("SELECT result_json, provider_session_id, started_at FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(SOURCE)) as { result_json: string; provider_session_id: string; started_at: number };
  db.close();
  const value = (JSON.parse(row.result_json) as { value: { entries: Entry[] } }).value;
  const plain = value.entries.filter((e) => !isHost(e) && e["partial"] !== true);
  const captured = await captureNativeSession(row.provider_session_id, { cwd: "C:/UbuntuCode/JaiRA", sinceMs: row.started_at });
  const folded = foldIntoEntries({ entries: plain }, captured)["entries"] as Entry[];
  // The approvals, by the call whose input they name: what `recordApprovalCall` now finds at ask time.
  const byCommand = new Map<string, string>();
  for (const e of folded) for (const p of parts(e)) if (p["type"] === "tool_use") byCommand.set(JSON.stringify((p["input"] as { command?: unknown } | undefined)?.command ?? null), String(p["id"]));
  const hosts = value.entries.filter(isHost).map((e) => {
    const use = parts(e).find((p) => p["type"] === "tool_use");
    const caller = use !== undefined ? byCommand.get(JSON.stringify((use["input"] as { command?: unknown } | undefined)?.command ?? null)) : undefined;
    return (caller !== undefined ? { ...e, calledBy: caller } : e) as never;
  });
  return mergeHostCalls(folded as never, hosts).entries;
}

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") };
  initProject(world.project, world.home);
  const entries = await realEntries();
  console.log(`the record: ${entries.length} entries`);
  const app = await App.launch(world, { out: OUT, port: 9258 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 950);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const norm = (a: string): string => a.split("\\").join("/").toLowerCase();
    const same = (a: string): boolean => norm(a) === norm(world.project);
    const project = (projects.find((p) => same(p.project)) ?? projects.find((p) => p.kind === "user")!).project;
    console.log("projects:", projects.map((p) => `${p.kind} ${p.project}`).join(" | "), "->", project);
    const title = "A few things: quit dialog, when column, icons";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "A few things" }, project, conversation: true });
    await app.ipc("task:start", { taskId: made.taskId, project, fake: [{ output: "Done." }] });
    await app.until(says(title), "the conversation to be listed");
    await settle(1500);
    const db = new Database(join(world.home, "system", "jaira.db"));
    const row = db.prepare(`SELECT id, result_json FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(made.taskId) as { id: string; result_json: string };
    // A delegated agent's record holds its conversation as entries (a fake's holds messages).
    db.prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`).run(JSON.stringify({ value: { entries, finishReason: "stop" } }), row.id);
    db.close();

    await app.clickText("All chats");
    await settle(1500);
    await app.until(says(title), "the conversation in the Chat list");
    await app.clickText(title);
    await settle(4000);
    await app.shot("1-thread", undefined, false);
    // A lane's hit areas: 12 wide, a pointer cursor, in the gutter. The longest is a background lane.
    const longest = async (): Promise<{ x: number; y: number; h: number } | undefined> => {
      const found = await app.evaluate<Array<{ x: number; y: number; h: number }>>(
        `(() => [...document.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer' && Math.round(d.getBoundingClientRect().width) === 12).map((d) => { const r = d.getBoundingClientRect(); return { x: r.x + 6, y: r.y, h: r.height }; }))()`,
      );
      return found.filter((l) => l.h > 60 && l.y + l.h > 220 && l.y < 1100).sort((a, b) => b.h - a.h)[0];
    };
    const hoverLane = async (): Promise<boolean> => {
      const lane = await longest();
      if (lane === undefined) return false;
      await app.hover(lane.x, Math.min(Math.max(lane.y + 40, 180), lane.y + lane.h - 12));
      await settle(800);
      return true;
    };
    const press = async (label: string): Promise<boolean> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
        const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify("@@")});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`.replace(JSON.stringify("@@"), JSON.stringify(label)));
      if (at === null) return false;
      await app.clickAt(at.x, at.y);
      await settle(1500);
      return true;
    };
    console.log("hover:", await hoverLane());
    await app.shot("2-hover-stack", undefined, false);
    console.log("bring here:", await press("Bring into this conversation"));
    await app.shot("3-brought-here", undefined, false);
    if (await hoverLane()) {
      await app.shot("4-hover-brought", undefined, false);
      console.log("send back:", await press("Send back to the background"));
    }
    // The main window: entered, as a substate — the agent is the page, the title a breadcrumb; back out by it.
    if (await hoverLane()) {
      console.log("main view:", await press("Open as the main view"));
      await settle(1500);
      await app.shot("5-main-view", undefined, false);
      await app.clickText(title);
      await settle(2000);
    }
    if (await hoverLane()) {
      console.log("beside:", await press("Open beside"));
      await settle(1500);
      await app.shot("5-beside", undefined, false);
    }
    if (await hoverLane()) {
      console.log("panel:", await press("Open in the side panel"));
      await settle(1500);
      await app.shot("6-panel", undefined, false);
    }
  } finally {
    await app.close();
  }
}

await main();
