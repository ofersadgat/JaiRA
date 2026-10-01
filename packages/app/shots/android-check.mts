/**
 * The phone app on the Android emulator, in the fidelity gate's own world (decision 0015): what
 * `android.mts` does for the rooms, done for the states a room is rarely in — a gate parked in a
 * conversation, the changeset reviewer, a run's rail, a card in the air.
 *
 *   npx tsx packages/app/shots/android-check.mts up [--reseed] [--metro 8082] [--port 9292]     leave it running
 *   npx tsx packages/app/shots/android-check.mts screen [filter]        what the phone says, and where
 *   npx tsx packages/app/shots/android-check.mts tap "<text>" [nth]     press what reads so
 *   npx tsx packages/app/shots/android-check.mts shot <name> [x,y,w,h]  photograph it (or a part, enlarged) into parity/android/
 *   npx tsx packages/app/shots/android-check.mts open [query]           the app again, by its link (`&still=1` kept)
 *   npx tsx packages/app/shots/android-check.mts reload [moving]        stopped and opened again, on the sources as saved
 *                                                                       (`moving`: nothing held still)
 *   npx tsx packages/app/shots/peek.mts '<expression>' --port 9292      the desktop the phone is paired with
 *
 * `up` seeds `parityWorld.mts`'s world once (kept between runs, as a studio keeps its own), launches the
 * desktop on it, makes the tasks some scenes make the first time they are reached (an answered gate, an
 * adoption, the conversations), serves the debug build its JavaScript from a Metro of this run's own,
 * pairs the emulator by the deep link and stays up until `parity/android/.release` appears. The link
 * carries `&still=1`: the app's endless animations (the waiting line's pulse, a spinner) stand still, so
 * `uiautomator dump` — which waits for the screen to be idle and has no way to be told not to — can
 * read it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { SCENES, drawn, seed } from "./parityWorld.mjs";
import { buildWorld, type World } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "android");
const DIR = join(import.meta.dirname, ".world-android-check");
const CLIENT = join(import.meta.dirname, "..", "..", "client");
const APK = join(CLIENT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const SDK = process.env["ANDROID_HOME"] ?? join(process.env["LOCALAPPDATA"] ?? "", "Android", "Sdk");
const ADB = join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const SERIAL = arg("--serial") ?? "emulator-5554";
const METRO = Number(arg("--metro") ?? 8082);
const PORT = Number(arg("--port") ?? 9292);
const PACKAGE = "com.mistlabs.jaira";
/** Where `up` leaves the link it paired by, for `open`. */
const LINK = join(OUT, ".link");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const adb = (...args: string[]): string => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

export interface Node {
  text: string;
  x: number;
  y: number;
  box: [number, number, number, number];
}

/** Everything on screen that has text (or an accessible name), with where it is — from `uiautomator dump`. */
export function screen(): Node[] {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("shell", "cat", "/sdcard/ui.xml");
  const nodes: Node[] = [];
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    const text = (m[1] || m[2] || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n");
    const box: [number, number, number, number] = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    if (text !== "") nodes.push({ text, x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, box });
  }
  return nodes;
}

/**
 * Photograph the phone. `crop` (`x,y,w,h` in device pixels) keeps a part of it, drawn three times its
 * size: fitted to a phone the desktop's layout is a third of its own size, too small to read whole.
 */
export function shot(name: string, crop?: readonly [number, number, number, number]): void {
  mkdirSync(OUT, { recursive: true });
  let png: Buffer = execFileSync(ADB, ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 1 << 28 });
  if (crop !== undefined) {
    const whole = PNG.sync.read(png);
    const [x, y, w, h] = crop;
    const by = 3;
    const part = new PNG({ width: w * by, height: h * by });
    for (let row = 0; row < h * by; row++) {
      for (let col = 0; col < w * by; col++) {
        const from = ((y + Math.floor(row / by)) * whole.width + x + Math.floor(col / by)) * 4;
        whole.data.copy(part.data, (row * part.width + col) * 4, from, from + 4);
      }
    }
    png = PNG.sync.write(part);
  }
  writeFileSync(join(OUT, `${name}.png`), png);
  console.log(`  ${name}.png`);
}

