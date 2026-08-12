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
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { isProject } from "@jaira/persistence";
import { IPC_CHANNELS, PUSH_CHANNEL, type IpcChannel, type PushMessage } from "@jaira/shared";
import { AppService, type KeychainPort } from "./service";

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

const service = new AppService({
  publish: (message: PushMessage) => {
    if (window && !window.isDestroyed()) window.webContents.send(PUSH_CHANNEL, message);
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
  "project:current": (() => service.current()) as Handler,
  "task:list": ((request: { project?: string } | undefined) => service.listTasks(request?.project)) as Handler,
  "task:detail": ((request: { taskId: string; project?: string }) => service.taskDetail(request.taskId, request.project)) as Handler,
  "task:create": ((request: Parameters<typeof service.createTask>[0]) => service.createTask(request)) as Handler,
  "task:start": ((request: Parameters<typeof service.startTask>[0]) => service.startTask(request)) as Handler,
  "task:cancel": ((request: { taskId: string; project?: string }) =>
    service.cancelTask(request.taskId, request.project)) as Handler,
  "board:view": ((request: { level?: string; project?: string } | undefined) => service.board(request ?? {})) as Handler,
  "board:roots": ((request: { project?: string } | undefined) => service.boardRoots(request ?? {})) as Handler,
  "files:tree": (() => service.filesTree()) as Handler,
  "state:view": ((request: { stateId: string }) => service.stateView(request.stateId)) as Handler,
  "state:slots": ((request: { stateIds: string[] }) => service.stateSlots(request.stateIds)) as Handler,
  "task:conversation": ((request: { taskId: string; project?: string }) => service.conversation(request.taskId, request.project)) as Handler,
  "task:system": (() => service.listSystemTasks()) as Handler,
  "project:list": (() => service.listProjects()) as Handler,
  "session:history": ((request: Parameters<typeof service.sessionHistory>[0]) => service.sessionHistory(request)) as Handler,
  "session:view": ((request: Parameters<typeof service.sessionView>[0]) => service.sessionView(request)) as Handler,
  "chat:plan": ((request: Parameters<typeof service.chatPlan>[0]) => service.chatPlan(request)) as Handler,
  "chat:send": ((request: Parameters<typeof service.sendChatMessage>[0]) => service.sendChatMessage(request)) as Handler,
  "log:list": ((request: Parameters<typeof service.listLogs>[0]) => service.listLogs(request)) as Handler,
  "job:list": ((request: Parameters<typeof service.listJobs>[0]) => service.listJobs(request)) as Handler,
  "job:output": ((request: Parameters<typeof service.jobOutput>[0]) => service.jobOutput(request)) as Handler,
  "interaction:pending": (() => service.pendingInteractions()) as Handler,
  "interaction:submit": ((request: { requestId: string; value: never }) =>
    service.submitInteraction(request.requestId, request.value)) as Handler,
  "approval:pending": (() => service.pendingApprovals()) as Handler,
  "approval:submit": ((request: { requestId: string; decision: "allow" | "deny"; scope?: never }) =>
    service.submitApproval(request.requestId, request.decision, request.scope)) as Handler,
  "workflow:browse": (() => service.browseWorkflows()) as Handler,
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
  "file:write": ((request: Parameters<typeof service.writeFile>[0]) => service.writeFile(request)) as Handler,
  "file:create": ((request: Parameters<typeof service.createFile>[0]) => service.createFile(request)) as Handler,
  "file:rename": ((request: Parameters<typeof service.renameFile>[0]) => service.renameFile(request)) as Handler,
  "file:delete": ((request: Parameters<typeof service.deleteFile>[0]) => service.deleteFile(request)) as Handler,
  "shell:reveal": ((request: { file: string }) => service.revealFile(request)) as Handler,
  "history:size": (() => service.historySize()) as Handler,
  "history:prune": ((request: Parameters<typeof service.pruneHistory>[0]) =>
    service.pruneHistory(request)) as Handler,
  "settings:read": (() => service.readSettings()) as Handler,
  "settings:write": ((request: Parameters<typeof service.writeSettings>[0]) => service.writeSettings(request)) as Handler,
  "config:read": (() => service.readConfig()) as Handler,
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

void app.whenReady().then(async () => {
  // No menu bar. Left alone, Electron installs a default File/Edit/View/Window menu whose every item
  // is either a no-op here or something the app offers better elsewhere — and on Windows and Linux
  // it takes a row across the top of the window to say so. Nulling it also disables the Alt key that
  // would otherwise summon it back over the layout.
  Menu.setApplicationMenu(null);
  registerIpc();
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
