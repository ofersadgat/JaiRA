/**
 * The app, launched as it ships and photographed over the DevTools protocol.
 *
 * The harness this replaced rendered a page of its own — a second Vite build, a second HTML file, a
 * second content policy — and photographed that. Every one of those was a place for the picture and
 * the product to disagree, and they did: the harness page carried no policy at all, so a WebAssembly
 * module the app's `script-src 'self'` refuses instantiated happily there, and the figures showed
 * the TextMate grammars running while the app fell back to Monaco's own tokenizer.
 *
 * There is one page now, and it is the app's. That class of bug cannot recur, because there is no
 * second thing to keep in step.
 *
 * ## Why CDP, and why it costs nothing
 *
 * Electron opens an ordinary DevTools endpoint under `--remote-debugging-port`, and Node 22 has both
 * `fetch` and a native `WebSocket`, so the entire client below is dependency-free — no Puppeteer, no
 * `ws`, no browser extension. What it drives is the real renderer: the same Chromium, the same font
 * stack, the same rasteriser, the same composition. There is nothing left for a picture to be
 * unrepresentative OF.
 *
 * ## Seeding goes through the app's own channels
 *
 * `ipc()` calls `window.jaira.invoke`, which the preload bridge whitelists to exactly the IPC
 * contract — so creating and starting a task here takes the same route the renderer takes when a
 * person clicks "New task". It is not a back door, and a state reached through it is a state the app
 * can actually be in.
 *
 * ## A failure must never photograph as a success
 *
 * The lesson the old harness learned the hard way, kept: an evaluation that throws is raised as an
 * error rather than returning `undefined`, page console errors are forwarded, and the run exits
 * non-zero if anything spoke up. A rig that writes "done" over an empty directory is worse than one
 * that crashes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { World } from "./world.mjs";

/** Where the app lives, relative to this file (`packages/app/shots`). */
const APP_DIR = join(import.meta.dirname, "..");
/**
 * The Electron executable, as the `electron` package reports it. Since Electron 42 the package no
 * longer downloads its binary on install; asking for the path downloads it the first time.
 */
const ELECTRON = createRequire(join(APP_DIR, "package.json"))("electron") as string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A CDP reply, as much of it as anything here reads. */
interface Reply {
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: unknown;
    readonly data?: string;
  };
}

export interface Options {
  /** Where the PNGs land. */
  readonly out: string;
  /** The window, in CSS pixels. Pictures come out at twice this — see `deviceScaleFactor`. */
  readonly width?: number;
  readonly height?: number;
  /** Not the default 9222: a browser someone already has open would answer instead of the app. */
  readonly port?: number;
  /** A phone instead of a window: its viewport and scale, with touch (the island harness, 0015 S5). */
  readonly phone?: { readonly width: number; readonly height: number; readonly scale: number };
  /** Extra switches for a {@link browse}d browser. */
  readonly flags?: readonly string[];
}

export class App {
  private id = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  /** Anything that went wrong and did not throw. A non-empty list is a failed run. */
  readonly complaints: string[] = [];
  /** Everything the process printed to stdout, for a script that needs something it said. */
  said = "";

  private constructor(
    private readonly child: ChildProcess,
    private readonly ws: WebSocket,
    private readonly out: string,
  ) {}