export function tap(text: string, nth = 0): void {
  const all = screen();
  const exact = all.filter((n) => n.text === text);
  const node = (exact.length > 0 ? exact : all.filter((n) => n.text.includes(text)))[nth];
  if (node === undefined) throw new Error(`nothing on screen reads "${text}"`);
  adb("shell", "input", "tap", String(Math.round(node.x)), String(Math.round(node.y)));
}

async function until(test: () => boolean, what: string, seconds = 90): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    try {
      if (test()) return;
    } catch {}
    await sleep(1000);
  }
  shot(`failed-${what.replace(/\W+/g, "-")}`);
  throw new Error(`gave up waiting for ${what}`);
}

/** The task parked at a changeset review whose changes are pictures, and its workflow. */
export const PICTURES = "review the new mark";
const svg = (body: string, width = 160, height = 96): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
/**
 * The set `changesetSpecimens.tsx` reviews on web: a picture redrawn (an SVG, which travels as its own
 * source), one added, and a change of code — so the reviewer opens on a comparison, and its diff island
 * is one press away.
 */
const PICTURE_CHANGESET = {
  source: "git:4f3a2b1c9d8e7f60a1b2c3d4e5f60718293a4b5c",
  changes: [
    {
      id: "i1",
      path: "assets/logo.svg",
      action: "update",
      reason: "the mark nudged right, with the new badge beside it",
      before: svg(`<rect x="8" y="8" width="144" height="80" rx="10" fill="#e8eefc"/><circle cx="56" cy="48" r="24" fill="#3b5bdb"/>`),
      after: svg(`<rect x="8" y="8" width="144" height="80" rx="10" fill="#e8eefc"/><circle cx="60" cy="48" r="24" fill="#3b5bdb"/><rect x="96" y="36" width="40" height="24" rx="4" fill="#f59f00"/>`),
    },
    { id: "i2", path: "assets/badge.svg", action: "create", reason: "the badge on its own", after: svg(`<circle cx="24" cy="24" r="20" fill="#2f9e44"/><path d="M14 25 l7 7 l13 -15" stroke="#fff" stroke-width="4" fill="none"/>`, 48, 48) },
    {
      id: "c1",
      path: "src/availability.ts",
      action: "update",
      reason: "answer from the cached snapshot while it is young enough",
      before: ["export async function availability(): Promise<Snapshot> {", "  return await probeEverything();", "}"].join("\n"),
      after: ["export async function availability(): Promise<Snapshot> {", "  if (cached !== null && Date.now() - cached.checkedAt < INTERVAL) return cached;", "  cached = await probeEverything();", "  return cached;", "}"].join("\n"),
    },
  ],
};
const PICTURES_WORKFLOW = {
  label: "Pictures",
  inputs: { changeset: { schema: { type: "object" } } },
  outputs: { decision: { schema: { type: "string" }, optional: true }, decisions: { schema: { type: "array", items: { type: "object" } }, optional: true } },
  operation: { kind: "function", function: "review_artifacts", args: { prompt: "Review the new mark.", tree: "proposal" } },
};

