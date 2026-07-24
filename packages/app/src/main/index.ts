/**
 * Electron main process (DESIGN §2, §11.2).
 *
 * This file is deliberately thin: it owns windows and the IPC seam, and every
 * request is forwarded to {@link AppService}, which knows nothing about Electron.
 * That split is what keeps the engine out of the renderer and makes the whole app
 * surface testable headlessly.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { isProject } from "@jaira/persistence";
import { IPC_CHANNELS, PUSH_CHANNEL, type IpcChannel, type PushMessage } from "@jaira/shared";
import { AppService } from "./service";

/** `dist/` layout produced by the build (see build.mjs / vite.config.ts). */
const DIST = __dirname;
const RENDERER_HTML = join(DIST, "renderer", "index.html");
const PRELOAD = join(DIST, "preload.cjs");

let window: BrowserWindow | undefined;

const service = new AppService({
  publish: (message: PushMessage) => {
    if (window && !window.isDestroyed()) window.webContents.send(PUSH_CHANNEL, message);
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
  "project:current": (() => service.current()) as Handler,
  "task:list": (() => service.listTasks()) as Handler,
  "task:detail": ((request: { taskId: string }) => service.taskDetail(request.taskId)) as Handler,
  "task:create": ((request: Parameters<typeof service.createTask>[0]) => service.createTask(request)) as Handler,
  "task:start": ((request: Parameters<typeof service.startTask>[0]) => service.startTask(request)) as Handler,
  "task:cancel": ((request: { taskId: string }) => service.cancelTask(request.taskId)) as Handler,
  "board:view": ((request: { level?: string } | undefined) => service.board(request?.level)) as Handler,
  "interaction:pending": (() => service.pendingInteractions()) as Handler,
  "interaction:submit": ((request: { requestId: string; value: never }) =>
    service.submitInteraction(request.requestId, request.value)) as Handler,
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

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0f1115",
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
