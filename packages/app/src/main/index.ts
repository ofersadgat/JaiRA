/**
 * Electron main process (DESIGN §2, §11.2).
 *
 * This file is deliberately thin: it owns windows and the IPC seam, and every
 * request is forwarded to {@link AppService}, which knows nothing about Electron.
 * That split is what keeps the engine out of the renderer and makes the whole app
 * surface testable headlessly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { isProject } from "@jaira/persistence";
import {
  ARTIFACT_SCHEME,
  IPC_CHANNELS,
  PUSH_CHANNEL,
  takeHomeFlag,
  type IpcChannel,
  type PushMessage,
  type SaveFileRequest,
} from "@jaira/shared";
import { AppService, type CrashKind, type KeychainPort } from "./service";

// Source maps are enabled in `entry.cjs`, which loads this bundle — NOT here. The flag registers a
// map for modules compiled after it runs, and by the time this line executes the bundle it belongs to
// has already been compiled. See that file for the whole of the reasoning.

/** `dist/` layout produced by the build (see build.mjs / vite.config.ts). */
const DIST = __dirname;
const RENDERER_HTML = join(DIST, "renderer", "index.html");
const PRELOAD = join(DIST, "preload.cjs");

let window: BrowserWindow | undefined;

/**
 * The encrypted secret store, backed by Electron's `safeStorage`.
 *
 * `safeStorage` encrypts and decrypts but stores nothing, so the ciphertext needs a home: one JSON
 * file in the app's own userData directory, holding base64 blobs. That file is useless without the
 * OS keyring entry that unlocks it, which is the whole point — a copied file is not a copied
 * credential.
 *
 * Availability is checked on every call rather than once at startup. On Linux it depends on a
 * keyring being present in the session, and answering from a cached "yes" would mean writing
 * plaintext when it later turns out to be no.
 */
function electronKeychain(): KeychainPort {
  // Resolved per call, not at module load: this runs while the module graph is still being
  // evaluated, and `userData` is only guaranteed once the app has settled its paths.
  const fileOf = (): string => join(app.getPath("userData"), "secrets.json");
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(fileOf(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (all: Record<string, string>): void => {
    const file = fileOf();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  };
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    reason: "this system provides no OS-backed encrypted store, so secrets must go in a .env.local file",
    get: (name) => {
      const blob = load()[name];
      if (blob === undefined) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(blob, "base64"));
      } catch {
        // A blob written under a different OS user or a reset keyring cannot be read back. Treating
        // it as absent lets the chain fall through instead of failing the run outright.
        return undefined;
      }
    },
    set: (name, value) => {
      const all = load();
      all[name] = safeStorage.encryptString(value).toString("base64");
      save(all);
    },
    remove: (name) => {
      const all = load();
      delete all[name];
      save(all);
    },
  };
}

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
 * Wrapped twice over. The inner call can fail because `service` is still in its own temporal dead
 * zone — a push raised during `new AppService(...)` reaches this before the binding exists — and
 * because a reporter is code, and code has bad days. Every caller here is a last resort, so the one
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
    service.recordCrash(kind, e);
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
    service.recordWarning(warning);
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