/** Make the task parked at the picture review, once: its workflow written into the project, then started. */
async function pictures(desktop: App): Promise<void> {
  const projects = await desktop.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const at = project !== undefined ? { project } : {};
  const tasks = await desktop.ipc<Array<{ title: string }>>("task:list", at);
  if (tasks.some((t) => t.title === PICTURES)) return;
  await desktop.ipc("workflow:write", { stateId: "pictures", layer: "project", ...at, text: JSON.stringify(PICTURES_WORKFLOW, null, 2) });
  const made = await desktop.ipc<{ taskId: string }>("task:create", { title: PICTURES, workflow: "pictures", inputs: { changeset: PICTURE_CHANGESET }, ...at });
  await desktop.ipc("task:start", { taskId: made.taskId, fake: [], ...at });
  for (let i = 0; i < 40; i++) {
    const pending = await desktop.ipc<Array<{ taskId: string }>>("interaction:pending", undefined);
    if (pending.some((p) => p.taskId === made.taskId)) return;
    await sleep(500);
  }
  throw new Error("the picture review never parked at its gate");
}

/**
 * A debug build's settings, in its own preferences: its JavaScript from its own localhost (which `adb
 * reverse` sends to this run's Metro — an emulator asks the host's 8081 otherwise), and Fast Refresh off:
 * the sources are shared, and another copier's save reloaded the app under a state a check had just
 * reached. A change is picked up by `reload`.
 */
function prefs(): void {
  adb("shell", `run-as ${PACKAGE} sh -c 'mkdir -p shared_prefs && echo "<map><string name=\\"debug_http_host\\">localhost:8081</string><boolean name=\\"hot_module_replacement\\" value=\\"false\\" /></map>" > shared_prefs/${PACKAGE}_preferences.xml'`);
}

/** The app again, by the link it was paired with (its code is spent: the kept pairing stands). */
function open(query?: string): void {
  // `moving`: without `&still=1`, to watch what moves (the screen then reads only while nothing does).
  const kept = readFileSync(LINK, "utf8");
  const link = query === "moving" ? kept.replace("&still=1", "") : kept + (query !== undefined ? `&${query}` : "");
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, PACKAGE);
}

/** A run fifteen states deep: past a dozen the rail has no room for a lane each, and stacks the shallow ones in one striped column. */
export const DEEP = "walk down the well";
const DEPTH = 15;

/** Make it, once: a chain of states each mounting the next as its one child, the last a prompt a fake model answers. */
async function deep(desktop: App): Promise<void> {
  const projects = await desktop.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const at = project !== undefined ? { project } : {};
  const tasks = await desktop.ipc<Array<{ title: string }>>("task:list", at);
  if (tasks.some((t) => t.title === DEEP)) return;
  for (let i = DEPTH - 1; i >= 0; i--) {
    const stateId = ["well", ...Array.from({ length: i }, () => "down")].join("/");
    const state =
      i === DEPTH - 1
        ? { label: "Floor", outputs: { said: { schema: { type: "string" }, binding: ".operation.output.said" } }, operation: { prompt: "Say what is at the bottom.", model: "planner", output: { said: { schema: { type: "string" } } } } }
        : { label: i === 0 ? "Well" : `Level ${i}`, environment: { kind: "prompt", model: "planner" }, children: { down: {} }, sequence: ["down"] };
    await desktop.ipc("workflow:write", { stateId, layer: "project", ...at, text: JSON.stringify(state, null, 2) });
  }
  const made = await desktop.ipc<{ taskId: string }>("task:create", { title: DEEP, workflow: "well", inputs: {}, ...at });
  await desktop.ipc("task:start", { taskId: made.taskId, fake: [{ model: "planner", output: { said: "water" } }], ...at });
  await sleep(4000);
}

/** A run waiting on a MOVE (`on_user_event`): its first gate answered, the next step the person's to take — by a drag on the run's board. */
export const WAITS = "wait for the move";

