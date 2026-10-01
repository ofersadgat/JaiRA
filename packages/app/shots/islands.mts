/**
 * The island test of decision 0015 (S5), in a browser standing in for the phone.
 *
 *   npm --workspace @jaira/client run build:island
 *   npx tsx packages/app/shots/islands.mts            with file access for file pages (as the WebView will be set)
 *   npx tsx packages/app/shots/islands.mts --strict   without it: what a WebView left at its defaults would do
 *
 * A harness page loads the built island page (`packages/client/dist-island/`) in iframes, from
 * `file://`, as a WebView loads it from the app's assets: each island is its own opaque origin, and a
 * worker or module script is subject to the same file-URL rules Android applies. It drives each
 * island over the real bridge (`packages/client/island/protocol.ts`) on a phone-sized viewport with
 * touch, and records what 0015's island test asks: time to drawn, whether Monaco got its worker,
 * whether the grammars coloured the text, how the content height settles, memory with three islands
 * live, a palette switch, and typed input in the editable editor. Keyboard, IME and gestures are not
 * measured here — they need the device.
 *
 * The code editors (the Files room's surfaces): the Monaco editor (`code`) over a 2,000-line file —
 * ready, drawn, its worker, its grammar, a palette switch with the person's editor look carried in
 * the render, and typing that comes back — the same island as the code view (the tokenizer, no
 * editor), and the schema-aware editor's text (`schemaText`), typed into.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAppearanceConfig } from "@jaira/shared";
import { App } from "./driver.mjs";

const CLIENT_DIST = join(import.meta.dirname, "..", "..", "client", "dist");
const HARNESS = join(CLIENT_DIST, "..", "dist-island", "harness.html");
const OUT = join(import.meta.dirname, "parity", "islands");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const STRICT = process.argv.includes("--strict");

const HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#888">
<script>
window.__events = [];
const frames = {};
window.open_ = (id, component, props, look, height, auto) => {
  const f = document.createElement("iframe");
  f.src = component + "/index.html";
  f.style.cssText = "width:100%;border:0;display:block;height:" + height + "px";
  document.body.appendChild(f);
  frames[id] = { f, component, props, look, auto, t0: performance.now() };
};
window.render_ = (id, look) => {
  const fr = frames[id];
  fr.look = look;
  fr.t0 = performance.now();
  fr.f.contentWindow.postMessage(JSON.stringify({ kind: "render", component: fr.component, props: fr.props, look }), "*");
};
addEventListener("message", (e) => {
  const id = Object.keys(frames).find((k) => frames[k].f.contentWindow === e.source);
  if (id === undefined) return;
  const m = JSON.parse(e.data);
  m.id = id;
  m.at = Math.round(performance.now() - frames[id].t0);
  window.__events.push(m);
  if (m.kind === "ready") window.render_(id, frames[id].look);
  if (m.kind === "height" && frames[id].auto && m.px > 0) frames[id].f.style.height = m.px + "px";
});
</script></body></html>`;

interface Event {
  id: string;
  kind: string;
  at: number;
  ms?: number;
  colours?: number;
  heap?: number;
  px?: number;
  name?: string;
  value?: unknown;
  level?: string;
  text?: string;
  message?: string;
}

const LOOK = { palette: "ink", theme: "light" } as const;

/**
 * A TypeScript file of about `lines` lines, and the same with every tenth line changed. Seeded from a
 * component still in the renderer (the DOM board it was read from is gone); the islands are told it is
 * `board.tsx`, which is only a name.
 */
function sources(lines: number): { original: string; modified: string } {
  const seed = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "monacoDiff.tsx"), "utf8").split("\n");
  const out: string[] = [];
  while (out.length < lines) out.push(...seed);
  const original = out.slice(0, lines);
  const modified = original.map((line, i) => (i % 10 === 5 ? `${line} // changed ${i}` : line));
  return { original: original.join("\n"), modified: modified.join("\n") };
}

const MARKDOWN = [
  "# Review notes",
  "",
  "The critique found **three** weaknesses. See `feature/plan/critique` for the full report.",
  "",
  "| Weakness | Severity | Where |",
  "| --- | --- | --- |",
  "| The sync lint ignores renames | high | `lint.ts:42` |",
  "| No test for an empty board | medium | `board.test.ts` |",
  "| Copy says \"we\" | low | `composer.tsx` |",
  "",
  "```ts",
  "export function laneOf(card: BoardCard): Lane {",
  '  if (card.status === "running") return "running";',
  '  return card.endedAt !== undefined ? "finished" : "not-started";',
  "}",
  "```",
  "",
  "- first point",
  "- second point, which is long enough to wrap onto a second line on a phone-sized screen",
].join("\n");

