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
import { app, BrowserWindow, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
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
  // The one capability the service cannot have itself: opening a file manager is Electron's, and
  // the service stays Electron-free so it remains testable headlessly.
  reveal: (file: string) => shell.showItemInFolder(file),
});

/**
 * Channel → handler, one entry per contract channel (a missing or misspelled key
 * is a type error). Requests arrive over IPC as structured clones, so each
 * handler asserts the shape its channel declares.
 */
type Handler = (request: never) => unknown;

const handlers: Record<IpcChannel, Handler> = {
  "project:open": ((request: { dir: string }) => service.open(resolve(request.dir))) as Handler,
  "project:current": (() => service.current()) as Handler,
  "task:list": (() => service.listTasks()) as Handler,
  "task:detail": ((request: { taskId: string }) => service.taskDetail(request.taskId)) as Handler,
  "task:create": ((request: Parameters<typeof service.createTask>[0]) => service.createTask(request)) as Handler,
  "task:start": ((request: Parameters<typeof service.startTask>[0]) => service.startTask(request)) as Handler,
  "task:cancel": ((request: { taskId: string }) => service.cancelTask(request.taskId)) as Handler,
  "board:view": ((request: { level?: string } | undefined) => service.board(request?.level)) as Handler,
  "board:roots": (() => service.boardRoots()) as Handler,
  "files:tree": (() => service.filesTree()) as Handler,
  "state:view": ((request: { stateId: string }) => service.stateView(request.stateId)) as Handler,
  "state:slots": ((request: { stateIds: string[] }) => service.stateSlots(request.stateIds)) as Handler,
  "task:conversation": ((request: { taskId: string }) => service.conversation(request.taskId)) as Handler,
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
  "secret:capabilities": (() => service.secretCapabilities()) as Handler,
  "secret:set": ((request: Parameters<typeof service.setSecret>[0]) => service.setSecret(request)) as Handler,
};

function registerIpc(): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
      // Errors surface as rejections the renderer can display; the service's
      // messages are already human-facing ("unknown task 't-1'").
      return (handlers[channel] as (request: unknown) => unknown)(request);
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

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: WINDOW_BACKGROUND[service.readSettings().theme],
    show: false,
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
