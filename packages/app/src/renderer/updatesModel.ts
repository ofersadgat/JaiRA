/**
 * What the update, plugin and health screens decide, apart from how they draw it (decision 0011 §4–§6
 * and the person's rulings on the three rounds of mockups, 2026-09-26). Pure, so the rules the person
 * set — when the sidebar row shows, which choices its menu offers, how a nightly is named — are
 * tested without a window.
 *
 * Three surfaces read it:
 *
 *  - **the sidebar's Update row**, above Settings, shown only while there is something to do: an
 *    update available and not dismissed, downloading, waiting to restart, downloaded, or failed. It is
 *    a SPLIT row: the row is one click (download if needed, then Wait + update) and its chevron opens
 *    the other ways ({@link updateMenu});
 *  - **Settings → About**: the same split button as the Status row's control, always there, whether
 *    or not the sidebar's notice was dismissed; and the Plugins rows ({@link pluginFamilies});
 *  - **Settings' warnings and errors**: the pills on the Settings row and on each page, the card that
 *    lists them all, and each page's "Needs attention" section ({@link healthCounts},
 *    {@link healthGroups}, {@link healthFixLabel}).
 */
import {
  PLUGINS,
  channelOfVersion,
  type HealthAction,
  type HealthItem,
  type HealthPage,
  type LogEntry,
  type PluginId,
  type PluginStatus,
  type UpdateBusy,
  type UpdateRestartChoice,
  type UpdateState,
} from "@jaira/shared/browser";
import type { PillCounts } from "./pill";

// --- versions ------------------------------------------------------------------------------------

/**
 * How a version is named where there is little room: a nightly is just "nightly" — its date and build
 * number are what the hover card is for (the person's ruling, round 1) — and a stable release is itself.
 */
export function versionLabel(version: string): string {
  return channelOfVersion(version) === "nightly" ? "nightly" : version;
}

/** "published today, 14:05", "published yesterday, 09:12", "published Sep 24" — or nothing. */
export function publishedWords(releaseDate: string | undefined, now: number = Date.now()): string | undefined {
  if (releaseDate === undefined) return undefined;
  const at = new Date(releaseDate);
  if (Number.isNaN(at.getTime())) return undefined;
  const day = (d: Date): string => d.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (day(at) === day(today)) return `published today, ${time}`;
  if (day(at) === day(yesterday)) return `published yesterday, ${time}`;
  return `published ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** "checked just now", "checked 12 min ago", "checked 3 h ago" — or the honest absence of one. */
export function checkedAgo(at: number | undefined, now: number = Date.now()): string {
  if (at === undefined || at === 0) return "not checked yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "checked just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`;
}

/** "2 runs working · 1 chat turn" — what is going, as the menu's head says it. Empty when nothing is. */
export function busyWords(busy: UpdateBusy | undefined): string {
  if (busy === undefined) return "";
  const parts: string[] = [];
  if (busy.runs > 0) parts.push(`${busy.runs} ${busy.runs === 1 ? "run" : "runs"} working`);
  if (busy.turns > 0) parts.push(`${busy.turns} chat ${busy.turns === 1 ? "turn" : "turns"}`);
  return parts.join(" · ");
}

/** "the 2 runs", "the chat turn", "2 runs and 1 chat turn" — what a restart waits for. */
export function waitedFor(busy: UpdateBusy | undefined): string {
  if (busy === undefined || busy.runs + busy.turns === 0) return "nothing is going";
  const runs = busy.runs === 1 ? "1 run" : `${busy.runs} runs`;
  const turns = busy.turns === 1 ? "1 chat turn" : `${busy.turns} chat turns`;
  if (busy.turns === 0) return runs;
  if (busy.runs === 0) return turns;
  return `${runs} and ${turns}`;
}

const going = (busy: UpdateBusy | undefined): boolean => busy !== undefined && busy.runs + busy.turns > 0;

/** "2 runs finish", "1 run finishes" — the tail of "restarts when …". */
function whenFinished(busy: UpdateBusy | undefined): string {
  return `${waitedFor(busy)} ${busy !== undefined && busy.runs + busy.turns === 1 ? "finishes" : "finish"}`;
}

// --- the sidebar row -----------------------------------------------------------------------------

/** What the sidebar's Update row says, or `null` while it has nothing to say. */
export interface SidebarUpdate {
  kind: "available" | "manual" | "downloading" | "waiting" | "downloaded" | "restarting" | "error";
  glyph: string;
  label: string;
  /** The version, short ("nightly" for a nightly), at the row's trailing end. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** The row's tooltip: what the one click does. */
  title: string;
  /** The × on hover dismisses the notice for this version. */
  dismissible: boolean;
  /** The chevron: the other ways to update. */
  menu: boolean;
}

