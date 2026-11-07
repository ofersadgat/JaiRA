/**
 * A design canvas, end to end (decisions 0020, 0024): a real agent runs `/design`, publishes a canvas
 * through `show_artifact` from the Design type's own instructions, the conversation opens it in the EDITOR
 * (no board, no Edit) whose artboards RUN under JaiRA's `.dc.html` runtime, and the editor's change is kept
 * as a version marked the person's.
 *
 * A real agent (claude-cli/sonnet by default — this rig spends a little, and a second turn at the end,
 * for the comment sent to Claude). Passes when:
 *   - the task has a canvas with `project/canvas.json` and at least one `.dc.html` artboard;
 *   - the conversation draws the canvas in its editor, and every artboard frame posts `dc:ready`;
 *   - in the editor, a click on an artboard selects one of its elements, Delete removes it, and the
 *     canvas gains a version whose author is the person; a drag moves one; every drawing tool saves;
 *   - an artboard marked interactive runs in place under ▶ (a click in it picks nothing), ⤢ fills the
 *     editor with it, ■ stops it; PNG and PDF export;
 *   - the comment tool pins a note and a comment for Claude on the artboard: both kept, the note never
 *     sent, the other in the conversation as the person's message; a pin opened and resolved.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/canvas.mts [--model claude-cli/haiku] [--pages http://127.0.0.1:8081/] [--reuse]
 *
 * `--reuse` opens the canvas the last run made instead of asking the agent for a new one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Design a sign-in screen";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/sonnet";
const pages = arg("--pages");
const reuse = process.argv.includes("--reuse");
const OUT = join(import.meta.dirname, "out", "canvas");
const WORLD = join(import.meta.dirname, ".world-canvas");

/** Every tool allowed: the rig is about the canvas, not about asking. */
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));

