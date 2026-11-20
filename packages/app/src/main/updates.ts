/**
 * The app's own updates (decision 0011 §4–§5): electron-updater, driven by the person.
 *
 * The feed is the public releases repository; electron-builder writes it into `app-update.yml` at
 * package time (`package.mjs`). This module decides WHEN and WHICH:
 *
 *  - **When.** Once, a little after start, then hourly — not t3code's four minutes: the person asked
 *    for care with polling. A check while one is running, or once an update is downloaded, does
 *    nothing. Downloading and installing are the person's clicks, never automatic.
 *  - **Which.** The channel is the `updates.channel` setting, else the running build's own
 *    (`channelOfVersion`). Nightly reads the prereleases' `nightly*.yml`; stable reads the latest
 *    release's `latest*.yml`. After a switch, the next check may install an OLDER version once — that
 *    is how nightly goes back to stable. A version the feed offers from the other channel is ignored.
 *  - **Installing** is a quit: `index.ts` asks for it, lets the ordinary quit drain runs and close the
 *    databases, and only then calls {@link UpdateManager.installNow}.
 *  - **macOS without a Developer ID** cannot install an update (Squirrel.Mac checks the signature), so
 *    such a build still checks, and offers the release page instead of a download (`manual`).
 *  - **macOS with one** installs through Squirrel.Mac ({@link SquirrelPort}), which must have taken the
 *    update before the app may end: a download is done only once it has, and a restart is Squirrel's
 *    to end.
 *
 * electron-updater is reached through {@link UpdaterPort}, so all of the above is tested without it.
 */
import { channelOfVersion, type UpdateBusy, type UpdateChannel, type UpdateRestartAnswer, type UpdateRestartChoice, type UpdateState } from "@jaira/shared";
import type { JairaUpdatesConfig } from "@jaira/shared";

/** The part of electron-updater's `autoUpdater` this uses. */
export interface UpdaterPort {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike; isUpdateAvailable?: boolean } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
}

/**
 * macOS's installer, Squirrel.Mac: Electron's own `autoUpdater`. electron-updater downloads the zip and
 * then hands it to Squirrel through a server inside this process, and only when its
 * `autoInstallOnAppQuit` is on; Squirrel unpacks it, checks that it is signed as this app is, and starts
 * ShipIt, which installs it as soon as the app has ended. `update-downloaded` says all that is done.
 * Until then the update is only in this process, and ending the process loses it (2026-11-20: a signed
 * nightly quit to install, came back as the same version, and ShipIt had never started).
 */
export interface SquirrelPort {
  on(event: "update-downloaded", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface UpdateInfoLike {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | ReadonlyArray<{ version?: string; note?: string | null }> | null;
}

export interface UpdateManagerOptions {
  /** The running build's version (`app.getVersion()`). */
  version: string;
  /** electron-updater, or nothing when this build cannot update; `disabledReason` then says why. */
  port?: UpdaterPort;
  disabledReason?: string;
  /** The platform cannot install by itself: offer the release page. */
  manual?: boolean;
  /** macOS signed with a Developer ID: Squirrel.Mac installs, and must take the update first. */
  squirrel?: SquirrelPort;
  /** How long a download waits for Squirrel to take it, and a restart for Squirrel to end the app. */
  squirrelTakeMs?: number;
  squirrelRestartMs?: number;
  /** The release page of a version. */
  releaseUrl: (version: string) => string;
  /** Every change of state, for the window. */
  publish: (state: UpdateState) => void;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** How long after start the first check waits, and how often checks repeat. */
  firstCheckMs?: number;
  intervalMs?: number;
  /** What is going now: runs in flight and chat turns being answered — asked of the engine, which may be another process's. */
  busy?: () => UpdateBusy | Promise<UpdateBusy>;
  /** Mark every run so the next start resumes it, before a "Pause + update" quits. */
  suspendForUpdate?: () => unknown;
  /** Quit the app the ordinary way (drain, close); `installOnQuit` then finishes it. */
  quit?: () => void;
  /** The version whose notice the person dismissed, as remembered; and how to remember a new one. */
  dismissed?: string;
  saveDismissed?: (version: string) => void;
  /** How often "Wait + update" looks at what is going. */
  pollMs?: number;
}

export type RestartChoice = UpdateRestartChoice;
export type RestartAnswer = UpdateRestartAnswer;

export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Squirrel copies and unpacks the whole zip, a few seconds; minutes means it never will. */
export const SQUIRREL_TAKE_MS = 5 * 60 * 1000;
/** Squirrel tells ShipIt to start the app again and ends it, at once; past this the quit goes on without it. */
export const SQUIRREL_RESTART_MS = 15_000;

/** electron-updater names stable's feed `latest`. */
const feedChannel = (channel: UpdateChannel): string => (channel === "nightly" ? "nightly" : "latest");

function notesOf(info: UpdateInfoLike): string | undefined {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    const text = notes.map((n) => n.note ?? "").filter((n) => n !== "").join("\n\n");
    return text === "" ? undefined : text;
  }
  return undefined;
}

export class UpdateManager {
  private state: UpdateState;
  private readonly own: UpdateChannel;
  /** The channel the last check read, to know when a switch allows one downgrade. */
  private checkedChannel: UpdateChannel | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<UpdateState> | undefined;

