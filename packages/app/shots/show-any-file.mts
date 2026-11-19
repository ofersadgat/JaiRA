/**
 * `show_artifact` shows the person any file (2026-11-13): three pictures in one call drawn side by side
 * under the line, a code file and a CSV sent in the call each as its own card, a PDF refused with why —
 * and `read_file` hands the agent a picture it can see.
 *
 * A real agent (claude-cli/haiku — this rig spends a little), in a world of its own with real pictures
 * (the sidebar crops from t-wdxyhs1w6w's run) copied into its project.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/show-any-file.mts
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Show any file";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "show-any-file");
const WORLD = join(import.meta.dirname, ".world-show-any-file");
const REPO = join(import.meta.dirname, "..", "..", "..");
const SET = { read_file: "allow", glob: "allow", grep: "allow", show_artifact: "allow", shell: "ask", other: "ask" };

const OPENING = [
  "Do exactly these three things, in order, then reply with one line.",
  "1. Call show_artifact once with `artifacts` set to the three pictures shots/before.png, shots/after.png and shots/menu.png, and `caption` set to \"Icons before and after, and the When menu open\".",
  "2. Call show_artifact once with `artifacts` set to [\"src/scope.ts\", \"docs/quarterly.pdf\", {\"data\": \"route,first draw ms\\nchat list,212\\ntasks tab,188\\n\", \"name\": \"timings.csv\"}].",
  "3. Call read_file on shots/before.png, look at the picture, and reply with the colour of the narrow column down its left side, in one or two words.",
].join("\n");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  // Real pictures, a code file, and a file JaiRA has no view for.
  mkdirSync(join(world.project, "shots"), { recursive: true });
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "before-1-crop.png"), join(world.project, "shots", "before.png"));
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "after-1-crop.png"), join(world.project, "shots", "after.png"));
  copyFileSync(join(import.meta.dirname, "out", "sidebar-scope", "1b-when-menu.png"), join(world.project, "shots", "menu.png"));
  mkdirSync(join(world.project, "src"), { recursive: true });
  writeFileSync(join(world.project, "src", "scope.ts"), 'export function scopeOf(at: { workspace?: string }): string {\n  return at.workspace ?? "project";\n}\n', "utf8");
  mkdirSync(join(world.project, "docs"), { recursive: true });
  writeFileSync(join(world.project, "docs", "quarterly.pdf"), Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\n", "latin1"));

  const app = await App.launch(world, { out: OUT, port: 9274 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`show-any-file: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 1000);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: OPENING } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until("document.body.innerText.includes('timings.csv')", "the second show", 600);
    // The answer to step 3 ends the turn: wait for the thread to stop changing.
    let last = "";
    for (let i = 0; i < 60; i++) {
      await settle(2000);
      const now = await app.evaluate<string>("document.body.innerText");
      if (now === last) break;
      last = now;
    }

    const facts = await app.evaluate<{ pictures: Array<{ w: number; h: number; shownW: number; top: number }>; text: string }>(`(() => ({
      pictures: [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('data:image/')).map((i) => { const r = i.getBoundingClientRect(); return { w: i.naturalWidth, h: i.naturalHeight, shownW: Math.round(r.width), top: Math.round(r.top) }; }),
      text: document.body.innerText,
    }))()`);
    console.log(`show-any-file: pictures ${JSON.stringify(facts.pictures)}`);
    const gallery = facts.pictures.filter((p) => p.w > 0);
    check(gallery.length >= 3 && gallery.slice(0, 3).every((p) => p.shownW > 100), "the three pictures are drawn, decoded, at a width that shows them");
    check(facts.text.includes("before.png, after.png, menu.png"), "the call's line names what it shows");
    check(gallery.length >= 3 && new Set(gallery.slice(0, 3).map((p) => p.top)).size === 1, "the three pictures sit side by side in one row");
    check(facts.text.includes("Icons before and after, and the When menu open"), "the call's caption is over them");
    check(/scope\.ts[\s\S]{0,40}code · v1/.test(facts.text), "the code file is its own card, called code");
    check(/timings\.csv[\s\S]{0,40}table · v1/.test(facts.text), "the CSV sent in the call is its own card, called a table");
    check(/no view for quarterly\.pdf/.test(facts.text), "the PDF is refused with why");

    // The pictures, in view.
    await app.evaluate(`(() => { const i = [...document.querySelectorAll('img')].find((x) => x.src.startsWith('data:image/')); if (i) i.scrollIntoView({ block: 'center' }); })()`);
    await settle(800);
    await app.shot("1-gallery", undefined, false);
    await app.evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent ?? '').trim() === 'timings.csv'); if (el) el.scrollIntoView({ block: 'center' }); })()`);
    await settle(800);
    await app.shot("2-files", undefined, false);
    await app.evaluate(`(() => { const s = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY !== 'visible'); for (const e of s) e.scrollTop = e.scrollHeight; })()`);
    await settle(800);
    await app.shot("3-end", undefined, false);

    // What the agent was handed for the picture it read, out of the record.
    const thread = await app.ipc<{ session: { turns: Array<{ parts?: unknown }> } }>("chat:thread", { taskId: made.taskId });
    const raw = JSON.stringify(thread);
    const tooLong = raw.includes("exceeds maximum allowed tokens");
    check(!tooLong, "read_file on the picture was not refused as too long");
    const answer = facts.text.split("\n").filter((l) => l.trim().length > 0).slice(-12).join(" | ");
    console.log(`show-any-file: the thread's end: ${answer.slice(0, 600)}`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`show-any-file: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("show-any-file: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
