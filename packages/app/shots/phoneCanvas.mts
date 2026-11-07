/**
 * A design canvas on a phone (decision 0020 §4-5), in a browser standing in for the phone's WebView.
 *
 *   npm --workspace @jaira/client run build:island
 *   npx tsx packages/app/shots/phoneCanvas.mts
 *
 * The pieces are the real ones but the store: an engine's network listener (`engineNet.ts`) serving a
 * canvas's files as a canvas grant is served, the grant rewritten as the phone's engine bridge rewrites it (`artifactAddress`),
 * and the built `canvas` island page loaded from `file://` as a WebView loads it from the app's assets,
 * driven over the island bridge. Each artboard runs sandboxed into an opaque origin, out of the harness's
 * reach, so what says it RAN is the engine's own request log: an artboard's runtime fetches its own source
 * again and every `dc-import`ed sibling, which a page that only loaded never does.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishedMime } from "@jaira/shared";
import { claimEngine } from "@jaira/service/engineHost";
import { listenNetwork } from "@jaira/service/engineNet";
import { machineIdentity } from "@jaira/service/machine";
import { artifactAddress } from "../../client/bridges/engineBridge";
import { App } from "./driver.mjs";

const ISLANDS = join(import.meta.dirname, "..", "..", "client", "dist-island");
const HARNESS = join(ISLANDS, "harness-canvas.html");
const FIXTURES = join(import.meta.dirname, "..", "..", "dc-runtime", "test", "fixtures");
const RUNTIME = join(import.meta.dirname, "..", "..", "dc-runtime", "dist", "support.js");
const OUT = join(import.meta.dirname, "parity", "phone-canvas");
const BROWSER = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync);

const HOST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title><script src="./support.js"></script></head><body>
<x-dc><section style="padding: 12px; width: 240px"><dc-import name="Card" hint-size="200,120" item='{{ item }}'></dc-import></section></x-dc>
<script type="text/x-dc" data-dc-script>class Component extends DCLogic { renderVals() { return { item: { title: "Imported" } }; } }</script>
</body></html>`;

const HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#888">
<script>
window.__events = [];
let frame;
window.open_ = (props, component = "canvas") => {
  frame = document.createElement("iframe");
  frame.src = component + "/index.html";
  frame.style.cssText = "width:100%;border:0;display:block;height:520px";
  document.body.appendChild(frame);
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = JSON.parse(e.data);
    window.__events.push(m);
    if (m.kind === "ready") frame.contentWindow.postMessage(JSON.stringify({ kind: "render", component, props, look: { palette: "ink", theme: "light" } }), "*");
  });
};
</script></body></html>`;

async function main(): Promise<void> {
  if (BROWSER === undefined) throw new Error("no Chrome or Edge to stand in for the phone");
  if (!existsSync(join(ISLANDS, "canvas", "index.html"))) throw new Error("no canvas island page: npm --workspace @jaira/client run build:island");
  const home = mkdtempSync(join(tmpdir(), "jaira-phone-canvas-"));
  // The canvas as published, served as `AppService.servedArtifact` serves a canvas grant (its files at
  // their paths, `support.js` the runtime, the canvas policy) - the service's own grant path is
  // `fleetDevices.test.ts`'s; this rig is about what a phone's WebView does with one.
  const files: Record<string, string> = {
    "project/canvas.json": JSON.stringify({ title: "Phone", order: ["poster.dc.html", "Host.dc.html"], boards: { "poster.dc.html": { x: 0, y: 0, w: 880, h: 560, title: "Poster" }, "Host.dc.html": { x: 940, y: 0, w: 264, h: 160, title: "Host" } } }),
    "project/poster.dc.html": readFileSync(join(FIXTURES, "poster.dc.html"), "utf8"),
    "project/Card.dc.html": readFileSync(join(FIXTURES, "Card.dc.html"), "utf8"),
    "project/Host.dc.html": HOST,
    // A published page (decision 0020 §4): its script runs, and says so by asking for a file of its own.
    "chart.html": `<!doctype html><title>Chart</title><p id="p">static</p><script>fetch("./chart.json").then((r) => r.json()).then((d) => { document.getElementById("p").textContent = d.word; });</script>`,
    "chart.json": JSON.stringify({ word: "ran" }),
  };
  const runtime = readFileSync(RUNTIME, "utf8");
  const token = randomUUID().replaceAll("-", "");
  const host = await claimEngine({ baseDir: home, kind: "desktop", version: "0.2.0", handlers: {}, authorizeNetwork: () => undefined } as never);
  const asked: string[] = [];
  const net = await listenNetwork({
    host: host!,
    identity: () => machineIdentity(home),
    version: "0.2.0",
    port: 0,
    artifacts: {
      served: (t, path) => {
        if (t !== token) return undefined;
        asked.push(path);
        const file = decodeURIComponent(path).replace(/^\/+/, "");
        if (file.endsWith("support.js")) return { body: runtime, mediaType: "text/javascript", policy: "canvas" };
        const text = files[file];
        return text === undefined ? undefined : { body: text, mediaType: publishedMime(file), policy: file.startsWith("project/") ? "canvas" : "page" };
      },
      blob: () => undefined,
    },
  });  mkdirSync(OUT, { recursive: true });
  let app: App | undefined;
  try {
    // As the phone's engine bridge hands it on, for an engine reached at this listener.
    const url = artifactAddress(`jaira-artifact://${token}/project/canvas.json`, `ws://127.0.0.1:${String(net.port)}/engine`);
    const base = url.slice(0, url.lastIndexOf("project/canvas.json"));
    console.log(`phone: the grant at ${base}`);
    const index = files["project/canvas.json"];    writeFileSync(HARNESS, HARNESS_HTML);
    app = await App.browse(BROWSER, pathToFileURL(HARNESS).href, { out: OUT, port: 9274, phone: { width: 390, height: 844, scale: 3 }, flags: ["--allow-file-access-from-files"] });
    await app.evaluate(`window.open_(${JSON.stringify({ index, base, style: { height: 440 } })})`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const drew = await app.evaluate<boolean>(`window.__events.some((e) => e.kind === "drawn")`);
      if (drew && asked.includes("/project/Card.dc.html") && asked.filter((p) => p === "/project/poster.dc.html").length >= 2) break;
    }
    const events = await app.evaluate<Array<{ kind: string; level?: string; message?: string; text?: string }>>(`window.__events`);
    console.log(`phone: island ${JSON.stringify(events.map((e) => e.kind))}${events.some((e) => e.kind === "error" || e.level === "error") ? ` ${JSON.stringify(events.filter((e) => e.kind === "error" || e.kind === "log"))}` : ""}`);
    console.log(`phone: frames ${JSON.stringify(await app.evaluate(`(() => { try { return [...frame.contentDocument.querySelectorAll("iframe")].map((f) => f.src + " " + f.getBoundingClientRect().width + "x" + f.getBoundingClientRect().height); } catch (e) { return String(e); } })()`))}`);
    console.log(`phone: the engine was asked for ${JSON.stringify(asked)}`);
    await app.shot("board");
    const count = (path: string): number => asked.filter((p) => p === path).length;
    if (!events.some((e) => e.kind === "drawn")) throw new Error("the canvas island never drew");
    if (count("/project/poster.dc.html") < 2) throw new Error("the poster artboard loaded but its runtime never read its own source");
    if (count("/project/Host.dc.html") < 2) throw new Error("the host artboard loaded but its runtime never read its own source");
    if (count("/project/Card.dc.html") < 1) throw new Error("the host artboard's dc-import never fetched its sibling");
    if (count("/project/support.js") < 2) throw new Error("the artboards never loaded the runtime");
    // Two fingers: spread apart zooms in about the point between them, pinched together zooms out.
    const zoom = async (): Promise<{ z: string; transform: string }> =>
      app!.evaluate(`(() => { const d = frame.contentDocument; const z = [...d.querySelectorAll("span")].find((s) => /^\\d+%$/.test(s.textContent)); const layer = [...d.querySelectorAll("div")].find((x) => x.style.transform.startsWith("translate")); return { z: z ? z.textContent : "", transform: layer ? layer.style.transform : "" }; })()`);
    const area = await app.evaluate<{ x: number; y: number }>(`(() => { const r = frame.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 300 }; })()`);
    const pinchBy = async (from: number, to: number): Promise<void> => {
      const at = (gap: number): Array<{ x: number; y: number; id: number }> => [
        { x: area.x - gap / 2, y: area.y, id: 1 },
        { x: area.x + gap / 2, y: area.y, id: 2 },
      ];
      await app!.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
      for (let i = 1; i <= 12; i++) {
        await app!.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / 12) });
        await new Promise((r) => setTimeout(r, 20));
      }
      await app!.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await new Promise((r) => setTimeout(r, 400));
    };
    const before = await zoom();
    await pinchBy(60, 240);
    const spread = await zoom();
    await app.shot("pinched-out");
    await pinchBy(240, 60);
    const pinched = await zoom();
    console.log(`phone: zoom ${before.z} -> spread ${spread.z} -> pinched ${pinched.z}`);
    const pct = (s: string): number => Number.parseInt(s, 10);
    if (!(pct(spread.z) >= pct(before.z) * 3.5)) throw new Error(`spreading two fingers 4x apart did not zoom in 4x (${before.z} -> ${spread.z})`);
    if (Math.abs(pct(pinched.z) - pct(before.z)) > 1) throw new Error(`pinching back did not return the zoom (${before.z} -> ${pinched.z})`);
    if (pinched.transform !== before.transform && Math.abs(pct(pinched.z) - pct(before.z)) === 0) console.log(`phone: the view moved by the pinch round trip: ${before.transform} -> ${pinched.transform}`);
    // A published page, in the artifact island: its script runs from the same route.
    asked.splice(0);
    await app.evaluate(`document.body.innerHTML = ""; window.__events = []; window.open_(${JSON.stringify({ url: `${base}chart.html`, published: true, style: { width: "100%", height: 300 } })}, "artifact")`);
    for (let i = 0; i < 40 && !asked.includes("/chart.json"); i++) await new Promise((r) => setTimeout(r, 250));
    console.log(`phone: the page island asked for ${JSON.stringify(asked)}`);
    if (!asked.includes("/chart.html")) throw new Error("the artifact island never loaded the page");
    if (!asked.includes("/chart.json")) throw new Error("the page loaded but its script never ran");
    await app.shot("page");
    console.log("phone canvas: passed");
  } finally {
    await app?.close();
    await net.close();
    await host!.close();
    rmSync(HARNESS, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