const service = new AppService({
  ...(home !== undefined ? { baseDir: home } : {}),
  publish: (message: PushMessage) => {
    // GUARDED, because this is a send into another process and the service treats it as a statement.
    //
    // `webContents.send` structure-clones its argument and throws on anything it cannot represent, and
    // it throws again for a window torn down between the check and the call. Every caller upstream is
    // ordinary bookkeeping — "a run started", "the board changed" — written as if telling the window
    // were free. It is not, and an exception here surfaces wherever that bookkeeping happened to sit,
    // which for an engine event is inside the run.
    //
    // A push is NEWS, and news that cannot be delivered is not the sender's failure to survive: the
    // renderer refetches on reconnect and on `store:invalidate`, so a dropped frame costs latency and
    // nothing else.
    try {
      if (window && !window.isDestroyed()) window.webContents.send(PUSH_CHANNEL, message);
    } catch (e) {
      // Not through `service.log`, which would publish a `log:entry` back through this same failing
      // channel. `recordCrash` records; whether the window hears about it is a separate question that
      // this frame is in no position to answer.
      reportCrash("push", new Error(`'${message.type}' could not be delivered: ${(e as Error).message}`));
    }
  },
  keychain: electronKeychain(),
  // The app checks what can actually answer a prompt — by itself, at startup, at project open, and
  // after every configuration write. It is the one caller that should: it has a settings screen to
  // keep honest, and a user who should never have to press a button to find out that the provider
  // the screen shows as enabled has no key behind it.
  probeOnStart: true,
  // The two capabilities the service cannot have itself: a file manager and a directory dialog are
  // both Electron's, and the service stays Electron-free so it remains testable headlessly.
  reveal: (file: string) => shell.showItemInFolder(file),
  chooseDirectory: async ({ title, buttonLabel }) => {
    // Modal to the window when there is one, so the dialog cannot end up behind it.
    const result = await (window && !window.isDestroyed()
      ? dialog.showOpenDialog(window, { title, buttonLabel, properties: ["openDirectory", "createDirectory"] })
      : dialog.showOpenDialog({ title, buttonLabel, properties: ["openDirectory", "createDirectory"] }));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
});

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
type Handler = (request: never) => unknown;

const handlers: Record<IpcChannel, Handler> = {
  "project:open": ((request: { dir: string }) => service.open(resolve(request.dir))) as Handler,
  "project:init": ((request: { dir: string }) => service.init(resolve(request.dir))) as Handler,
  "project:choose": ((request: { mode?: "open" | "init" } | undefined) =>
    service.chooseProject(request?.mode ?? "open")) as Handler,
  "project:inspect": ((request: { dir: string }) => service.inspect(request.dir)) as Handler,
  "project:current": (() => service.current()) as Handler,
  "task:list": ((request: { project?: string } | undefined) => service.listTasks(request?.project)) as Handler,
  "task:detail": ((request: { taskId: string; project?: string }) => service.taskDetail(request.taskId, request.project)) as Handler,
  "task:create": ((request: Parameters<typeof service.createTask>[0]) => service.createTask(request)) as Handler,
  "task:start": ((request: Parameters<typeof service.startTask>[0]) => service.startTask(request)) as Handler,
  "task:cancel": ((request: { taskId: string; project?: string }) =>
    service.cancelTask(request.taskId, request.project)) as Handler,
  "task:rerun": ((request: Parameters<typeof service.rerunTask>[0]) => service.rerunTask(request)) as Handler,
  "task:resume": ((request: Parameters<typeof service.resumeTask>[0]) => service.resumeTask(request)) as Handler,
  "task:resumable": ((request: { taskId: string; project?: string }) =>
    service.resumable(request.taskId, request.project)) as Handler,
  "task:delete": ((request: { taskId: string; project?: string }) =>
    service.deleteTask(request.taskId, request.project)) as Handler,
  "task:rename": ((request: Parameters<typeof service.renameTask>[0]) => service.renameTask(request)) as Handler,
  "board:view": ((request: { level?: string; project?: string } | undefined) => service.board(request ?? {})) as Handler,
  "board:roots": ((request: { project?: string } | undefined) => service.boardRoots(request ?? {})) as Handler,
  "files:tree": ((request: { project?: string } | undefined) => service.filesTree(request)) as Handler,
  "state:view": ((request: { stateId: string; project?: string }) =>
    service.stateView(request.stateId, request.project)) as Handler,
  "state:slots": ((request: { stateIds: string[]; project?: string }) =>
    service.stateSlots(request.stateIds, request.project)) as Handler,
  "state:effective": ((request: Parameters<typeof service.effectiveState>[0]) =>
    service.effectiveState(request)) as Handler,
  "task:conversation": ((request: { taskId: string; project?: string }) => service.conversation(request.taskId, request.project)) as Handler,
  "task:system": (() => service.listSystemTasks()) as Handler,
  "project:list": (() => service.listProjects()) as Handler,
  "task:all": ((request: { workflows?: string[] } | undefined) => service.listAllTasks(request ?? {})) as Handler,
  "session:history": ((request: Parameters<typeof service.sessionHistory>[0]) => service.sessionHistory(request)) as Handler,
  "run:records": ((request: Parameters<typeof service.runRecords>[0]) => service.runRecords(request)) as Handler,
  "session:view": ((request: Parameters<typeof service.sessionView>[0]) => service.sessionView(request)) as Handler,
  "session:live": ((request: Parameters<typeof service.sessionLive>[0]) => service.sessionLive(request)) as Handler,
  "chat:plan": ((request: Parameters<typeof service.chatPlan>[0]) => service.chatPlan(request)) as Handler,
  "chat:startPlan": ((request: Parameters<typeof service.chatStartPlan>[0]) => service.chatStartPlan(request)) as Handler,
  "chat:send": ((request: Parameters<typeof service.sendChatMessage>[0]) => service.sendChatMessage(request)) as Handler,
  "chat:cancel": ((request: Parameters<typeof service.cancelChatTurn>[0]) => service.cancelChatTurn(request)) as Handler,
  "chat:thread": ((request: Parameters<typeof service.chatThread>[0]) => service.chatThread(request)) as Handler,
  "log:list": ((request: Parameters<typeof service.listLogs>[0]) => service.listLogs(request)) as Handler,
  "job:list": ((request: Parameters<typeof service.listJobs>[0]) => service.listJobs(request)) as Handler,
  "job:output": ((request: Parameters<typeof service.jobOutput>[0]) => service.jobOutput(request)) as Handler,
  "interaction:pending": (() => service.pendingInteractions()) as Handler,
  "interaction:submit": ((request: { requestId: string; value: never }) =>
    service.submitInteraction(request.requestId, request.value)) as Handler,
  "approval:pending": (() => service.pendingApprovals()) as Handler,
  "approval:submit": ((request: { requestId: string; decision: "allow" | "deny"; scope?: never }) =>
    service.submitApproval(request.requestId, request.decision, request.scope)) as Handler,
  "userEvent:pending": (() => service.pendingUserEvents()) as Handler,
  "userEvent:deliver": ((request: { requestId: string }) => service.deliverUserEvent(request.requestId)) as Handler,
  "question:pending": (() => service.pendingQuestions()) as Handler,
  "question:submit": ((request: { requestId: string; answers?: Record<string, string | string[]> }) =>
    service.submitQuestion(request.requestId, request.answers)) as Handler,
  "workflow:browse": ((request: { project?: string } | undefined) => service.browseWorkflows(request?.project)) as Handler,
  "functions:pending": ((request: { taskId: string; project?: string }) => service.functionsPending(request)) as Handler,
  "functions:approve": ((request: { files: string[]; project?: string }) => service.functionsApprove(request)) as Handler,
  "workflow:read": ((request: Parameters<typeof service.readWorkflow>[0]) => service.readWorkflow(request)) as Handler,
  "workflow:write": ((request: Parameters<typeof service.writeWorkflow>[0]) => service.writeWorkflow(request)) as Handler,
  "workflow:move": ((request: Parameters<typeof service.moveWorkflow>[0]) => service.moveWorkflow(request)) as Handler,
  "workflow:syncStatus": ((request: Parameters<typeof service.syncStatus>[0]) => service.syncStatus(request)) as Handler,
  "workflow:sync": ((request: Parameters<typeof service.runSync>[0]) => service.runSync(request)) as Handler,
  "workflow:syncCancel": (() => service.cancelSync()) as Handler,
  "workflow:delete": ((request: Parameters<typeof service.deleteWorkflow>[0]) =>
    service.deleteWorkflow(request)) as Handler,
  "schema:validate": ((request: Parameters<typeof service.validateSchema>[0]) =>
    service.validateSchema(request)) as Handler,
  "schema:detect": ((request: { text: string }) => service.detectSchema(request.text)) as Handler,
  "file:read": ((request: Parameters<typeof service.readFile>[0]) => service.readFile(request)) as Handler,
  "uri:read": ((request: Parameters<typeof service.readUri>[0]) => service.readUri(request)) as Handler,
  "artifact:serve": ((request: Parameters<typeof service.serveArtifact>[0]) => service.serveArtifact(request)) as Handler,
  "artifact:list": ((request: Parameters<typeof service.listArtifacts>[0]) => service.listArtifacts(request)) as Handler,
  "git:identity": ((request: Parameters<typeof service.gitIdentity>[0]) => service.gitIdentity(request)) as Handler,
  "file:find": ((request: Parameters<typeof service.findFiles>[0]) => service.findFiles(request)) as Handler,
  "changeset:review": ((request: Parameters<typeof service.reviewChanges>[0]) => service.reviewChanges(request)) as Handler,
  "changeset:reviewSync": ((request: Parameters<typeof service.reviewSyncChangeset>[0]) =>
    service.reviewSyncChangeset(request)) as Handler,
  "file:write": ((request: Parameters<typeof service.writeFile>[0]) => service.writeFile(request)) as Handler,
  "file:create": ((request: Parameters<typeof service.createFile>[0]) => service.createFile(request)) as Handler,
  "file:rename": ((request: Parameters<typeof service.renameFile>[0]) => service.renameFile(request)) as Handler,
  "file:delete": ((request: Parameters<typeof service.deleteFile>[0]) => service.deleteFile(request)) as Handler,
  "shell:reveal": ((request: { file: string }) => service.revealFile(request)) as Handler,
  "shell:saveFile": ((request: SaveFileRequest) => saveFile(request)) as Handler,
  "shell:download": ((request: { url: string }) => download(request.url)) as Handler,
  "shell:copyImageAt": ((request: { x: number; y: number }) => copyImageAt(request.x, request.y)) as Handler,
  "shell:edit": ((request: { verb: "cut" | "copy" | "paste" | "selectAll" }) => edit(request.verb)) as Handler,
  "history:size": ((request: { project?: string } | undefined) => service.historySize(request?.project)) as Handler,
  "history:prune": ((request: Parameters<typeof service.pruneHistory>[0]) =>
    service.pruneHistory(request)) as Handler,
  "settings:read": (() => service.readSettings()) as Handler,
  "settings:write": ((request: Parameters<typeof service.writeSettings>[0]) => service.writeSettings(request)) as Handler,
  "config:read": ((request: { project?: string } | undefined) => service.readConfig(request?.project)) as Handler,
  "config:write": ((request: Parameters<typeof service.writeConfig>[0]) => service.writeConfig(request)) as Handler,
  "executor:list": (() => service.listExecutors()) as Handler,
  "executor:probe": ((request: { name?: string } | undefined) => service.probeExecutors(request?.name)) as Handler,
  "model:probe": (() => service.probeModelRoutes()) as Handler,
  "availability:read": (() => service.readAvailability()) as Handler,
  "availability:refresh": (() => service.refreshAvailability()) as Handler,
  "secret:capabilities": (() => service.secretCapabilities()) as Handler,
  "secret:set": ((request: Parameters<typeof service.setSecret>[0]) => service.setSecret(request)) as Handler,
};

function registerIpc(): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
      try {
        // Errors surface as rejections the renderer can display; the service's
        // messages are already human-facing ("unknown task 't-1'").
        const answer = await (handlers[channel] as (request: unknown) => unknown)(request);
        // The one handler whose result the frame depends on: the window controls are drawn by the
        // OS, so a theme switch has to be pushed back out to it.
        if (channel === "settings:write") repaintTitleBar();
        return answer;
      } catch (e) {
        // RECORDED, then RETHROWN. The renderer's contract is unchanged — it still gets the rejection
        // and still shows the message — but the failure is no longer invisible to everyone else. Every
        // handler failure in the app becomes one line naming the channel, for six lines here.
        service.recordIpcFailure(channel, e);
        throw e;
      }
    });
  }
}