/**
 * The sidebar row, from where the updater stands.
 *
 * Hidden while there is nothing to do — up to date, not checked, checking, a build that cannot update —
 * and after the person said so: the × dismissed this version (`dismissed`), or "Not now" left it to the
 * next quit (`pending: "on-quit"`, where About says so instead). `restarting` is this window's own
 * knowledge that it asked for the restart and the app is on its way out.
 */
export function sidebarUpdateOf(state: UpdateState | null, restarting = false): SidebarUpdate | null {
  if (state === null) return null;
  const next = state.available;
  const version = next !== undefined ? versionLabel(next.version) : undefined;
  const withVersion = version !== undefined ? { version } : {};
  if (restarting) return { kind: "restarting", glyph: "↻", label: "Restarting…", title: "Restarting to install the update", dismissible: false, menu: false };
  if (next !== undefined && state.dismissed === next.version) return null;
  switch (state.status) {
    case "available":
      if (next === undefined) return null;
      if (state.manual === true) {
        return { kind: "manual", glyph: "↗", label: "Get", ...withVersion, title: `Open the release page of ${next.version}`, dismissible: true, menu: false };
      }
      return { kind: "available", glyph: "↓", label: "Update", ...withVersion, title: `Update to ${next.version}: downloads, then restarts once nothing is going`, dismissible: true, menu: true };
    case "downloading":
      return {
        kind: "downloading",
        glyph: "↓",
        label: "Downloading",
        percent: state.percent ?? 0,
        title: `Downloading ${next?.version ?? "the update"} — ${state.percent ?? 0}%`,
        dismissible: false,
        menu: true,
      };
    case "downloaded":
      if (state.pending === "on-quit") return null;
      if (state.pending === "waiting") {
        return {
          kind: "waiting",
          glyph: "◷",
          label: `Waiting for ${waitedFor(state.busy)}…`,
          title: `Waiting for ${waitedFor(state.busy)} to finish, then restarting`,
          dismissible: false,
          menu: true,
        };
      }
      // No version on this one: "Restart to update" is the whole of what the row has room to say.
      return { kind: "downloaded", glyph: "↻", label: "Restart to update", title: `Restart to install ${next?.version ?? "the update"}`, dismissible: true, menu: true };
    case "error":
      return {
        kind: "error",
        glyph: "!",
        label: "Update failed",
        title: `${state.error ?? "The update could not be checked or downloaded"} — opens Settings → About`,
        dismissible: next !== undefined,
        menu: false,
      };
    default:
      return null;
  }
}

// --- the menu -------------------------------------------------------------------------------------

/** One entry of the Update menu: a way to restart, or the release notes. */
export type UpdateMenuItem =
  | { kind: "choice"; choice: UpdateRestartChoice; name: string; hint: string; on?: boolean; rule?: boolean }
  | { kind: "notes"; name: string; hint: string; rule?: boolean };

export interface UpdateMenu {
  /** What is going, or that nothing is — the menu's head. */
  head: string;
  items: UpdateMenuItem[];
}

/**
 * The choices behind the chevron, the same in the sidebar and on About (the person's rulings, round 3):
 *
 *  - with runs or chat turns going: Wait + update (✓, the click), Pause + update, Not now;
 *  - with nothing going: Update now (✓), Not now;
 *  - while waiting: Pause + update, Not now, Cancel;
 *  - after Not now (About's "Restart now"): the first list without Not now, which is where it stands.
 *
 * The sidebar adds Release notes, which opens About. There is no "Hide until a newer version": that is
 * the × on hover alone. `busy` is what `update:busy` answered when the menu opened; `queued` is a choice
 * made while the download was still running, which the ✓ then marks.
 */
