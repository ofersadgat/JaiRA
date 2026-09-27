/**
 * Electron main process (DESIGN §2, §11.2): the desktop window.
 *
 * This file is deliberately thin: it owns windows and the IPC seam, and every request is forwarded to
 * the engine, which knows nothing about Electron. The engine is this process's own {@link AppService}
 * by default, or another process's when one already hosts it (decision 0012 §5): a separate server, a
 * second window, a `jaira` command. Either way it is reached through one {@link EngineLink}.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeTheme, powerMonitor, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { isProject } from "@jaira/persistence";
import {
  ARTIFACT_SCHEME,
  IPC_CHANNELS,
  PALETTE_FRAME,
  PUSH_CHANNEL,
  defaultBaseDir,
  pluginSpec,
  type EngineStatus,
  type PluginId,
  type PluginStatus,
  type UpdateState,
  releasePageOf,
  resolveTheme,
  takeHomeFlag,
  THIRD_PARTY_LICENSES_FILE_NAME,
  type JairaAppearanceConfig,
  type IpcChannel,
  type PushMessage,
  type SaveFileRequest,
} from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import { autoUpdater } from "electron-updater";
import {
  AppService,
  HOST_CHANNELS,
  connectEngine,
  discoverEngine,
  hostEngine,
  machineSettings,
  pidAlive,
  resolveBaseDir,
  stackDetail,
  type CrashKind,
  type EngineClient,
  type EngineDiscovery,
  type Handler,
  type HostChannel,
  type HostedEngine,
} from "@jaira/service";
import { UpdateManager, type RestartChoice, type UpdaterPort } from "./updates";
import { cliCommandStatus, installCliCommand, type CliCommandContext } from "./cliCommand";
import { localLink, remoteLink, type EngineLink } from "./engineLink";
import { CLIENT_SCHEME_PRIVILEGES, CLIENT_URL, registerClientProtocol } from "./clientProtocol";
import { startSpikeSocket, type SpikeSocket } from "./spikeSocket";
import { electronKeychain } from "./keychain";
import { tailChromiumLog } from "./chromiumLog";
import { startPlugins } from "@jaira/runtime";

// Source maps are enabled in `entry.cjs`, which loads this bundle — NOT here. The flag registers a
// map for modules compiled after it runs, and by the time this line executes the bundle it belongs to
// has already been compiled. See that file for the whole of the reasoning.

/** `dist/` layout produced by the build (see build.mjs / vite.config.ts). */
const DIST = __dirname;
const RENDERER_HTML = join(DIST, "renderer", "index.html");
/** One's `dist/client`, copied here by `build:client` (decision 0013, S1). */
const CLIENT_DIR = join(DIST, "client");
/**
 * Which renderer the window loads: the One client (the default), or the Vite build it replaced, kept
 * while the spike compares the two (`JAIRA_RENDERER=vite`).
 */
const RENDERER: "one" | "vite" = process.env.JAIRA_RENDERER === "vite" ? "vite" : "one";
/** The throwaway remote transport (0013 S2), when `JAIRA_SPIKE_WS` asks for it. */
let spike: SpikeSocket | undefined;
const PRELOAD = join(DIST, "preload.cjs");

let window: BrowserWindow | undefined;

/**
 * Whether the window's renderer is there to hear a push.
 *
 * `isDestroyed()` answers for the WINDOW, and a window outlives its renderer: after the renderer
 * process dies the BrowserWindow stands, `isDestroyed()` says no, and `webContents.send` reaches a
 * frame that no longer exists. Electron reports that by printing "Error sending from webFrameMain"
 * to the console itself, from inside `send`, without throwing — so the guard around the push could
 * not catch it, and every push after a crash printed one, the crash's own log entry included.
 *
 * True from the page's first load, false from the moment the renderer goes, true again once the
 * reload in {@link reloadAfterCrash} has brought a page back.
 */
let rendererAlive = false;

/**
 * Where the renderer's death is written down, when it is written down at all.
 *
 * A renderer that dies of a native fault leaves nothing behind by default: Chromium handles its own
 * exceptions, so Windows files no Application Error event for it, and without a reporter no
 * minidump is written either. One did exactly that at four in the morning, idle, and the whole of
 * the record was its exit code. Started here, before anything else, so the crashpad handler is
 * attached to every process the app goes on to create. Never uploaded: the dumps stay under
 * `crashDumps`, which the crash entry names, so the next report can be read rather than guessed at.
 */
crashReporter.start({ uploadToServer: false });

/**
 * Report a failure that escaped everything else — to the console AND to the log.
 *
 * The console half is not redundant, it is a DEBT this file incurred by existing. Registering
 * `unhandledRejection` / `uncaughtException` does not add a reporter, it REPLACES Node's: the default
 * printer runs only while no listener is installed. So handlers that merely recorded would have
 * bought the Logs panel by taking away the terminal — and the terminal is where the one message that
 * explained this whole class of bug (`UnhandledPromiseRejectionWarning: Error: NaN is not allowed`)
 * actually turned up. Trading one silence for a quieter one is not a fix.
 *
 * PRINTED FIRST, for two reasons: the logger is a channel that can fail, and a `push` failure means
 * the Logs panel is precisely the surface that may not be updating.
 *
 * Wrapped twice over. The inner call can fail because there is no engine yet — a crash before this
 * window has found or built one only reaches the console — and because a reporter is code, and code has
 * bad days. Every caller here is a last resort, so the one
 * thing this must not do is throw a second exception over the first.
 */
function reportCrash(kind: CrashKind, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  try {
    // The STACK, not the message: a bare message is what made the original report unactionable, and
    // `entry.cjs` has source maps on now, so these frames name real files.
    console.error(`[jaira] ${kind}:`, e.stack ?? e.message);
  } catch {
    // A console that cannot be written to is not a reason to lose the record below.
  }
  try {
    link?.recordCrash(kind, e);
  } catch {
    // Nothing above to catch it and nothing left to report with.
  }
}

/**
 * The two failures that used to leave no trace at all.
 *
 * Electron runs Node with `--unhandled-rejections=warn`, so a rejection nobody handled prints one
 * warning to stdout and the process carries on as if nothing happened. That is how an hour went
 * missing: a run stalled, the app looked healthy, the Logs panel was empty, and the sentence naming
 * the cause — `Error: NaN is not allowed` — had been written to a console the app does not own.
 *
 * Registered at MODULE LOAD rather than in `whenReady`, because the service is constructed below and
 * construction is itself something that can throw; a net installed after the fall is not a net.
 *
 * Neither handler exits. An uncaught exception in the main process of a desktop app is not
 * automatically fatal, the run loop already fails the run it belongs to, and killing the window would
 * destroy the very Logs panel someone needs to read next.
 */
process.on("unhandledRejection", (reason: unknown) => reportCrash("unhandledRejection", reason));
process.on("uncaughtException", (error: unknown) => reportCrash("uncaughtException", error));

