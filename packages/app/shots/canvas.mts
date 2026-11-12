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
 *   - the chrome is Claude Code's: tools on a floating bar (shapes and lines behind ⌄), the panel opened
 *     from the top-right bar; an artboard marked interactive runs in place under ▶ on its label (a click
 *     in it picks nothing), ⤢ fills the editor with it, ■ stops it; ⬇ saves PNG and PDF;
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
      `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); if (!f) return null; f.scrollIntoView({ block: "center" }); const r = f.getBoundingClientRect(); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "clip") c = c.parentElement; const b = c ? c.getBoundingClientRect() : r; const left = Math.max(r.left, b.left), right = Math.min(r.right, b.right), top = Math.max(r.top, b.top), bottom = Math.min(r.bottom, b.bottom); return { x: (left + right) / 2, y: top + Math.min((bottom - top) / 3, 120), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") + " in " + [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(",") }; })()`,
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
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('[aria-label="Properties panel"]'); if (!b || (b.getAttribute("aria-pressed") === "true") === ${String(open)}) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) return;
      await settle(300);
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
     * A tool by its name: its button on the top-left bar, or — one of a group (pen, line, arrow; rectangle,
     * oval) that is not the group's button now — from behind the group's ⌄.
     */
    const pickTool = async (label: string): Promise<void> => {
      const onBar = await app.evaluate<boolean>(`!!document.querySelector('[role="toolbar"][aria-label="Tools"] [aria-label="${label}"]')`);
      if (onBar) {
        await clickLabel(label);
        return;
      }
      const group = ["Pen", "Line", "Arrow"].includes(label) ? "More pen and line tools" : "More shape tools";
      await clickLabel(group);
      await settle(300);
      const item = await app.evaluate<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('[role="menuitem"][aria-label="${label}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (item === null) throw new Error(`no ${label} behind ${group}`);
      await app.clickAt(item.x, item.y);
      await settle(200);
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
          `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "clip") c = c.parentElement; const b = c.getBoundingClientRect(); const mx = r.left + r.width / 2, my = r.top + r.height / 2; const hit = document.elementFromPoint(mx, my); const desc = (e) => e ? e.tagName + "[" + (e.getAttribute("aria-label") || e.getAttribute("role") || "") + "] " + (e.getAttribute("style") || "").slice(0, 160) : "nothing"; return "frame " + [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " board " + [b.left, b.top, b.width, b.height].map(Math.round).join(",") + " window " + innerWidth + "x" + innerHeight + "; at the frame's middle: " + desc(hit) + " < " + desc(hit && hit.parentElement); })()`,
        );
        throw new Error(`no point of the artboard is under the pointer's reach: ${why}`);
      }
      return at;
    };

    /** A point of the artboard over one of its elements (the design's bare margin picks nothing, and drags nothing). */
    const elementPoint = async (): Promise<{ x: number; y: number }> => {
      await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
      await settle(900);
      const candidates = await app.evaluate<Array<{ x: number; y: number }>>(
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); const out = []; for (const fy of [0.3, 0.45, 0.6, 0.2, 0.75]) for (const fx of [0.5, 0.35, 0.65]) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (document.elementFromPoint(x, y) === f) out.push({ x, y }); } return out; })()`,
      );
      for (const at of candidates) {
        await app.hover(at.x, at.y);
        await settle(200);
        const named = await app.evaluate<boolean>(`(() => { const h = window.__dc.filter((m) => m.type === "dc:hover").at(-1); return !!h && h.id !== null && !h.top; })()`);
        if (named) return at;
      }
      throw new Error(`no point of the artboard is over one of its elements (${String(candidates.length)} tried)`);
    };

    // Moving an element: dragged inside its artboard, written as the person's version.
    let n = await count();
    // Measured again: the delete changed the editor's panels, and the board's layout with them.
    const grip = await elementPoint();
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
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); if (!f) throw new Error("no artboard in the editor; islands " + [...document.querySelectorAll("[data-island]")].map((e) => e.getAttribute("data-island")).join(",")); f.scrollIntoView({ block: "center" }); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "clip") c = c.parentElement; const layer = [...c.children].find((e) => e.style.cursor === ${JSON.stringify(cursor)}); const r = c.getBoundingClientRect(); for (let y = r.top + 10; y < r.bottom - 50; y += 10) for (let x = r.left + 10; x < r.right - 50; x += 10) { if (document.elementFromPoint(x, y) === layer && document.elementFromPoint(x + 48, y + 38) === layer && document.elementFromPoint(x + 24, y + 19) === layer) return { x, y }; } return null; })()`,
      );
      if (at === null) throw new Error(`no bare stretch of the board to draw on (${cursor})`);
      return at;
    };
    const boardsBefore = Object.keys((JSON.parse((await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files["project/canvas.json"] ?? "{}") as { boards?: Record<string, unknown> }).boards ?? {});
    n = await count();
    for (const label of ["Rectangle", "Oval", "Arrow", "Line", "Pen"]) {
      await pickTool(label);
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
    const beforeLabel = await count();
    await app.clickAt(labelAt.x, labelAt.y);
    await settle(1800);
    // A press on an artboard's name that moved nothing is no edit (2026-11-07: it saved canvas.json as it was).
    if ((await count()) !== beforeLabel) throw new Error("a press on an artboard's label, with no move, saved a version");
    console.log("label: a press with no move saved nothing");

    // Keys (the person, 2026-11-08: "the canvas should have common keyboard shortcuts like ctrl+z for
    // undo"), the artboard selected by its label: Ctrl+D copies it, Shift+→ nudges the copy, Ctrl+Z takes
    // both back, Ctrl+Y and Ctrl+Z again; each is saved as the person's version.
    const filesNow = async (): Promise<Record<string, string>> => (await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: canvas.id })).files;
    const boardsIn = (f: Record<string, string>): Record<string, { x: number }> => (JSON.parse(f["project/canvas.json"] ?? "{}") as { boards?: Record<string, { x: number }> }).boards ?? {};
    const keyed = async (what: string, key: string, code: number, held: { ctrl?: boolean; shift?: boolean } = {}): Promise<Record<string, string>> => {
      const c = await count();
      await app.press(key, code, held);
      await personSaved(c, what);
      // The editor saves a second after the last change: let it, so the next key is its own version.
      await settle(600);
      return filesNow();
    };
    const k0 = await filesNow();
    const k1 = await keyed("Ctrl+D", "d", 68, { ctrl: true });
    const copy = Object.keys(boardsIn(k1)).filter((f) => boardsIn(k0)[f] === undefined);
    if (copy.length !== 1 || k1[`project/${copy[0]!}`] === undefined) throw new Error(`Ctrl+D did not copy the selected artboard into a file of its own: ${JSON.stringify(Object.keys(boardsIn(k1)))}`);
    const copyFile = copy[0]!;
    const k2 = await keyed("Shift+→", "ArrowRight", 39, { shift: true });
    if (boardsIn(k2)[copyFile]!.x !== boardsIn(k1)[copyFile]!.x + 10) throw new Error(`Shift+→ moved the copy from ${String(boardsIn(k1)[copyFile]!.x)} to ${String(boardsIn(k2)[copyFile]!.x)}, not 10 px`);
    const k3 = await keyed("Ctrl+Z (the nudge)", "z", 90, { ctrl: true });
    if (boardsIn(k3)[copyFile]!.x !== boardsIn(k1)[copyFile]!.x) throw new Error("Ctrl+Z did not take the nudge back");
    const k4 = await keyed("Ctrl+Z (the copy)", "z", 90, { ctrl: true });
    if (boardsIn(k4)[copyFile] !== undefined || k4[`project/${copyFile}`] !== undefined) throw new Error("Ctrl+Z did not take the copy back, with its file");
    const k5 = await keyed("Ctrl+Y", "y", 89, { ctrl: true });
    if (boardsIn(k5)[copyFile] === undefined) throw new Error("Ctrl+Y did not bring the copy back");
    const k6 = await keyed("Ctrl+Z (the copy, again)", "z", 90, { ctrl: true });
    if (JSON.stringify(boardsIn(k6)) !== JSON.stringify(boardsIn(k0)) || Object.keys(k6).sort().join() !== Object.keys(k0).sort().join()) throw new Error("after the undos the canvas is not what it was");
    console.log(`keys: Ctrl+D copied the artboard (${copyFile}), Shift+→ moved it 10, Ctrl+Z took both back, Ctrl+Y redid, Ctrl+Z undid again`);
    // Zoom keys: Ctrl+0 is 100%, Shift+1 fits again.
    const zoomWords = (): Promise<string> => app.evaluate<string>(`document.querySelector('[data-island="canvasEditor"] [aria-label="Zoom"]').textContent.trim()`);
    await app.press("0", 48, { ctrl: true });
    const atHundred = await zoomWords();
    await app.press("!", 49, { shift: true });
    const fitted = await zoomWords();
    console.log(`keys: Ctrl+0 → ${atHundred}, Shift+1 → ${fitted}`);
    if (!atHundred.startsWith("100%")) throw new Error(`Ctrl+0 zoomed to ${atHundred}`);
    if (fitted.startsWith("100%")) throw new Error("Shift+1 did not fit the canvas");
    // From inside an artboard: a press picks an element (the frame may take the focus, and tells the editor
    // its keys), and Ctrl+Z, Ctrl+Shift+Z still reach the editor.
    await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
    await settle(900);
    const inside = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-island="canvasEditor"] iframe').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 3, 120) }; })()`);
    const picks = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`);
    await app.clickAt(inside.x, inside.y);
    await settle(800);
    if ((await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:pick").length`)) === picks) throw new Error("a press in the artboard picked nothing (for the keys from inside it)");
    const k7 = await filesNow();
    // The artboard holding the focus, as it does when a press in it takes it: the keys are the frame's
    // document's, and reach the editor only as the runtime tells them (`dc:key`).
    await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').contentWindow.focus(); return true; })()`);
    await settle(300);
    const framed = await app.evaluate<boolean>(`document.activeElement === document.querySelector('[data-island="canvasEditor"] iframe')`);
    await keyed("Ctrl+Z from inside an artboard", "z", 90, { ctrl: true });
    const k8 = await keyed("Ctrl+Shift+Z from inside an artboard", "Z", 90, { ctrl: true, shift: true });
    const viaFrame = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:key").length`);
    const same = (a: Record<string, string>, b: Record<string, string>): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (!same(k8, k7)) throw new Error("Ctrl+Z then Ctrl+Shift+Z from inside an artboard did not come back to where it was");
    console.log(`keys: from inside an artboard (the frame focused: ${String(framed)}), Ctrl+Z and Ctrl+Shift+Z undid and redid (${String(viaFrame)} keys told by the frame)`);
    if (framed && viaFrame === 0) throw new Error("the focused artboard told the editor none of its keys");
    // Pressed outside the editor, the keys are the page's: Ctrl+Z saves nothing.
    // A press on the page itself, outside every editor. Sent to <body> rather than at a point: a real
    // click somewhere outside landed on a sidebar row once and took the conversation away.
    {
      const c = await count();
      await app.evaluate(`(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })); window.focus(); return true; })()`);
      await settle(300);
      await app.press("z", 90, { ctrl: true });
      await settle(2500);
      if ((await count()) !== c) throw new Error("Ctrl+Z pressed after a press outside the editor undid in it");
      console.log("keys: after a press outside the editor, Ctrl+Z is not the editor's");
    }
    // A selection rectangle (the person, 2026-11-08: "when the arrow icon is selected ... it should start a
    // select area (like you would see in file explorer) that selects elements in the area on release", and
    // "when the initial click doesnt land on an element"). First from the empty board beside the artboard,
    // over most of it: what it holds whole is selected; Delete takes them all; Ctrl+Z brings them back.
    await clickLabel("Pointer");
    await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
    await settle(900);
    const selectedCount = (): Promise<number> => app.evaluate<number>(`document.querySelectorAll('[data-island="canvasEditor"] [data-selected-element]').length`);
    const groundStart = await app.evaluate<{ x: number; y: number; to: { x: number; y: number } } | null>(
      `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); const ground = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && e.hasAttribute("data-canvas-ground"); }; const to = { x: r.left + r.width * 0.92, y: r.top + r.height * 0.7 }; for (let d = 4; d <= 40; d += 4) for (const y of [r.top + 8, r.top + 30, r.top + 60]) if (ground(r.left - d, y)) return { x: r.left - d, y, to }; return null; })()`,
    );
    if (groundStart === null) throw new Error("no empty board beside the artboard to start a selection rectangle from");
    const movesBefore = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:moved").length`);
    const filesBeforeArea = await filesNow();
    await app.evaluate(`(() => { window.__errs = []; window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason && e.reason.stack || e.reason))); return true; })()`);
    // Pressed, moved and looked at while held: the rectangle is drawn as the pointer goes.
    await app.mouse("mouseMoved", groundStart, false);
    await app.mouse("mousePressed", groundStart);
    for (let i = 1; i <= 8; i++) {
      await app.mouse("mouseMoved", { x: groundStart.x + ((groundStart.to.x - groundStart.x) * i) / 8, y: groundStart.y + ((groundStart.to.y - groundStart.y) * i) / 8 });
      await settle(40);
    }
    await settle(200);
    const drawnArea = await app.evaluate<{ width: number; height: number } | null>(`(() => { const a = document.querySelector('[data-island="canvasEditor"] [aria-label="Selection area"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    await app.mouse("mouseReleased", groundStart.to);
    await settle(1200);
    console.log(`area: drawn while held ${JSON.stringify(drawnArea)}`);
    if (drawnArea === null || drawnArea.width < 100 || drawnArea.height < 150) {
      await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').contentWindow.postMessage({ type: "dc:measure", req: "rig" }, "*"); return true; })()`);
      await settle(500);
      const probe = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:elements" && m.req === "rig").length`);
      throw new Error(`a drag from the empty board drew no selection rectangle as it went (${JSON.stringify(drawnArea)}); the artboard answers a measure asked directly: ${String(probe)}`);
    }
    const fromBoard = await selectedCount();
    const panelWords = await app.evaluate<string>(`(() => { const p = document.querySelector('[data-island="canvasEditor"] [aria-label="Properties"]'); return p ? p.innerText.slice(0, 200) : ""; })()`);
    console.log(`area: from the board over the artboard, ${String(fromBoard)} elements selected; the panel reads ${JSON.stringify(panelWords.split("\n")[0] ?? "")}`);
    await app.shot("area-from-board");
    if (fromBoard === 0) {
      const answers = await app.evaluate<string>(
        `JSON.stringify(window.__dc.filter((m) => m.type === "dc:elements").map((m) => ({ from: m.from, n: m.elements.length, some: m.elements.slice(0, 12).map((e) => [e.id, e.parent, e.tag, Math.round(e.view.x), Math.round(e.view.y), Math.round(e.view.width), Math.round(e.view.height)]) })))`,
      );
      const frameBox = await app.evaluate<string>(`(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); return f.title + " " + [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " offset " + f.offsetWidth + "x" + f.offsetHeight; })()`);
      throw new Error(`a selection rectangle from the board over most of an artboard selected none of its elements: from ${JSON.stringify(groundStart)}; frame ${frameBox}; answers ${answers}; page errors ${await app.evaluate<string>(`JSON.stringify(window.__errs)`)}`);
    }
    if ((await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:moved").length`)) !== movesBefore) throw new Error("the selection rectangle moved an element");
    const areaDeleted = await keyed(`Delete (${String(fromBoard)} selected)`, "Delete", 46);
    const changedFiles = Object.keys(areaDeleted).filter((path) => areaDeleted[path] !== filesBeforeArea[path] && path.endsWith(".dc.html"));
    if (changedFiles.length === 0 || changedFiles.some((path) => (areaDeleted[path] ?? "").length >= (filesBeforeArea[path] ?? "").length)) throw new Error(`Delete did not take the selected elements out: changed ${JSON.stringify(changedFiles)}`);
    const areaBack = await keyed("Ctrl+Z (the area's delete)", "z", 90, { ctrl: true });
    if (!same(areaBack, filesBeforeArea)) throw new Error("Ctrl+Z did not bring back what the rectangle's Delete took");
    console.log(`area: Delete took the ${String(fromBoard)} out of ${changedFiles.join(", ")}; Ctrl+Z brought them back`);
    // Then from the artboard's own background (its corner): the frame tells the editor where the pointer
    // is, no element moves, and the rectangle selects.
    await app.press("Escape", 27);
    await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
    await settle(900);
    const corner = await app.evaluate<{ x: number; y: number; to: { x: number; y: number } }>(
      `(() => { const r = document.querySelector('[data-island="canvasEditor"] iframe').getBoundingClientRect(); return { x: r.left + 3, y: r.top + 3, to: { x: r.left + r.width * 0.95, y: r.top + r.height * 0.75 } }; })()`,
    );
    const marqueesBefore = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:marquee").length`);
    const movesBeforeFrame = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:moved").length`);
    await app.drag(corner, corner.to);
    await settle(1200);
    const told = await app.evaluate<string[]>(`window.__dc.filter((m) => m.type === "dc:marquee").slice(${String(marqueesBefore)}).map((m) => m.phase)`);
    const fromFrame = await selectedCount();
    console.log(`area: from the artboard's corner, the frame told ${JSON.stringify([...new Set(told)])}; ${String(fromFrame)} elements selected`);
    await app.shot("area-from-artboard");
    if (!told.includes("start") || !told.includes("end")) throw new Error(`a drag from the artboard's background did not start a selection rectangle (the frame told ${JSON.stringify(told)})`);
    if ((await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:moved").length`)) !== movesBeforeFrame) throw new Error("a drag from the artboard's background moved an element");
    if (fromFrame === 0) throw new Error("a selection rectangle from the artboard's background selected nothing");
    await app.press("Escape", 27);

    // The artboard selected again, for Properties.
    await app.evaluate(`(() => { document.querySelector('[data-island="canvasEditor"] iframe').scrollIntoView({ block: "center" }); return true; })()`);
    await settle(900);
    const labelAgain = await app.evaluate<{ x: number; y: number }>(
      `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const label = f.parentElement.firstElementChild; const r = label.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 30), y: r.top + r.height / 2 }; })()`,
    );
    await app.clickAt(labelAgain.x, labelAgain.y);
    await settle(800);

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
    await clickLabel("Open it on its own");
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
      // The artboard's ⬇ on its label, then the format from its menu (a float in <body>).
      await clickLabel("Download");
      await settle(300);
      const button = await app.evaluate<{ x: number; y: number } | string>(
        `(() => { const b = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(format.toUpperCase())})); if (!b) return "no ${format.toUpperCase()} in the download menu; menu items " + [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()).join("|"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
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

    // The middle button pans the board, from a press over an artboard too (its frame tells the editor).
    await clickLabel("Pointer");
    const grab = await elementPoint();
    const frameAt = async (): Promise<{ x: number; y: number }> =>
      app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-island="canvasEditor"] iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const versionsBeforePan = await count();
    const framedBefore = await frameAt();
    await app.drag(grab, { x: grab.x + 40, y: grab.y + 30 }, 8, "middle");
    await settle(500);
    const framedAfter = await frameAt();
    const pannedBy = { x: Math.round(framedAfter.x - framedBefore.x), y: Math.round(framedAfter.y - framedBefore.y) };
    console.log(`pan: a middle-button drag from over the artboard moved it by ${JSON.stringify(pannedBy)}`);
    if (Math.abs(pannedBy.x - 40) > 6 || Math.abs(pannedBy.y - 30) > 6) throw new Error(`a middle-button drag over the artboard did not pan the board by (40, 30): ${JSON.stringify(pannedBy)}`);
    await settle(1500);
    if ((await count()) !== versionsBeforePan) throw new Error("a middle-button pan saved a version (it moved an element)");

    // The wheel over an artboard is the canvas's, as over the empty board (the person, 2026-11-11: Ctrl+wheel
    // "works over empty space in the canvas, but over an item, it wont zoom"): its frame tells the editor.
    const frameBox = async (): Promise<{ x: number; y: number; w: number }> =>
      app.evaluate<{ x: number; y: number; w: number }>(
        `(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`,
      );
    const over = await elementPoint();
    const beforeZoom = await frameBox();
    for (let i = 0; i < 3; i++) {
      await app.wheel(over, -100, true);
      await settle(300);
      const b = await frameBox();
      console.log(`wheel: notch ${String(i + 1)}: the pointer at ${((over.x - b.x) / b.w).toFixed(3)} of the artboard's width (pointer x ${String(over.x)}, frame left ${b.x.toFixed(1)}, width ${b.w.toFixed(1)})`);
    }
    // The board box is never scrolled: a scrolled one put every place read off the pointer that far off.
    const scrolled = await app.evaluate<number>(`(() => { const f = document.querySelector('[data-island="canvasEditor"] iframe'); let c = f.parentElement; while (c && getComputedStyle(c).overflow !== "clip") c = c.parentElement; return c ? c.scrollLeft + c.scrollTop : -1; })()`);
    if (scrolled !== 0) throw new Error(`the board box is scrolled (${String(scrolled)}), or not found`);
    const afterZoom = await frameBox();
    const grew = afterZoom.w / beforeZoom.w;
    // The point under the pointer stays under it: where it sat in the frame, as a share of its width.
    const shareBefore = (over.x - beforeZoom.x) / beforeZoom.w;
    const shareAfter = (over.x - afterZoom.x) / afterZoom.w;
    console.log(`wheel: Ctrl+wheel over the artboard grew it ${grew.toFixed(3)}x; the pointer at ${shareBefore.toFixed(3)} of its width, then ${shareAfter.toFixed(3)}`);
    if (grew < 1.3) throw new Error(`Ctrl+wheel over the artboard did not zoom the canvas in (${grew.toFixed(3)}x)`);
    if (Math.abs(shareAfter - shareBefore) > 0.01) throw new Error("Ctrl+wheel over the artboard did not zoom about the pointer");
    for (let i = 0; i < 3; i++) await app.wheel(over, 100, true);
    await settle(400);
    const backZoom = await frameBox();
    console.log(`wheel: back out to ${(backZoom.w / beforeZoom.w).toFixed(3)}x`);
    if (Math.abs(backZoom.w / beforeZoom.w - 1) > 0.02) throw new Error("Ctrl+wheel out over the artboard did not zoom back");
    // A plain wheel over an artboard being edited pans the canvas (running, the design's scroll comes first).
    const wheelsTold = async (): Promise<number> => app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:wheel").length`);
    const toldBefore = await wheelsTold();
    const beforeWheel = await frameBox();
    await app.wheel(over, 60);
    await settle(400);
    const afterWheel = await frameBox();
    const wheeled = { panned: Math.round(beforeWheel.y - afterWheel.y) };
    const wheelTold = (await wheelsTold()) - toldBefore;
    console.log(`wheel: a plain wheel over the artboard panned the canvas ${String(wheeled.panned)} px (the frame told ${String(wheelTold)})`);
    if (Math.abs(wheeled.panned - 60) > 6) throw new Error(`a plain wheel over the artboard did not pan the canvas by 60: ${String(wheeled.panned)} (the frame told ${String(wheelTold)})`);
    if ((await count()) !== versionsBeforePan) throw new Error("a wheel over the artboard saved a version");

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
    // The eye shows the canvas whole, in the main view: the editor at full width, as Claude Code's canvas.
    await clickLabel("Show this artifact in the main view");
    await settle(2500);
    const inMain = await app.evaluate<number>(`document.querySelectorAll('[data-island="canvasEditor"]').length`);
    console.log(`main view: ${String(inMain)} editors drawn`);
    await app.shot("main-view");
    console.log("canvas: passed");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