export function updateMenu(state: UpdateState, busy: UpdateBusy | undefined, where: "sidebar" | "about", queued?: UpdateRestartChoice): UpdateMenu {
  const downloaded = state.status === "downloaded";
  const version = state.available?.version;
  const notes: UpdateMenuItem[] = where === "sidebar" ? [{ kind: "notes", name: "Release notes", hint: "opens Settings → About", rule: true }] : [];
  if (downloaded && state.pending === "waiting") {
    const waiting = state.busy ?? busy;
    return {
      head: `Restarts when ${whenFinished(waiting)}${version !== undefined ? ` · ${version} is downloaded` : ""}`,
      items: [
        { kind: "choice", choice: "pause", name: "Pause + update", hint: "pauses them now and restarts" },
        { kind: "choice", choice: "later", name: "Not now", hint: "installs when JaiRA next closes" },
        { kind: "choice", choice: "cancel", name: "Cancel", hint: "stops waiting; Restart to update is back, and closing JaiRA still installs it", rule: true },
      ],
    };
  }
  const later = !(downloaded && state.pending === "on-quit");
  const get = downloaded ? "" : "downloads, then ";
  const mark = (choice: UpdateRestartChoice, fallback: boolean): boolean => (queued !== undefined ? queued === choice : fallback);
  if (going(busy)) {
    return {
      head: busyWords(busy),
      items: [
        { kind: "choice", choice: "wait", name: "Wait + update", hint: `${get}restarts when ${whenFinished(busy)}`, on: mark("wait", true) },
        { kind: "choice", choice: "pause", name: "Pause + update", hint: "pauses them now; they resume after the restart", on: mark("pause", false) },
        ...(later ? [{ kind: "choice" as const, choice: "later" as const, name: "Not now", hint: `${downloaded ? "" : "downloads; "}installs when JaiRA next closes`, on: mark("later", false) }] : []),
        ...notes,
      ],
    };
  }
  return {
    head: "Nothing is going",
    items: [
      { kind: "choice", choice: "now", name: "Update now", hint: `${get}restarts`, on: mark("now", true) || mark("wait", false) },
      ...(later ? [{ kind: "choice" as const, choice: "later" as const, name: "Not now", hint: `${downloaded ? "" : "downloads; "}installs when JaiRA next closes`, on: mark("later", false) }] : []),
      ...notes,
    ],
  };
}

// --- plugins ----------------------------------------------------------------------------------------

/** A plugin as a row draws it. */
export interface PluginRow {
  id: PluginId;
  name: string;
  /** One line under the name: what it does, or (a build) what hardware it is for. */
  note: string;
  status: PluginStatus;
  /**
   * Present because this development checkout has the package in its `node_modules` — it works
   * without a download, whatever version it is, and the store does not own it: nothing to download,
   * update or remove. Neither `current` nor `outdated` then.
   */
  workspace: boolean;
  /** Installed in the store, and the version this build names. */
  current: boolean;
  /** Installed in the store, but another version than this build names — what an app update left behind. */
  outdated: boolean;
  /** Downloading now. */
  busy: boolean;
}

/** A family: the SDK, or Local models with the builds this machine can use. */
export interface PluginFamily {
  base: PluginRow;
  /** Local models' builds — the recommended one marked by `status.recommended`; empty for the SDK. */
  builds: PluginRow[];
}

/** What each Local models build is for, in the few words a line under its name has room for. */
const BUILD_NOTES: Partial<Record<PluginId, string>> = {
  "llama-cpu": "works everywhere",
  "llama-vulkan": "any GPU with a Vulkan driver",
  "llama-cuda": "NVIDIA GPU",
  "llama-cuda-ext": "more NVIDIA generations; larger",
  "llama-metal": "Apple Silicon GPU",
};

function rowOf(status: PluginStatus): PluginRow {
  const spec = PLUGINS.find((p) => p.id === status.id)!;
  const variant = spec.variantOf !== undefined;
  const workspace = status.from === "workspace" && status.installed !== undefined;
  return {
    id: status.id,
    name: variant ? spec.title.replace(/^Local models: /, "") : spec.title,
    note: variant ? (BUILD_NOTES[status.id] ?? spec.purpose) : spec.purpose,
    status,
    workspace,
    current: !workspace && status.installed !== undefined && status.installed === status.version,
    outdated: !workspace && status.installed !== undefined && status.installed !== status.version,
    busy: status.progress !== undefined,
  };
}

/**
 * The Plugins rows: one per family, in the catalog's order, each with the builds this machine can use
 * (the person's ruling: unavailable ones are not shown). A family whose base this machine cannot use is
 * left out whole. Builds are ordered installed first, then the suggested one, then the catalog's order —
 * what you have, then what you would add.
 */
export function pluginFamilies(statuses: readonly PluginStatus[]): PluginFamily[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const families: PluginFamily[] = [];
  for (const spec of PLUGINS) {
    if (spec.variantOf !== undefined) continue;
    const base = byId.get(spec.id);
    if (base === undefined || !base.available) continue;
    const builds = PLUGINS.filter((p) => p.variantOf === spec.id)
      .map((p) => byId.get(p.id))
      .filter((s): s is PluginStatus => s !== undefined && s.available)
      .map((s, at) => ({ row: rowOf(s), at }))
      .sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at)
      .map((entry) => entry.row);
    families.push({ base: rowOf(base), builds });
  }
  return families;
}

const rank = (row: PluginRow): number => (row.status.installed !== undefined ? 0 : row.status.recommended === true ? 1 : 2);

