/**
 * How much the phone app redraws, per tap and per change from its machine (2026-11-06: the person, "the
 * iphone app has very slow interactions"). The same stand-in as `phoneLayout.mts` — a desktop over a
 * world with tasks, and a phone-sized headless Chrome on `/native` paired with it by the code — with the
 * CPU slowed to stand in for a phone's, and React's devtools hook installed before the page loads, so
 * every commit is counted with the components it drew.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/phone-redraws.mts [--throttle 4]
 *
 * It measures:
 *
 * - **idle**: a quiet machine, nothing touched, for a few seconds — commits there are redraws for nothing;
 * - **drawer**: a tap on ▸| — from the touch to the frame the drawer is in;
 * - **open**: a gate's row in the Inbox tapped — the sheet's frame, then everything drawn in the next seconds
 *   as the task's views arrive;
 * - **busy**: another task renamed on the desktop three times a second — what each change costs the phone;
 * - **busy tap**: the drawer tapped while that goes on.
 *
 * Each reports commits, components drawn (rendered again, and mounted), the script time Chrome counts,
 * and the longest task; `--names` prints the components drawn most, and where the draws started (a
 * component drawn with none above it drawn). Names need an unminified client (`minify: false` in
 * `packages/client/vite.config.ts`'s `build`, for the measuring only).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { serveClient } from "./serveClient.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "phone-redraws");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const says = (text: string): string => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const THROTTLE = Number(arg("--throttle") ?? "4");
const NAMES = process.argv.includes("--names");

/**
 * React's devtools hook, before React loads: each commit counted, and each component the commit drew —
 * walked as the devtools do, down only where a fiber's children were made again (a subtree bailed out
 * keeps its old child, and its old flags with it).
 */
const HOOK = `(() => {
  const PERFORMED = 1;
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const s = { commits: 0, rendered: 0, mounted: 0, names: {}, roots: {}, longest: 0, longTasks: 0, longTotal: 0 };
  window.__redraws = s;
  window.__redrawsReset = () => { s.commits = 0; s.rendered = 0; s.mounted = 0; s.names = {}; s.roots = {}; s.longest = 0; s.longTasks = 0; s.longTotal = 0; };
  const nameOf = (f) => { const t = f.type; if (!t) return "?"; if (typeof t === "string") return t; return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || "anon"; };
  const note = (f) => { const n = nameOf(f); s.names[n] = (s.names[n] || 0) + 1; };
  const mountedUnder = (top) => {
    const stack = [top];
    while (stack.length) { const f = stack.pop(); if (COMPONENT.has(f.tag)) { s.mounted++; note(f); } for (let c = f.child; c; c = c.sibling) stack.push(c); }
  };
  // A component drawn with none drawn above it is where the draw started: whose own state moved.
  const walk = (top) => {
    const stack = [[top, false]];
    while (stack.length) {
      const [f, under] = stack.pop();
      const prev = f.alternate;
      if (prev === null) { mountedUnder(f); continue; }
      const drew = COMPONENT.has(f.tag) && (f.flags & PERFORMED) !== 0;
      if (drew) { s.rendered++; note(f); if (!under) { const n = nameOf(f); s.roots[n] = (s.roots[n] || 0) + 1; } }
      if (f.child === prev.child) continue;
      for (let c = f.child; c; c = c.sibling) stack.push([c, under || drew]);
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(r) { id += 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { s.commits++; try { walk(root.current); } catch (e) { s.error = String(e); } },
  };
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { s.longTasks++; s.longTotal += e.duration; s.longest = Math.max(s.longest, e.duration); } }).observe({ type: "longtask" });
  } catch {}
  // From a touch to the first frame a condition holds in.
  window.__tapAt = 0;
  addEventListener("touchend", () => { window.__tapAt = performance.now(); }, true);
  window.__frameWhen = (test) => new Promise((resolve) => {
    const started = performance.now();
    const look = () => { let ok = false; try { ok = !!test(); } catch {} if (ok) resolve(performance.now() - window.__tapAt); else if (performance.now() - started > 15000) resolve(-1); else requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });
})();`;

