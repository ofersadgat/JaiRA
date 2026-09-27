/**
 * The app's own updates (decision 0011 §4–§5): which channel a build follows and where the updater
 * stands. The main process owns the updater (`packages/app/src/main/updates.ts`); these are the shapes
 * it hands the window.
 *
 * Two channels. `stable` releases are `X.Y.Z`; `nightly` releases are `X.Y.Z-nightly.YYYYMMDD.N`
 * prereleases, published to the same releases repository with their own feed files (`nightly*.yml`
 * beside stable's `latest*.yml`). A build follows the channel its own version belongs to unless the
 * person's `updates.channel` setting says otherwise.
 */

export type UpdateChannel = "stable" | "nightly";

/** The public repository every release is published to (decision 0011 §3), and so the update feed. */
export const UPDATE_FEED_REPOSITORY = { owner: "ofersadgat", repo: "releases" } as const;

/** A release's page, which a platform that installs by hand opens. */
export function releasePageOf(version: string): string {
  return `https://github.com/${UPDATE_FEED_REPOSITORY.owner}/${UPDATE_FEED_REPOSITORY.repo}/releases/tag/v${version}`;
}

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

/** The channel a version was released on. Anything that is not a nightly counts as stable. */
export function channelOfVersion(version: string): UpdateChannel {
  return NIGHTLY_VERSION.test(version) ? "nightly" : "stable";
}

/** Where the updater stands. */
export type UpdateStatus =
  /** Updates cannot happen in this build; `reason` says why. */
  | "disabled"
  /** Nothing checked yet. */
  | "idle"
  | "checking"
  | "up-to-date"
  /** A newer version is published and not downloaded. */
  | "available"
  | "downloading"
  /** Downloaded; installing is a restart. */
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** The running build's version. */
  version: string;
  /** The channel being followed: the setting, else the running build's own. */
  channel: UpdateChannel;
  /** Why updates are off, for `disabled`. */
  reason?: string;
  /** The newer version, from `available` on. */
  available?: {
    version: string;
    releaseDate?: string;
    /** The release's notes, as published. */
    notes?: string;
    /** The release page, for a platform that installs by hand. */
    url: string;
  };
  /** 0–100 while `downloading`. */
  percent?: number;
  /**
   * The platform cannot install this update itself (an unsigned macOS build: Squirrel.Mac refuses an
   * app without a Developer ID signature), so `available` offers the release page instead of a
   * download.
   */
  manual?: boolean;
  /** When the feed was last read, epoch ms. */
  checkedAt?: number;
  /** What went wrong, for `error`. */
  error?: string;
  /** The version whose notice the person dismissed; the notice shows again for a newer one. */
  dismissed?: string;
  /**
   * A downloaded update the person put off: `on-quit` installs when JaiRA next closes ("Not now"; any
   * quit installs a downloaded update), `waiting` restarts by itself once nothing is going ("Wait +
   * update").
   */
  pending?: "on-quit" | "waiting";
  /** While `waiting`: what is still going. */
  busy?: UpdateBusy;
}

/**
 * The person's answer to "Restart to update" (decision 0011 §4, the ruling of 2026-09-26): `now`, or,
 * with runs or chat turns going, "Not now" (`later`), "Pause + update" (`pause`), "Wait + update"
 * (`wait`), and `cancel` to stop waiting.
 */
export type UpdateRestartChoice = "now" | "later" | "pause" | "wait" | "cancel";

export interface UpdateRestartAnswer {
  /** The app is quitting to install. */
  installing: boolean;
  /** `now` found work going and did nothing: what is going, for the three choices. */
  busy?: UpdateBusy;
  pending?: UpdateState["pending"];
}

/** What is going: runs in flight, and chat turns being answered. */
export interface UpdateBusy {
  runs: number;
  turns: number;
}

/**
 * The `jaira` command on this machine's PATH (decision 0011 §7), for About's Command line row: the
 * installer puts it there on Windows and with the .deb; macOS gets an install action.
 */
export interface CliCommandStatus {
  state: "installed" | "missing" | "development" | "unavailable";
  /** Where the command is, when installed. */
  path?: string;
  /** Why it is not there, or how to get it, when that is not an action here. */
  reason?: string;
  /** Whether About can put it there (again). */
  canInstall: boolean;
}

/**
 * Where the engine this window uses runs (decision 0012 §5), for About's Engine section: in this
 * window's own process, in another process it is a client of, or nowhere yet.
 */
export interface EngineStatus {
  /** `local`: this window's process hosts it; `remote`: another process does; `starting`: neither yet. */
  mode: "local" | "remote" | "starting";
  /** The host, when there is one: this window's own for `local`. */
  host?: { kind: "desktop" | "server" | "cli"; pid: number; version: string; startedAt: number };
  /** This window's process. */
  pid: number;
  /** This window started the separate server it uses (`engine.separateServer`). */
  startedServer: boolean;
  /** Why this window is not using the engine it would have chosen: a pipe that could not be made, a server that did not start. */
  note?: string;
}