/**
 * The frame colour Chromium paints before the document exists.
 *
 * Read from the saved preference rather than hardcoded: this is painted before any CSS loads, so a
 * fixed value means every cold start flashes the wrong theme at anyone using the other one. The
 * values match the `--bg` of each palette in `styles.css` — the two have to be kept in step, which
 * is why both say so.
 */
const WINDOW_BACKGROUND = { light: "#f5f6f8", dark: "#0f1115" } as const;
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
function titleBarOverlay(theme: "light" | "dark"): { color: string; symbolColor: string; height: number } {
  return {
    color: theme === "dark" ? "#161922" : "#ffffff",
    symbolColor: theme === "dark" ? "#8b93a7" : "#5c6779",
    height: TITLE_BAR_HEIGHT,
  };
}

/**
 * Repaint the window controls after a theme switch.
 *
 * Called from the IPC seam rather than from the renderer over a channel of its own: the theme is
 * already written through `settings:write`, and a second round trip that the renderer had to
 * remember to make is a second round trip it would eventually forget. macOS draws its own traffic
 * lights and has no overlay to set, so the call is guarded rather than platform-branched at every
 * use.
 */
function repaintTitleBar(): void {
  if (process.platform === "darwin") return;
  if (window === undefined || window.isDestroyed()) return;
  try {
    window.setTitleBarOverlay(titleBarOverlay(service.readSettings().theme));
  } catch {
    // Only available on a window created with an overlay. Nothing here is worth failing a settings
    // write over.
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const theme = service.readSettings().theme;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: WINDOW_BACKGROUND[theme],
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
    titleBarOverlay: titleBarOverlay(theme),
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
  win.webContents.on("render-process-gone", (_event, details) => {
    reportCrash("renderer", new Error(`the window's renderer process ended: ${details.reason} (exit ${details.exitCode})`));
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
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 3 || printed.size >= RENDERER_CONSOLE_LIMIT) return;
    const at = `${message} (${sourceId}:${line})`;
    if (printed.has(at)) return;
    printed.add(at);
    reportCrash("renderer", new Error(at));
  });

  await win.loadFile(RENDERER_HTML);
  win.show();
  return win;
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
  const fromArgv = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith("-"));
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
  protocol.handle(ARTIFACT_SCHEME, (request) => {
    const token = new URL(request.url).pathname.replace(/^\/+/, "");
    const granted = service.servedArtifact(token);
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

void app.whenReady().then(async () => {
  registerArtifactProtocol();
  // No menu bar. Left alone, Electron installs a default File/Edit/View/Window menu whose every item
  // is either a no-op here or something the app offers better elsewhere — and on Windows and Linux
  // it takes a row across the top of the window to say so. Nulling it also disables the Alt key that
  // would otherwise summon it back over the layout.
  Menu.setApplicationMenu(null);
  registerIpc();
  // The projects this window had open when it was last quit, before the one the command line names:
  // restoring first keeps the list's own order (oldest to newest) and leaves an explicitly requested
  // directory opened LAST, which is what `service.current()` hands the window to stand at.
  try {
    await service.restore();
  } catch (e) {
    console.error(`failed to re-open the remembered projects: ${(e as Error).message}`);
  }
  const dir = startupProject();
  if (dir) {
    try {
      await service.open(dir);
    } catch (e) {
      console.error(`failed to open project ${dir}: ${(e as Error).message}`);
    }
  }
  window = await createWindow();

  const capture = process.env["JAIRA_CAPTURE"];
  if (capture) void captureAndExit(window, capture);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) window = await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Aborted runs need to finish journaling before the database closes, so quitting
// waits for the service rather than tearing the process down mid-write.
let closing = false;
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void service.close().finally(() => app.quit());
});
