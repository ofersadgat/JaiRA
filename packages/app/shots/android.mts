/**
 * The phone app on the Android emulator (decision 0015), end to end.
 *
 *   npm --workspace @jaira/client run build:island && (cd packages/client && npx one prebuild --platform android)
 *   (cd packages/client/android && ./gradlew assembleDebug)
 *   npx tsx packages/app/shots/android.mts [--serial emulator-5554] [--metro 8082] [--hold]
 *
 * A desktop with a few tasks and a pairing code showing; Metro (`one dev`) serving the debug build its
 * JavaScript; the emulator reaching Metro and the desktop engine's loopback listener through `adb
 * reverse`. The app is installed, opened by the deep link that pairs and connects it
 * (`jaira:///?address=…&code=…`, what a QR code on Settings → Machines would carry; decision 0013 as
 * amended 2026-09-30) and photographed: the universal shell drawn natively (no WebView in it), fitted
 * and at its own size; the board scrolled under its column headings, which must stay put; a task opened
 * in the panel, Files, Chat and Settings. Then the phone WRITES: its Dark switch is a settings write on
 * the desktop's engine, and the desktop's own window turns dark; and a gate the desktop's run parks at
 * is offered on the phone's strip by a push, opened from there in the phone's own panel and ANSWERED
 * there — the desktop's task moves on. Stopped and opened again with no link, it connects by the token
 * it kept in the keystore. Then, by the same link with `&screen=islands` (its
 * code is spent, so the kept pairing stands), the three islands with their readouts, and text typed
 * into the editable island coming back over the bridge. Last, the desktop forgets the phone, which is
 * dropped and returns to its Connect screen.
 * What the screen says is read from Android's accessibility dump (`uiautomator`), so a tab that shows
 * an error rather than the app is caught. The dump waits for a second in which nothing on screen
 * changes, and a running task's panel counts its seconds: the link says `&still=1`, which holds the
 * app's clocks and spinners (`client/src/native/still.ts`). `android-check.mts` is the same rig kept up,
 * in the fidelity gate's world, for the states a room is rarely in.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "android");
const CLIENT = join(import.meta.dirname, "..", "..", "client");
const APK = join(CLIENT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const SDK = process.env["ANDROID_HOME"] ?? join(process.env["LOCALAPPDATA"] ?? "", "Android", "Sdk");
const ADB = join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const SERIAL = process.argv.includes("--serial") ? process.argv[process.argv.indexOf("--serial") + 1]! : "emulator-5554";
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
  process.env["JAIRA_RENDERER"] = "one";
  const desktop = await App.launch(world, { out: OUT, port: 9290 });
  let metro: ChildProcess | undefined;
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
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
    // A server started just now has bundled nothing: the bundle is asked for here first, so the phone's
    // first screen (and the pairing code's ten minutes) does not wait on it.
    if (metro !== undefined) await fetch(`http://127.0.0.1:${METRO}/index.bundle?platform=android&dev=true&minify=false`).then((r) => r.arrayBuffer(), () => undefined);

    // What "Pair a machine" shows, and where this engine listens (on loopback, like everything of its).
    // Asked for last: the code works for ten minutes.
    const shown = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    const PORT = shown.self.port;
    if (PORT === undefined || shown.pairing === undefined) throw new Error("the desktop's engine is not listening for devices, or showed no code");

    // The emulator reaches the host's Metro and the desktop engine's listener as its own localhost.
    adb("reverse", "tcp:8081", `tcp:${METRO}`);
    adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
    adb("install", "-r", APK);
    adb("shell", "am", "force-stop", PACKAGE);
    // On an emulator React Native asks the HOST's own port 8081 for its JavaScript (10.0.2.2), whatever
    // `adb reverse` says — so `--metro` was ignored, and a shared dev server that had stopped answering
    // left the app on a blank screen (2026-09-30). Told to ask its own localhost, it goes through the
    // reverse above, to whichever Metro this run uses. A debug build's setting, in its own preferences.
    // Fast Refresh off as well: the sources are shared, and another copier's save reloads the app under a
    // state this run has just reached.
    adb("shell", `run-as ${PACKAGE} sh -c 'mkdir -p shared_prefs && echo "<map><string name=\\"debug_http_host\\">localhost:8081</string><boolean name=\\"hot_module_replacement\\" value=\\"false\\" /></map>" > shared_prefs/${PACKAGE}_preferences.xml'`);
    adb("logcat", "-c");
    // The code as its letters and digits alone — however it is typed is read the same — so nothing in
    // the link needs escaping on its way through `adb shell`.
    const link = `jaira:///?address=${encodeURIComponent(`127.0.0.1:${PORT}`)}&code=${shown.pairing.code.replace(/[^A-Za-z0-9]/g, "")}&still=1`;
    const started = Date.now();
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, PACKAGE);

    await until(() => says("Open a project"), "the app to pair, connect and draw the shell", 240);
    const paired = async (): Promise<MachinesView["devices"]> => (await desktop.ipc<MachinesView>("machines:view", undefined)).devices;
    const device = (await paired())[0];
    if (device === undefined || !device.connected || device.kind !== "phone") throw new Error(`the desktop does not list the phone as a connected device: ${JSON.stringify(await paired())}`);
    console.log(`(1) paired by the deep link's code as "${device.label}" and connected in ${Math.round((Date.now() - started) / 1000)} s (first bundle from Metro included)`);
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
    console.log("(2) the task in the panel, Files, Chat and Settings, each drawn");

    // The phone WRITES (decision 0015's v2: nothing is read-only any more). The sidebar's Dark switch is a
    // settings write on the desktop's engine (`config:write`): pressed on the phone, the desktop's own
    // window turns dark from the push its store gets — and light again when the phone switches back.
    if ((await desktop.theme()) !== "light") throw new Error("the desktop did not open in the light look");
    tap("DARK");
    for (let i = 0; i < 60 && (await desktop.theme()) !== "dark"; i++) await sleep(500);
    if ((await desktop.theme()) !== "dark") throw new Error("the phone's switch to dark did not reach the desktop's engine");
    await until(() => says("LIGHT"), "the phone itself to turn dark", 30);
    await sleep(1500);
    quiet();
    shot("6-phone-wrote-dark");
    await desktop.shot("desktop-after-phone-wrote-dark");
    tap("LIGHT");
    for (let i = 0; i < 60 && (await desktop.theme()) !== "light"; i++) await sleep(500);
    if ((await desktop.theme()) !== "light") throw new Error("the phone's switch back to light did not reach the desktop's engine");
    await until(() => says("DARK"), "the phone itself to turn light again", 30);
    console.log("(2) the phone wrote: its Dark switch turned the desktop's own window dark, and back");
    tap("TASKS");

    // A push, about a task: a run on the desktop parks at its gate, and the phone's strip offers it.
    // Pressed there it opens in the phone's own panel, the gate drawn where the run stopped in its
    // conversation, and the phone answers it: the desktop's engine has nothing parked any more.
    const parked = (await desktop.ipc<{ taskId: string }>("task:create", { title: "plan the offline mode", workflow: "feature/plan", inputs: { issue: "# plan the offline mode" } })).taskId;
    await desktop.ipc("task:start", { taskId: parked, fake: blockedAtTheGate() });
    const gates = async (): Promise<Array<{ taskId: string; requestId: string }>> => (await desktop.ipc<Array<{ taskId: string; requestId: string }>>("interaction:pending", undefined)).filter((p) => p.taskId === parked);
    for (let i = 0; i < 60 && (await gates()).length === 0; i++) await sleep(500);
    const gate = (await gates())[0];
    if (gate === undefined) throw new Error("the desktop's run never parked at its gate");
    await until(() => says("Review the critique result."), "the phone to be offered the gate (a push)", 60);
    quiet();
    shot("6-gate-offered");
    tap("Review the critique result.");
    await until(() => screen().some((n) => n.text === "approve"), "the gate to open in the phone's panel", 60);
    await sleep(1500);
    shot("6-gate-in-panel");
    tap("approve");
    for (let i = 0; i < 60 && (await gates()).length > 0; i++) await sleep(500);
    if ((await gates()).length > 0) throw new Error("the phone's answer did not reach the desktop's engine: the gate is still parked");
    await until(() => !says("Review the critique result."), "the phone's strip to let the answered gate go (a push)", 60);
    shot("6-gate-answered");
    console.log("(2) a gate the desktop's run parked at was offered on the phone, opened in its panel and answered there: the desktop's task moved on");

    // Stopped, and opened again as a person opens an app — no link: the token kept in the keystore
    // connects it straight away.
    adb("shell", "am", "force-stop", PACKAGE);
    // The launcher's own intent, once the stop has settled: `monkey` sent straight after it was dropped
    // now and then, and the run waited two minutes at the home screen.
    await sleep(1500);
    adb("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", `${PACKAGE}/.MainActivity`);
    await until(() => says("Open a project"), "the app, opened with no link, to connect by its kept token", 120);
    await sleep(3000);
    quiet();
    shot("6-relaunched");
    console.log("(2) opened again with no link, the phone connected by the token it kept");

    // `--hold`: everything stays up (desktop, Metro, the app) for driving the phone by hand, until
    // `parity/android/.release` appears.
    if (process.argv.includes("--hold")) {
      console.log(`holding: the app is connected; touch ${join(OUT, ".release")} to go on`);
      while (!existsSync(join(OUT, ".release"))) await sleep(1000);
      rmSync(join(OUT, ".release"));
    }

    // The island harness, opened by the same link with `&screen=islands`. Its code is spent: the pairing
    // it made the first time stands.
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

    // Forgotten on the desktop (Settings → Machines → Forget…): the phone's connection is dropped, its
    // next hello refused, and it is back at the Connect screen saying why.
    await desktop.ipc("machines:forget", { id: device.id });
    await until(() => says("Connect to a JaiRA machine"), "the forgotten phone to return to its Connect screen", 60);
    await sleep(1000);
    shot("9-forgotten");
    if ((await paired()).length !== 0) throw new Error("the desktop still lists the forgotten phone");
    console.log("(5) forgotten on the desktop, the phone was dropped and is back at its Connect screen");

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