async function waits(desktop: App): Promise<void> {
  const projects = await desktop.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const at = project !== undefined ? { project } : {};
  const tasks = await desktop.ipc<Array<{ title: string }>>("task:list", at);
  if (tasks.some((t) => t.title === WAITS)) return;
  const gate = (name: string): unknown => ({ label: name, outputs: { confirmed: { schema: { type: "boolean" } } }, operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } } });
  const files: Record<string, unknown> = {
    "evt/a": gate("a"),
    "evt/b": gate("b"),
    "evt/c": gate("c"),
    evt: { label: "Event", children: { a: { state: "evt/a", transitions: [{ to: "c", when: "on_user_event('task_move', { to_state: 'c' })" }] }, b: { state: "evt/b" }, c: { state: "evt/c" } }, sequence: ["a", "b", "c"] },
  };
  for (const [stateId, state] of Object.entries(files)) await desktop.ipc("workflow:write", { stateId, layer: "project", ...at, text: JSON.stringify(state, null, 2) });
  const made = await desktop.ipc<{ taskId: string }>("task:create", { title: WAITS, workflow: "evt", inputs: {}, ...at });
  await desktop.ipc("task:start", { taskId: made.taskId, fake: [], ...at });
  for (let i = 0; i < 40; i++) {
    const pending = await desktop.ipc<Array<{ taskId: string; requestId: string }>>("interaction:pending", undefined);
    const mine = pending.find((p) => p.taskId === made.taskId);
    if (mine !== undefined) {
      await desktop.ipc("interaction:submit", { requestId: mine.requestId, value: { confirmed: true } });
      await sleep(2000);
      return;
    }
    await sleep(500);
  }
  throw new Error("the waiting run never parked at its first gate");
}

