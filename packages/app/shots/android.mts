/**
 * The phone app on the Android emulator (decision 0015), end to end.
 *
 *   npm --workspace @jaira/client run build:island && (cd packages/client && npx one prebuild --platform android)
 *   (cd packages/client/android && ./gradlew assembleDebug)
 *   npx tsx packages/app/shots/android.mts [--serial emulator-5554] [--metro 8082] [--hold]
 *
 * A desktop with a few tasks and the spike socket; Metro (`one dev`) serving the debug build its
 * JavaScript; the emulator reaching both through `adb reverse`. The app is installed, opened by the deep
 * link that connects it (`jaira:///?address=…&token=…`) and photographed: the universal shell drawn
 * natively (no WebView in it), fitted and at its own size; the board scrolled under its column headings,
 * which must stay put; a task opened in the panel, Files, Chat and Settings; then, by the same link with `&screen=islands`,
 * the three islands with their readouts, and text typed into the editable island coming back over the
 * bridge.
 * What the screen says is read from Android's accessibility dump (`uiautomator`), so a tab that shows
 * an error rather than the app is caught.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "android");
const CLIENT = join(import.meta.dirname, "..", "..", "client");
const APK = join(CLIENT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const SDK = process.env["ANDROID_HOME"] ?? join(process.env["LOCALAPPDATA"] ?? "", "Android", "Sdk");
const ADB = join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const SERIAL = process.argv.includes("--serial") ? process.argv[process.argv.indexOf("--serial") + 1]! : "emulator-5554";
const PORT = 8767;
/**
 * The host's port for Metro, which the phone reaches as its own 8081. One's shared dev server (8081) by
 * default; `--metro 8082` for a server of this run's own — one started after a change to
 * `metro.config.cjs`, which a running server does not reread.
 */
const METRO = process.argv.includes("--metro") ? Number(process.argv[process.argv.indexOf("--metro") + 1]) : 8081;
const PACKAGE = "com.mistlabs.jaira";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const adb = (...args: string[]): string => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

/** Everything on screen that has text, with where it is — from `uiautomator dump`. */
function screen(): { text: string; x: number; y: number }[] {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("shell", "cat", "/sdcard/ui.xml");
  const nodes: { text: string; x: number; y: number }[] = [];
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    const text = (m[1] || m[2] || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (text !== "") nodes.push({ text, x: (Number(m[3]) + Number(m[5])) / 2, y: (Number(m[4]) + Number(m[6])) / 2 });
  }
  return nodes;
}
const says = (text: string): boolean => screen().some((n) => n.text.includes(text));

async function until(test: () => boolean, what: string, seconds = 90): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    try {
      if (test()) return;
    } catch {}
    await sleep(1000);
  }
  shot(`failed-${what.replace(/\W+/g, "-")}`);
  throw new Error(`gave up waiting for ${what}; the screen says: ${screen().map((n) => n.text).slice(0, 25).join(" | ")}`);
}

function shot(name: string): void {
  const png = execFileSync(ADB, ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 1 << 28 });
  writeFileSync(join(OUT, `${name}.png`), png);
  console.log(`  ${name}.png`);
}

/**
 * A development build's LogBox toasts ("Open debugger to view warnings.") sit over the bottom of the
 * screen, the frame's zoom button with them: each is dismissed by the × at its right end.
 */
function quiet(): void {
  for (let i = 0; i < 4; i++) {
    const toast = screen().find((n) => n.text.startsWith("Open debugger to view"));
    if (toast === undefined) return;
    adb("shell", "input", "tap", String(Math.round(toast.x * 2 - 90)), String(Math.round(toast.y)));
  }
}

function tap(text: string): void {
  const node = screen().find((n) => n.text === text) ?? screen().find((n) => n.text.includes(text));
  if (node === undefined) throw new Error(`nothing on screen reads "${text}"`);
  adb("shell", "input", "tap", String(Math.round(node.x)), String(Math.round(node.y)));
}