/**
 * Node's own warnings, which went to a console this app does not own.
 *
 * The third silence, and the same shape as the two above: `MaxListenersExceededWarning` named a real
 * accumulation, and the only place it appeared was the terminal of whoever happened to have started
 * the app from one. The Logs panel — the surface built for exactly this — said nothing.
 *
 * This one incurs NO debt, unlike its neighbours. `unhandledRejection` and `uncaughtException` are
 * "default runs only if nobody listens" events, so registering there took the terminal away and had
 * to buy it back with a `console.error`. `warning` is not: Node's printer is an ordinary listener
 * registered at bootstrap, so adding another one is purely additive and the terminal keeps its copy.
 *
 * `--trace-warnings` is therefore not needed and is not the fix. It changes what Node's printer
 * prints; the `Error` handed to a listener has carried `.stack` all along, and that stack names the
 * exact line that added the eleventh listener. Recording it is the difference between "something in
 * this process leaks" and a file and a line number.
 */
process.on("warning", (warning: Error) => {
  try {
    link?.recordWarning(warning);
  } catch {
    // Same last-resort rule as `reportCrash`: the reporter must not become the failure.
  }
});

/**
 * `--home <dir>` off this launch's command line — the same flag the CLI takes.
 *
 * A COMMAND LINE beats a saved preference, which is why this is passed as `baseDir` rather than left
 * to `settingsBaseDir()`: the setting is where the base root normally lives, and the flag is how you
 * open a second window on a different one without changing what the first window will do next time.
 * The precedence that falls out is the one people expect — flag, then `JAIRA_HOME`, then the saved
 * setting, then `~/.jaira`.
 *
 * A malformed flag is ignored rather than fatal. There is no terminal to print usage into here, and
 * refusing to launch a desktop app over a typo in an argument leaves somebody with a window that
 * never appears and nothing that says why.
 */
const home = takeHomeFlag(process.argv.slice(1)).home;

/** The shared root this window stands on, resolved the way the engine resolves it (flag, env, saved setting, `~/.jaira`). */
const baseDir = resolveBaseDir(home);

// Downloadable plugins (decision 0011 §6): the store under the base root, from the manifest the build
// wrote beside this bundle. Opened before the service, whose startup probes ask whether the Claude
// Agent SDK and node-llama-cpp are there.
const plugins = startPlugins(home ?? defaultBaseDir(), __dirname);

/** Tell the window something. The service's pushes and the updater's both go this way. */
function pushToWindow(message: PushMessage): void {
  spike?.publish(message);
  // GUARDED, because this is a send into another process and the service treats it as a statement.
  //
  // `webContents.send` structure-clones its argument and throws on anything it cannot represent, and
  // it throws again for a window torn down between the check and the call. A window whose RENDERER
  // is gone is a third case, and one `send` does not throw for — see `rendererAlive`. Every caller upstream is
  // ordinary bookkeeping — "a run started", "the board changed" — written as if telling the window
  // were free. It is not, and an exception here surfaces wherever that bookkeeping happened to sit,
  // which for an engine event is inside the run.
  //
  // A push is NEWS, and news that cannot be delivered is not the sender's failure to survive: the
  // renderer refetches on reconnect and on `store:invalidate`, so a dropped frame costs latency and
  // nothing else.
  try {
    if (window && !window.isDestroyed() && rendererAlive) window.webContents.send(PUSH_CHANNEL, message);
  } catch (e) {
    // Not through `service.log`, which would publish a `log:entry` back through this same failing
    // channel. `recordCrash` records; whether the window hears about it is a separate question that
    // this frame is in no position to answer.
    reportCrash("push", new Error(`'${message.type}' could not be delivered: ${(e as Error).message}`));
  }
  // …and to every client of the engine's pipe (decision 0012 §3), under the same rule: news.
  try {
    hosted?.host.broadcast(message);
  } catch (e) {
    reportCrash("push", new Error(`'${message.type}' could not be sent on the engine's pipe: ${(e as Error).message}`));
  }
  if (message.type === "store:invalidate" && message.scope === "config") afterConfigWrite();
  // A sign-in page from an engine with no screen of its own (`jaira serve`): opened here, where the
  // person is (decision 0013 §8). Only http(s), for the reason `openExternal` gives.
  if (message.type === "open:external" && /^https?:\/\//i.test(message.url)) void shell.openExternal(message.url).catch(() => undefined);
}

/**
 * The engine this window uses (decision 0012 §5): its own, or another process's. Undefined only while
 * it is being found or built — at the start, and after the host it used went away.
 */
let link: EngineLink | undefined;
/** This process's hold on the engine's pipe, when this window hosts the engine. */
let hosted: HostedEngine | undefined;
/** This window started the separate server it uses (`engine.separateServer`). */
let startedServer = false;
/** Why this window is not using the engine it would have chosen. */
let engineNote: string | undefined;

/** Stops reading Chromium's log, after one last read; set once the engine is there to read it into. */
let stopChromiumLog = (): void => undefined;

/** Where this window's engine runs, for About. */
function engineStatus(): EngineStatus {
  const host = link?.host;
  return {
    mode: link === undefined ? "starting" : link.mode,
    ...(host !== undefined ? { host: { kind: host.kind, pid: host.pid, version: host.version, startedAt: host.startedAt } } : {}),
    pid: process.pid,
    startedServer,
    ...(engineNote !== undefined ? { note: engineNote } : {}),
  };
}

/**
 * What this launch IS, said once, before anything can go wrong in it.
 *
 * The Logs panel used to open on a list whose first line was whatever had already broken, with no
 * way to tell which build was running, which base root it was pointed at, or whether the command
 * line had asked for something other than the default — and every one of those is the first question
 * asked of a report. It is `info`, and it is the boundary between launches now that the panel reads
 * back the ones before it (see `Diagnostics.hydrate`): the entries above this line are history.
 *
 * `argv` WHOLE, minus the executable. It is the flags this run was given — the thing a person is
 * asking about when they say "but I passed `--home`" — and it holds nothing a log may not have: the
 * app's own flags are paths, and paths are already the substance of half the entries here.
 */
function recordLaunch(engine: EngineLink): void {
engine.recordApp("info", `JaiRA ${app.getVersion()} started`, {
  argv: process.argv.slice(1),
  home: home ?? null,
  baseDir,
  engine: engine.mode === "local" ? "this window" : `${engine.host?.kind ?? "?"} pid ${engine.host?.pid ?? "?"}`,
  pid: process.pid,
  platform: `${process.platform}-${process.arch}`,
  // Which downloadable plugins this machine has (decision 0011 §6); null when the build ships no manifest.
  plugins: plugins === undefined ? null : plugins.status().flatMap((s) => (s.installed !== undefined ? [`${s.id}@${s.installed}`] : [])),
  electron: process.versions["electron"] ?? null,
  chrome: process.versions["chrome"] ?? null,
  node: process.versions["node"] ?? null,
  // What the libraries will actually emit into this panel: `@declarative-ai/log` drops anything
  // below its minimum BEFORE the sink sees it, so a panel with no `debug` in it is not necessarily
  // a quiet app. Naming the level here is what makes that visible rather than mysterious.
  logLevel: process.env["LOG_LEVEL"] ?? "info (default; set LOG_LEVEL=debug for more)",
});
}

/**
 * Why this build cannot update itself, or nothing when it can (decision 0011 §4). The feed file is
 * written by electron-builder when the build is packaged with a publish target (`package.mjs`); Linux
 * updates only the AppImage (which says where it is in `APPIMAGE`) and the `.deb` (which carries the
 * `package-type` marker electron-updater installs it by).
 */
function updateDisabledReason(): string | undefined {
  if (!app.isPackaged) return "a development build does not update itself";
  if (process.env["JAIRA_DISABLE_AUTO_UPDATE"] !== undefined) return "turned off by JAIRA_DISABLE_AUTO_UPDATE";
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return "this build has no update feed";
  if (process.platform === "linux" && process.env["APPIMAGE"] === undefined && !existsSync(join(process.resourcesPath, "package-type"))) {
    return "only the AppImage and .deb builds update themselves";
  }
  return undefined;
}

/**
 * What the packaging step recorded about this build (`package.mjs` writes `jairaBuild` into the
 * packaged `package.json`). A development build has none.
 */
function buildInfo(): { macSigned?: boolean } {
  try {
    const manifest = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { jairaBuild?: { macSigned?: boolean } };
    return manifest.jairaBuild ?? {};
  } catch {
    return {};
  }
}

/**
 * A check or download that failed is one of Settings' warnings, on About, until one succeeds. Only a
 * change is reported: the updater publishes on every step, the board need not hear each.
 */
let updateHealth: string | undefined;
function noteUpdateHealth(state: UpdateState): void {
  const problem = state.status === "error" ? (state.error ?? "the update could not be checked or downloaded") : undefined;
  if (problem === updateHealth) return;
  updateHealth = problem;
  if (problem === undefined) link?.healthClear("update");
  else link?.healthSet({ id: "update", level: "warning", page: "about", title: "Updates", detail: problem, action: "retry-update" });
}

/** What the `jaira` command's status and install need to know about this app (`cliCommand.ts`). */
function cliContext(): CliCommandContext {
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    resources: process.resourcesPath,
    ...(process.env["LOCALAPPDATA"] !== undefined ? { localAppData: process.env["LOCALAPPDATA"] } : {}),
    ...(process.env["APPIMAGE"] !== undefined ? { appImage: process.env["APPIMAGE"] } : {}),
  };
}

