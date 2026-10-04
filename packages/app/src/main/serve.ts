/**
 * `JaiRA --serve`: the engine as a server, with no window (decision 0012 §5-§6).
 *
 * Started by the installer's `jaira serve` and by a desktop whose `engine.separateServer` is on. It is
 * the app's own Electron binary as a MAIN process — not `ELECTRON_RUN_AS_NODE` — because only a main
 * process has `safeStorage`, and with the same `userData` it reads the same keychain the desktop does.
 *
 * It hosts until it is stopped: `jaira server stop` (`engine:stop`), a desktop that started it and
 * quits without `keepServerRunning`, or a signal. Stopping drains runs and closes the databases the way
 * the desktop's quit does, so a run cut by it resumes at the next start.
 */
import { join } from "node:path";
import { app } from "electron";
import { AppService, hostEngine, resolveBaseDir, type HostedEngine } from "@jaira/service";
import { takeHomeFlag } from "@jaira/shared";
import { startPlugins } from "@jaira/runtime";
import { electronKeychain } from "./keychain";
import { tailChromiumLog } from "./chromiumLog";

const home = takeHomeFlag(process.argv.slice(1)).home;
const baseDir = resolveBaseDir(home);

function say(line: string): void {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // Started detached, with nowhere to write: the log file has it all the same.
  }
}

// No dock icon, no window, and nothing that quits when the (nonexistent) last window closes. A server
// draws nothing: no GPU process, and no renderer to sandbox. On Linux the switch below is too late to
// spare the setuid sandbox helper (Chromium checks it before this runs), so whoever starts a server
// passes `--no-sandbox` on its command line there too (`desktop.ts`, the CLI's `jaira serve`).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.dock?.hide();
app.on("window-all-closed", () => undefined);

let hosted: HostedEngine | undefined;
let stopping: Promise<void> | undefined;
let stopChromiumLog = (): void => undefined;

function stop(why: string): Promise<void> {
  stopping ??= (async () => {
    say(`stopping (${why}): draining runs and closing the databases`);
    hosted?.built()?.recordApp("info", `the server is stopping (${why})`);
    stopChromiumLog();
    try {
      await hosted?.close();
    } finally {
      app.quit();
    }
  })();
  return stopping;
}

process.on("SIGINT", () => void stop("interrupted"));
process.on("SIGTERM", () => void stop("terminated"));

void app.whenReady().then(async () => {
  startPlugins(baseDir, __dirname);
  try {
    hosted = await hostEngine({
      baseDir,
      kind: "server",
      version: app.getVersion(),
      eager: true,
      // The client this install ships, for a browser paired as a device (decision 0013, amended 2026-09-30).
      network: { clientDir: join(__dirname, "client") },
      service: (publish) =>
        new AppService({
          baseDir,
          version: app.getVersion(),
          publish,
          keychain: electronKeychain(),
          // A server keeps the settings honest and the catalog current for every window it serves.
          probeOnStart: true,
          refreshCatalog: true,
        }),
      stop: () => stop("asked to stop"),
      onFailure: (channel, error) => hosted?.built()?.recordIpcFailure(channel, error),
      log: (level, message) => {
        say(message);
        hosted?.built()?.recordApp(level, message);
      },
    });
  } catch (e) {
    say(`error: the engine could not be hosted: ${(e as Error).message}`);
    app.exit(1);
    return;
  }
  if (hosted === undefined) {
    say("error: another process already hosts the engine for this base root — see `jaira server status`");
    app.exit(3);
    return;
  }
  const service = hosted.engine();
  // Chromium's own lines: a server started detached has no stderr anyone reads (`chromiumLog.ts`).
  stopChromiumLog = tailChromiumLog((record) => service.recordChromium(record.level, record.message, record.detail));
  service.recordApp("info", `JaiRA ${app.getVersion()} serves the engine (pid ${process.pid})`, { baseDir, argv: process.argv.slice(1) });
  say(`JaiRA ${app.getVersion()} serves the engine for ${baseDir} (pid ${process.pid})`);
  // The projects last open, as the desktop re-opens them: their events tasks, watchers and waiting runs
  // carry on here with no window. A desktop connecting later asks the same, and it is a no-op then.
  await service.restore().catch((e: unknown) => service.recordApp("warn", `could not re-open the remembered projects: ${(e as Error).message}`));
});
