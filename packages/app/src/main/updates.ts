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
 *
 * electron-updater is reached through {@link UpdaterPort}, so all of the above is tested without it.
 */
import { channelOfVersion, type UpdateChannel, type UpdateState } from "@jaira/shared";
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
  /** The release page of a version. */
  releaseUrl: (version: string) => string;
  /** Every change of state, for the window. */
  publish: (state: UpdateState) => void;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** How long after start the first check waits, and how often checks repeat. */
  firstCheckMs?: number;
  intervalMs?: number;
}

export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

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
    this.state =
      options.port === undefined
        ? { status: "disabled", version: options.version, channel: this.own, reason: options.disabledReason ?? "this build does not update itself" }
        : { status: "idle", version: options.version, channel: this.own, ...(options.manual === true ? { manual: true } : {}) };
    const port = options.port;
    if (port !== undefined) {
      port.autoDownload = false;
      port.autoInstallOnAppQuit = false;
      port.on("download-progress", (progress) => {
        if (this.state.status === "downloading") this.set({ ...this.state, percent: Math.round(progress.percent) });
      });
    }
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

  /** Download what `check` found. A manual platform downloads nothing; the window opens the page. */
  async download(): Promise<UpdateState> {
    const port = this.options.port;
    if (port === undefined || this.state.status !== "available" || this.state.manual === true) return this.state;
    this.set({ ...this.state, status: "downloading", percent: 0 });
    try {
      await port.downloadUpdate();
      const { percent: _p, ...rest } = this.state;
      this.set({ ...rest, status: "downloaded" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.options.log?.("warn", "update download failed", { message });
      const { percent: _p, ...rest } = this.state;
      this.set({ ...rest, status: "error", error: message });
    }
    return this.state;
  }

  /** Whether an install can start: only a downloaded update. The caller then quits the app. */
  canInstall(): boolean {
    return this.state.status === "downloaded";
  }

  /** Replace the app and relaunch it. Called after the quit has drained runs and closed the databases. */
  installNow(): void {
    if (!this.canInstall()) return;
    this.options.log?.("info", `installing update ${this.state.available?.version ?? ""}`);
    this.options.port?.quitAndInstall(true, true);
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
