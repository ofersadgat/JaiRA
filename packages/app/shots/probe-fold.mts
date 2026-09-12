/**
 * A probe, not a scene: measure what folding a section does to the conversation's scroller, and
 * what the Instances index marks as the reader scrolls.
 *
 *   npx tsx shots/probe-fold.mts
 *
 * Throwaway by design — it prints numbers rather than taking pictures, so a change to the scroller
 * can be checked against a real layout instead of reasoned about.
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out");
const WORLD = join(import.meta.dirname, ".world-probe");

const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  blocks: number;
  shut: number;
  sbHeight: number;
  lastBottom: number;
  viewBottom: number;
  here: string | null;
}

const GEOMETRY = `(() => {
  const el = document.querySelector(".run-convo");
  if (!el) return null;
  const blocks = [...el.querySelectorAll("[data-instance], [data-entered]")];
  const last = blocks.at(-1);
  const sb = el.querySelector(".sb");
  const here = document.querySelector(".rail-mark.here .rail-mark-name");
  return {
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: Math.round(el.scrollTop),
    blocks: blocks.length, shut: el.querySelectorAll(".st-block.is-shut, .sb-gutter.solo:not(:has(.open))").length,
    sbHeight: sb ? Math.round(sb.getBoundingClientRect().height) : -1,
    lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : -1,
    viewBottom: Math.round(el.getBoundingClientRect().bottom),
    here: here ? here.textContent : null,
  };
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9231 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    const made = await app.ipc<{ taskId: string }>("task:create", {
      title: "probe the fold",
      workflow: "feature/plan",
      inputs: { issue: "# probe\n\nA run to fold." },
    });
    await app.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
    await app.until(says("done"), "the task to finish");
    await app.clickText("probe the fold");
    // The middle column as the conversation, the panel as Details — the arrangement the index
    // marks in. The toggle is in the top bar of the middle column.
    // Drill into the run (a double-click on the card), which puts the mode toggle in the top bar;
    // then read the middle column as the conversation and the panel as Details, where the index is.
    await app.evaluate(`(() => {
      const card = [...document.querySelectorAll("[class*='card']")].find((e) => (e.textContent ?? "").includes("probe the fold"));
      if (!card) return false;
      card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return true;
    })()`);
    await app.until(says("Conversation"), "the mode toggle to appear");
    await app.clickText("Conversation");
    await app.clickText("Details");
    console.log("mode buttons", await app.evaluate<string[]>("[...document.querySelectorAll('.run-mode button')].map(b => b.textContent + ':' + b.className)"));
    console.log("columns", await app.evaluate<string>("['.composite', '.run-convo', '.task-context', '.rail-mark'].map(s => s + '=' + document.querySelectorAll(s).length).join(' ')"));
    await app.shot("probe-debug");
    await app.until("document.querySelectorAll('.run-convo [data-instance]').length >= 3", "several states to draw");
    await app.resize(1280, 700);
    await new Promise((r) => setTimeout(r, 600));

    const g0 = await app.evaluate<Geometry | null>(GEOMETRY);
    console.log("at rest", g0);
    await app.shot("probe-rest");

    // Pinned at the bottom, then fold every section: what is left, and where is the reader?
    await app.evaluate("(() => { const el = document.querySelector('.run-convo'); el.scrollTop = el.scrollHeight; return true; })()");
    await new Promise((r) => setTimeout(r, 300));
    const g1 = await app.evaluate<Geometry | null>(GEOMETRY);
    console.log("scrolled to bottom", g1);
    const FOLDS = "document.querySelectorAll('.run-convo .lh button[aria-expanded], .run-convo .sb-gutter.solo')";
    const heads = await app.evaluate<number>(`${FOLDS}.length`);
    console.log("fold buttons", heads);
    for (let i = 0; i < heads; i++) {
      await app.evaluate(`(() => { const b = ${FOLDS}[${i}]; b && b.click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 200));
      const g = await app.evaluate<Geometry | null>(GEOMETRY);
      console.log(`after fold ${i + 1}`, g);
    }
    await app.shot("probe-folded");

    // Unfold everything, then scroll through and read what the index marks.
    for (let i = 0; i < heads; i++) {
      await app.evaluate(`(() => { const b = ${FOLDS}[${i}]; b && b.click(); return true; })()`);
    }
    await new Promise((r) => setTimeout(r, 300));
    const total = (await app.evaluate<Geometry | null>(GEOMETRY))?.scrollHeight ?? 0;
    for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      await app.evaluate(`(() => { const el = document.querySelector('.run-convo'); el.scrollTop = ${Math.round(total * fraction)}; return true; })()`);
      await new Promise((r) => setTimeout(r, 250));
      const g = await app.evaluate<Geometry | null>(GEOMETRY);
      console.log(`at ${fraction}`, { scrollTop: g?.scrollTop, here: g?.here });
    }
    await app.shot("probe-spy");
  } finally {
    await app.close();
  }
}

await main();