interface Stats {
  commits: number;
  rendered: number;
  mounted: number;
  names: Record<string, number>;
  roots: Record<string, number>;
  longest: number;
  longTasks: number;
  longTotal: number;
  error?: string;
}

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome to stand in for the phone");
  mkdirSync(OUT, { recursive: true });
  rmSync(join(OUT, ".profile-9285"), { recursive: true, force: true });
  const world = buildWorld(join(import.meta.dirname, ".world-phone-redraws"));
  const desktop = await App.launch(world, { out: OUT, port: 9284 });
  let phone: App | undefined;
  const served = await serveClient();
  const results: Array<{ scene: string; line: string }> = [];
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
    const done: string[] = [];
    for (let i = 0; i < 6; i++) {
      const title = `finished task ${i + 1}`;
      const made = await desktop.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await desktop.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
      done.push(made.taskId);
    }
    const parked = (await desktop.ipc<{ taskId: string }>("task:create", { title: "tighten the changeset lint", workflow: "feature/plan", inputs: { issue: "# tighten the changeset lint" } })).taskId;
    await desktop.ipc("task:start", { taskId: parked, fake: blockedAtTheGate() });
    for (let i = 0; i < 60; i++) {
      const pending = await desktop.ipc<Array<{ taskId: string }>>("interaction:pending", undefined);
      if (pending.some((p) => p.taskId === parked)) break;
      await sleep(500);
    }

    const shown = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    const port = shown.self.port;
    if (port === undefined || shown.pairing === undefined) throw new Error("the desktop's engine is not listening for devices, or showed no code");
    const url = `http://127.0.0.1:${served.port}/native?address=${encodeURIComponent(`127.0.0.1:${port}`)}`;
    phone = await App.browse(CHROME, url, { out: OUT, port: 9285, phone: { width: 390, height: 844, scale: 3 } });
    await phone.until(`!!document.querySelector('[aria-label="Open the sidebar"]') && ${says("No machine connected")}`, "the phone's shell");
    await phone.evaluate(`[...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === "No machine connected. Connect").click()`);
    await phone.until(says("Connect to a JaiRA machine"), "the Connect screen");
    await phone.evaluate(`document.querySelector('input[aria-label="Code"]').focus()`);
    await phone.type(shown.pairing.code);
    await phone.clickText("Pair");
    await phone.until(`!!document.querySelector('[aria-label="Open the sidebar"]') && !${says("Connect to a JaiRA machine")} && !${says("No machine connected")}`, "the phone to pair");

    // Paired (kept in the profile): load again with the hook in, slowed to a phone's pace.
    await phone.cdp("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await phone.cdp("Page.reload", {});
    await phone.until(`!!window.__redraws && !!document.querySelector('[aria-label="Open the sidebar"]') && !${says("No machine connected")}`, "the phone to come back paired");
    await sleep(3000);
    if (THROTTLE > 1) await phone.cdp("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    await phone.cdp("Performance.enable", {});

    const script = async (): Promise<number> => {
      const m = await phone!.cdp<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics", {});
      return (m.metrics.find((x) => x.name === "ScriptDuration")?.value ?? 0) * 1000;
    };
    const measure = async (scene: string, act: () => Promise<number | void>, windowMs: number): Promise<void> => {
      await phone!.evaluate("window.__redrawsReset()");
      const s0 = await script();
      const latency = await act();
      await sleep(windowMs);
      const s1 = await script();
      const s = await phone!.evaluate<Stats>("JSON.parse(JSON.stringify(window.__redraws))");
      const top = Object.entries(s.names)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12)
        .map(([n, c]) => `${n}×${c}`)
        .join(", ");
      const line =
        `${typeof latency === "number" ? `tap→frame ${latency < 0 ? "never" : `${Math.round(latency)} ms`}; ` : ""}` +
        `${s.commits} commits, ${s.rendered} components redrawn + ${s.mounted} mounted; script ${Math.round(s1 - s0)} ms; ` +
        `${s.longTasks} long tasks (${Math.round(s.longTotal)} ms, longest ${Math.round(s.longest)} ms)${s.error ? `; hook error ${s.error}` : ""}`;
      results.push({ scene, line });
      console.log(`${scene.padEnd(10)} ${line}`);
      if (NAMES) {
        const roots = Object.entries(s.roots)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([n, c]) => `${n}×${c}`)
          .join(", ");
        console.log(`           most drawn: ${top}`);
        console.log(`           drawn from: ${roots}`);
      }
    };
    const tapLabel = async (label: string): Promise<void> => {
      const box = await phone!.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (box === null) throw new Error(`nothing named "${label}" on the phone`);
      await tapAt(box);
    };
    const tapText = async (text: string): Promise<void> => {
      const box = await phone!.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (box === null) throw new Error(`no "${text}" on the phone`);
      await tapAt(box);
    };
    const tapAt = async (at: { x: number; y: number }): Promise<void> => {
      await phone!.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
      await phone!.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const frameWhen = (test: string): Promise<number> => phone!.evaluate<number>(`window.__frameWhen(() => ${test})`);

    await measure("idle", async () => undefined, 4000);
    await measure(
      "drawer",
      async () => {
        await tapLabel("Open the sidebar");
        return frameWhen(`!!document.querySelector('[aria-label="Close the sidebar"]')`);
      },
      1500,
    );
    await phone.until(says("Inbox"), "the drawer's Inbox row");
    await measure(
      "inbox",
      async () => {
        await tapText("Inbox");
        return frameWhen(says("Review the critique result."));
      },
      1500,
    );
    await measure(
      "open",
      async () => {
        await tapText("Review the critique result.");
        return frameWhen(`!!document.querySelector('[aria-label="Drag the panel"]')`);
      },
      4000,
    );
    await phone.shot("open");

    // Another task changing on the machine three times a second: what the phone pays per change.
    let renaming = true;
    const renames = (async () => {
      let n = 0;
      while (renaming) {
        await desktop.ipc("task:rename", { taskId: done[n % done.length], title: `finished task ${(n % done.length) + 1} (${n})` });
        n += 1;
        await sleep(330);
      }
      return n;
    })();
    await sleep(500);
    await measure("busy", async () => undefined, 5000);
    await measure(
      "busy tap",
      async () => {
        await tapLabel("Open the sidebar");
        return frameWhen(`!!document.querySelector('[aria-label="Close the sidebar"]')`);
      },
      1500,
    );
    renaming = false;
    console.log(`(${await renames} renames on the desktop)`);
    await phone.shot("busy");
  } finally {
    const said = [...(phone?.complaints ?? [])].filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (said.length > 0) console.log(`the phone spoke up:\n  ${said.slice(0, 12).join("\n  ")}`);
    served.server.close();
    await phone?.close();
    await desktop.close();
  }
  console.log(`CPU slowed ${THROTTLE}×. Wrote ${OUT}`);
}

await main();