  constructor(private readonly options: UpdateManagerOptions) {
    this.own = channelOfVersion(options.version);
    const dismissed = options.dismissed !== undefined ? { dismissed: options.dismissed } : {};
    this.state =
      options.port === undefined
        ? { status: "disabled", version: options.version, channel: this.own, reason: options.disabledReason ?? "this build does not update itself", ...dismissed }
        : { status: "idle", version: options.version, channel: this.own, ...(options.manual === true ? { manual: true } : {}), ...dismissed };
    const port = options.port;
    if (port !== undefined) {
      port.autoDownload = false;
      // Elsewhere `installOnQuit` runs the installer. On macOS this is what has electron-updater hand the
      // download to Squirrel at once, and Squirrel's ShipIt then installs it at whatever quit comes.
      port.autoInstallOnAppQuit = options.squirrel !== undefined;
      port.on("download-progress", (progress) => {
        if (this.state.status === "downloading") this.set({ ...this.state, percent: Math.round(progress.percent) });
      });
    }
    options.squirrel?.on("update-downloaded", () => this.squirrelTook?.());
    options.squirrel?.on("error", (error) => this.squirrelFailed?.(error));
  }

  /** What Squirrel's next `update-downloaded` or `error` is waited for by, if anything. */
  private squirrelTook: (() => void) | undefined;
  private squirrelFailed: ((error: Error) => void) | undefined;