async function events(app: App): Promise<Event[]> {
  return app.evaluate<Event[]>("window.__events");
}

async function waitFor(app: App, test: string, what: string, seconds = 60): Promise<void> {
  await app.until(`window.__events.some((e) => ${test})`, what, seconds * 4);
}

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome to stand in for the phone");
  if (!existsSync(join(CLIENT_DIST, "..", "dist-island", "diff", "index.html"))) throw new Error("build the island first: npm --workspace @jaira/client run build:island");
  writeFileSync(HARNESS, HARNESS_HTML);
  mkdirSync(OUT, { recursive: true });
  const flags = STRICT ? [] : ["--allow-file-access-from-files"];
  const app = await App.browse(CHROME, pathToFileURL(HARNESS).href, { out: OUT, port: 9270, phone: { width: 390, height: 844, scale: 3 }, flags });
  const report: string[] = [];
  const note = (line: string): void => {
    console.log(line);
    report.push(line);
  };
  const fresh = async (): Promise<void> => {
    await app.navigate(pathToFileURL(HARNESS).href);
    await app.until("Array.isArray(window.__events)", "the harness");
  };
  note(`islands in Chrome as a phone (390×844 @3, touch), ${STRICT ? "WITHOUT" : "with"} file access for file pages`);

  try {
    // 1. Markdown, sized to its content.
    await fresh();
    await app.evaluate(`open_("md", "markdown", { text: ${JSON.stringify(MARKDOWN)} }, ${JSON.stringify(LOOK)}, 50, true)`);
    try {
      await waitFor(app, `e.id === "md" && e.kind === "drawn"`, "the markdown island to draw", 30);
      await new Promise((r) => setTimeout(r, 1000));
      const ev = (await events(app)).filter((e) => e.id === "md");
      const heights = ev.filter((e) => e.kind === "height").map((e) => e.px);
      note(`markdown: ready ${ev.find((e) => e.kind === "ready")?.at} ms, drawn ${ev.find((e) => e.kind === "drawn")?.ms} ms after render, ${ev.find((e) => e.kind === "drawn")?.colours} inks; heights ${heights.join(" → ")} (${heights.length} reports)`);
      await app.shot("markdown");
    } catch (e) {
      note(`markdown: FAILED — ${(e as Error).message}; ${JSON.stringify((await events(app)).slice(0, 5))}`);
    }

    // 2. Monaco diffs, read-only, at three sizes.
    for (const lines of [200, 2000, 20000]) {
      await fresh();
      const { original, modified } = sources(lines);
      await app.evaluate(
        `open_("diff", "diff", ${JSON.stringify({ original, modified, mime: "text/x-typescript", file: "board.tsx", readOnly: true })}, ${JSON.stringify(LOOK)}, 700, false)`,
      );
      try {
        await waitFor(app, `e.id === "diff" && e.kind === "drawn"`, `the ${lines}-line diff to draw`, 90);
        await new Promise((r) => setTimeout(r, 1500));
        const ev = (await events(app)).filter((e) => e.id === "diff");
        const fallback = ev.some((e) => e.kind === "log" && /web worker|fall(ing)? back/i.test(e.text ?? ""));
        const drawn = ev.find((e) => e.kind === "drawn");
        note(
          `diff ${lines} lines: ready ${ev.find((e) => e.kind === "ready")?.at} ms, drawn ${drawn?.ms} ms after render, ${drawn?.colours} inks, worker ${fallback ? "FELL BACK to the main thread" : "started"}` +
            (ev.some((e) => e.kind === "error") ? `, errors: ${ev.filter((e) => e.kind === "error").map((e) => e.message).join("; ")}` : ""),
        );
        if (lines === 2000) await app.shot("diff-2000");
      } catch (e) {
        const ev = (await events(app)).filter((x) => x.id === "diff");
        note(`diff ${lines} lines: FAILED — ${(e as Error).message}; ${JSON.stringify(ev.slice(0, 6)).slice(0, 600)}`);
      }
    }

    // 3. Three islands at once, and what they cost.
    await fresh();
    const before = await app.metrics();
    const { original, modified } = sources(2000);
    await app.evaluate(`open_("a", "markdown", { text: ${JSON.stringify(MARKDOWN)} }, ${JSON.stringify(LOOK)}, 50, true)`);
    await app.evaluate(`open_("b", "diff", ${JSON.stringify({ original, modified, mime: "text/x-typescript", file: "board.tsx", readOnly: true })}, ${JSON.stringify(LOOK)}, 400, false)`);
    await app.evaluate(`open_("c", "markdownEditor", { text: ${JSON.stringify(MARKDOWN)}, readOnly: true }, ${JSON.stringify(LOOK)}, 300, false)`);
    try {
      for (const id of ["a", "b", "c"]) await waitFor(app, `e.id === "${id}" && e.kind === "drawn"`, `island ${id}`, 90);
      await new Promise((r) => setTimeout(r, 2000));
      // Each island is its own origin, and in Chromium its own process, so each reports its own heap.
      const heaps = (await events(app)).filter((e) => e.kind === "drawn" && ["a", "b", "c"].includes(e.id)).map((e) => `${e.id} ${((e.heap ?? 0) / 1048576).toFixed(0)} MB`);
      note(`three islands: JS heap per island ${heaps.join(", ")} (the harness itself: ${((before["JSHeapUsedSize"] ?? 0) / 1048576).toFixed(0)} MB)`);
      await app.shot("three");

      // 4. A palette switch, without a reload.
      await app.evaluate(`render_("a", { palette: "ink", theme: "dark" })`);
      await app.until(`window.__events.filter((e) => e.id === "a" && e.kind === "drawn").length >= 2`, "the markdown island to redraw dark", 40);
      note(`palette switch: the markdown island redrew in dark without a reload`);
      await app.shot("three-dark");
    } catch (e) {
      note(`three islands: FAILED — ${(e as Error).message}`);
    }

    // 6. The code editor (Monaco, editable) over a 2,000-line file, with an editor look in the render.
    await fresh();
    const code = sources(2000).original;
    // The person's look as the host sends it: the defaults, with the code editor's minimap off and a
    // tab of 4 — so a look that did not arrive would show.
    const defaults = defaultAppearanceConfig();
    const appearance = { ...defaults, editors: { ...defaults.editors, code: { ...defaults.editors.code, minimap: false, tabSize: 4 } } };
    await app.evaluate(
      `open_("code", "code", ${JSON.stringify({ text: code, mime: "text/x-typescript", file: "C:/w/board.tsx", view: "write" })}, ${JSON.stringify({ ...LOOK, appearance })}, 700, false)`,
    );
    try {
      await waitFor(app, `e.id === "code" && e.kind === "drawn"`, "the code editor to draw", 90);
      await new Promise((r) => setTimeout(r, 1500));
      const ev = (await events(app)).filter((e) => e.id === "code");
      const fallback = ev.some((e) => e.kind === "log" && /web worker|fall(ing)? back/i.test(e.text ?? ""));
      const drawn = ev.find((e) => e.kind === "drawn");
      note(
        `code editor 2000 lines: ready ${ev.find((e) => e.kind === "ready")?.at} ms, drawn ${drawn?.ms} ms after render, ${drawn?.colours} inks, worker ${fallback ? "FELL BACK to the main thread" : "started"}, heap ${((drawn?.heap ?? 0) / 1048576).toFixed(0)} MB` +
          (ev.some((e) => e.kind === "error") ? `, errors: ${ev.filter((e) => e.kind === "error").map((e) => e.message).join("; ")}` : ""),
      );
      await app.shot("code-2000");
      // A tap on the first line's text, then text committed the way an IME commits it.
      await app.clickAt(200, 16);
      await new Promise((r) => setTimeout(r, 300));
      await app.type("typedOnAPhone ");
      await app.until(`window.__events.some((e) => e.id === "code" && e.kind === "event" && e.name === "change" && String(e.value).includes("typedOnAPhone"))`, "the typed text to come back", 20);
      note(`code editor: typed text reached the host as a change over the bridge`);
      // The palette, switched without a reload: the window to dark, and the editors to follow it (the
      // default editor palette, Monokai Light, is a palette of its own and stays light in a dark window,
      // as it does on the desktop).
      await app.evaluate(`render_("code", ${JSON.stringify({ palette: "ink", theme: "dark", appearance: { ...appearance, editorTheme: "app" } })})`);
      await app.until(`window.__events.filter((e) => e.id === "code" && e.kind === "drawn").length >= 2`, "the code editor to redraw dark", 40);
      // The dark grammar theme is fetched on the way (Shiki's), so give it a moment before the picture.
      await new Promise((r) => setTimeout(r, 2500));
      const said = (await events(app)).filter((e) => e.id === "code" && (e.kind === "log" || e.kind === "error")).map((e) => e.text ?? e.message);
      note(`code editor: redrew in dark without a reload (see code-dark.png)${said.length > 0 ? `; it said: ${said.join(" | ").slice(0, 400)}` : ""}`);
      await app.shot("code-dark");
    } catch (e) {
      const ev = (await events(app)).filter((x) => x.id === "code");
      note(`code editor: FAILED — ${(e as Error).message}; ${JSON.stringify(ev.slice(0, 6)).slice(0, 600)}`);
    }

    // 7. The same island as the code view: the tokenizer's colours, no editor under them.
    await fresh();
    await app.evaluate(`open_("view", "code", ${JSON.stringify({ text: code, mime: "text/x-typescript", reading: true })}, ${JSON.stringify(LOOK)}, 700, false)`);
    try {
      await waitFor(app, `e.id === "view" && e.kind === "drawn"`, "the code view to draw", 90);
      await new Promise((r) => setTimeout(r, 2500));
      const ev = (await events(app)).filter((e) => e.id === "view");
      const drawn = ev.filter((e) => e.kind === "drawn");
      note(`code view 2000 lines: ready ${ev.find((e) => e.kind === "ready")?.at} ms, drawn ${drawn[0]?.ms} ms after render, ${drawn.at(-1)?.colours} inks`);
      await app.shot("code-view");
    } catch (e) {
      note(`code view: FAILED — ${(e as Error).message}`);
    }

    // 8. The schema-aware editor's text: a permission set, against its schema, typed into.
    await fresh();
    const permissions = JSON.stringify({ description: "Ask before anything writes.", rules: [{ tool: "read_file", decision: "allow" }] }, null, 2);
    await app.evaluate(`open_("json", "schemaText", ${JSON.stringify({ text: permissions, schemaId: null, format: "json", wrap: false, fill: 0 })}, ${JSON.stringify(LOOK)}, 400, false)`);
    try {
      await waitFor(app, `e.id === "json" && e.kind === "drawn"`, "the schema editor to draw", 60);
      const ev = (await events(app)).filter((e) => e.id === "json");
      note(`schema editor: ready ${ev.find((e) => e.kind === "ready")?.at} ms, drawn ${ev.find((e) => e.kind === "drawn")?.ms} ms after render, ${ev.find((e) => e.kind === "drawn")?.colours} inks`);
      await app.clickAt(300, 60);
      await new Promise((r) => setTimeout(r, 300));
      await app.type("typed ");
      await app.until(`window.__events.some((e) => e.id === "json" && e.kind === "event" && String(e.value).includes("typed "))`, "the typed text to come back", 20);
      note(`schema editor: typed text reached the host as a change over the bridge`);
      await app.shot("schema-typed");
    } catch (e) {
      note(`schema editor: FAILED — ${(e as Error).message}`);
    }

    // 5. The editable editor: does typed text come back over the bridge?
    await fresh();
    await app.evaluate(`open_("ed", "markdownEditor", { text: "# notes\\n\\nfirst line\\n", readOnly: false }, ${JSON.stringify(LOOK)}, 500, false)`);
    try {
      await waitFor(app, `e.id === "ed" && e.kind === "drawn"`, "the editor to draw", 60);
      // A tap in the editor's text, then text committed the way an IME commits it.
      await app.clickAt(120, 90);
      await new Promise((r) => setTimeout(r, 300));
      await app.type("typed on a phone ");
      await app.until(`window.__events.some((e) => e.id === "ed" && e.kind === "event" && String(e.value).includes("typed on a phone"))`, "the typed text to come back", 20);
      note(`editable editor: typed text reached the host as an onChange over the bridge`);
      await app.shot("editor-typed");
    } catch (e) {
      note(`editable editor: FAILED — ${(e as Error).message}`);
    }
  } finally {
    await app.close();
  }
  writeFileSync(join(OUT, `report${STRICT ? "-strict" : ""}.txt`), report.join("\n") + "\n");
  console.log(`wrote ${OUT}`);
}

await main();