async function main(): Promise<void> {
  if (!existsSync(APK)) throw new Error(`no debug APK at ${APK}: build it with ./gradlew assembleDebug`);
  mkdirSync(OUT, { recursive: true });
  const devices = execFileSync(ADB, ["devices"], { encoding: "utf8" });
  if (!devices.includes(`${SERIAL}\tdevice`)) throw new Error(`${SERIAL} is not attached:\n${devices}`);

  // The desktop, with something on its board.
  const world = buildWorld(join(import.meta.dirname, ".world-android"));
  process.env["JAIRA_SPIKE_WS"] = String(PORT);
  process.env["JAIRA_RENDERER"] = "one";
  const desktop = await App.launch(world, { out: OUT, port: 9290 });
  let metro: ChildProcess | undefined;
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
    const token = /token ([0-9a-f]{32})/.exec(desktop.said)?.[1];
    if (token === undefined) throw new Error("the desktop printed no token");
    for (const title of ["add dark mode", "rework the sync lint"]) {
      const made = await desktop.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await desktop.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
    }
    await desktop.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "both tasks to finish");

    // Metro, for the debug build's JavaScript: One's dev server, which serves the studios' pages and a
    // phone's bundle on the same port. Started here unless one is already answering (a studio's), as
    // `studio.mts` does; one that is not ours is left running.
    let running = false;
    try {
      running = (await fetch(`http://127.0.0.1:${METRO}/`)).status < 500;
    } catch {}
    metro = running ? undefined : spawn(process.execPath, [join(CLIENT, "..", "..", "node_modules", "one", "run.mjs"), "dev", "--port", String(METRO)], { cwd: CLIENT, stdio: ["ignore", "pipe", "pipe"] });
    if (running) console.log(`(0) Metro: the dev server already on ${METRO}`);
    let metroLog = "";
    metro?.stdout?.on("data", (d: Buffer) => (metroLog += String(d)));
    metro?.stderr?.on("data", (d: Buffer) => (metroLog += String(d)));
    for (let i = 0; i < 90; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${METRO}/`)).status < 500) break;
      } catch {}
      await sleep(1000);
    }

    // The emulator reaches the host's Metro and the desktop's socket as its own localhost.
    adb("reverse", "tcp:8081", `tcp:${METRO}`);
    adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
    adb("install", "-r", APK);
    adb("shell", "am", "force-stop", PACKAGE);
    adb("logcat", "-c");
    const link = `jaira:///?address=${encodeURIComponent(`ws://127.0.0.1:${PORT}/`)}&token=${token}`;
    const started = Date.now();
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, PACKAGE);

    await until(() => says("Open a project"), "the app to connect and draw the shell", 240);
    console.log(`(1) connected by deep link in ${Math.round((Date.now() - started) / 1000)} s (first bundle from Metro included)`);
    await sleep(4000);
    quiet();
    shot("1-shell-fit");
    // The shell is native: no WebView anywhere in what Android is drawing.
    const webviews = (adb("shell", "cat", "/sdcard/ui.xml").match(/class="android\.webkit\.WebView"/g) ?? []).length;
    if (webviews > 0) throw new Error(`the shell drew ${webviews} WebView(s): it must be native`);
    console.log("(1) the universal shell draws natively, fitted to the phone (no WebView)");

    tap("1:1");
    await sleep(1500);
    shot("2-shell-full");
    tap("fit");
    console.log("(2) at its own size, and back");

    // A column's heading sticks while the board scrolls under it (`Board.tsx`'s `StickyHead` on a phone):
    // a slow drag up the empty board moves the second row's "Events" heading with the board, while the
    // first row's "Planning" goes only as far as the board's top and stays there over its cards.
    const tops = (): { planning: number; events: number } => {
      const all = screen();
      return { planning: all.find((n) => n.text === "Planning")?.y ?? NaN, events: all.find((n) => n.text === "Events")?.y ?? NaN };
    };
    const before = tops();
    adb("shell", "input", "swipe", "600", "1500", "600", "1380", "1500");
    await sleep(1500);
    const after = tops();
    shot("2-board-scrolled");
    const scrolled = before.events - after.events;
    const held = before.planning - after.planning;
    if (!(scrolled > 40 && held < scrolled / 2)) throw new Error(`the column headings did not stick: the board scrolled ${scrolled} px and Planning's heading moved ${held}`);
    console.log(`(2) the board scrolled ${Math.round(scrolled)} px; the first row's headings moved ${Math.round(held)} and stuck at its top`);
    adb("shell", "input", "swipe", "600", "1300", "600", "1700", "300");
    await sleep(1000);

    // The rooms, as a person walks them: a task opened in the panel, Files, Chat, Settings, fitted.
    const rooms: [string, string, string][] = [
      ["add dark mode", "Conversation", "3-task"],
      ["FILES", "Select a file in the tree.", "4-files"],
      ["CHAT", "What are we doing?", "5-chat"],
      ["SETTINGS", "Connections", "6-settings"],
    ];
    for (const [press, shows, name] of rooms) {
      tap(press);
      await until(() => says(shows), `${name} to show "${shows}"`, 30);
      await sleep(1500);
      quiet();
      shot(name);
    }
    tap("TASKS");
    console.log("(2) the task in the panel, Files, Chat and Settings, each drawn");

    // `--hold`: everything stays up (desktop, Metro, the app) for driving the phone by hand, until
    // `parity/android/.release` appears.
    if (process.argv.includes("--hold")) {
      console.log(`holding: the app is connected; touch ${join(OUT, ".release")} to go on`);
      while (!existsSync(join(OUT, ".release"))) await sleep(1000);
      rmSync(join(OUT, ".release"));
    }

    // The island harness, opened by the same link with `&screen=islands`.
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}&screen=islands'`, PACKAGE);
    await until(() => screen().filter((n) => /^(markdown|diff|editor): ready \d/.test(n.text)).length === 3, "all three islands to report ready", 120);
    await until(() => screen().filter((n) => /drawn \d/.test(n.text)).length >= 2, "the islands to draw", 120);
    await sleep(3000);
    shot("7-islands");
    for (const n of screen().filter((n) => /^(markdown|diff|editor):/.test(n.text))) console.log(`(3) ${n.text}`);

    // Typing into the editable island (v2). One swipe over the markdown island brings the editor up — a swipe
    // over Monaco scrolls Monaco, not the page. Keys go to CodeMirror inside the WebView, and each change
    // must come back over the bridge as an event the readout counts.
    adb("shell", "input", "swipe", "540", "1100", "540", "300", "300");
    await sleep(1000);
    const typeInto = (): void => {
      const editor = screen().find((n) => n.text.includes("first line"));
      if (editor === undefined) throw new Error("the editor island is not on screen");
      adb("shell", "input", "tap", "700", String(Math.round(editor.y)));
    };
    typeInto();
    await sleep(1500);
    // Gboard's first appearance opens a stylus tutorial over everything, which would take the keys.
    if (says("Try out your stylus")) {
      tap("Cancel");
      await sleep(1000);
      typeInto();
      await sleep(1000);
    }
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END");
    adb("shell", "input", "text", "%styped%son%sthe%semulator");
    await until(() => says("typed on the emulator"), "the typed text in the editor", 20);
    shot("8-editor-typed");
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    adb("shell", "input", "swipe", "540", "400", "540", "1500", "300");
    await until(() => screen().some((n) => /^editor: .*events (\d+)/.exec(n.text) !== null && Number(/events (\d+)/.exec(n.text)![1]) >= 22), "the typed keys to come back over the bridge", 20);
    console.log(`(4) ${screen().find((n) => n.text.startsWith("editor:"))!.text}`);

    // Gesture handler 2.x's `findNodeHandle` under StrictMode is reported in a development build, and
    // nothing is wrong (`DesktopFrame.tsx`); anything else is.
    // `uiautomator dump` itself sometimes dies ("FATAL EXCEPTION: UiAutomation"): that process is not the app.
    const log = adb("logcat", "-d", "-s", "ReactNativeJS:E", "AndroidRuntime:E").split("\n");
    const dumper = new Set(log.filter((l) => l.includes("FATAL EXCEPTION: UiAutomation")).map((l) => l.split(/\s+/)[2]));
    const crashes = log.filter((l) => /E (ReactNativeJS|AndroidRuntime)/.test(l) && !l.includes("is deprecated in StrictMode") && !dumper.has(l.split(/\s+/)[2]));
    console.log(crashes.length === 0 ? "no JavaScript or runtime errors in logcat" : `logcat errors:\n  ${crashes.slice(0, 10).join("\n  ")}`);
    if (metro !== undefined) writeFileSync(join(OUT, "metro.log"), metroLog);
  } finally {
    metro?.kill();
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
}

await main();