  /**
   * Launch the app over `world` and attach.
   *
   * `JAIRA_HOME` rather than the `--home` flag, and not merely as a matter of taste: `startupProject`
   * in `src/main/index.ts` scans raw `process.argv` for the first non-dash path that exists, so the
   * flag's VALUE is picked up as the project to open and the app tries to open the base root. The
   * environment variable has the same precedence and no such reading.
   */
  static async launch(world: World, options: Options): Promise<App> {
    const port = options.port ?? 9229;
    mkdirSync(options.out, { recursive: true });

    // `--user-data-dir` is Chromium's switch and Electron's `userData` follows it: the world's keychain
    // and profile, never the author's. See `World.userData`.
    /*
     * `CalculateNativeWinOcclusion` off, or the window is only drawn while nothing covers it.
     *
     * On Windows Chromium asks the OS whether a window is covered, and a covered one — behind
     * another app, or opened behind the foreground window, which is where Windows puts a window a
     * background process opens — is marked hidden: `document.visibilityState` reads "hidden" and
     * `requestAnimationFrame` never fires. React and IPC carry on, so every wait on the DOM still
     * passes, but everything drawn on a frame does not happen. Monaco is the one surface here that
     * draws only on frames: the preview's editor mounted, measured itself at 758×199 and drew no
     * lines, for as long as the window stayed covered — and a capture waits for a frame forever.
     * `Page.bringToFront` does not help; it raises the page, not the OS window over what covers it.
     */
    const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${port}`, `--user-data-dir=${world.userData}`, "--disable-features=CalculateNativeWinOcclusion"], {
      cwd: world.project,
      env: { ...process.env, JAIRA_HOME: world.home, JAIRA_PROJECT: world.project },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return App.attach(child, port, options);
  }

  /**
   * A plain browser, headless, on `url` — the One client served by the desktop's spike socket (0015
   * S2), photographed with the same verbs as the app. `browser` is the executable (Chrome, Edge).
   */
  static async browse(browser: string, url: string, options: Options): Promise<App> {
    const port = options.port ?? 9229;
    mkdirSync(options.out, { recursive: true });
    const profile = join(options.out, `.profile-${port}`);
    const child = spawn(
      browser,
      ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", ...(options.flags ?? []), url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return App.attach(child, port, options, true);
  }

  private static async attach(child: ChildProcess, port: number, options: Options, quiet = false): Promise<App> {
    // Assigned once attached; stdout that arrives before then is kept here and handed over.
    let app: App | undefined;
    let early = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (app === undefined) early += String(d);
      else app.said += String(d);
    });

    const complaints: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
      if (quiet) return;
      const line = String(d).trim();
      // The endpoint announcement is not news, and neither is an empty flush.
      if (line === "" || line.includes("DevTools listening")) return;
      console.log(`  [app] ${line.slice(0, 300)}`);
      complaints.push(line.slice(0, 300));
    });

    // The endpoint appears a moment after the process does, and not at all if the app died on
    // startup — so this loop is also how a failed launch is noticed.
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 80 && target === undefined; i++) {
      await sleep(250);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        target = list.find((t) => t.type === "page");
      } catch {
        // Not listening yet. The loop is the wait.
      }
    }
    if (target === undefined) throw new Error(`no CDP page target on ${port} after 20s — did the app start?`);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not attach to the app's page target"));
    });

    app = new App(child, ws, options.out);
    app.complaints.push(...complaints);
    app.said = early;
    ws.onmessage = (e: MessageEvent) => app.receive(String(e.data));

    await app.send("Page.enable");
    await app.send("Runtime.enable");
    // A page in the background draws no frames, and `Page.captureScreenshot` then waits for one
    // forever — a shot that hangs, not one that fails. This raises the PAGE; an app window that
    // something else covers is the business of the switch in `launch`.
    await app.send("Page.bringToFront");
    await app.send("Emulation.setDeviceMetricsOverride", {
      width: options.phone?.width ?? options.width ?? 1280,
      height: options.phone?.height ?? options.height ?? 860,
      // Two, so 10px type is readable in the PNG. The old harness could only ask for this with a
      // process-wide launch switch; here it is a call, and it could differ per shot.
      deviceScaleFactor: options.phone?.scale ?? 2,
      mobile: options.phone !== undefined,
    });
    if (options.phone !== undefined) await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    return app;
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as Reply & { id?: number; method?: string; params?: unknown };
    if (typeof message.id === "number") {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
      return;
    }
    // The page's own console, in the driver's log. The old harness needed this because an Electron
    // main process on Windows has no console attached; here it is simpler — an error the page prints
    // is evidence about the app, and evidence is the whole product.
    if (message.method === "Runtime.consoleAPICalled") {
      const params = message.params as { type?: string; args?: { value?: unknown }[] };
      if (params.type === "error") {
        const said = (params.args ?? []).map((a) => String(a.value ?? "")).join(" ");
        console.log(`  [page] ${said.slice(0, 300)}`);
        this.complaints.push(said.slice(0, 300));
      }
    }
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the page. A throw there is a throw here — never a quiet `undefined`. */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails !== undefined) {
      throw new Error(`page threw: ${JSON.stringify(reply.result.exceptionDetails).slice(0, 400)}`);
    }
    return reply.result?.result?.value as T;
  }

  /**
   * Call the app's IPC the way the renderer calls it.
   *
   * The rejection is turned into a string rather than left to reject, because a refused channel or a
   * refusal from the service is a fact about the app worth reading, and an unhandled rejection
   * crossing the protocol boundary is not.
   */
  async ipc<T>(channel: string, request: unknown = {}): Promise<T> {
    const said = await this.evaluate<string>(
      `window.jaira.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)})` +
        `.then(r => JSON.stringify(r ?? null), e => "REFUSED " + e.message)`,
    );
    if (said.startsWith("REFUSED ")) throw new Error(`${channel}: ${said.slice(8)}`);
    return JSON.parse(said) as T;
  }

  /** Wait until the page says so. `what` is what appears in the error if it never does. */
  async until(expression: string, what: string, tries = 80): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if ((await this.evaluate<boolean>(`Boolean(${expression})`)) === true) return;
      await sleep(250);
    }
    // The one cause that is not about the page: a hidden page draws no frames (see `launch`).
    const hidden = (await this.evaluate<string>("document.visibilityState")) === "hidden";
    throw new Error(`gave up waiting for ${what}${hidden ? " (the page is hidden, so nothing drawn on a frame was drawn)" : ""}`);
  }

  /**
   * Choose the theme the NEXT launch opens in.
   *
   * Not this one. The renderer reads the configuration once per load and owns what it shows — a
   * write from out here reaches the file and not the window. Which is the same shape the predecessor
   * had, for the same underlying reason: a theme is a property of the whole page, so it is one theme
   * per load, and `run.mts` takes a pass per theme.
   *
   * The mode is `appearance.mode` of the personal layer ("Just you", `personal-settings.json`), the
   * one every project's look is laid under, and the write goes through `config:write` — so the file
   * is written, and checked, by the code that owns its format rather than by this rig guessing at it.
   */
  async preferTheme(theme: "light" | "dark"): Promise<void> {
    const view = await this.ipc<{ you: Record<string, unknown> | null }>("config:read", {});
    const you = view.you ?? {};
    const appearance = { ...((you["appearance"] as Record<string, unknown> | undefined) ?? {}), mode: theme };
    await this.ipc("config:write", { layer: "you", config: { ...you, appearance } });
  }

  /**
   * The whole look the NEXT launch opens in: the mode, the palette, and the status wash (Appearance),
   * written the way {@link preferTheme} writes the mode alone.
   */
  async preferLook(look: { theme: "light" | "dark"; palette: string; wash: boolean }): Promise<void> {
    const view = await this.ipc<{ you: Record<string, unknown> | null }>("config:read", {});
    const you = view.you ?? {};
    const appearance = { ...((you["appearance"] as Record<string, unknown> | undefined) ?? {}), mode: look.theme, palette: look.palette, statusWash: look.wash };
    await this.ipc("config:write", { layer: "you", config: { ...you, appearance } });
  }

  /** What this window actually opened in, for the caller to name its pictures by. */
  theme(): Promise<"light" | "dark"> {
    return this.evaluate<"light" | "dark">(`document.documentElement.dataset.theme`);
  }

  /**
   * Click at a point, with REAL input events.
   *
   * {@link clickText}'s `element.click()` is enough for a button and is not enough for Monaco: the
   * editor puts its caret from a `mousedown` at a position, and a synthetic click on a token span
   * carries no position at all. So a gesture that has to land somewhere in a document comes through
   * here, where the browser is told a mouse was actually pressed.
   */
  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: 1 });
    }
    await sleep(150);
  }

  /**
   * Press a key, with REAL input events — the only way to reach an editor keybinding.
   *
   * `windowsVirtualKeyCode` is the field Monaco's keybinding service reads; a `KeyboardEvent`
   * constructed in the page has a `keyCode` of 0 and matches nothing at all, which is how a
   * synthetic F12 quietly does nothing.
   */
  async press(key: string, code: number, held: { alt?: boolean; shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
    // Chromium's bit field: 1 alt, 2 ctrl, 8 shift. Monaco reads the modifiers off the event rather
    // than tracking key state, so a chord has to arrive as one event with them set.
    const modifiers = (held.alt === true ? 1 : 0) | (held.ctrl === true ? 2 : 0) | (held.shift === true ? 8 : 0);
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        modifiers,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      });
    }
    await sleep(500);
  }

  /**
   * Move the pointer over a point and leave it there — what a hover is.
   *
   * `ctrl` is not decoration: holding it turns a hover into Monaco's go-to-definition preview, which
   * is a different code path from the ordinary hover and from the peek widget, and the one a person
   * triggers by accident most often.
   */
  async hover(x: number, y: number, held: { ctrl?: boolean } = {}): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      modifiers: held.ctrl === true ? 2 : 0,
    });
    await sleep(900);
  }

  /**
   * Click the first element whose visible text contains `text`.
   *
   * By text rather than by class, because a class is an implementation detail this rig has no
   * business pinning: a selector that breaks when a component is refactored is a rig that reports
   * a rendering failure every time somebody renames a div. Deepest match wins, so "Tasks" finds the
   * label and not the panel that contains it.
   */
  async clickText(text: string): Promise<void> {
    const hit = await this.evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(text)};
      const has = (e) => (e.textContent ?? "").includes(want);
      // The deepest match: one that contains the text while none of its children do. Anything
      // shallower is an ancestor that merely contains the thing you meant.
      const deepest = [...document.querySelectorAll("*")]
        .filter((e) => has(e) && ![...e.children].some(has))
        .pop();
      if (!deepest) return false;
      deepest.scrollIntoView({ block: "center", behavior: "instant" });
      // Up to the nearest thing that handles a click, because the text usually sits in a span inside
      // the control rather than on it. React delegates at the root so a click on a descendant would
      // bubble anyway — but only if the descendant is inside the handler's element, which a floated
      // label or a sibling caption is not.
      const target = deepest.closest("button, a, [role=button], [class*='card'], [class*='row'], li") ?? deepest;
      target.click();
      return true;
    })()`);
    if (!hit) throw new Error(`nothing to click reading "${text}"`);
    // One frame for React to commit. A click and a look in the same task finds the old tree.
    await sleep(250);
  }

  /**
   * Give the window a different size for the next few shots.
   *
   * The one scene that needs it is a settings pane taller than the window: its own scroll container
   * means `captureBeyondViewport` has nothing to capture — the content below the fold is not painted
   * at all, so the picture is the top of the pane and then the app's bottom strip showing through.
   * Making the viewport tall enough is the honest fix, because it photographs the pane at a size the
   * app will genuinely draw it at on a large screen rather than stitching one together.
   */
  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    // One frame for the layout to settle at the new size before anything is measured or captured.
    await sleep(250);
  }

  /**
   * One picture. `of` is a CSS selector to frame; omitted, the whole window.
   *
   * `captureBeyondViewport` is why a selector may name something below the fold — the predecessor
   * read the compositor, so it could only photograph what was on screen, and its 1000×900 window
   * silently clipped every specimen wider or taller than that.
   */
  async shot(name: string, of?: string): Promise<void> {
    const clip =
      of === undefined
        ? undefined
        : await this.evaluate<{ x: number; y: number; width: number; height: number } | null>(`(() => {
            const el = document.querySelector(${JSON.stringify(of)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
          })()`);
    if (of !== undefined && clip === null) throw new Error(`nothing matches "${of}" for ${name}`);

    // Again before every capture, not only at launch: a page that fell into the background stops
    // drawing frames, and a capture waits for the next one forever.
    await this.send("Page.bringToFront");
    const reply = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      ...(clip !== null && clip !== undefined ? { clip: { ...clip, scale: 1 } } : {}),
    });
    const data = reply.result?.data;
    if (data === undefined) throw new Error(`the capture of ${name} returned nothing`);
    writeFileSync(join(this.out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`  ${name}.png`);
  }

  /**
   * Hold still, for a comparison of two renderers of one state (`parity.mts`).
   *
   * From the next document on: every page starts its clock at `epochMs` and lets it run from there,
   * so "36 seconds ago" says the same thing at the same step of both passes, and animations and
   * transitions are off, so neither picture catches a spinner mid-turn. The clock RUNS rather than
   * stopping: Monaco's tokenizer budgets its work by the clock, and a stopped one never colours a
   * line.
   */
  async holdStill(epochMs: number): Promise<void> {
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const T = ${epochMs};
        const Real = Date;
        const now = () => T + Math.floor(performance.now());
        class Held extends Real { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
        globalThis.Date = Held;
        const still = () => {
          const s = document.createElement("style");
          s.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
          document.documentElement.appendChild(s);
        };
        if (document.documentElement) still(); else document.addEventListener("DOMContentLoaded", still);
      })()`,
    });
  }

  /** Type into whatever has focus, as an IME commits text: one `insertText`, no key events. */
  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** The renderer's own counters (`Performance.getMetrics`): heap, nodes, documents, frames. */
  async metrics(): Promise<Record<string, number>> {
    await this.send("Performance.enable");
    const reply = (await this.send("Performance.getMetrics")) as unknown as { result?: { metrics?: { name: string; value: number }[] } };
    return Object.fromEntries((reply.result?.metrics ?? []).map((m) => [m.name, m.value]));
  }

  /** Load `url` in the window, and wait for it to finish loading. */
  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.until("document.readyState === 'complete'", `${url} to load`);
  }

  async close(): Promise<void> {
    this.ws.close();
    this.child.kill();
    await sleep(300);
  }
}