/** Where the updater remembers the version whose notice was dismissed: the machine's, beside `limits.json`. */
const updatesFile = join(baseDir, "system", "updates.json");

function readDismissed(): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(updatesFile, "utf8")) as { dismissed?: unknown }).dismissed;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const updates = (() => {
  const disabledReason = updateDisabledReason();
  const dismissed = readDismissed();
  if (disabledReason === undefined) {
    autoUpdater.logger = {
      info: (message: unknown) => link?.recordApp("debug", `updater: ${String(message)}`),
      // Shown in Settings as the update's warning, so not counted again from the log.
      warn: (message: unknown) => link?.recordApp("warn", `updater: ${String(message)}`, undefined, "update"),
      error: (message: unknown) => link?.recordApp("warn", `updater: ${String(message)}`, undefined, "update"),
      debug: () => undefined,
    };
  }
  return new UpdateManager({
    version: app.getVersion(),
    ...(disabledReason === undefined ? { port: autoUpdater as unknown as UpdaterPort } : { disabledReason }),
    // Squirrel.Mac installs only an app signed with a Developer ID; until there is one (0011 §2), a mac
    // build checks and points at the release page.
    manual: process.platform === "darwin" && buildInfo().macSigned !== true,
    releaseUrl: releasePageOf,
    publish: (state) => {
      pushToWindow({ type: "update:changed", state });
      noteUpdateHealth(state);
    },
    log: (level, message, data) => link?.recordApp(level, message, data as JsonValue | undefined, level === "warn" ? "update" : undefined),
    // What a quit would cut. An engine in another process is cut only when installing replaces the
    // binary it runs on — a server this install started — and then it is stopped before the install.
    busy: () => (link === undefined ? { runs: 0, turns: 0 } : link.mode === "local" || sameInstall() ? link.activeWork() : { runs: 0, turns: 0 }),
    suspendForUpdate: () => (link === undefined ? undefined : link.mode === "local" || sameInstall() ? link.suspendForUpdate() : undefined),
    // The ordinary quit: `before-quit` below drains, closes, and then lets the updater install.
    quit: () => setImmediate(() => app.quit()),
    ...(dismissed !== undefined ? { dismissed } : {}),
    saveDismissed: (version) => {
      try {
        mkdirSync(dirname(updatesFile), { recursive: true });
        writeFileSync(updatesFile, `${JSON.stringify({ dismissed: version })}\n`);
      } catch (e) {
        link?.recordApp("warn", "could not remember the dismissed update", { message: (e as Error).message });
      }
    },
  });
})();

/**
 * The downloadable plugins as the window sees them (decision 0011 §6): the store's status, with the
 * download under way and the last failure held here, where the downloads run.
 */
const pluginProgress = new Map<PluginId, { done: number; total: number }>();
const pluginErrors = new Map<PluginId, string>();

function pluginStatuses(): PluginStatus[] {
  return (plugins?.status() ?? []).map((status) => {
    const progress = pluginProgress.get(status.id);
    const error = pluginErrors.get(status.id);
    return { ...status, ...(progress !== undefined ? { progress } : {}), ...(error !== undefined ? { error } : {}) };
  });
}

function publishPlugins(): void {
  pushToWindow({ type: "plugin:changed", plugins: pluginStatuses() });
}

/** Download a plugin; a failure is kept on its row rather than thrown, so the page can say it and offer Try again. */
async function installPlugin(id: PluginId): Promise<PluginStatus[]> {
  if (plugins === undefined) throw new Error("this build carries no plugin manifest");
  if (pluginProgress.has(id)) return pluginStatuses();
  pluginErrors.delete(id);
  pluginProgress.set(id, { done: 0, total: 0 });
  publishPlugins();
  try {
    await plugins.install(id, (p) => {
      pluginProgress.set(id, { done: p.done, total: p.total });
      publishPlugins();
    });
    link?.recordApp("info", `installed the ${pluginSpec(id).title} plugin`);
    link?.healthClear(`plugin:${id}`);
  } catch (e) {
    pluginErrors.set(id, (e as Error).message);
    // A download that did not happen is one of Settings' warnings (the person, 2026-09-26: "failed
    // download should be a warning"), on About, with Try again.
    link?.healthSet({
      id: `plugin:${id}`,
      level: "warning",
      page: "about",
      title: pluginSpec(id).title,
      detail: `download failed: ${(e as Error).message}`,
      action: "retry-plugin",
      subject: id,
    });
    link?.recordApp("warn", `could not install the ${pluginSpec(id).title} plugin: ${(e as Error).message}`, { message: (e as Error).message }, `plugin:${id}`);
  } finally {
    pluginProgress.delete(id);
    publishPlugins();
  }
  // What the routes can run on just changed; the Connections page reads it from the probes.
  void link?.probeExecutors().catch(() => undefined);
  return pluginStatuses();
}

function removePlugin(id: PluginId): PluginStatus[] {
  if (plugins === undefined) throw new Error("this build carries no plugin manifest");
  pluginErrors.delete(id);
  try {
    plugins.remove(id);
  } catch (e) {
    pluginErrors.set(id, `could not remove it: ${(e as Error).message}`);
  }
  publishPlugins();
  void link?.probeExecutors().catch(() => undefined);
  return pluginStatuses();
}