async function up(): Promise<void> {
  if (!existsSync(APK)) throw new Error(`no debug APK at ${APK}: build it with ./gradlew assembleDebug`);
  mkdirSync(OUT, { recursive: true });
  const devices = execFileSync(ADB, ["devices"], { encoding: "utf8" });
  if (!devices.includes(`${SERIAL}\tdevice`)) throw new Error(`${SERIAL} is not attached:\n${devices}`);

  let world: World;
  if (process.argv.includes("--reseed") || !existsSync(join(DIR, "home"))) {
    console.log("seeding the world (a minute or two)…");
    world = buildWorld(DIR);
    await seed(world, OUT, PORT + 1000);
  } else {
    world = { home: join(DIR, "home"), project: join(DIR, "project"), userData: join(DIR, "user-data") };
  }
  const desktop = await App.launch(world, { out: OUT, port: PORT });
  let metro: ChildProcess | undefined;
  try {
    await desktop.until(drawn, "the desktop to draw", 400);
    // What some scenes make the first time they are reached: the answered gate, the adoption, the
    // conversations (one with tool calls, one with a page). Reached once on the desktop's own page.
    for (const name of ["task-answered", "task-adopted", "conversation", "conversation-tools"]) {
      try {
        await SCENES.find((s) => s.name === name)!.reach(desktop);
      } catch (e) {
        console.log(`(the desktop did not reach ${name}: ${(e as Error).message})`);
      }
    }
    await pictures(desktop);
    await deep(desktop);
    await waits(desktop);

    let running = false;
    try {
      running = (await fetch(`http://127.0.0.1:${METRO}/`)).status < 500;
    } catch {}
    metro = running ? undefined : spawn(process.execPath, ["--max-old-space-size=8192", join(CLIENT, "..", "..", "node_modules", "one", "run.mjs"), "dev", "--port", String(METRO)], { cwd: CLIENT, stdio: ["ignore", "pipe", "pipe"] });
    let metroLog = "";
    const said = (d: Buffer): void => {
      metroLog = (metroLog + String(d)).slice(-200_000);
      writeFileSync(join(OUT, "metro-check.log"), metroLog);
    };
    metro?.stdout?.on("data", said);
    metro?.stderr?.on("data", said);
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${METRO}/`)).status < 500) break;
      } catch {}
      await sleep(1000);
    }
    if (metro !== undefined) await fetch(`http://127.0.0.1:${METRO}/index.bundle?platform=android&dev=true&minify=false`).then((r) => r.arrayBuffer(), () => undefined);
    console.log(`Metro on ${METRO}${running ? " (already running)" : ""}`);

    const shown = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    const port = shown.self.port;
    if (port === undefined || shown.pairing === undefined) throw new Error("the desktop's engine is not listening for devices, or showed no code");
    adb("reverse", "tcp:8081", `tcp:${METRO}`);
    adb("reverse", `tcp:${port}`, `tcp:${port}`);
    adb("install", "-r", APK);
    adb("shell", "am", "force-stop", PACKAGE);
    prefs();
    adb("logcat", "-c");
    const link = `jaira:///?address=${encodeURIComponent(`127.0.0.1:${port}`)}&code=${shown.pairing.code.replace(/[^A-Za-z0-9]/g, "")}&still=1`;
    writeFileSync(LINK, link);
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, PACKAGE);
    await until(() => screen().some((n) => n.text.includes("Open a project")), "the app to pair, connect and draw the shell", 300);
    console.log(`ready: the phone is paired with the desktop on CDP port ${PORT}; touch ${join(OUT, ".release")} to stop`);
    while (!existsSync(join(OUT, ".release"))) await sleep(1000);
    rmSync(join(OUT, ".release"));
  } finally {
    metro?.kill();
    await desktop.close();
  }
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "screen") {
  const filter = process.argv[3];
  for (const n of screen()) if (filter === undefined || n.text.includes(filter)) console.log(`${JSON.stringify(n.text)} @ ${Math.round(n.x)},${Math.round(n.y)} [${n.box.join(",")}]`);
} else if (command === "tap") tap(process.argv[3]!, Number(process.argv[4] ?? 0));
else if (command === "shot") shot(process.argv[3]!, process.argv[4] !== undefined ? (process.argv[4].split(",").map(Number) as [number, number, number, number]) : undefined);
else if (command === "open") open(process.argv[3]);
else if (command === "reload") {
  // Stopped and opened again: the bundle is fetched afresh, with whatever was saved since.
  adb("shell", "am", "force-stop", PACKAGE);
  prefs();
  open(process.argv[3]);
  await until(() => screen().some((n) => n.text.includes("Open a project")), "the app to draw the shell again", 180);
} else if (command === "tall") {
  // A layout that ran away (a `Press` growing in a box whose height was still being settled): any view
  // taller than twenty screens, from the activity's own view hierarchy — read without waiting for idle.
  const top = adb("shell", "dumpsys", "activity", "top");
  const mine = top.slice(top.lastIndexOf(`ACTIVITY ${PACKAGE}`));
  const tall = [...mine.matchAll(/(\S+)\{\S+ [^}]*? (-?\d+),(-?\d+)-(-?\d+),(-?\d+)[ }]/g)].filter((m) => Number(m[5]) - Number(m[3]) > 48_000);
  for (const m of tall.slice(0, 12)) console.log(`${m[1]!.split(".").pop()} ${m[2]},${m[3]}-${m[4]},${m[5]}`);
  console.log(tall.length === 0 ? "no view taller than twenty screens" : `${tall.length} views taller than twenty screens`);
} else if (command === "desk") {
  // The desktop the phone is paired with: `desk click "<text>"`, `desk shot <name>` — the same state on
  // the desktop's own page, to hold the phone's picture against.
  const desktop = await App.connect(PORT, { out: OUT });
  try {
    if (process.argv[3] === "click") await desktop.clickText(process.argv[4]!);
    else if (process.argv[3] === "shot") await desktop.shot(process.argv[4]!);
    else console.log(JSON.stringify(await desktop.evaluate(process.argv[4]!), null, 2));
  } finally {
    await desktop.close();
  }
} else if (command === "pictures") {
  const desktop = await App.connect(PORT, { out: OUT });
  try {
    await pictures(desktop);
    await deep(desktop);
    await waits(desktop);
  } finally {
    await desktop.close();
  }
} else throw new Error("android-check.mts up | screen | tap | shot | open | pictures");
