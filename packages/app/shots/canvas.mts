/**
 * A design canvas, end to end (decision 0020): a real agent runs `/design`, publishes a canvas through
 * `show_artifact` from the Design type's own instructions, the conversation draws it as a board whose
 * artboards RUN under JaiRA's `.dc.html` runtime, and the editor's change is kept as a version marked the
 * person's.
 *
 * A real agent (claude-cli/sonnet by default — this rig spends a little). Passes when:
 *   - the task has a canvas with `project/canvas.json` and at least one `.dc.html` artboard;
 *   - every artboard frame on the board posts `dc:ready` with a size (the runtime drew it);
 *   - in the editor, a click on an artboard selects one of its elements, Delete removes it, and the
 *     canvas gains a version whose author is the person.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/canvas.mts [--model claude-cli/haiku] [--pages http://127.0.0.1:8081/] [--reuse]
 *
 * `--reuse` opens the canvas the last run made instead of asking the agent for a new one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  const app = await App.launch(world, { out: OUT, port: 9271 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 980);
    // Every message the window is posted, from the artboard frames among others.
    await app.evaluate(`(() => { window.__dc = []; window.addEventListener("message", (e) => { if (e.data && typeof e.data.type === "string" && e.data.type.startsWith("dc:")) window.__dc.push(e.data); }); })()`);
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
    for (let i = 0; i < 6; i++) {
      const toggle = await app.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = [...document.querySelectorAll('[aria-label="Show steps"]')][0]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (toggle === null) break;
      await app.clickAt(toggle.x, toggle.y);
      await settle(1200);
    }
    const board = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll('[data-island="canvas"]')]; const el = all[all.length - 1]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (board === null) {
      await app.shot("no-board");
      const islands = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-island]')].map((e) => e.getAttribute('data-island'))`);
      const text = await app.evaluate<string>(`document.body.innerText.slice(-3000)`);
      throw new Error(`the conversation draws no canvas board; islands ${JSON.stringify(islands)}; the page ends ${JSON.stringify(text)}`);
    }
    await settle(4000);
    await app.shot("board");
    const ready = await app.evaluate<number>(`window.__dc.filter((m) => m.type === "dc:ready" && m.size && m.size.width > 0).length`);
    const errors = await app.evaluate<string[]>(`window.__dc.filter((m) => m.type === "dc:error").map((m) => m.message)`);
    console.log(`board: ${String(ready)} dc:ready, errors ${JSON.stringify(errors)}`);
    if (ready === 0) throw new Error(`no artboard reported it rendered; errors: ${JSON.stringify(errors)}`);

    // The editor: an element selected in an artboard, deleted, kept as the person's version.
    await app.clickText("Edit");
    await settle(4000);
    await app.shot("editor");
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
    await app.shot("edited");
    console.log("canvas: passed");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