/**
 * The three verbs that could not be service methods.
 *
 * Everything else in the table below forwards to {@link AppService}, which is Electron-free so that
 * the whole app surface stays testable headlessly. These are the exceptions in the same way
 * `reveal` and `chooseDirectory` are: a save dialog, a download and a clipboard bitmap are all
 * Electron's, and there is no shape the service could hold them in that would not be an Electron
 * shim with a port behind it. They live here, where the Electron already is.
 */

/**
 * Save bytes the renderer holds, wherever the person says.
 *
 * The proposed name is reduced to its BASENAME. It arrives as an artifact path — `docs/report.md` —
 * and a `defaultPath` with separators in it proposes a directory that may not exist, so the dialog
 * opens somewhere nobody asked for. The extension is the part that matters and basename keeps it.
 *
 * A cancelled dialog answers `{ file: null }` rather than throwing: the person decided not to save,
 * which is an outcome. Throwing would put "Error: canceled" in the toast.
 */
async function saveFile(request: SaveFileRequest): Promise<{ file: string | null }> {
  const options = { defaultPath: basename(request.name) };
  const target = await (window && !window.isDestroyed()
    ? dialog.showSaveDialog(window, options)
    : dialog.showSaveDialog(options));
  if (target.canceled || target.filePath === undefined || target.filePath === "") return { file: null };
  await writeFile(target.filePath, Buffer.from(request.data, "base64"));
  return { file: target.filePath };
}

/**
 * What may be downloaded by URL — everything a page in this app can legitimately be showing.
 *
 * An allow list rather than a deny list, and short on purpose. The URL reaches here from a
 * right-click, so it is whatever was in a `src` attribute — including one a model wrote — and
 * `javascript:` is the reason a bare `downloadURL` of an arbitrary string is not something to hand
 * a renderer. These five are the schemes an image in this app is actually served from.
 */
const DOWNLOADABLE = new Set(["data:", "blob:", "file:", "http:", "https:", `${ARTIFACT_SCHEME}:`]);

/**
 * Hand a URL to Chromium's downloader, which prompts for a location by itself.
 *
 * The case {@link saveFile} cannot serve: an image inside a sandboxed artifact frame. The renderer
 * cannot read those bytes — an opaque origin is exactly what it must not be able to reach into — but
 * the browser has them decoded already.
 */
function download(url: string): { started: boolean } {
  if (window === undefined || window.isDestroyed()) return { started: false };
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return { started: false };
  }
  if (!DOWNLOADABLE.has(scheme)) return { started: false };
  window.webContents.downloadURL(url);
  return { started: true };
}

/**
 * Copy the image under a point, in the window's own coordinates.
 *
 * Silent when there is no image there — `copyImageAt` is fire-and-forget and reports nothing back —
 * so `copied` says the request was made, not that a bitmap landed. That is honest: the menu only
 * offers this over something Chromium already told us was an image.
 */
/**
 * Cut, copy, paste or select-all, on whatever has focus.
 *
 * Delegated to the WebContents rather than done in the renderer, because that is the only way
 * `paste` works: script may not read the clipboard on a page's own say-so. It also lands in the
 * right place without anybody tracking where that is — Chromium routes these to the focused frame,
 * which is the frame that was just right-clicked.
 */
function edit(verb: "cut" | "copy" | "paste" | "selectAll"): { verb: string } {
  if (window !== undefined && !window.isDestroyed()) window.webContents[verb]();
  return { verb };
}

function copyImageAt(x: number, y: number): { copied: boolean } {
  if (window === undefined || window.isDestroyed()) return { copied: false };
  window.webContents.copyImageAt(Math.round(x), Math.round(y));
  return { copied: true };
}

/**
 * Channel → handler, one entry per contract channel (a missing or misspelled key
 * is a type error). Requests arrive over IPC as structured clones, so each
 * handler asserts the shape its channel declares.
 */

/**
 * The desktop's own answers (`HOST_CHANNELS`): Electron's dialogs and clipboard, and the installed app's
 * updater, plugins, licence file and command. Every other channel is the service's (`serviceHandlers`).
 */
const hostHandlers: Record<HostChannel, Handler> = {
  "shell:saveFile": ((request: SaveFileRequest) => saveFile(request)) as Handler,
  "shell:download": ((request: { url: string }) => download(request.url)) as Handler,
  "shell:copyImageAt": ((request: { x: number; y: number }) => copyImageAt(request.x, request.y)) as Handler,
  "shell:edit": ((request: { verb: "cut" | "copy" | "paste" | "selectAll" }) => edit(request.verb)) as Handler,
  "licenses:read": (() => readLicenseManifest()) as Handler,
  "update:state": (() => updates.current()) as Handler,
  "update:check": (() => updates.check()) as Handler,
  "update:download": (() => updates.download()) as Handler,
  "update:install": ((request: { when?: RestartChoice } | undefined) => updates.apply(request?.when ?? "wait")) as Handler,
  "update:dismiss": ((request: { version: string }) => updates.dismiss(request.version)) as Handler,
  "plugin:list": (() => pluginStatuses()) as Handler,
  "plugin:install": ((request: { id: PluginId }) => installPlugin(request.id)) as Handler,
  "plugin:remove": ((request: { id: PluginId }) => removePlugin(request.id)) as Handler,
  "cli:status": (() => cliCommandStatus(cliContext())) as Handler,
  "cli:install": (() => installCliCommand(cliContext())) as Handler,
  "engine:status": (() => engineStatus()) as Handler,
};
const HOST_ONLY = new Set<string>(HOST_CHANNELS);

/**
 * What a settings write means to this process besides the write: the window controls are drawn by the
 * OS, so a theme switch has to be pushed out to them, and the update channel is read here, not by the window.
 */
function afterConfigWrite(): void {
  repaintTitleBar();
  updates.configure(machineSettings(baseDir).updates);
}

/**
 * The Licenses page's manifest, written beside the renderer by its build (`licenses/thirdPartyLicenses.ts`).
 * Read on each ask rather than kept: the page is opened rarely, and the file is half a megabyte.
 */
async function readLicenseManifest(): Promise<unknown> {
  const file = join(DIST, "renderer", THIRD_PARTY_LICENSES_FILE_NAME);
  if (!existsSync(file)) {
    throw new Error(`The renderer was built without its license manifest (${file}). Rebuild the app: npm run app:build.`);
  }
  const manifest = JSON.parse(await readFile(file, "utf8")) as { schemaVersion?: unknown; entries?: unknown[] };
  // The downloaded plugins' packages are not in the build's manifest — the installer does not ship them —
  // so their notices are added from the store (decision 0011 §6), each tagged with its plugin.
  const fromPlugins = plugins?.notices() ?? [];
  return fromPlugins.length === 0 || !Array.isArray(manifest.entries) ? manifest : { ...manifest, entries: [...manifest.entries, ...fromPlugins] };
}

/** One request, from whichever transport carried it: the window's IPC, or the spike socket (0013 S2). */
async function dispatch(channel: IpcChannel, request: unknown): Promise<unknown> {
  try {
    // Errors surface as rejections the renderer can display; the service's
    // messages are already human-facing ("unknown task 't-1'").
    // The host's own answers here; the rest are the engine's, wherever it runs. A settings write is
    // followed by its `store:invalidate` push, which repaints the frame (`pushToWindow`).
    if (HOST_ONLY.has(channel)) return await (hostHandlers[channel as HostChannel] as (request: unknown) => unknown)(request);
    if (link === undefined) throw new Error("the engine is not reachable yet — JaiRA is finding or starting it");
    return await link.invoke(channel, request);
  } catch (e) {
    // RECORDED, then RETHROWN. The renderer's contract is unchanged — it still gets the rejection
    // and still shows the message — but the failure is no longer invisible to everyone else. Every
    // handler failure in the app becomes one line naming the channel, for six lines here.
    link?.recordIpcFailure(channel, e);
    throw e;
  }
}

