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
/** The scenes whose every commit `--names` lists: `--commits open,busy`. */
const COMMITS = (arg("--commits") ?? "").split(",");
/** With `--names`: why each component drew (`--why`), and what is mounted once the task is open (`--census`). */
const WHY = process.argv.includes("--why");
const CENSUS = process.argv.includes("--census");

/**
 * React's devtools hook, before React loads: each commit counted, and each component the commit drew —
 * walked as the devtools do, down only where a fiber's children were made again (a subtree bailed out
 * keeps its old child, and its old flags with it).
 */
const HOOK = `(() => {
  const PERFORMED = 1;
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const s = { commits: 0, rendered: 0, mounted: 0, names: {}, roots: {}, log: [], why: {}, remade: {}, moved: {}, longest: 0, longTasks: 0, longTotal: 0 };
  window.__redraws = s;
  window.__redrawsReset = () => { s.commits = 0; s.rendered = 0; s.mounted = 0; s.names = {}; s.roots = {}; s.log = []; s.why = {}; s.remade = {}; s.moved = {}; s.longest = 0; s.longTasks = 0; s.longTotal = 0; };
  const nameOf = (f) => { const t = f.type; if (!t) return "?"; if (typeof t === "string") return t; return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || "anon"; };
  const note = (f) => { const n = nameOf(f); s.names[n] = (s.names[n] || 0) + 1; };
  const mountedUnder = (top) => {
    const stack = [top];
    while (stack.length) { const f = stack.pop(); if (COMPONENT.has(f.tag)) { s.mounted++; note(f); } for (let c = f.child; c; c = c.sibling) stack.push(c); }
  };
  // Why a component drew: its props the same object, the same field by field, different only in things
  // made again with equal content (a new callback, a new element, an equal object), or with a value moved.
  const same = (a, b, depth) => {
    if (a === b) return true;
    if (typeof a === "function" && typeof b === "function") return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || depth > 5) return false;
    if (a.$$typeof !== undefined || b.$$typeof !== undefined) return a.$$typeof === b.$$typeof && a.type === b.type && a.key === b.key && same(a.props, b.props, depth + 1);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => same(a[k], b[k], depth + 1));
  };
  const kindOf = (v) => typeof v === "function" ? "callback" : v !== null && typeof v === "object" && v.$$typeof !== undefined ? "element" : Array.isArray(v) && v.some((x) => x !== null && typeof x === "object" && x.$$typeof !== undefined) ? "element" : "object";
  const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };
  const why = (f, prev) => {
    const a = prev.memoizedProps, b = f.memoizedProps;
    if (a === b) return bump(s.why, "same props object (own state, context or a store)");
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const moved = [...keys].filter((k) => a?.[k] !== b?.[k]);
    if (moved.length === 0) return bump(s.why, "props equal field by field (drawn with its parent)");
    const real = moved.filter((k) => !same(a?.[k], b?.[k], 0));
    const n = nameOf(f);
    if (real.length === 0) {
      bump(s.why, "props new but equal in content (callbacks, elements, objects made again)");
      for (const k of moved) bump(s.remade, n + "." + k + " (" + kindOf(b?.[k]) + ")");
      return;
    }
    bump(s.why, "a prop's value moved");
    for (const k of real) bump(s.moved, n + "." + k);
  };
  // What is mounted, by component: how many components and DOM elements under each, how many of those
  // elements lie in the viewport, and how many are the top element at their centre (not covered).
  window.__census = () => {
    const W = innerWidth, H = innerHeight;
    const look = (el) => {
      if (!(el instanceof Element)) return [0, 0];
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return [0, 0];
      const x = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
      const top = document.elementFromPoint(x, y);
      return [1, top !== null && (top === el || el.contains(top)) ? 1 : 0];
    };
    const visit = (f) => {
      let comps = 0, hosts = 0, inView = 0, seen = 0, kids = [];
      for (let c = f.child; c; c = c.sibling) {
        const r = visit(c);
        comps += r.comps; hosts += r.hosts; inView += r.inView; seen += r.seen; kids.push(...r.kids);
      }
      if (f.tag === 5) { const [v, t] = look(f.stateNode); hosts += 1; inView += v; seen += t; }
      if (COMPONENT.has(f.tag)) {
        const node = { name: nameOf(f), comps: comps + 1, hosts, inView, seen, kids: kids.filter((k) => k.comps >= 25) };
        return { comps: comps + 1, hosts, inView, seen, kids: [node] };
      }
      return { comps, hosts, inView, seen, kids };
    };
    const all = visit(window.__lastRoot.current);
    return { comps: all.comps, hosts: all.hosts, inView: all.inView, seen: all.seen, kids: all.kids };
  };
  // A component drawn with none drawn above it is where the draw started: whose own state moved.
  const walk = (top) => {
    const stack = [[top, false]];
    while (stack.length) {
      const [f, under] = stack.pop();
      const prev = f.alternate;
      if (prev === null) { mountedUnder(f); continue; }
      const drew = COMPONENT.has(f.tag) && (f.flags & PERFORMED) !== 0;
      if (drew) { s.rendered++; note(f); why(f, prev); if (!under) { const n = nameOf(f); s.roots[n] = (s.roots[n] || 0) + 1; s.from.push(n); } }
      if (f.child === prev.child) continue;
      // Under a component that skipped its draw (a memo), a draw started on its own.
      const below = COMPONENT.has(f.tag) ? drew : under;
      for (let c = f.child; c; c = c.sibling) stack.push([c, below]);
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(r) { id += 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      window.__lastRoot = root;
      s.commits++;
      const r0 = s.rendered, m0 = s.mounted;
      s.from = [];
      try { walk(root.current); } catch (e) { s.error = String(e); }
      if (s.log.length < 200) s.log.push({ t: Math.round(performance.now() - window.__tapAt), rendered: s.rendered - r0, mounted: s.mounted - m0, from: s.from.slice(0, 10) });
    },
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
  log: Array<{ t: number; rendered: number; mounted: number; from: string[] }>;
  why: Record<string, number>;
  remade: Record<string, number>;
  moved: Record<string, number>;
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
        if (WHY) {
          const list = (bag: Record<string, number>, n: number): string =>
            Object.entries(bag)
              .sort(([, a], [, b]) => b - a)
              .slice(0, n)
              .map(([k, c]) => `${k}×${c}`)
              .join(", ");
          for (const [k, c] of Object.entries(s.why).sort(([, a], [, b]) => b - a)) console.log(`           ${String(c).padStart(6)}  ${k}`);
          console.log(`           made again most: ${list(s.remade, 14)}`);
          console.log(`           moved most: ${list(s.moved, 14)}`);
        }
        if (COMMITS.includes(scene)) for (const c of s.log) if (c.rendered + c.mounted > 20) console.log(`             +${c.t} ms: ${c.rendered} drawn, ${c.mounted} mounted, from ${c.from.join(", ")}`);
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
    if (CENSUS) {
      interface Node {
        name: string;
        comps: number;
        hosts: number;
        inView: number;
        seen: number;
        kids: Node[];
      }
      const census = async (where: string): Promise<void> => {
        const all = await phone!.evaluate<Node>("window.__census()");
        console.log(`census, ${where}: ${all.comps} components over ${all.hosts} elements; ${all.inView} elements in the screen, ${all.seen} of them uncovered`);
        // The tree, each line a component with its share; a chain of one child keeping most of it folded into one line.
        const print = (node: Node, depth: number, chain: string[]): void => {
          const big = node.kids.filter((k) => k.comps >= Math.max(40, all.comps * 0.015));
          const only = big.length === 1 && big[0]!.comps >= node.comps * 0.85 ? big[0]! : undefined;
          if (only !== undefined && depth < 60) return print(only, depth, [...chain, node.name]);
          const names = [...chain, node.name];
          const shown = names.length > 3 ? `${names[0]} › … › ${names.slice(-2).join(" › ")}` : names.join(" › ");
          console.log(`${"  ".repeat(Math.min(depth, 20))}${node.comps} comps, ${node.hosts} els (${node.inView} in screen, ${node.seen} uncovered)  ${shown}`);
          for (const kid of big.sort((a, b) => b.comps - a.comps)) print(kid, depth + 1, []);
        };
        for (const top of all.kids) print(top, 0, []);
      };
      const sheetTop = (): Promise<number | null> => phone!.evaluate<number | null>(`(() => { const el = document.querySelector('[aria-label="Drag the panel"]'); return el ? Math.round(el.getBoundingClientRect().top) : null; })()`);
      const drag = async (y0: number, y1: number): Promise<void> => {
        await phone!.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: y0 }] });
        for (let i = 1; i <= 14; i++) {
          await phone!.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: y0 + ((y1 - y0) * i) / 14 }] });
          await sleep(20);
        }
        await phone!.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(1200);
      };
      await census(`the task open, its sheet at half (top ${await sheetTop()})`);
      const half = await sheetTop();
      if (half !== null) {
        await drag(half + 8, 120);
        await census(`the sheet full (top ${await sheetTop()})`);
        const full = await sheetTop();
        if (full !== null) await drag(full + 8, full + 220);
      }
      await tapLabel("Open the sidebar");
      await sleep(1200);
      await census("the drawer open");
      await tapLabel("Close the sidebar").catch(() => undefined);
      await sleep(800);
    }

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
    // The same, the task's sheet raised to full over the board.
    // The drawer the last tap opened, swiped shut as a finger would.
    if (await phone.evaluate<boolean>(`!!document.querySelector('[aria-label="Close the sidebar"]')`)) {
      await phone.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: 420 }] });
      for (let i = 1; i <= 14; i++) {
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300 - (260 * i) / 14, y: 422 }] });
        await sleep(20);
      }
      await phone.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await sleep(1000);
    const sheetTopNow = (): Promise<number | null> => phone!.evaluate<number | null>(`(() => { const el = document.querySelector('[aria-label="Drag the panel"]'); return el ? Math.round(el.getBoundingClientRect().top) : null; })()`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const top = await sheetTopNow();
      if (top === null || top < 120) break;
      await phone.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: top + 8 }] });
      for (let i = 1; i <= 14; i++) {
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: top + 8 + ((100 - top - 8) * i) / 14 }] });
        await sleep(20);
      }
      await phone.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(1500);
    }
    const raised = await sheetTopNow();
    if (raised !== null && raised < 120) {
      const board = await phone.evaluate<string>(`(() => { const el = document.querySelector('[data-testid="board-column"]'); if (!el) return "no board"; let at = el; while (at && getComputedStyle(at).display !== "none") at = at.parentElement; return at ? "the board hidden" : "the board shown"; })()`);
      console.log(`(the sheet at top ${raised}: ${board})`);
      await measure("busy full", async () => undefined, 5000);
    } else console.log(`(the sheet did not rise to full: top ${raised})`);
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