interface Published {
  id: string;
  version: number;
  kind: string;
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  writeFileSync(join(world.home, "settings.json"), JSON.stringify({ appearance: { conversation: { workPhases: true, workRows: 5 } } }, null, 2));
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: 9271, mainInspect: 9272 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 980);
    // Every message the window is posted, from the artboard frames among others.
    await app.evaluate(`(() => { window.__dc = []; window.addEventListener("message", (e) => { if (e.data && typeof e.data.type === "string" && e.data.type.startsWith("dc:")) { const f = [...document.querySelectorAll("iframe")].find((el) => el.contentWindow === e.source); window.__dc.push({ ...e.data, from: f ? f.title : null }); } }); })()`);
    // `--reuse`: the canvas the last run made, without another turn of the agent.
    const kept = join(WORLD, "task.txt");
    const made = reuse && existsSync(kept)
      ? { taskId: readFileSync(kept, "utf8").trim() }
      : await app.ipc<{ taskId: string }>("task:create", {
          title: TITLE,
          workflow: "chat/session",
          inputs: { message: "/design a sign-in screen for a small todo app — one artboard, a phone size" },
        });
    if (!(reuse && existsSync(kept))) {
      writeFileSync(kept, made.taskId);
      await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: FULL } });
    }
    await app.until(says(TITLE), "the conversation to be listed", 200);

    // The canvas: published, with an artboard in it.
    let canvas: Published | undefined;
    let files: Record<string, string> = {};
    for (let i = 0; ; i++) {
      const list = await app.ipc<Published[]>("artifact:published", { taskId: made.taskId });
      canvas = list.find((a) => a.kind === "canvas");
      if (canvas !== undefined) {
        files = (await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files;
        if (files["project/canvas.json"] !== undefined && Object.keys(files).some((p) => p.endsWith(".dc.html"))) break;
      }
      if (i > 720) throw new Error(`no canvas with an artboard in six minutes: ${JSON.stringify(list)} ${JSON.stringify(Object.keys(files))}`);
      await settle(500);
    }
    console.log(`canvas: ${canvas.id} v${String(canvas.version)} — ${Object.keys(files).sort().join(", ")}`);
    // Let the turn finish publishing what it meant to.
    if (!reuse) await settle(20_000);

    await app.clickText(TITLE);
    await settle(3000);
    // The finished turn's steps fold under its phase: open every one, so the publishing call is drawn.
    for (let i = 0; i < 40; i++) {
      const toggle = await app.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = [...document.querySelectorAll('[aria-label="Show steps"]')][0]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (toggle === null) break;
      await app.clickAt(toggle.x, toggle.y);
      await settle(1200);
    }
    // The canvas opens in its editor (decision 0024): the newest version, on a computer, is edited, not looked at.
    const editor = await app.evaluate<{ x: number; y: number; boards: number } | null>(
      `(() => { const all = [...document.querySelectorAll('[data-island="canvasEditor"]')]; const el = all[all.length - 1]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, boards: document.querySelectorAll('[data-island="canvas"]').length }; })()`,
    );
    if (editor === null) {
      await app.shot("no-editor");
      const islands = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-island]')].map((e) => e.getAttribute('data-island'))`);
      const text = await app.evaluate<string>(`document.body.innerText.slice(-3000)`);
      throw new Error(`the conversation does not open the canvas in its editor; islands ${JSON.stringify(islands)}; the page ends ${JSON.stringify(text)}`);
    }
    await settle(4000);
    await app.shot("editor");
    const ready = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:ready" && m.size && m.size.width > 0).length`);
    const errors = await app.evaluate<string[]>(`window.__dc.filter((m) => m.type === "dc:error").map((m) => m.message)`);
    const editButtons = await app.evaluate<number>(`[...document.querySelectorAll('[data-island="canvasEditor"] button, [data-island="canvas"] button')].filter((b) => b.textContent.trim() === "Edit" || b.textContent.trim() === "Done").length`);
    console.log(`editor: opened at once (boards elsewhere ${String(editor.boards)}); ${String(ready)} dc:ready, errors ${JSON.stringify(errors)}; Edit/Done buttons ${String(editButtons)}`);
    if (ready === 0) throw new Error(`no artboard reported it rendered; errors: ${JSON.stringify(errors)}`);
    if (editButtons > 0) throw new Error("the editor still offers Edit or Done");

    // An element selected in an artboard, deleted, kept as the person's version.
    const frame = await app.evaluate<{ x: number; y: number } | null>(
      // The middle of what is visible of the frame: its box clipped to the board around it.
      `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); if (!f) return null; f.scrollIntoView({ block: "center" }); const r = f.getBoundingClientRect(); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "hidden") c = c.parentElement; const b = c ? c.getBoundingClientRect() : r; const left = Math.max(r.left, b.left), right = Math.min(r.right, b.right), top = Math.max(r.top, b.top), bottom = Math.min(r.bottom, b.bottom); return { x: (left + right) / 2, y: top + Math.min((bottom - top) / 3, 120), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") + " in " + [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(",") }; })()`,
    );
    if (frame === null) throw new Error("the editor draws no artboard");
    await settle(2000);
    const path = await app.evaluate<string>(
      `(() => { let e = document.elementFromPoint(${"${frame.x}"}, ${"${frame.y}"}); const out = []; while (e && out.length < 6) { out.push(e.tagName + (e.getAttribute("data-island") ? "[" + e.getAttribute("data-island") + "]" : "") + (e.style && e.style.position ? "(" + e.style.position + ")" : "")); e = e.parentElement; } return out.join(" < "); })()`.replace("${frame.x}", String((frame as { x: number }).x)).replace("${frame.y}", String((frame as { y: number }).y)),
    );
    console.log(`editor: the frame's box ${(frame as unknown as { box: string }).box}; under the point ${path}`);
    const before = (await app.ipc<Array<{ version: number; author: string }>>("artifact:versions", { taskId: made.taskId, artifact: canvas.id })).length;
    const readyBefore = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:ready").length`);
    const under = await app.evaluate<string>(`(() => { const e = document.elementFromPoint(${String(frame.x)}, ${String(frame.y)}); return e ? e.tagName + " " + (e.getAttribute("title") ?? "") : "nothing"; })()`);
    await app.clickAt(frame.x, frame.y);
    await settle(1200);
    const picked = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`);
    const kinds = await app.evaluate<string[]>(`[...new Set(window.__dc.map((m) => m.type))]`);
    console.log(`editor: ${String(picked)} dc:pick; under the click ${under}; dc:ready before ${String(readyBefore)}; kinds ${JSON.stringify(kinds)}`);
    if (picked === 0) throw new Error("a click on the artboard picked nothing");
    await app.shot("selected");
    // Narrow (a conversation's column), the properties panel is closed: opened for its Delete, then closed.
    const panel = async (open: boolean): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('[aria-label="Properties panel"]'); if (!b || (b.getAttribute("aria-pressed") === "true") === ${String(open)}) return null; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) return;
      await app.clickAt(at.x, at.y);
      await settle(400);
    };
    await panel(true);
    await app.clickText("Delete element");
    for (let i = 0; ; i++) {
      const versions = await app.ipc<Array<{ version: number; author: string }>>("artifact:versions", { taskId: made.taskId, artifact: canvas.id });
      if (versions.length > before && versions.at(-1)!.author === "person") {
        console.log(`editor: saved v${String(versions.at(-1)!.version)}, the person's`);
        break;
      }
      if (i > 40) throw new Error(`the edit was not saved as the person's version: ${JSON.stringify(versions)}`);
      await settle(250);
    }
    await settle(1500);
    await panel(false);
    await app.shot("edited");

    /** Wait for a version the person made after `count` versions, and say what it changed. */
    const personSaved = async (count: number, what: string): Promise<Array<{ version: number; author: string; changed: Record<string, string> }>> => {
      for (let i = 0; ; i++) {
        const versions = await app.ipc<Array<{ version: number; author: string; changed: Record<string, string> }>>("artifact:versions", { taskId: made.taskId, artifact: canvas!.id });
        if (versions.length > count && versions.at(-1)!.author === "person") {
          console.log(`editor: ${what} saved as v${String(versions.at(-1)!.version)}, changing ${Object.keys(versions.at(-1)!.changed).join(", ")}`);
          return versions;
        }
        if (i > 40) throw new Error(`${what} was not saved as the person's version: ${JSON.stringify(versions.map((v) => [v.version, v.author]))}`);
        await settle(250);
      }
    };
    const count = async (): Promise<number> => (await app.ipc<unknown[]>("artifact:versions", { taskId: made.taskId, artifact: canvas!.id })).length;
    const clickLabel = async (label: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector('[aria-label="${label}"]'); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (hit !== el && !el.contains(hit)) throw new Error("${label} is covered by " + (hit ? hit.tagName + " " + hit.textContent.slice(0, 40) : "nothing") + " at " + Math.round(r.left) + "," + Math.round(r.top)); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) throw new Error(`no control labelled ${label}`);
      await app.clickAt(at.x, at.y);
    };

    /**
     * A point on the artboard as it stands now, with room for a short drag on it: every save can change
     * the editor's panels, and the board's layout with them, so a point measured earlier may be a panel.
     */
    const artboardPoint = async (): Promise<{ x: number; y: number }> => {
      // Into view first, and let the thread finish moving: one still scrolling slides the frame out from
      // under a drag, and its release lands outside it.
      await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
      await settle(900);
      const at = await app.evaluate<{ x: number; y: number } | null>(
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); for (let y = r.top + 20; y < r.bottom - 50; y += 10) for (let x = r.left + 10; x < r.right - 40; x += 10) { if (document.elementFromPoint(x, y) === f && document.elementFromPoint(x + 30, y + 40) === f) return { x, y }; } return null; })()`,
      );
      if (at === null) {
        await app.shot("no-artboard-point");
        const why = await app.evaluate<string>(
          `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "hidden") c = c.parentElement; const b = c.getBoundingClientRect(); const mx = r.left + r.width / 2, my = r.top + r.height / 2; const hit = document.elementFromPoint(mx, my); const desc = (e) => e ? e.tagName + "[" + (e.getAttribute("aria-label") || e.getAttribute("role") || "") + "] " + (e.getAttribute("style") || "").slice(0, 160) : "nothing"; return "frame " + [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " board " + [b.left, b.top, b.width, b.height].map(Math.round).join(",") + " window " + innerWidth + "x" + innerHeight + "; at the frame's middle: " + desc(hit) + " < " + desc(hit && hit.parentElement); })()`,
        );
        throw new Error(`no point of the artboard is under the pointer's reach: ${why}`);
      }
      return at;
    };

    // Moving an element: dragged inside its artboard, written as the person's version.
    let n = await count();
    // Measured again: the delete changed the editor's panels, and the board's layout with them.
    const grip = await artboardPoint();
    await app.drag(grip, { x: grip.x + 30, y: grip.y + 40 });
    await settle(500);
    const moved = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:moved").length`);
    const tally = await app.evaluate<Record<string, number>>(`window.__dc.reduce((t, m) => (t[m.type] = (t[m.type] || 0) + 1, t), {})`);
    console.log(`editor: ${String(moved)} dc:moved; messages ${JSON.stringify(tally)}`);
    if (moved === 0) throw new Error("a drag on the artboard was not reported as a move");
    await personSaved(n, "the move");
    await settle(1500);
    await app.shot("moved");

    // The drawing tools, each on the board where it is bare now: a shape is a note of its kind in
    // canvas.json, a note and a text are notes with what was typed, an artboard is a file of its own.
    /** A bare stretch of the board's layer whose cursor is `cursor`, with room for a short drag. */
    const bareBoard = async (cursor: "crosshair" | "default"): Promise<{ x: number; y: number }> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); if (!f) throw new Error("no artboard in the editor; islands " + [...document.querySelectorAll("[data-island]")].map((e) => e.getAttribute("data-island")).join(",")); f.scrollIntoView({ block: "center" }); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "hidden") c = c.parentElement; const layer = [...c.children].find((e) => e.style.cursor === ${JSON.stringify(cursor)}); const r = c.getBoundingClientRect(); for (let y = r.top + 10; y < r.bottom - 50; y += 10) for (let x = r.left + 10; x < r.right - 50; x += 10) { if (document.elementFromPoint(x, y) === layer && document.elementFromPoint(x + 48, y + 38) === layer && document.elementFromPoint(x + 24, y + 19) === layer) return { x, y }; } return null; })()`,
      );
      if (at === null) throw new Error(`no bare stretch of the board to draw on (${cursor})`);
      return at;
    };
    const boardsBefore = Object.keys((JSON.parse((await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files["project/canvas.json"] ?? "{}") as { boards?: Record<string, unknown> }).boards ?? {});
    n = await count();
    for (const label of ["Rectangle", "Oval", "Arrow", "Line", "Pen"]) {
      await clickLabel(label);
      const from = await bareBoard("crosshair");
      await app.drag(from, { x: from.x + 48, y: from.y + 38 });
      await settle(200);
    }
    await clickLabel("Note");
    const noteAt = await bareBoard("crosshair");
    await app.clickAt(noteAt.x, noteAt.y);
    await settle(400);
    await app.type("A note from the rig");
    await app.press("Escape", 27);
    await settle(200);
    await clickLabel("Text");
    const textFrom = await bareBoard("default");
    await app.drag(textFrom, { x: textFrom.x + 48, y: textFrom.y + 38 });
    await settle(400);
    await app.type("A heading from the rig");
    await app.press("Escape", 27);
    await settle(200);
    await clickLabel("Artboard");
    const boardFrom = await bareBoard("crosshair");
    await app.drag(boardFrom, { x: boardFrom.x + 48, y: boardFrom.y + 38 });
    await settle(200);
    await clickLabel("Pointer");
    // Saved a second after the last change: wait for the person's version, then for the versions to rest.
    await personSaved(n, "the drawings");
    for (let last = -1, i = 0; ; i++) {
      const now = await count();
      if (now === last) break;
      if (i > 20) throw new Error("the editor kept saving");
      last = now;
      await settle(2000);
    }
    const afterDrawing = (await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files;
    const index = JSON.parse(afterDrawing["project/canvas.json"] ?? "{}") as { boards?: Record<string, unknown>; notes?: Record<string, { kind?: string; text?: string }> };
    const notes = Object.values(index.notes ?? {});
    console.log(`editor: the drawings saved: notes ${JSON.stringify(notes.map((note) => note.kind ?? `text:${note.text ?? ""}`))}; boards ${JSON.stringify(Object.keys(index.boards ?? {}))}`);
    for (const kind of ["rect", "oval", "arrow", "line", "pen"]) {
      if (!notes.some((note) => note.kind === kind)) throw new Error(`no ${kind} note in canvas.json: ${JSON.stringify(index.notes)}`);
    }
    for (const text of ["A note from the rig", "A heading from the rig"]) {
      if (!notes.some((note) => note.text === text)) throw new Error(`no note reading "${text}" in canvas.json: ${JSON.stringify(index.notes)}`);
    }
    const newBoard = Object.keys(index.boards ?? {}).find((file) => !boardsBefore.includes(file) && afterDrawing[`project/${file}`] !== undefined);
    if (newBoard === undefined) throw new Error(`the drawn artboard is not a file of the canvas: ${JSON.stringify(Object.keys(afterDrawing))}`);
    // And it is DRAWN: framed from the grant of the version that saved it, its runtime ready — not a
    // frame of a file the opened version's grant does not hold ("no such artifact").
    const newTitle = (index.boards?.[newBoard] as { title?: string } | undefined)?.title ?? newBoard;
    for (let i = 0; ; i++) {
      const ready = await app.evaluate<boolean>(`window.__dc.some((m) => m.type === "dc:ready" && m.from === ${JSON.stringify(newTitle)})`);
      if (ready) break;
      if (i > 40) throw new Error(`the drawn artboard ${newBoard} never drew: ${await app.evaluate<string>(`JSON.stringify([...document.querySelectorAll('[data-island="canvasEditor"] iframe')].map((f) => f.title + " " + f.src))`)}`);
      await settle(250);
    }
    console.log(`editor: the drawn artboard ${newBoard} is framed and drawn`);
    await app.shot("drawings");

    // Run: the artboard marked interactive (its Properties' "Works"), then ▶ on its label runs it where it
    // sits: a click in it is the design's, so the editor picks nothing; ⤢ fills the editor with it; ■ stops.
    await clickLabel("Pointer");
    const labelAt = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const label = f.parentElement.firstElementChild; const r = label.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 30), y: r.top + r.height / 2 }; })()`,
    );
    if (labelAt === null) throw new Error("the artboard has no label");
    await app.clickAt(labelAt.x, labelAt.y);
    await settle(600);
    await panel(true);
    const works = await app.evaluate<boolean>(`(() => { const box = document.querySelector('[aria-label="Its controls respond: it runs (▶)"]'); if (!box) return null; return box.checked; })()`);
    if (works === null) throw new Error("selecting the artboard did not show its Properties");
    n = await count();
    if (!works) {
      await clickLabel("Its controls respond: it runs (▶)");
      await personSaved(n, "marking the artboard interactive");
    }
    await panel(false);
    await settle(800);
    await clickLabel("Run");
    await settle(1500);
    const runningLabel = await app.evaluate<boolean>(`[...document.querySelectorAll('[data-island="canvasEditor"] span')].some((s) => s.textContent.includes(" · running"))`);
    if (!runningLabel) throw new Error("▶ did not run the artboard");
    const picksBefore = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`);
    const inRun = await artboardPoint();
    await app.clickAt(inRun.x, inRun.y);
    await settle(800);
    const picksAfter = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`);
    console.log(`run: in place; picks before a click in it ${String(picksBefore)}, after ${String(picksAfter)}`);
    if (picksAfter !== picksBefore) throw new Error("a click in a running artboard was taken by the editor");
    await app.shot("running");
    await clickLabel("Run it on its own");
    await settle(1500);
    if (!(await app.evaluate<boolean>(`document.body.innerText.includes("Back to the canvas")`))) throw new Error("⤢ did not fill the editor with the artboard");
    await app.shot("running-full");
    await app.clickText("Back to the canvas");
    await settle(1000);
    await clickLabel("Run");
    await settle(800);
    await clickLabel("Stop");
    await settle(800);
    if (await app.evaluate<boolean>(`[...document.querySelectorAll('[data-island="canvasEditor"] span')].some((s) => s.textContent.includes(" · running"))`)) throw new Error("■ did not stop the artboard");

    // Export: the selected artboard drawn out of sight at its size and saved where the person says -
    // here, where the Save dialog (stubbed in the main process) says.
    const exports = join(OUT, "exports");
    // Emptied first: an export of the same artboard is the same name, so one left by an earlier run
    // would be overwritten, and no new file would ever show.
    rmSync(exports, { recursive: true, force: true });
    mkdirSync(exports, { recursive: true });
    await app.evaluateMain(9272, `(() => { const { dialog } = require("electron"); const path = require("path"); dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: path.join(${JSON.stringify(exports)}, path.basename(args.at(-1).defaultPath)) }); return true; })()`);
    /**
     * A point over one of the artboard's elements: hovered until the frame names one there. The first point
     * of the frame from its top-left may be the page's bare margin, which names nothing (the design differs
     * every run).
     */
    const elementPoint = async (): Promise<{ x: number; y: number }> => {
      await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
      await settle(900);
      const candidates = await app.evaluate<Array<{ x: number; y: number }>>(
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); const out = []; for (const fy of [0.3, 0.45, 0.6, 0.2, 0.75]) for (const fx of [0.5, 0.35, 0.65]) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (document.elementFromPoint(x, y) === f) out.push({ x, y }); } return out; })()`,
      );
      for (const at of candidates) {
        await app.hover(at.x, at.y);
        await settle(200);
        const named = await app.evaluate<boolean>(`(() => { const h = window.__dc.filter((m) => m.type === "dc:hover").at(-1); return !!h && h.id !== null; })()`);
        if (named) return at;
      }
      throw new Error(`no point of the artboard is over one of its elements (${String(candidates.length)} tried)`);
    };
    // Stopped, the artboard is edited again: a click on an element in it picks it (and the export follows that).
    const picksStopped = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`);
    let chosen = await elementPoint();
    await app.clickAt(chosen.x, chosen.y);
    await settle(800);
    if ((await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`)) === picksStopped) {
      // Once more, measured again, and said: a click that lands as the frame redraws is lost the first time.
      const last = await app.evaluate<string>(`JSON.stringify(window.__dc.slice(-6).map((m) => [m.type, m.from]))`);
      console.log(`stop: the first click after Stop picked nothing; the last messages ${last}`);
      chosen = await elementPoint();
      await app.clickAt(chosen.x, chosen.y);
      await settle(800);
      if ((await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`)) === picksStopped) {
        await app.shot("stopped-no-pick");
        const hoversBefore = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:hover").length`);
        await app.hover(chosen.x + 3, chosen.y + 3);
        await app.hover(chosen.x + 6, chosen.y + 6);
        await settle(400);
        const hoversAfter = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:hover").length`);
        const where = await app.evaluate<string>(
          `(() => { const fs = [...document.querySelectorAll('[data-island="canvasEditor"] iframe')]; const hit = document.elementFromPoint(${String(chosen.x)}, ${String(chosen.y)}); return JSON.stringify({ frames: fs.map((f) => ({ title: f.title, pe: f.style.pointerEvents, outline: f.style.outline, src: f.src.slice(-40) })), hit: hit ? hit.tagName + " " + (hit.title || "") : null, labels: [...document.querySelectorAll('[data-island="canvasEditor"] [aria-label="Run"], [data-island="canvasEditor"] [aria-label="Stop"]')].map((b) => b.getAttribute("aria-label")) }); })()`,
        );
        throw new Error(`a stopped artboard is not edited again: two clicks in it picked nothing; hovers ${String(hoversBefore)} -> ${String(hoversAfter)}; ${where}`);
      }
    }
    console.log("stop: the artboard is edited again (a click in it picked an element)");
    for (const format of ["png", "pdf"] as const) {
      const before = new Set(existsSync(exports) ? readdirSync(exports) : []);
      // The editor's own button, not the first thing on the page that says PNG (the agent's reply may).
      const button = await app.evaluate<{ x: number; y: number } | string>(
        `(() => { const b = [...document.querySelectorAll('[data-island="canvasEditor"] button')].find((e) => e.textContent.trim() === ${JSON.stringify(format.toUpperCase())}); if (!b) return "no ${format.toUpperCase()} button; the bar has " + [...document.querySelectorAll('[data-island="canvasEditor"] button')].slice(0, 12).map((e) => e.textContent.trim()).join("|"); b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (typeof button === "string") throw new Error(button);
      await app.clickAt(button.x, button.y);
      let file: string | undefined;
      for (let i = 0; i < 60 && file === undefined; i++) {
        await settle(250);
        file = readdirSync(exports).find((f) => f.endsWith(`.${format}`) && !before.has(f));
      }
      if (file === undefined) {
        // Why: the same call the editor made, with the frame's own address, its answer or its error.
        const src = await app.evaluate<string>(`document.querySelector('[data-island="canvasEditor"] iframe').src`);
        const answer = await app.ipc("shell:exportArtboard", { url: src, width: 390, height: 844, format, name: "diagnosis" }).then((a) => JSON.stringify(a), (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error(`no ${format.toUpperCase()} was saved; the frame is ${src}; asked directly, export answers ${answer}; the folder has ${JSON.stringify(readdirSync(exports))}`);
      }
      const bytes = readFileSync(join(exports, file));
      const signed = format === "png" ? bytes.subarray(1, 4).toString("latin1") === "PNG" : bytes.subarray(0, 4).toString("latin1") === "%PDF";
      console.log(`editor: exported ${file}, ${String(bytes.length)} bytes${format === "png" ? `, ${String(bytes.readUInt32BE(16))}x${String(bytes.readUInt32BE(20))}` : ""}`);
      if (!signed || bytes.length < 1000) throw new Error(`${file} is not a ${format.toUpperCase()} of the artboard`);
    }

    // Comments (decision 0024): the comment tool pins one on the artboard where it is pressed.
    const comment = async (text: string, toClaude: boolean): Promise<void> => {
      // Over an element: the comment tool pins where the frame names one (a press on bare margin names nothing).
      const at = await elementPoint();
      await clickLabel("Comment");
      await app.clickAt(at.x, at.y);
      await settle(800);
      if (!(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="New comment"] textarea')`))) throw new Error("the comment tool opened no comment box");
      await app.type(text);
      if (!toClaude) {
        await app.evaluate(`(() => { const box = document.querySelector('[aria-label="New comment"] input[type="checkbox"]'); box.click(); return true; })()`);
      }
      await app.evaluate(`(() => { const b = [...document.querySelectorAll('[aria-label="New comment"] button')].find((e) => e.textContent.trim() === "Comment"); b.click(); return true; })()`);
      await settle(1200);
    };
    const NOTE = "A note for people from the rig";
    const ASK = "Make the sign-in button full width (from the rig)";
    await comment(NOTE, false);
    await app.shot("comment-note");
    // A pin opened, and resolved from its card — before anything is sent, so no turn of the agent's is
    // redrawing the conversation under it.
    await clickLabel("Pointer");
    await clickLabel("Comment 1");
    await settle(600);
    await app.shot("comment-open");
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('[aria-label="Comment 1"][role="dialog"] button')].find((e) => e.textContent.trim() === "Resolve"); b.click(); return true; })()`);
    for (let i = 0; ; i++) {
      const now = await app.ipc<Array<{ text: string; resolvedAt?: number }>>("artifact:comments", { taskId: made.taskId, artifact: canvas.id });
      if (now.find((c) => c.text === NOTE)?.resolvedAt !== undefined) break;
      if (i > 20) throw new Error("Resolve did not resolve the comment");
      await settle(250);
    }
    console.log("comments: the note resolved from its pin");
    const versionNow = (await app.ipc<Array<{ version: number }>>("artifact:versions", { taskId: made.taskId, artifact: canvas.id })).at(-1)!.version;
    const turnsBefore = await app.ipc<{ session: { turns: Array<{ role: string; text?: string }> } } | null>("chat:thread", { taskId: made.taskId });
    await comment(ASK, true);
    await app.shot("comment-sent");
    const pinned = await app.ipc<Array<{ id: string; text: string; toClaude: boolean; version: number; sentAt?: number; resolvedAt?: number }>>("artifact:comments", { taskId: made.taskId, artifact: canvas.id });
    console.log(`comments: ${JSON.stringify(pinned.map((c) => ({ text: c.text, toClaude: c.toClaude, version: c.version, sent: c.sentAt !== undefined, resolved: c.resolvedAt !== undefined })))}`);
    const note = pinned.find((c) => c.text === NOTE);
    const ask = pinned.find((c) => c.text === ASK);
    if (note === undefined || note.toClaude || note.sentAt !== undefined) throw new Error("the note was not kept as a note for people");
    if (ask === undefined || !ask.toClaude || ask.sentAt === undefined) throw new Error("the comment for Claude was not sent");
    if (ask.version !== versionNow) throw new Error(`the comment names v${String(ask.version)}, not the version the editor holds (v${String(versionNow)})`);
    for (let i = 0; ; i++) {
      const thread = await app.ipc<{ session: { turns: Array<{ role: string; text?: string }> } } | null>("chat:thread", { taskId: made.taskId });
      const asked = thread?.session.turns.filter((t) => t.role === "user" && (t.text ?? "").includes(ASK)) ?? [];
      if (asked.length > 0) {
        console.log(`comments: in the conversation as the person's message: ${JSON.stringify(asked[0]!.text)}`);
        break;
      }
      if (i > 120) throw new Error(`the comment for Claude never reached the conversation (turns before ${String(turnsBefore?.session.turns.length ?? 0)})`);
      await settle(500);
    }
    const sentNote = (await app.ipc<{ session: { turns: Array<{ role: string; text?: string }> } } | null>("chat:thread", { taskId: made.taskId }))?.session.turns.some((t) => (t.text ?? "").includes(NOTE));
    if (sentNote === true) throw new Error("the note for people reached the conversation");
    console.log("canvas: passed");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