function registerIpc(): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, request: unknown) => dispatch(channel, request));
  }
}

/**
 * The frame colour Chromium paints before the document exists.
 *
 * Read from the saved look rather than hardcoded: this is painted before any CSS loads, so a fixed
 * value means every cold start flashes the wrong theme at anyone using the other one. The look is the
 * shared root's with the personal layer's over it (`AppService.windowAppearance`) — never a project's,
 * because a window holds several. The values are `PALETTE_FRAME`, a copy of each palette's `--bg` in
 * `styles.css` — the two have to be kept in step, which is why both say so.
 */
function frameOf(look: JairaAppearanceConfig): { ground: string; panel: string; dim: string } {
  // `system` asks the OS, which is what the renderer asks too (`prefers-color-scheme`).
  return PALETTE_FRAME[look.palette][resolveTheme(look.mode, nativeTheme.shouldUseDarkColors)];
}
/**
 * How many DISTINCT renderer console errors are mirrored into the log before the window stops being
 * quoted. Enough to hold the failure and the handful of warnings that led to it; small enough that a
 * component erroring on every frame cannot fill the panel with one sentence.
 */
const RENDERER_CONSOLE_LIMIT = 50;

/**
 * How tall the strip along the top of the window is, in px.
 *
 * One number, and the renderer must not disagree with it: the OS draws the minimise/maximise/close
 * buttons into a band of exactly this height, and the app reads the band back out of the
 * `titlebar-area-*` CSS environment variables rather than repeating it — see `styles.css`.
 */
const TITLE_BAR_HEIGHT = 34;

/**
 * The window-controls overlay, painted to match the theme.
 *
 * The frame is gone (see {@link createWindow}), so these three buttons are all that is left of it,
 * and they are drawn by the OS over the top-right of the page. That means their background is not
 * ours to style in CSS — it is this value — and a fixed one would leave a white notch in the corner
 * of the dark theme. `--panel`, because what sits under that corner is a panel in every view.
 */
function titleBarOverlay(look: JairaAppearanceConfig): { color: string; symbolColor: string; height: number } {
  const frame = frameOf(look);
  return { color: frame.panel, symbolColor: frame.dim, height: TITLE_BAR_HEIGHT };
}

/**
 * Repaint the window controls after a theme switch.
 *
 * Called from the IPC seam rather than from the renderer over a channel of its own: the theme is
 * already written through `config:write`, and a second round trip that the renderer had to
 * remember to make is a second round trip it would eventually forget. macOS draws its own traffic
 * lights and has no overlay to set, so the call is guarded rather than platform-branched at every
 * use.
 */
function repaintTitleBar(): void {
  if (process.platform === "darwin") return;
  if (window === undefined || window.isDestroyed()) return;
  try {
    window.setTitleBarOverlay(titleBarOverlay(machineSettings(baseDir).appearance));
  } catch {
    // Only available on a window created with an overlay. Nothing here is worth failing a settings
    // write over.
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const look = machineSettings(baseDir).appearance;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: frameOf(look).ground,
    show: false,
    /*
     * NO TITLE BAR, and no menu bar either (see `app.whenReady`).
     *
     * Both were a strip of chrome saying nothing the app does not already say better: the title bar
     * repeated the project name that the sidebar now carries, and the menu bar held the stock
     * Electron menu — File/Edit/View — none of whose items this app defines. What they cost was the
     * top of the window, which is where the sidebar wants to start.
     *
     * `hidden` rather than `frame: false`: the window still needs to be minimised, maximised and
     * closed, and reimplementing those three buttons per platform is how an app comes to look like
     * an app that reimplemented them. The OS keeps drawing them, into the band `titleBarOverlay`
     * describes, and the layout reserves that band through the `titlebar-area-*` env variables.
     */
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlay(look),
    webPreferences: {
      preload: PRELOAD,
      // The renderer gets no Node: its only capability is the typed bridge
      // (DESIGN §11.2), which is also what makes the approval-gate guarantee hold.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  /*
   * A right-click the RENDERER could not have heard.
   *
   * The renderer draws this app's context menus itself, over its own document, and cancels the
   * default — which stops Chromium from ever raising this event for the main frame. What is left is
   * the case it cannot reach: an artifact rendered in a sandboxed frame with an opaque origin, where
   * a `contextmenu` listener in this window hears nothing. That is the sandbox working correctly and
   * not a gap to close, so the fix is not to open the frame up but to forward what the browser
   * process already saw, and let the renderer draw the SAME menu it draws everywhere else.
   *
   * `params.x` / `params.y` are in the web area's coordinates, which is the space a DOM event's
   * `clientX` / `clientY` is in — so the menu lands under the pointer without any translation.
   *
   * Nothing forwarded here is a capability. It is a description of what was clicked; the verbs the
   * menu offers are the same ones it offers over this window's own content, each checked where it
   * runs.
   */
  win.webContents.on("context-menu", (_event, params) => {
    if (win.isDestroyed()) return;
    // Guarded for the same reason the push seam is: a send can throw, and a menu that failed to open
    // must not take down the event handler that would have opened the next one.
    try {
      win.webContents.send(PUSH_CHANNEL, {
        type: "frame:contextMenu",
        menu: {
          x: params.x,
          y: params.y,
          selectionText: params.selectionText,
          linkURL: params.linkURL,
          srcURL: params.srcURL,
          mediaType: params.mediaType,
          isEditable: params.isEditable,
          editFlags: {
            canCut: params.editFlags.canCut,
            canCopy: params.editFlags.canCopy,
            canPaste: params.editFlags.canPaste,
            canSelectAll: params.editFlags.canSelectAll,
          },
        },
      } satisfies PushMessage);
    } catch (e) {
      reportCrash("push", new Error(`context menu could not be forwarded: ${(e as Error).message}`));
    }
  });

  /**
   * What the RENDERER did, when what it did was die.
   *
   * The window going white is a renderer that crashed or a React tree that threw, and until this
   * neither left a single trace anywhere main could see: the Logs panel is drawn BY the renderer, so
   * the one surface that would have reported it is the surface that just stopped existing, and main
   * — which owns the log and survives — was not listening. A report of "the app turned totally
   * white" was therefore the whole of the evidence, and there was nowhere else to look.
   *
   * All four go through {@link reportCrash}, so they print to the terminal AND land in the log the
   * next window will show. `console-message` is deliberately included and deliberately narrowed to
   * errors: it is what carries the renderer's own thrown exceptions across, which is what makes the
   * error boundary's `console.error` reach a place that outlives the crash.
   */
  win.webContents.on("did-finish-load", () => {
    rendererAlive = true;
  });
  /**
   * A link with `target="_blank"` — a package's source on the Licenses page, a review's forge page —
   * goes to the person's browser. Electron's default opens it in a second, frameless app window with
   * no way back; nothing in the app asks for one. Only http(s), for the reason `openExternal` gives.
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    // BEFORE the report: the report is a log entry, a log entry is a push, and the frame it would be
    // pushed into is the one that just went.
    rendererAlive = false;
    reportCrash(
      "renderer",
      new Error(
        `the window's renderer process ended: ${details.reason} (exit ${details.exitCode}); ` +
          `minidumps, if any, are under ${app.getPath("crashDumps")}`,
      ),
    );
    reloadAfterCrash(win, details.reason);
  });
  win.webContents.on("unresponsive", () => {
    reportCrash("renderer", new Error("the window stopped responding — the renderer is blocked or thrashing"));
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    reportCrash("renderer", new Error(`the window would not load: ${description} (${code}) at ${url}`));
  });
  /**
   * …and what it PRINTED, deduplicated, because a console is not a log.
   *
   * Level 3 is `error` in Chromium's levels; below it is the app talking to itself. Even at that
   * level the stream is not all crashes — React reports "each child in a list should have a unique
   * key" through `console.error` too, once per render — so an unfiltered mirror would file a
   * thousand copies of one warning under `crash` and bury the entry somebody opened the panel to
   * find. Distinct messages only, and a hard ceiling: past it the interesting one has already been
   * recorded, and what follows is the same failure repeating.
   */
  const printed = new Set<string>();
  win.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    if (level !== "error" || printed.size >= RENDERER_CONSOLE_LIMIT) return;
    const at = `${message} (${sourceId}:${lineNumber})`;
    if (printed.has(at)) return;
    printed.add(at);
    reportCrash("renderer", new Error(at));
  });

  if (RENDERER === "one") await win.loadURL(CLIENT_URL);
  else await win.loadFile(RENDERER_HTML);
  win.show();
  return win;
}

