/**
 * A probe over a REAL run: copy a project's task records into a scratch world and photograph the
 * conversation, scrolled through, so a rail drawn over a deep run can be looked at rather than
 * reasoned about.
 *
 *   JAIRA_PROBE_PROJECT=C:\UbuntuCode\JaiRA JAIRA_PROBE_TASK=t-u9895uzcg8 npx tsx shots/probe-real.mts
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out");
const WORLD = join(import.meta.dirname, ".world-real");
const PROJECT = process.env["JAIRA_PROBE_PROJECT"] ?? "C:\\UbuntuCode\\JaiRA";
const TASK = process.env["JAIRA_PROBE_TASK"] ?? "t-u9895uzcg8";
const TITLE = process.env["JAIRA_PROBE_TITLE"] ?? "feature #1";

const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const system = join(world.project, ".jaira", "system");
  mkdirSync(join(system, "tasks"), { recursive: true });
  for (const name of ["jaira.db", "jaira.db-wal", "jaira.db-shm"]) {
    const from = join(PROJECT, ".jaira", "system", name);
    if (existsSync(from)) cpSync(from, join(system, name));
  }
  cpSync(join(PROJECT, ".jaira", "system", "snapshots"), join(system, "snapshots"), { recursive: true });
  cpSync(join(PROJECT, ".jaira", "system", "tasks", `${TASK}.json`), join(system, "tasks", `${TASK}.json`));

  const app = await App.launch(world, { out: OUT, port: 9232 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.until(says(TITLE), "the task to be listed", 120);
    await app.clickText(TITLE);
    await app.evaluate(`(() => {
      const card = [...document.querySelectorAll("[class*='card']")].find((e) => (e.textContent ?? "").includes(${JSON.stringify(TITLE)}));
      if (!card) return false;
      card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return true;
    })()`);
    await app.until(says("Conversation"), "the mode toggle to appear");
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('.run-mode button')].find((b) => (b.textContent ?? '').trim() === 'Conversation'); if (b) b.click(); return !!b; })()`);
    await new Promise((r) => setTimeout(r, 300));
    if (await app.evaluate<boolean>("[...document.querySelectorAll('.task-context button')].some((b) => (b.textContent ?? '').trim() === 'Details')")) await app.clickText("Details");
    await new Promise((r) => setTimeout(r, 3000));
    await app.shot("real-debug");
    console.log("columns", await app.evaluate<string>("['.composite', '.run-convo', '.run-convo [data-instance]', '.rail-row', '.sb-band', '.empty'].map(s => s + '=' + document.querySelectorAll(s).length).join(' ')"));
    console.log("empty says", await app.evaluate<string>("[...document.querySelectorAll('.run-convo .empty, .composite .empty')].map(e => e.textContent).join(' | ')"));
    await app.until("document.querySelectorAll('.run-convo [data-instance]').length >= 3", "the conversation to draw", 160);
    await new Promise((r) => setTimeout(r, 1500));
    await app.resize(1280, 1400);
    await new Promise((r) => setTimeout(r, 500));

    // The rail's rows, as drawn: which have no lane at all, and where the turns are.
    const rows = await app.evaluate<string[]>(`(() => {
      const out = [];
      for (const row of document.querySelectorAll('.run-convo .rail-row')) {
        const segs = row.querySelectorAll('.rail-gut .rail-seg').length;
        const svg = row.querySelectorAll('.rail-gut svg').length;
        const cls = row.className.replace('rail-row', '').trim();
        const text = (row.querySelector('.rail-content')?.textContent ?? '').trim().slice(0, 60).replace(/\\s+/g, ' ');
        out.push(segs + ' seg ' + svg + ' svg [' + cls + '] ' + Math.round(row.getBoundingClientRect().height) + 'px  ' + text);
      }
      return out;
    })()`);
    for (const line of rows) console.log(line);

    const total = await app.evaluate<number>("document.querySelector('.run-convo').scrollHeight");
    const view = await app.evaluate<number>("document.querySelector('.run-convo').clientHeight");
    console.log("scrollHeight", total, "clientHeight", view);
    let i = 0;
    for (let top = 0; process.env["JAIRA_PROBE_SHOTS"] !== undefined && top < total; top += view - 80) {
      await app.evaluate(`(() => { document.querySelector('.run-convo').scrollTop = ${top}; return true; })()`);
      await new Promise((r) => setTimeout(r, 300));
      await app.shot(`real-${String(i++).padStart(2, "0")}`);
    }
  } finally {
    await app.close();
  }
}

await main();