  /**
   * Squirrel's word that it has the update and ShipIt is waiting for the app to end. Asked before the
   * download starts, since Squirrel may answer before the download's own promise settles; `stop` stops
   * listening, for a download that failed first.
   */
  private squirrelTakes(): { taken: Promise<void>; stop: () => void } {
    if (this.options.squirrel === undefined) return { taken: Promise.resolve(), stop: () => undefined };
    let stop = (): void => undefined;
    const taken = new Promise<void>((resolve, reject) => {
      stop = () => {
        clearTimeout(timer);
        this.squirrelTook = undefined;
        this.squirrelFailed = undefined;
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error("macOS's updater did not take the downloaded update"));
      }, this.options.squirrelTakeMs ?? SQUIRREL_TAKE_MS);
      timer.unref?.();
      this.squirrelTook = () => {
        stop();
        resolve();
      };
      this.squirrelFailed = (error) => {
        stop();
        reject(error);
      };
    });
    return { taken, stop };
  }

  current(): UpdateState {
    return this.state;
  }

  /** Apply the settings: a changed channel is checked soon, and may go back one version once. */
  configure(settings: JairaUpdatesConfig): void {
    const channel = settings.channel ?? this.own;
    if (channel === this.state.channel) return;
    const { available: _available, percent: _percent, error: _error, ...rest } = this.state;
    const status = this.state.status === "disabled" ? "disabled" : "idle";
    this.set({ ...rest, status, channel });
    if (status !== "disabled" && this.timer !== undefined) this.schedule(1000);
  }

  /** Start checking: once after a short wait, then on the interval. */
  start(): void {
    if (this.options.port === undefined) return;
    this.schedule(this.options.firstCheckMs ?? FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Read the feed now. */
  check(): Promise<UpdateState> {
    const port = this.options.port;
    if (port === undefined) return Promise.resolve(this.state);
    if (this.running !== undefined) return this.running;
    if (this.state.status === "downloading" || this.state.status === "downloaded") return Promise.resolve(this.state);
    this.running = this.read(port).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async read(port: UpdaterPort): Promise<UpdateState> {
    const channel = this.state.channel;
    const switched = this.checkedChannel !== undefined ? this.checkedChannel !== channel : channel !== this.own;
    port.channel = feedChannel(channel);
    port.allowPrerelease = channel === "nightly";
    port.allowDowngrade = switched;
    const { available: _a, percent: _p, error: _e, ...rest } = this.state;
    this.set({ ...rest, status: "checking" });
    try {
      const result = await port.checkForUpdates();
      this.checkedChannel = channel;
      const now = this.options.now?.() ?? Date.now();
      const info = result?.updateInfo;
      const offered = info !== undefined && result?.isUpdateAvailable !== false && info.version !== this.options.version;
      if (!offered || channelOfVersion(info.version) !== channel) {
        // Nothing newer — or the feed answered from the other channel, which this build does not follow.
        this.set({ ...rest, status: "up-to-date", checkedAt: now });
        return this.state;
      }
      const notes = notesOf(info);
      this.set({
        ...rest,
        status: "available",
        checkedAt: now,
        available: {
          version: info.version,
          ...(info.releaseDate !== undefined ? { releaseDate: info.releaseDate } : {}),
          ...(notes !== undefined ? { notes } : {}),
          url: this.options.releaseUrl(info.version),
        },
      });
      this.options.log?.("info", `update ${info.version} is available on ${channel}`);
      return this.state;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.options.log?.("warn", "update check failed", { message });
      this.set({ ...rest, status: "error", error: message, checkedAt: this.options.now?.() ?? Date.now() });
      return this.state;
    }
  }

  /**
   * Download what `check` found. A manual platform downloads nothing; the window opens the page. On
   * macOS it is downloaded only once Squirrel has taken it ({@link SquirrelPort}).
   */
  async download(): Promise<UpdateState> {
    const port = this.options.port;
    if (port === undefined || this.state.status !== "available" || this.state.manual === true) return this.state;
    this.set({ ...this.state, status: "downloading", percent: 0 });
    const squirrel = this.squirrelTakes();
    try {
      // Both at once, so a failure of either is the download's and neither is left unheard.
      await Promise.all([squirrel.taken, port.downloadUpdate()]);
      const { percent: _p, ...rest } = this.state;
      this.set({ ...rest, status: "downloaded" });
    } catch (e) {
      squirrel.stop();
      const message = e instanceof Error ? e.message : String(e);
      this.options.log?.("warn", "update download failed", { message });
      const { percent: _p, ...rest } = this.state;
      this.set({ ...rest, status: "error", error: message });
    }
    return this.state;
  }

  /**
   * The Update button: download what is available if it is not yet, then {@link restart} with the
   * choice (the person, 2026-09-26: "the update button in the sidebar should wait and update. there
   * should be a dropdown button that allows you to select the other options including not now"). The
   * button's own choice is `wait`; the dropdown's are `pause` and `later`. A platform that installs by
   * hand has nothing to download or restart into.
   */
  async apply(choice: RestartChoice): Promise<RestartAnswer> {
    if (this.state.manual === true) return { installing: false };
    if (this.state.status === "available") await this.download();
    return await this.restart(choice);
  }

  /** Whether an install can happen: only a downloaded update. */
  canInstall(): boolean {
    return this.state.status === "downloaded";
  }

  /**
   * The person's answer to "Restart to update" (the ruling of 2026-09-26):
   *
   *  - `now` restarts at once when nothing is going; with runs or chat turns going it installs nothing
   *    and says how many, so the window can offer the three choices below.
   *  - `later` ("Not now") leaves the update to install when JaiRA next closes — which is true of ANY
   *    quit once an update is downloaded (`installOnQuit`); this only says so on screen.
   *  - `pause` ("Pause + update") suspends every run so the next start resumes it, then restarts.
   *  - `wait` ("Wait + update") restarts by itself once nothing is going, and can be canceled.
   *  - `cancel` stops waiting and nothing more: Restart to update is back, and any quit still installs it.
   */
  async restart(choice: RestartChoice): Promise<RestartAnswer> {
    if (!this.canInstall()) return { installing: false };
    this.stopWaiting();
    const { busy: _busy, pending: _pending, ...rest } = this.state;
    switch (choice) {
      case "now": {
        const busy = await this.busyNow();
        if (busy.runs + busy.turns > 0) return { installing: false, busy };
        return this.quitToInstall();
      }
      case "pause":
        await this.options.suspendForUpdate?.();
        return this.quitToInstall();
      case "wait": {
        const now = await this.busyNow();
        if (now.runs + now.turns === 0) return this.quitToInstall();
        this.set({ ...rest, pending: "waiting", busy: now });
        const waiting = setInterval(() => {
          void this.busyNow().then((busy) => {
            // Canceled, or answered twice, while the engine was being asked.
            if (this.waiting !== waiting) return;
            if (busy.runs + busy.turns === 0) {
              this.stopWaiting();
              this.quitToInstall();
              return;
            }
            const was = this.state.busy;
            if (was?.runs !== busy.runs || was?.turns !== busy.turns) this.set({ ...this.state, busy });
          });
        }, this.options.pollMs ?? 2000);
        this.waiting = waiting;
        waiting.unref?.();
        return { installing: false, pending: "waiting" };
      }
      case "later":
        this.set({ ...rest, pending: "on-quit" });
        return { installing: false, pending: "on-quit" };
      case "cancel":
        // Stop waiting, and nothing more: the update is ready again, Restart to update is back, and any
        // quit still installs it.
        this.set(rest);
        return { installing: false };
    }
  }

  private waiting: ReturnType<typeof setInterval> | undefined;

  /** What is going, or nothing when the engine cannot say: a failed ask must not hold an update forever. */
  private async busyNow(): Promise<UpdateBusy> {
    try {
      return (await this.options.busy?.()) ?? { runs: 0, turns: 0 };
    } catch (e) {
      this.options.log?.("warn", "could not ask the engine what is running", { message: (e as Error).message });
      return { runs: 0, turns: 0 };
    }
  }

  private stopWaiting(): void {
    if (this.waiting !== undefined) clearInterval(this.waiting);
    this.waiting = undefined;
  }

  private quitToInstall(): RestartAnswer {
    this.relaunch = true;
    this.options.quit?.();
    return { installing: true };
  }

  /** Whether the quit under way was asked for to install, so the app starts again afterwards. */
  private relaunch = false;

  /**
   * Called at the end of every quit, after runs have drained and the databases closed: a downloaded
   * update installs. It starts the app again only when the quit was a restart asked for here; any
   * other quit installs silently and the update is simply there at the next start.
   *
   * It resolves when the caller may end the process. On macOS ShipIt is already waiting for the app to
   * end and installs it then, so a plain quit simply ends; a restart has Squirrel tell ShipIt to start
   * the app again, and Squirrel ends the app itself once it has — ended sooner, ShipIt would install and
   * start nothing. Only if Squirrel fails, or has not ended the app in time, does the quit go on.
   */
  installOnQuit(): Promise<void> {
    this.stopWaiting();
    if (!this.canInstall()) return Promise.resolve();
    this.options.log?.("info", `installing update ${this.state.available?.version ?? ""}${this.relaunch ? " and restarting" : " on quit"}`);
    if (this.options.squirrel === undefined) {
      this.options.port?.quitAndInstall(true, this.relaunch);
      return Promise.resolve();
    }
    if (!this.relaunch) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const goOn = (): void => {
        clearTimeout(timer);
        this.squirrelFailed = undefined;
        resolve();
      };
      const timer = setTimeout(goOn, this.options.squirrelRestartMs ?? SQUIRREL_RESTART_MS);
      this.squirrelFailed = (error) => {
        this.options.log?.("warn", "macOS's updater could not restart JaiRA: the update installs as it closes", { message: error.message });
        goOn();
      };
      this.options.port?.quitAndInstall(true, true);
    });
  }

  /** Hide the notice for this version; a newer one shows again. */
  dismiss(version: string): UpdateState {
    this.options.saveDismissed?.(version);
    this.set({ ...this.state, dismissed: version });
    return this.state;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(this.options.intervalMs ?? CHECK_INTERVAL_MS));
    }, ms);
    this.timer.unref?.();
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.options.publish(state);
  }
}
