/**
 * How the desktop window's board fills in as it loads (2026-11-06: the person, "when the app loads, i see
 * tasks render one by one on the task view instead of all at once … all the data should already be
 * there"). A desktop over a world with tasks; the window loaded again with a script in it before anything
 * else, which notes on every frame how many of the world's task titles are on screen, and every commit
 * React makes. Printed as one timeline from the load.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/desktop-launch.mts [--tasks 12] [--projects 4] [--throttle 4] [--cold]
 *
 * `--projects`: that many more projects beside the world's, each opened, the tasks shared among them.
 * `--clone <repo>` (again for more): a clone of a real repository as one more project — the size of
 * what a project's reads walk (its files, what git ignores) is a real one's; cloned with `--shared` into
 * the world, so the repository itself is only read.
 * `--cold`: the app quit and started again over the world, the timeline from its window's first load
 * (the projects reopened by the main process as it starts) — rather than the window loaded again.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { initProject } from "@jaira/persistence";
import { join } from "node:path";
import { happyRules, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "desktop-launch");
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const TASKS = Number(arg("--tasks") ?? "12");
const THROTTLE = Number(arg("--throttle") ?? "1");
const PROJECTS = Number(arg("--projects") ?? "0");
const COLD = process.argv.includes("--cold");
const CLONES = process.argv.flatMap((a, i) => (a === "--clone" && process.argv[i + 1] !== undefined ? [process.argv[i + 1]!] : []));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** On every frame: the titles on screen, when that number moves; and React's commits, stamped. */
const SAMPLER = (titles: readonly string[]): string => `(() => {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const want = new Set(${JSON.stringify(titles)});
  const log = { cards: [], commits: [], epoch: Date.now() };
  window.__launch = log;
  const count = () => { let n = 0; for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && want.has(el.textContent)) n++; return n; };
  const sample = () => { const n = count(); const last = log.cards[log.cards.length - 1]; if (last === undefined || last.n !== n) log.cards.push({ at: at(), n }); if (performance.now() - t0 < 15000) requestAnimationFrame(sample); };
  requestAnimationFrame(sample);
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(r) { id += 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot() { if (performance.now() - t0 < 15000) log.commits.push(at()); },
  };
})();`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(join(import.meta.dirname, ".world-desktop-launch"));
  let desktop = await App.launch(world, { out: OUT, port: 9286, mainInspect: 9287 });
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
    const projects = [world.project];
    for (let i = 0; i < PROJECTS; i++) {
      const dir = join(import.meta.dirname, ".world-desktop-launch", `project-${i + 2}`);
      initProject(dir, world.home);
      await desktop.ipc("project:open", { dir });
      projects.push(dir);
    }
    for (const [i, repo] of CLONES.entries()) {
      const dir = join(import.meta.dirname, ".world-desktop-launch", `clone-${i + 1}`);
      execFileSync("git", ["clone", "--quiet", "--shared", repo, dir], { stdio: "ignore" });
      if (!existsSync(join(dir, ".jaira"))) initProject(dir, world.home);
      // The world's workflows, so its tasks run here too.
      writeWorkflowFiles(join(dir, ".jaira", "workflows"), specPlanningFiles());
      await desktop.ipc("project:open", { dir });
      projects.push(dir);
    }
    const titles: string[] = [];
    for (let i = 0; i < TASKS; i++) {
      const title = `launch task ${i + 1}`;
      titles.push(title);
      const project = projects[i % projects.length]!;
      const made = await desktop.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` }, project });
      await desktop.ipc("task:start", { taskId: made.taskId, fake: i % 4 === 3 ? blockedAtTheGate() : happyRules(), project });
    }
    await sleep(4000);
    // The Tasks room, where the person saw it.
    await desktop.evaluate(`[...document.querySelectorAll('[aria-label]')].find((e) => /^Tasks/.test(e.getAttribute('aria-label') ?? ""))?.click()`).catch(() => undefined);
    await sleep(1500);
    const before = await desktop.evaluate<number>(`(() => { const want = new Set(${JSON.stringify(titles)}); let n = 0; for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && want.has(el.textContent)) n++; return n; })()`);
    console.log(`before the load: ${before} of ${TASKS} task titles on screen`);
    await desktop.shot("before");

    if (COLD) {
      // Quit, and start again over the same world: the window's first load is the one measured.
      await desktop.close();
      await sleep(1500);
      desktop = await App.launch(world, { out: OUT, port: 9286, mainInspect: 9287 });
    }
    // Every request the window makes, timed where the main process takes it and answers it.
    await desktop.evaluateMain(
      9287,
      `(() => { const { ipcMain } = require("electron"); const m = ipcMain._invokeHandlers; globalThis.__ipcLog = []; for (const [ch, fn] of m) m.set(ch, async (e, req) => { const t = Date.now(); let out; try { out = await fn(e, req); return out; } finally { const said = ch === "sync:since" && out ? " -> " + (out.whole ? "whole" : (out.changes ?? []).map((c) => c.collection + ":" + c.id).join(" ")) : ""; globalThis.__ipcLog.push([ch, t, Date.now(), JSON.stringify(req ?? null).slice(0, 70) + said]); } }); const w = require("electron").BrowserWindow.getAllWindows()[0]; const send = w.webContents.send.bind(w.webContents); w.webContents.send = (ch, ...a) => { const t = Date.now(); globalThis.__ipcLog.push(["> " + ch, t, t, JSON.stringify(a[0] ?? null).slice(0, 90)]); return send(ch, ...a); }; return m.size; })()`,
    );
    await desktop.cdp("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER(titles) });
    if (THROTTLE > 1) await desktop.cdp("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    await desktop.cdp("Page.reload", {});
    await sleep(8000);
    const log = await desktop.evaluate<{ cards: Array<{ at: number; n: number }>; commits: number[]; epoch: number }>("JSON.parse(JSON.stringify(window.__launch ?? { cards: [], commits: [], epoch: 0 }))");
    const ipc = await desktop.evaluateMain<Array<[string, number, number, string]>>(9287, "globalThis.__ipcLog");
    console.log(`the ${COLD ? "cold start" : "load"} (${projects.length} projects, CPU slowed ${THROTTLE}x): ${log.commits.length} commits in the first 8 s`);
    // One timeline: each request (when main took it, how long it held it), and each change in the titles on screen.
    const lines = [
      ...ipc.map(([ch, start, end, req]) => ({ at: start - log.epoch, line: `${ch.padEnd(22)} ${String(end - start).padStart(4)} ms  ${req}` })),
      ...log.cards.map((c) => ({ at: c.at, line: `== ${c.n} of ${TASKS} task titles on screen` })),
    ].sort((a, b) => a.at - b.at);
    const busy = ipc.reduce((sum, [, start, end]) => sum + (end - start), 0);
    console.log(`  ${ipc.length} requests, ${busy} ms held in the main process in all`);
    for (const one of lines) console.log(`  +${String(one.at).padStart(5)} ms  ${one.line}`);
    const by = new Map<string, { n: number; ms: number }>();
    for (const [ch, start, end] of ipc) {
      const was = by.get(ch) ?? { n: 0, ms: 0 };
      by.set(ch, { n: was.n + 1, ms: was.ms + end - start });
    }
    console.log("  by channel:", [...by].sort(([, a], [, b]) => b.ms - a.ms).map(([ch, v]) => `${ch} ${v.n}x ${v.ms}ms`).join(", "));
    await desktop.shot("after");
  } finally {
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
}

await main();