/** "106 MB", "9.4 MB", "820 KB" — a download's size. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * What adding a build downloads: its own packages, plus the family's base when that is not installed
 * yet (installing a build installs its base). Unknown when either size is.
 */
export function buildDownloadBytes(family: PluginFamily, build: PluginRow): number | undefined {
  const own = build.status.downloadBytes;
  if (own === undefined) return undefined;
  if (family.base.status.installed !== undefined) return own;
  const base = family.base.status.downloadBytes;
  return base === undefined ? undefined : base + own;
}

// --- health -------------------------------------------------------------------------------------------

/** The pages problems are listed under, in the card's order: where a fix is. */
export const HEALTH_PAGES: ReadonlyArray<{ page: HealthPage; label: string }> = [
  { page: "connections", label: "Connections" },
  { page: "logs", label: "Logs" },
  { page: "about", label: "About" },
];

/** Errors and warnings as the status pills count them — of one page, or of all. */
export function healthCounts(items: readonly HealthItem[], page?: HealthPage): PillCounts {
  const counts: PillCounts = {};
  for (const item of items) {
    if (page !== undefined && item.page !== page) continue;
    counts[item.level] = (counts[item.level] ?? 0) + 1;
  }
  return counts;
}

/** Every item, grouped by the page it belongs to, pages in {@link HEALTH_PAGES}' order, empty ones left out. */
export function healthGroups(items: readonly HealthItem[]): Array<{ page: HealthPage; label: string; items: HealthItem[] }> {
  return HEALTH_PAGES.map(({ page, label }) => ({ page, label, items: items.filter((item) => item.page === page) })).filter((group) => group.items.length > 0);
}

/** "3 errors · 2 warnings". */
export function healthTally(items: readonly HealthItem[]): string {
  const errors = items.filter((i) => i.level === "error").length;
  const warnings = items.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  return parts.join(" · ");
}

/** What an item's button says. */
export function healthFixLabel(action: HealthAction): string {
  switch (action) {
    case "sign-in":
      return "Sign in again";
    case "check":
      return "Check again";
    case "retry-plugin":
      return "Try again";
    case "retry-update":
      return "Check again";
    case "open-logs":
      return "Open logs";
  }
}

/**
 * "since 14:12" for an error — something that stopped and is still stopped — and "at 15:20" for a
 * warning, which is a thing that failed once. Another day's adds the date.
 */
export function sinceWords(item: HealthItem, now: number = Date.now()): string {
  const at = new Date(item.since);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const when = at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  return `${item.level === "error" ? "since" : "at"} ${when}`;
}

// --- the log's unseen entries ---------------------------------------------------------------------

/** The log's two items on the board (main's `health.ts`): errors and warnings written since each was last dismissed. */
export const LOG_ERRORS_ID = "log:errors";
export const LOG_WARNINGS_ID = "log:warnings";

/**
 * What in the log the person has not seen, read off the board: since when each level has entries they
 * have not dismissed, and how many (the count main keeps, which spans pages the panel has not
 * fetched). Absent when both are dismissed.
 */
export interface LogUnseen {
  /** Epoch ms of the first error and the first warning since the last dismissal. */
  since: { error?: number; warn?: number };
  counts: PillCounts;
  /** The board's ids to dismiss, for the panel's Dismiss. */
  ids: string[];
}

/** How many entries a log item counts (the board keeps it); one when it does not say. */
const loggedCount = (item: HealthItem): number => item.count ?? 1;

export function logUnseen(items: readonly HealthItem[]): LogUnseen | undefined {
  const errors = items.find((item) => item.id === LOG_ERRORS_ID);
  const warnings = items.find((item) => item.id === LOG_WARNINGS_ID);
  if (errors === undefined && warnings === undefined) return undefined;
  return {
    since: { ...(errors !== undefined ? { error: errors.since } : {}), ...(warnings !== undefined ? { warn: warnings.since } : {}) },
    counts: { ...(errors !== undefined ? { error: loggedCount(errors) } : {}), ...(warnings !== undefined ? { warning: loggedCount(warnings) } : {}) },
    ids: [errors, warnings].flatMap((item) => (item === undefined ? [] : [item.id])),
  };
}

/**
 * Whether one entry is among those not seen: an error or a warning written at or after its level's
 * `since`. An entry Settings already shows where it belongs (`raised`, a failed plugin download on
 * About) is not counted by the board, so it is not marked here either.
 */
export function isUnseenLog(entry: Pick<LogEntry, "level" | "at" | "raised">, unseen: LogUnseen | undefined): boolean {
  if (unseen === undefined || entry.raised !== undefined) return false;
  if (entry.level !== "error" && entry.level !== "warn") return false;
  const since = unseen.since[entry.level];
  return since !== undefined && entry.at >= since;
}