/**
 * How long a reloaded renderer has to stay up before its next death counts as a fresh one. Inside
 * it, a second death is the same fault meeting the same page, and reloading again would be a loop
 * drawing a white window at full speed.
 */
const RELOAD_BACKOFF_MS = 30_000;
let reloadedAt = 0;

/**
 * Bring the page back after its renderer died.
 *
 * The window stood for eight hours over a dead renderer once — white, with a run parked behind it
 * waiting for an answer nobody could give, until somebody quit the app. Nothing about that wait was
 * necessary: everything the page shows is refetched from the service on load, and the run had never
 * left the service. So a dead renderer is reloaded, once; if the reload dies inside the backoff the
 * window is left as it is, with the reason on record, because a loop would be worse than a blank.
 *
 * `clean-exit` is the renderer leaving on purpose — what a navigation or the quit looks like from
 * here — and is not reloaded. Neither is anything after `before-quit`.
 */
function reloadAfterCrash(win: BrowserWindow, reason: string): void {
  if (reason === "clean-exit" || closing || win.isDestroyed()) return;
  const now = Date.now();
  if (now - reloadedAt < RELOAD_BACKOFF_MS) {
    link?.recordApp(
      "error",
      `the renderer died again within ${RELOAD_BACKOFF_MS / 1000}s of being reloaded; leaving the window as it is`,
    );
    return;
  }
  reloadedAt = now;
  link?.recordApp("info", "reloading the window after its renderer died");
  try {
    win.webContents.reload();
  } catch (e) {
    reportCrash("renderer", new Error(`the window could not be reloaded: ${(e as Error).message}`));
  }
}

/**
 * Debug/CI affordance: with `JAIRA_CAPTURE=<file.png>` the window is screenshotted
 * once the first paint has settled and the app exits. It makes the UI verifiable
 * from a headless script (and in CI) instead of only by eye.
 */
async function captureAndExit(win: BrowserWindow, file: string): Promise<void> {
  const settleMs = Number(process.env["JAIRA_CAPTURE_DELAY_MS"] ?? 1200);
  await new Promise((r) => setTimeout(r, settleMs));
  const image = await win.webContents.capturePage();
  await writeFile(file, image.toPNG());
  console.log(`captured ${file}`);
  app.quit();
}

/**
 * Open a project on startup: `JAIRA_PROJECT`, the first CLI argument, or the
 * current directory when it already looks like a project.
 */
function startupProject(): string | undefined {
  const fromEnv = process.env["JAIRA_PROJECT"];
  if (fromEnv) return resolve(fromEnv);
  // Past `--home <dir>`, whose value is a base root, not a project.
  const fromArgv = takeHomeFlag(process.argv.slice(app.isPackaged ? 1 : 2)).rest.find((a) => !a.startsWith("-"));
  if (fromArgv && existsSync(fromArgv)) return resolve(fromArgv);
  return isProject(process.cwd()) ? process.cwd() : undefined;
}

/**
 * The scheme interactive artifacts load from — declared BEFORE the app is ready, which is the only
 * time Electron accepts it.
 *
 * `standard` so the frame gets an ordinary URL origin to be sandboxed away from, rather than the
 * quirks a non-standard scheme brings to relative URLs and document.baseURI. Deliberately NOT
 * `supportFetchAPI` and NOT `corsEnabled`: a shown artifact has no business making requests, and the
 * served CSP says so too — this just removes the capability rather than relying on the policy alone.
 */
protocol.registerSchemesAsPrivileged([
  { privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }, scheme: ARTIFACT_SCHEME },
  CLIENT_SCHEME_PRIVILEGES,
]);

/**
 * Serve one granted artifact into a frame.
 *
 * The response headers are the whole point of this handler existing. A model-authored page cannot be
 * shown from `srcdoc`, because a `srcdoc` document inherits the embedder's CSP — measured against
 * this app's own policy, where `script-src 'self'` refuses every inline script it contains. Served
 * from here it gets a policy of its own, as a HEADER, which the document cannot override the way it
 * could a `<meta>` tag somebody injected into its markup.
 *
 * That policy is strictly narrower than the app's in every direction but one: inline script is
 * permitted (there is no other way for a self-contained page to work), and everything that would let
 * it reach out — network, frames of its own, form posts — is denied outright.
 *
 * A STATIC artifact served here still gets no scripts, because the renderer only ever points a frame
 * at a token whose grant said `interactive`; this is the second half of that, refusing to serve a
 * script-permitting policy for a grant that never claimed one.
 */
