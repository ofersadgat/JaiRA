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
const OUT = join(import.meta.dirname, "out", "subagent-view");
const WORLD = join(tmpdir(), "jaira-shots-subagent-view");
type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close(): void };
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string, options?: { readonly?: boolean }) => Db;

type Entry = Record<string, unknown> & { content?: unknown };
const parts = (e: Entry): Array<Record<string, unknown>> => (Array.isArray(e.content) ? (e.content as Array<Record<string, unknown>>) : []);
const isHost = (e: Entry): boolean => parts(e).some((p) => (p["type"] === "tool_use" && /^(approve_tool_call|check_permission)$/.test(String(p["name"]))) || (p["type"] === "tool_result" && /^(approve|check)_/.test(String(p["tool_use_id"]))));

/** The real record's entries, as a close under this build would store them. */
async function realEntries(): Promise<unknown[]> {
  const db = new Database(join(homedir(), ".jaira", "system", "jaira.db"), { readonly: true });
  const row = db.prepare("SELECT result_json, provider_session_id, started_at FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(SOURCE) as { result_json: string; provider_session_id: string; started_at: number };
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
  const app = await App.launch(world, { out: OUT, port: 9257 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 950);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const norm = (a: string): string => a.split("\\").join("/").toLowerCase();
    const same = (a: string): boolean => norm(a) === norm(world.project);
    const project = (projects.find((p) => same(p.project)) ?? projects.find((p) => p.kind === "user")!).project;
    console.log("projects:", projects.map((p) => `${p.kind} ${p.project}`).join(" | "), "->", project);
    const title = "A few things: quit dialog, when column, icons";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", inputs: { message: "A few things" }, project, conversation: true });
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
    await app.shot("0-chat", undefined, false);
    await app.until(says(title), "the conversation in the Chat list");
    await app.clickText(title);
    const outer = "Quit dialog for running work";
    await app.until(says(outer), "the subagent's line", 120);
    await settle(1500);
    await app.shot("1-thread", undefined, false);

    const press = async (label: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
        const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (at === null) throw new Error(`nothing labelled "${label}"`);
      await settle(300);
      await app.clickAt(at.x, at.y);
      await settle(1200);
    };

    // Opened in place: its conversation nested under the line, the subagent it started a line of its own.
    await press(`show ${outer}'s run here`);
    const inner = "Build quit-with-running-work dialog";
    await app.until(says(inner), "the nested subagent's line");
    await app.shot("2-open-in-place", undefined, false);
    await press(`hide ${outer}'s run`);

    // Walked into: the subagent is the page, the title a breadcrumb.
    await press(`go into ${outer}`);
    await app.until(says(inner), "the subagent's page");
    await app.shot("3-walked-in", undefined, false);

    // Deeper: the subagent it started, its calls and the approvals beside them.
    await press(`go into ${inner}`);
    await app.until("document.body.innerText.includes('approve')", "the inner subagent's page with its approvals", 60).catch(() => undefined);
    await settle(1500);
    await app.shot("4-walked-deeper", undefined, false);

    // Back out by the first crumb.
    await app.clickText(title);
    await settle(1500);
    await app.shot("5-back-out", undefined, false);

    // Outside the Chat view (no host draws it): the same line from the subagent's entries alone, and its
    // go-in walking the Tasks view's trail.
    await app.clickText("All tasks");
    await settle(1500);
    await app.clickText(title);
    await app.until(says(outer), "the subagent's line in the Tasks view", 120);
    await settle(1500);
    const line = await app.evaluate<{ go: boolean; steps: boolean }>(`(() => ({
      go: [...document.querySelectorAll('[aria-label]')].some((e) => e.getAttribute('aria-label') === ${JSON.stringify(`go into ${outer}`)}),
      steps: /99 steps/.test(document.body.innerText),
    }))()`);
    console.log(`subagent-view: tasks view line ${JSON.stringify(line)}`);
    await app.shot("6-tasks-view", undefined, false);
    if (line.go) {
      await press(`go into ${outer}`);
      await settle(1500);
      await app.shot("7-tasks-walked-in", undefined, false);
    }
    console.log("subagent-view: done");
  } finally {
    await app.close();
  }
}

await main();
