/**
 * Does Monaco work in the Electron app, as an island of the universal page (decision 0015)? Every surface it has:
 *
 *   npm --workspace @jaira/app run build                     then either
 *   npx tsx packages/app/shots/monaco.mts                    the development build (electron .)
 *   npx tsx packages/app/shots/monaco.mts --packaged         the installer's app (release/<version>/win-unpacked)
 *
 * In one window, against a scratch project holding a TypeScript file with a type error and a `.patch`:
 *   1. the Appearance preview draws, coloured by the TextMate grammars (WASM);
 *   2. the file opens in Monaco, coloured, and the type error is underlined — by the project's own
 *      compiler, asked over `file:check` (Monaco's validation is off), which is why the project has a
 *      `tsconfig.json`;
 *   3. typed text lands in the editor's model;
 *   4. the patch opens in Monaco's diff editor, with its insertions and deletions marked;
 * and across all of it, whether Monaco's workers started (Chromium reports each as a target) or it
 * fell back to the main thread (it says so on the console).
 *
 * Standalone rather than on `driver.mts`: the packaged app is its own executable, not `electron .`.
 * It keeps the driver's lesson about Windows occlusion (`--disable-features=CalculateNativeWinOcclusion`):
 * a window Windows considers covered draws no frames, and Monaco draws only on frames.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildWorld } from "./world.mjs";

const APP_DIR = join(import.meta.dirname, "..");
const OUT = join(import.meta.dirname, "parity", "monaco");
const PACKAGED = process.argv.includes("--packaged");
const PORT = 9300;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function executable(): { file: string; args: string[] } {
  if (!PACKAGED) return { file: createRequire(join(APP_DIR, "package.json"))("electron") as string, args: [APP_DIR] };
  const version = (JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as { version: string }).version;
  const file = join(APP_DIR, "release", version, "win-unpacked", "JaiRA.exe");
  if (!existsSync(file)) throw new Error(`no packaged app at ${file}: npm run app:dist`);
  return { file, args: [] };
}

/** A DevTools connection: one page target, plus the browser's list of targets for counting workers. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (r: { result?: Record<string, unknown>; error?: unknown }) => void>();
  readonly console: { level: string; text: string }[] = [];
  readonly workers = new Set<string>();
  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
      if (m.id !== undefined) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled") {
        const p = m.params as { type: string; args: { value?: unknown; description?: string }[] };
        this.console.push({ level: p.type, text: p.args.map((a) => String(a.value ?? a.description ?? "")).join(" ") });
      } else if (m.method === "Target.attachedToTarget" || m.method === "Target.targetCreated") {
        const info = (m.params as { targetInfo: { type: string; targetId: string; url: string } }).targetInfo;
        if (info.type === "worker") this.workers.add(`${info.targetId} ${info.url.slice(0, 60)}`);
      }
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not attach to ${url}`));
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const result = r.result as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
    if (result?.exceptionDetails !== undefined) throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    return result?.result?.value as T;
  }
  async until(expression: string, what: string, seconds = 30): Promise<void> {
    for (let i = 0; i < seconds * 4; i++) {
      if ((await this.evaluate<boolean>(`Boolean(${expression})`)) === true) return;
      await sleep(250);
    }
    const hidden = await this.evaluate<string>("document.visibilityState");
    throw new Error(`gave up waiting for ${what} (document ${hidden})`);
  }
  /** Click the deepest element under `within` whose text is `text`, as the driver's `clickText` does. */
  async clickText(text: string, within = "body"): Promise<void> {
    const hit = await this.evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(text)};
      const has = (e) => (e.textContent ?? "").includes(want);
      const deepest = [...document.querySelector(${JSON.stringify(within)}).querySelectorAll("*")].filter((e) => has(e) && ![...e.children].some(has)).pop();
      if (!deepest) return false;
      deepest.scrollIntoView({ block: "center", behavior: "instant" });
      (deepest.closest("button, a, [role=button], [class*='row'], li") ?? deepest).click();
      return true;
    })()`);
    if (!hit) throw new Error(`nothing to click reading "${text}"`);
    await sleep(300);
  }
  /** A real press at the middle of the first element matching `selector` (Monaco places its caret from a mousedown). */
  async pressOn(selector: string): Promise<void> {
    const at = await this.evaluate<{ x: number; y: number } | null>(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x + Math.min(r.width - 4, 400), y: r.y + 8 } : null; })()`);
    if (at === null) throw new Error(`nothing matches ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
  async shot(name: string): Promise<void> {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}${PACKAGED ? "-packaged" : ""}.png`), Buffer.from(String((r.result as { data: string }).data), "base64"));
  }
  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(join(import.meta.dirname, ".world-monaco"));
  // The project the file is IN. Monaco's own TypeScript validation is off (`monacoDiff.tsx`): what is
  // underlined is what the project's compiler says (`file:check`), and with no `tsconfig.json` covering
  // a file it says nothing about types — a type error then draws no underline, by design.
  writeFileSync(join(world.project, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", strict: true, noEmit: true }, include: ["*.ts"] }, null, 2));
  writeFileSync(
    join(world.project, "broken.ts"),
    [
      "export interface Answer {",
      "  readonly value: number;",
      "  readonly label: string;",
      "}",
      "",
      "// A type error on purpose: a string where a number belongs.",
      'export const answer: Answer = { value: "forty-two", label: "the answer" };',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(world.project, "change.patch"),
    [
      "--- a/greeting.ts",
      "+++ b/greeting.ts",
      "@@ -1,4 +1,4 @@",
      " export function greet(name: string): string {",
      '-  return "Hello, " + name;',
      "+  return `Hello, ${name}!`;",
      " }",
      " ",
      "",
    ].join("\n"),
  );

  const { file, args } = executable();
  // The world's own `userData` (keychain, Chromium profile), never the author's — as the driver does it.
  const child: ChildProcess = spawn(file, [...args, `--remote-debugging-port=${PORT}`, `--user-data-dir=${world.userData}`, "--disable-features=CalculateNativeWinOcclusion"], {
    cwd: world.project,
    env: { ...process.env, JAIRA_HOME: world.home, JAIRA_PROJECT: world.project },
    stdio: "ignore",
  });
  let page: Cdp | undefined;
  let browser: Cdp | undefined;
  const results: string[] = [];
  const say = (line: string): void => {
    console.log(line);
    results.push(line);
  };
  try {
    let targets: { type: string; url: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 120 && !targets.some((t) => t.type === "page"); i++) {
      await sleep(250);
      try {
        targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as typeof targets;
      } catch {}
    }
    const target = targets.find((t) => t.type === "page");
    if (target === undefined) throw new Error("the app opened no page");
    page = await Cdp.open(target.webSocketDebuggerUrl);
    const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string; "User-Agent": string };
    browser = await Cdp.open(version.webSocketDebuggerUrl);
    await browser.send("Target.setDiscoverTargets", { discover: true });
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await page.until("document.getElementById('root')?.children.length > 0 && document.querySelector('[role=navigation]') !== null", "the window to draw", 60);
    const where = await page.evaluate<string>("location.protocol + '//' + location.host + location.pathname + (globalThis.__vxrnIsSPA === true ? ' (the One client)' : ' (not the One client)')");
    say(`${PACKAGED ? "packaged app" : "development build"}: ${version["User-Agent"].match(/Electron\/[\d.]+/)?.[0]}, renderer ${where}`);

    // 1. The Appearance preview.
    await page.clickText("Settings");
    await page.clickText("Appearance");
    // The File types section by its test id, its preview by the `code` island in it; what is inside an
    // island is Monaco's own DOM, by Monaco's own classes.
    const PREVIEW = "[data-testid=ft] [data-island=code]";
    await page.until(`document.querySelector("${PREVIEW}") !== null`, "the preview to mount");
    await page.until(
      `(document.querySelector("${PREVIEW}").scrollIntoView({ block: "center" }),
        [...document.querySelectorAll("${PREVIEW} .view-lines span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)"))`,
      "the preview to colour itself",
    );
    const previewInks = await page.evaluate<number>(`new Set([...document.querySelectorAll("${PREVIEW} .view-lines span[class^=mtk]")].map((s) => getComputedStyle(s).color)).size`);
    say(`1. Appearance preview: drawn and coloured by the TextMate grammars (${previewInks} inks)`);
    await page.shot("1-preview");

    // 2. A TypeScript file in the Files view.
    // From a fresh load: in Settings the sidebar is Settings' own navigation, whose "Files tree" matches too.
    await page.evaluate("location.reload()");
    await sleep(1000);
    // The sidebar with the project's rooms in it: the landmark is drawn before the project has loaded.
    await page.until("document.getElementById('root')?.children.length > 0 && (document.querySelector('[role=navigation]')?.textContent ?? '').includes('Files')", "the window to draw again", 60);
    await page.clickText("Files", '[role="navigation"]');
    await page.until(`document.body.innerText.includes("broken.ts")`, "the file tree to list broken.ts");
    await page.clickText("broken.ts");
    await page.until(`[...document.querySelectorAll(".monaco-editor .view-lines")].some((v) => v.textContent.includes("forty-two"))`, "broken.ts to open in Monaco");
    await page.until(`document.querySelectorAll(".monaco-editor .view-lines span[class^=mtk]").length > 0`, "its tokens");
    await sleep(1500);
    const inks = await page.evaluate<number>(`new Set([...document.querySelectorAll(".monaco-editor .view-lines span[class^=mtk]")].map((s) => getComputedStyle(s).color)).size`);
    let underlined = false;
    try {
      await page.until(`document.querySelector(".monaco-editor .squiggly-error") !== null`, "the type error to be underlined", 45);
      underlined = true;
    } catch {}
    say(`2. broken.ts: opened in Monaco, ${inks} inks; the type error ${underlined ? "is underlined (the project's compiler answered)" : "was NOT underlined within 45 s"}`);
    await page.shot("2-code");

    // 3. Typing.
    await page.pressOn(".monaco-editor .view-lines .view-line");
    await sleep(300);
    await page.send("Input.insertText", { text: "typed_here_" });
    let typed = false;
    try {
      await page.until(`[...document.querySelectorAll(".monaco-editor .view-lines")].some((v) => v.textContent.includes("typed_here_"))`, "typed text to appear", 10);
      typed = true;
    } catch {}
    say(`3. typing: ${typed ? "the text landed in the editor" : "the text did NOT appear (the pane may be read-only here)"}`);
    await page.shot("3-typed");

    // 4. The patch, in the diff editor.
    // A patch reads as the app's own change list by default; "Side by side" is the one in Monaco's diff
    // editor, the panes a review uses. Chosen the way Appearance chooses it: a renderer choice written
    // to the personal layer through the app's own `config:write`, which the window applies live.
    await page.evaluate(`(async () => {
      const view = await window.jaira.invoke("config:read", {});
      const you = view.you ?? {};
      const appearance = { ...(you.appearance ?? {}), renderers: { ...((you.appearance ?? {}).renderers ?? {}), "text/x-diff:preview": { read: "sidebyside" } } };
      await window.jaira.invoke("config:write", { layer: "you", config: { ...you, appearance } });
    })()`);
    await sleep(500);
    await page.clickText("change.patch", '[role="navigation"]');
    await page.until(`document.querySelector(".monaco-diff-editor .view-lines .view-line") !== null`, "the diff editor to draw");
    await page.until(`document.querySelectorAll(".monaco-diff-editor .line-insert, .monaco-diff-editor .line-delete, .monaco-diff-editor .char-insert, .monaco-diff-editor .char-delete").length > 0`, "the diff to be marked", 30);
    const marks = await page.evaluate<number>(`document.querySelectorAll(".monaco-diff-editor .line-insert, .monaco-diff-editor .line-delete, .monaco-diff-editor .char-insert, .monaco-diff-editor .char-delete").length`);
    say(`4. change.patch: Monaco's diff editor drew it, ${marks} insert/delete marks (computed by the diff worker), the patch shown side by side`);
    await page.shot("4-diff");

    // Workers, and anything Monaco said about them.
    const fellBack = page.console.filter((c) => /web worker|falling back|fall back/i.test(c.text));
    // Counted, not named: Chromium announces a dedicated worker with no URL.
    say(`workers started: ${browser.workers.size}; ${fellBack.length === 0 ? "no fallback to the main thread" : `FELL BACK: ${fellBack[0]!.text.slice(0, 160)}`}`);
    const errors = page.console.filter((c) => c.level === "error");
    say(`console errors: ${errors.length === 0 ? "none" : errors.map((e) => e.text.slice(0, 160)).join(" | ")}`);
  } finally {
    page?.close();
    browser?.close();
    child.kill();
    await sleep(500);
  }
  writeFileSync(join(OUT, `report${PACKAGED ? "-packaged" : ""}.txt`), results.join("\n") + "\n");
}

await main();