function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const token = new URL(request.url).pathname.replace(/^\/+/, "");
    const granted = await link?.servedArtifact(token).catch(() => undefined);
    if (granted === undefined) return new Response("no such artifact", { status: 404 });
    const scripts = granted.interactive ? "script-src 'unsafe-inline'; " : "";
    return new Response(granted.body, {
      headers: {
        "Content-Type": `${granted.mediaType}; charset=utf-8`,
        "Content-Security-Policy":
          `default-src 'none'; ${scripts}style-src 'unsafe-inline'; img-src data: blob:; ` +
          `font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'`,
        // Belt and braces with the CSP: nothing here is meant to be interpreted as another type.
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}


// --- the engine this window uses (decision 0012 §4-§5) ------------------------------------------------

/** How this window builds the engine when it hosts it. */
function buildService(): AppService {
  return new AppService({
    baseDir,
    version: app.getVersion(),
    publish: pushToWindow,
    // A window's engine keeps a copy of the other machines' tasks, to read while they are offline
    // (decision 0013 §6); `jaira serve` does not, unless the person switches it on.
    replicate: true,
    keychain: electronKeychain(),
    // The app checks what can actually answer a prompt — by itself, at startup, at project open, and
    // after every configuration write. It is the one caller that should: it has a settings screen to
    // keep honest, and a user who should never have to press a button to find out that the provider
    // the screen shows as enabled has no key behind it.
    probeOnStart: true,
    // …and keeps its model catalog current the same way: what each reachable route says it serves,
    // asked after those checks and hourly, and saved for the next start (decision 0009).
    refreshCatalog: true,
    // The two capabilities the service cannot have itself: a file manager and a directory dialog are
    // both Electron's, and the service stays Electron-free so it remains testable headlessly.
    reveal: (file: string) => shell.showItemInFolder(file),
    // A forge sign-in's page (the device flow's verification URL). Only http(s): the URL came from the
    // forge's answer, and nothing a remote server says should get to launch another scheme's handler.
    openExternal: (url: string) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
    },
    chooseDirectory: async ({ title, buttonLabel }) => {
      // Modal to the window when there is one, so the dialog cannot end up behind it.
      const result = await (window && !window.isDestroyed()
        ? dialog.showOpenDialog(window, { title, buttonLabel, properties: ["openDirectory", "createDirectory"] })
        : dialog.showOpenDialog({ title, buttonLabel, properties: ["openDirectory", "createDirectory"] }));
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
}

/** Whether the engine's host runs on this very executable — a server this install started, or another of its windows. */
function sameInstall(): boolean {
  return link?.mode === "remote" && link.host?.exe === process.execPath;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Host the engine in this process: claimed first, built after, so a lost race builds nothing. */
async function hostLocally(): Promise<EngineLink | undefined> {
  let claimed: HostedEngine | undefined;
  try {
    claimed = await hostEngine({
      baseDir,
      kind: "desktop",
      version: app.getVersion(),
      service: () => buildService(),
      // Other machines reach this engine through Tailscale, to loopback (decision 0013 §2).
      network: {},
      stopRefusal: "this engine is a JaiRA window's own; quit that window to stop it",
      onFailure: (channel, error) => link?.recordIpcFailure(channel, error),
      log: (level, message) => link?.recordApp(level, message),
    });
  } catch (e) {
    // No pipe and no port: the window still works, and says why nothing else can reach its engine.
    engineNote = `the engine's pipe could not be opened (${(e as Error).message}), so no other window or command can use it`;
    return localLink(buildService(), undefined);
  }
  if (claimed === undefined) return undefined;
  hosted = claimed;
  return localLink(claimed.engine(), claimed);
}

/**
 * Start `JaiRA --serve` (`engine.separateServer`) and connect to it once it answers. Detached, so it
 * outlives this window when `engine.keepServerRunning` says so. Undefined when it did not come up.
 */
async function startServer(): Promise<EngineClient | undefined> {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), "--serve", ...(home !== undefined ? ["--home", home] : [])];
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env });
    child.unref();
  } catch (e) {
    engineNote = `the separate server could not be started (${(e as Error).message}), so this window runs the engine itself`;
    return undefined;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(300);
    const found = await discoverEngine({ baseDir });
    if (found.kind !== "found") continue;
    const client = await connectEngine({ baseDir, client: "desktop", version: app.getVersion(), address: found.address }).catch(() => undefined);
    if (client !== undefined && !client.limited) return client;
    client?.close();
  }
  engineNote = "the separate server did not answer within 30 seconds, so this window runs the engine itself";
  return undefined;
}

/**
 * The host runs another version, which speaks another contract (§3). A server can be restarted on this
 * version; a window or a command is the person's to end.
 */
async function answerMismatch(client: EngineClient): Promise<"retry" | "quit"> {
  const host = client.host;
  const what = host.kind === "server" ? "A JaiRA server" : host.kind === "desktop" ? "Another JaiRA window" : "A jaira command";
  if (host.kind === "server") {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: [`Restart it on ${app.getVersion()}`, "Quit"],
      defaultId: 0,
      cancelId: 1,
      message: `${what} is running JaiRA ${host.version}, and this is ${app.getVersion()}.`,
      detail: "They cannot share the engine. Restarting the server drains its runs first; they resume when it starts again.",
    });
    if (response !== 0) return "quit";
    await client.invoke("engine:stop").catch(() => undefined);
    const gone = Date.now() + 60_000;
    while (pidAlive(host.pid) && Date.now() < gone) await sleep(300);
    client.close();
    return "retry";
  }
  client.close();
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Try again", "Quit"],
    defaultId: 0,
    cancelId: 1,
    message: `${what} (process ${host.pid}) is running JaiRA ${host.version}, and this is ${app.getVersion()}.`,
    detail: host.kind === "desktop" ? "Quit that window, then try again." : "Let that command finish, then try again.",
  });
  return response === 0 ? "retry" : "quit";
}

/** `engine.json` names a JaiRA process that is alive and answers nothing: the person decides (§4). */
async function answerStuck(found: EngineDiscovery & { kind: "stuck" }): Promise<"retry" | "quit"> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["End it and continue", "Try again", "Quit"],
    defaultId: 1,
    cancelId: 2,
    message: `JaiRA process ${found.pid}${found.name !== undefined ? ` (${found.name})` : ""} holds the engine but does not answer.`,
    detail: `It listens at ${found.address}. A second engine is not started beside it: two would write the same databases.`,
  });
  if (response === 2) return "quit";
  if (response === 0) {
    try {
      process.kill(found.pid);
    } catch {
      // Gone already, or not ours to end: looking again says which.
    }
    const gone = Date.now() + 10_000;
    while (pidAlive(found.pid) && Date.now() < gone) await sleep(200);
  }
  return "retry";
}

/**
 * Find the engine or build it (§5): connect to a host that answers, whatever the setting says; else
 * start a separate server when `engine.separateServer` is on; else host it here. A claim lost to a
 * process that started at the same moment is simply looked for again.
 */
async function establishEngine(): Promise<EngineLink | "quit"> {
  engineNote = undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const found = await discoverEngine({ baseDir });
    if (found.kind === "found") {
      const client = await connectEngine({ baseDir, client: "desktop", version: app.getVersion(), address: found.address }).catch((e: unknown) => e as Error);
      if (client instanceof Error) {
        // It answered `who` and then refused, or went: look again.
        await sleep(300);
        continue;
      }
      if (client.limited) {
        if ((await answerMismatch(client)) === "quit") return "quit";
        continue;
      }
      return adopt(client);
    }
    if (found.kind === "stuck") {
      if ((await answerStuck(found)) === "quit") return "quit";
      continue;
    }
    if (machineSettings(baseDir).engine.separateServer === true) {
      const client = await startServer();
      if (client !== undefined) {
        startedServer = true;
        return adopt(client);
      }
    }
    const local = await hostLocally();
    if (local !== undefined) return local;
  }
  engineNote = "the engine could not be found or claimed, so this window runs its own without a pipe";
  return localLink(buildService(), undefined);
}

/** Use another process's engine: its pushes to the window, and a takeover when it goes. */
function adopt(client: EngineClient): EngineLink {
  client.onPush((message) => pushToWindow(message));
  client.onClose(() => {
    if (closing) return;
    void takeOver();
  });
  return remoteLink(client);
}

