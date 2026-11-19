/**
 * The split's divider dragged back over an artifact's page (reported 2026-11-14: "expand the split far to
 * the left it becomes impossible to readjust the split back to the right. I drag the bar to the right but
 * it doesnt move"). The page is a frame — a document of its own — and the moves over it went to it, so a
 * drag that crossed into it stopped dead.
 *
 * A real agent (claude-cli/haiku by default) publishes one page; it is opened in a split, the divider
 * dragged far left (over the conversation), then right again (over the page's frame).
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-drag.mts [--model claude-cli/haiku]
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Split drag check";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "split-drag");
const WORLD = join(import.meta.dirname, ".world-split-drag");
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));
const PANE = (i: number): string => `[data-pane="${String(i)}"]`;
const PANEL = '[role="complementary"]';
const DIVIDER = '[role="separator"][aria-label="Resize the split"]';

const PAGE = `<!doctype html><title>Drag test</title><style>html,body{margin:0;height:100%;background:#cde}</style><h1>Drag test</h1>`;
const ASK = [`Call show_artifact with content ${JSON.stringify(PAGE)} and file_path "drag-test.html".`, `Then say "done" and nothing else.`].join("\n");

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9284 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const box = (selector: string): Promise<Box | null> =>
    app.evaluate<Box | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const press = async (selector: string): Promise<void> => {
    const at = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = all.at(-1); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (at === null) throw new Error(`nothing matches ${selector}`);
    await app.clickAt(at.x, at.y);
    await settle(1500);
  };
  /** The divider dragged by `dx`, in small steps, at height `y`. */
  const drag = async (dx: number, y: number): Promise<void> => {
    const d = await box(DIVIDER);
    if (d === null) throw new Error("no divider");
    const from = { x: d.left + d.width / 2, y };
    await app.mouse("mouseMoved", from, false);
    await app.mouse("mousePressed", from);
    for (let i = 1; i <= 20; i++) {
      await app.mouse("mouseMoved", { x: from.x + (dx * i) / 20, y });
      await settle(30);
    }
    await app.mouse("mouseReleased", { x: from.x + dx, y });
    await settle(800);
  };

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1700, 980);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: ASK } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: FULL } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    for (let i = 0; ; i++) {
      const list = await app.ipc<Array<{ kind: string }>>("artifact:published", { taskId: made.taskId });
      if (list.some((a) => a.kind === "page")) break;
      if (i > 480) throw new Error("no page published in four minutes");
      await settle(500);
    }
    await app.clickText(TITLE);
    await settle(3000);
    if ((await count('[aria-label="Unfold the panel"]')) > 0) await press('[aria-label="Unfold the panel"]');
    const where = (await count(`${PANEL} [aria-label="Open in a split"]`)) > 0 ? PANEL : PANE(0);
    await press(`${where} [aria-label="Open in a split"]`);
    await settle(2500);
    await app.shot("split", undefined, false);
    check((await count(`${PANE(1)} iframe`)) > 0, "the split draws the page in a frame");
    const frame = await box(`${PANE(1)} iframe`);
    const y = frame !== null ? frame.top + frame.height / 2 : 500;

    const start = (await box(PANE(1)))?.width ?? 0;
    await drag(-600, y);
    const wide = (await box(PANE(1)))?.width ?? 0;
    await app.shot("far-left", undefined, false);
    // As far as it goes: the first pane keeps its 360.
    check(wide > start + 100 && ((await box(PANE(0)))?.width ?? 0) <= 362, `dragged left, the split widened as far as it goes (${String(Math.round(start))} → ${String(Math.round(wide))})`);

    // Back right: the pointer is over the page's frame from the first step.
    await drag(500, y);
    const back = (await box(PANE(1)))?.width ?? 0;
    await app.shot("back-right", undefined, false);
    check(back < wide - 200,`dragged right over the page, the split narrowed (${String(Math.round(wide))} → ${String(Math.round(back))})`);
    check((await count("iframe")) > 0 && (await app.evaluate<string>(`getComputedStyle(document.querySelector('${PANE(1)} iframe')).pointerEvents`)) !== "none", "after the drag, the page takes the pointer again");
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "\nall checks passed" : `\n${String(failures.length)} failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

void main();
