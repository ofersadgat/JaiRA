/**
 * A picture the person sizes (round 2's board 4, 2026-11-14): its chip and corner on hover, the corner
 * dragged, the chip opened into the bar, + pressed, the controls gone with the pointer. On a REAL
 * screenshot: the record `screenshot-view.mts` uses (t-elvj5dhzoy's, read only from this machine's
 * database), drawn in its phase's card.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/picture-size.mts [operationRecordId]
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
const OUT = join(import.meta.dirname, "out", "picture-size");
const WORLD = join(tmpdir(), "jaira-shots-picture-size");
type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close(): void };
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string, options?: { readonly?: boolean }) => Db;

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

type Box = { x: number; y: number; w: number; h: number };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const boxOf = (el: string): string => `(() => { const el = ${el}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;
/** The screenshot, and its natural width. */
const PICTURE = `(() => { const i = [...document.querySelectorAll('img')].find((i) => i.src.startsWith('data:image/') && i.naturalWidth > 0); if (!i) return null; const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, nw: i.naturalWidth }; })()`;
/** The chip, by its accessible name ("Picture size 32%: open its controls"), and the size it says. */
const CHIP = `(() => { const el = [...document.querySelectorAll('[aria-label^="Picture size "]')].find((e) => e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent ?? '' }; })()`;
const GRIP = boxOf(`[...document.querySelectorAll('[aria-label="Drag to resize the picture"]')].find((e) => e.getBoundingClientRect().width > 0)`);
const LABELLED = (label: string): string => boxOf(`document.querySelector('[aria-label="${label}"]')`);
const scaleOf = (p: Box & { nw: number }): number => Math.round((p.w / p.nw) * 100);
const mid = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") };
  initProject(world.project, world.home);
  const entries = realEntries();
  const app = await App.launch(world, { out: OUT, port: 9259 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 950);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const norm = (a: string): string => a.split("\\").join("/").toLowerCase();
    const project = (projects.find((p) => norm(p.project) === norm(world.project)) ?? projects.find((p) => p.kind === "user")!).project;
    const title = "Picture size";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", inputs: { message: title }, project, conversation: true });
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
    await app.evaluate(`(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 200 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 0; })()`);
    await settle(1500);
    // The screenshot is in its phase's card ("6 steps · 1 min 10 s ⌄"), opened by its tail.
    const tail = await app.evaluate<Box | null>(boxOf(`[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^6 steps/.test((e.textContent ?? '').trim()))`));
    if (tail !== null) await app.clickAt(tail.x + tail.w / 2, tail.y + tail.h / 2);
    await app.until(`${PICTURE} !== null`, "a decoded screenshot", 60);
    await settle(800);
    const rest = (await app.evaluate<Box & { nw: number }>(PICTURE))!;
    await app.shot("0-rest", undefined, false);
    check("at rest: no chip", (await app.evaluate(CHIP)) === null);

    // Pointer over it: the chip and the corner.
    await app.hover(rest.x + rest.w / 3, rest.y + rest.h / 2);
    await settle(400);
    const chip = await app.evaluate<(Box & { text: string }) | null>(CHIP);
    const grip = await app.evaluate<Box | null>(GRIP);
    check("hovered: the chip says the size", chip !== null && chip.text.startsWith(`${scaleOf(rest)}%`), chip?.text);
    check("hovered: the corner is there", grip !== null);
    await app.shot("1-hover", undefined, false);
    if (chip === null || grip === null) return;

    // The corner, dragged 150 left: the chip says the size meanwhile, and the picture follows.
    const from = mid(grip);
    await app.mouse("mouseMoved", from, false);
    await app.mouse("mousePressed", from);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: from.x - 15 * i, y: from.y - 9 * i });
    await settle(300);
    const during = await app.evaluate<(Box & { text: string }) | null>(CHIP);
    const selected = await app.evaluate<string>(`String(window.getSelection())`);
    check("dragging: the chip says the size in pixels", during !== null && /\d+×\d+/.test(during.text), during?.text);
    check("dragging: no text is selected", selected === "", selected.slice(0, 40));
    await app.shot("2-dragging", undefined, false);
    await app.mouse("mouseReleased", { x: from.x - 150, y: from.y - 90 });
    await settle(500);
    const dragged = (await app.evaluate<Box & { nw: number }>(PICTURE))!;
    check("the corner dragged 150 left: the picture is 150 narrower", Math.abs(rest.w - dragged.w - 150) < 3, { from: Math.round(rest.w), to: Math.round(dragged.w) });
    await app.shot("3-dragged", undefined, false);

    // Pointer on the chip: the bar.
    await app.hover(dragged.x + dragged.w / 3, dragged.y + dragged.h / 2);
    const chip2 = (await app.evaluate<Box>(CHIP))!;
    await app.hover(chip2.x + chip2.w / 2, chip2.y + chip2.h / 2);
    await settle(400);
    const plus = await app.evaluate<Box | null>(LABELLED("Larger"));
    check("chip hovered: the bar opens (−, +, Fit, 1:1)", plus !== null && (await app.evaluate(LABELLED("Smaller"))) !== null && (await app.evaluate(LABELLED("Fit the column"))) !== null && (await app.evaluate(LABELLED("Actual size"))) !== null);
    await app.shot("4-bar", undefined, false);
    if (plus === null) return;

    // +: up to the next tenth, the card it is in still open.
    const before = scaleOf(dragged);
    await app.clickAt(plus.x + plus.w / 2, plus.y + plus.h / 2);
    await settle(500);
    const grown = await app.evaluate<(Box & { nw: number }) | null>(PICTURE);
    check("+ keeps the card open", grown !== null);
    if (grown !== null) check("+ grows it to the next tenth", scaleOf(grown) === (Math.floor(before / 10) + 1) * 10, { before, after: scaleOf(grown) });
    await app.shot("5-plus", undefined, false);

    // Pointer away: the controls go.
    const now = (await app.evaluate<Box>(PICTURE))!;
    await app.hover(now.x - 12, now.y + now.h / 2);
    await settle(400);
    check("pointer off the picture: no chip", (await app.evaluate(CHIP)) === null && (await app.evaluate(LABELLED("Larger"))) === null);
    await app.shot("6-away", undefined, false);
  } finally {
    await app.close();
    const failed = checks.filter(([, ok]) => !ok).length;
    console.log(`picture-size: ${checks.length - failed}/${checks.length} checks passed`);
  }
}

await main();