/**
 * The host this window used went away — a server stopped, a window or a command that held the engine
 * ended (§2, "lost its host"). Look again: another host, or this window becomes one. The page is
 * reloaded, since everything it shows came from the engine that went.
 */
let takingOver: Promise<void> | undefined;
function takeOver(): Promise<void> {
  takingOver ??= (async () => {
    const was = link?.host;
    link = undefined;
    startedServer = false;
    pushToWindow({ type: "engine:changed", status: engineStatus() });
    const next = await establishEngine();
    if (next === "quit") {
      app.quit();
      return;
    }
    link = next;
    next.recordApp("info", `the engine's host (${was?.kind ?? "?"}, pid ${was?.pid ?? "?"}) went away; ${next.mode === "local" ? "this window hosts it now" : `now using ${next.host?.kind} pid ${next.host?.pid}`}`);
    await next.restore().catch(() => undefined);
    pushToWindow({ type: "engine:changed", status: engineStatus() });
    if (window !== undefined && !window.isDestroyed()) window.webContents.reload();
  })().finally(() => {
    takingOver = undefined;
  });
  return takingOver;
}

void app.whenReady().then(async () => {
  registerArtifactProtocol();
  if (RENDERER === "one") registerClientProtocol(CLIENT_DIR);
  // No menu bar. Left alone, Electron installs a default File/Edit/View/Window menu whose every item
  // is either a no-op here or something the app offers better elsewhere — and on Windows and Linux
  // it takes a row across the top of the window to say so. Nulling it also disables the Alt key that
  // would otherwise summon it back over the layout.
  Menu.setApplicationMenu(null);
  // A person on `system` whose OS flips to dark gets a renderer that follows at once; the window
  // controls are drawn by the OS from a colour we hand it, so they have to be handed the new one.
  nativeTheme.on("updated", () => repaintTitleBar());
  registerIpc();
  const spikePort = Number(process.env.JAIRA_SPIKE_WS);
  if (Number.isInteger(spikePort) && spikePort > 0) spike = startSpikeSocket(spikePort, CLIENT_DIR, dispatch, (line) => console.log(line));
  const established = await establishEngine();
  if (established === "quit") {
    app.quit();
    return;
  }
  const engine = established;
  link = engine;
  recordLaunch(engine);
  // Chromium's own lines, from the first — the file has held them since the profile opened. Through
  // `link` at each line, so a window that took over its engine keeps reporting to the new one.
  stopChromiumLog = tailChromiumLog((record) => link?.recordChromium(record.level, record.message, record.detail));
  if (engineNote !== undefined) engine.recordApp("warn", engineNote);
  // The projects this window had open when it was last quit, before the one the command line names:
  // restoring first keeps the list's own order (oldest to newest) and leaves an explicitly requested
  // directory opened LAST, which is what `project:current` hands the window to stand at.
  try {
    await engine.restore();
  } catch (e) {
    // To the log as well as the console, and with the STACK. This is the failure that leaves a
    // window standing at nothing, and until it was recorded the only account of it was a line in a
    // terminal that a packaged app does not have.
    console.error(`failed to re-open the remembered projects: ${(e as Error).message}`);
    engine.recordApp("error", `failed to re-open the remembered projects: ${(e as Error).message}`, stackDetail(e).detail);
  }
  const dir = startupProject();
  if (dir) {
    engine.recordApp("info", `opening ${dir} from the command line`);
    try {
      await engine.open(dir);
    } catch (e) {
      console.error(`failed to open project ${dir}: ${(e as Error).message}`);
      engine.recordApp("error", `failed to open ${dir}: ${(e as Error).message}`, stackDetail(e).detail);
    }
  }
  window = await createWindow();
  link?.recordApp("info", "the window is up");

  // Merge requests somebody is waiting on (decision 0004): look NOW at the two moments a poller's
  // own cadence is wrong by construction. A machine that slept has timers that fire late or not at
  // all; a window left for a while is one whose person is about to read a stale strip. Five minutes
  // is the threshold the decision names — a glance at another app should not cost a request.
  // Starting is covered by the service: opening a project with requests still awaited probes at once.
  // The repository watcher (decision 0010 §2) at the same two moments, for the same reason.
  powerMonitor.on("resume", () => {
    link?.kickRemotes();
    link?.kickRepoWatch();
  });
  let leftAt: number | undefined;
  app.on("browser-window-blur", () => {
    leftAt = Date.now();
  });
  app.on("browser-window-focus", () => {
    if (leftAt !== undefined && Date.now() - leftAt >= 5 * 60_000) {
      link?.kickRemotes();
      link?.kickRepoWatch();
    }
    leftAt = undefined;
  });

  // The app's own updates (decision 0011 §4): the machine's channel, then a check shortly after start
  // and hourly. Nothing downloads until the person asks.
  updates.configure(machineSettings(baseDir).updates);
  updates.start();
  // Plugins follow the app (the person, 2026-09-26): a plugin an older build installed is brought to
  // this build's version in the background, bases before their variants; the older one keeps working
  // until the newer one is stored.
  void (async () => {
    for (const id of plugins?.outdated() ?? []) await installPlugin(id);
  })();

  const capture = process.env["JAIRA_CAPTURE"];
  if (capture) void captureAndExit(window, capture);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) window = await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * What quitting does to an engine in another process. A server this window started goes with it unless
 * `engine.keepServerRunning` says otherwise; a server on this very executable goes when an update is
 * about to replace the executable. Anything else — another window, a command — is not this window's.
 */
async function releaseRemote(engine: EngineLink): Promise<void> {
  const keep = machineSettings(baseDir).engine.keepServerRunning === true;
  const installing = updates.canInstall();
  const stopIt = engine.host?.kind === "server" && ((startedServer && !keep) || (installing && sameInstall()));
  if (!stopIt) return;
  const pid = engine.host!.pid;
  await engine.invoke("engine:stop", undefined).catch(() => undefined);
  // Its drain is its own; an installer must not start before the executable is free.
  const gone = Date.now() + (installing ? 120_000 : 5_000);
  while (pidAlive(pid) && Date.now() < gone) await sleep(250);
}

// Aborted runs need to finish journaling before the database closes, so quitting
// waits for the service rather than tearing the process down mid-write.
let closing = false;
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  const engine = link;
  // The other end of the launch line. A log that ends mid-sentence is a crash; a log that ends here
  // is a quit, and telling those two apart in yesterday's file is most of reading it.
  engine?.recordApp("info", engine.mode === "local" ? "quitting: draining runs and closing the databases" : "quitting: disconnecting from the engine");
  updates.stop();
  stopChromiumLog();
  // A local engine closes its pipe first — nothing should start a run on an engine that is draining —
  // then drains. A remote one is left, stopped only where this window is the reason it runs.
  const closed = engine === undefined ? Promise.resolve() : engine.mode === "local" ? engine.close() : releaseRemote(engine).then(() => engine.close());
  void closed.finally(() => {
    link = undefined;
    // A downloaded update installs at the end of EVERY quit (the person, 2026-09-26: "if not now is
    // pressed or the app is otherwise closed, the update happens on restart"): the runs have drained and
    // the databases are closed before anything replaces the app. It starts the app again only when the
    // quit was "Restart to update". `quitAndInstall` quits too; the `app.quit()` after it is what still
    // ends the process if the installer could not be started.
    updates.installOnQuit();
    app.quit();
  });
});
