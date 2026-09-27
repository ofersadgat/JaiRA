/**
 * The updater, the plugins and Settings' warnings and errors, as the renderer sees them (decision 0011
 * §4–§6). Machine-wide state read from the sidebar, the About page and every page's "Needs attention",
 * so it is published here and read with a hook — `limitsStore.ts`'s arrangement — rather than threaded
 * through the shell's props. Main pushes each change (`update:changed`, `plugin:changed`,
 * `health:changed`); the first reader fetches the current state.
 *
 * The actions here are the screens' verbs, and one of them carries state of its own: a choice made in
 * the Update menu while the download is still running. `update:install` answers only once the download
 * it started has finished, and a second call before then finds nothing downloaded to restart into, so
 * the choice is held here and sent the moment the update is downloaded.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { HealthItem, PluginId, PluginStatus, UpdateBusy, UpdateRestartChoice, UpdateState } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

let update: UpdateState | null = null;
let plugins: PluginStatus[] = [];
let health: HealthItem[] = [];
/** What `update:busy` last answered: what the menu's choices are offered by. */
let busy: UpdateBusy | undefined;
/** A choice made while the download was running, sent once it is downloaded. */
let queued: UpdateRestartChoice | undefined;
/** This window asked for the restart and the app is quitting to install. */
let restarting = false;
/** When each plugin row's Check last read the store, epoch ms. */
let pluginsChecked: Partial<Record<PluginId, number>> = {};
/** The snapshot handed to React, rebuilt only when something in it changed. */
let snapshot: UpdateView = { update, busy, queued, restarting };

const watchers = new Set<() => void>();
let started = false;

function notify(): void {
  snapshot = { update, busy, queued, restarting };
  for (const w of [...watchers]) w();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

const hasBridge = (): boolean => typeof window !== "undefined" && (window as { jaira?: unknown }).jaira !== undefined;

/** Fetch once and listen — the first time anything asks. A server render (no bridge) never starts. */
function start(): void {
  if (started || !hasBridge()) return;
  started = true;
  void invoke("update:state", undefined).then(publishUpdate, () => undefined);
  void invoke("plugin:list", undefined).then(publishPlugins, () => undefined);
  void invoke("health:list", undefined).then(publishHealth, () => undefined);
  subscribePush((message) => {
    if (message.type === "update:changed") publishUpdate(message.state);
    else if (message.type === "plugin:changed") publishPlugins(message.plugins);
    else if (message.type === "health:changed") publishHealth(message.items);
  });
}

/** Replace the updater's state — from main, or from a test drawing a still picture. */
export function publishUpdate(next: UpdateState): void {
  update = next;
  if (queued !== undefined && next.status === "downloaded") {
    const choice = queued;
    queued = undefined;
    void send(choice);
  }
  notify();
}

/** Replace the plugins — from main, or from a test. */
export function publishPlugins(next: PluginStatus[]): void {
  plugins = next;
  notify();
}

/** Replace the board — from main, or from a test. */
export function publishHealth(next: HealthItem[]): void {
  health = next;
  notify();
}

/** What is going, as the Update menu offers its choices by — from main, or from a test. */
export function publishBusy(next: UpdateBusy | undefined): void {
  busy = next;
  notify();
}

export interface UpdateView {
  update: UpdateState | null;
  busy: UpdateBusy | undefined;
  queued: UpdateRestartChoice | undefined;
  restarting: boolean;
}

export function useUpdate(): UpdateView {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function usePlugins(): { plugins: PluginStatus[]; checked: Partial<Record<PluginId, number>> } {
  useEffect(start, []);
  const list = useSyncExternalStore(subscribe, () => plugins, () => plugins);
  const checked = useSyncExternalStore(subscribe, () => pluginsChecked, () => pluginsChecked);
  return { plugins: list, checked };
}

export function useHealth(): HealthItem[] {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => health, () => health);
}

// --- the update's verbs ------------------------------------------------------------------------------

/** Ask what is going now — when a menu opens. */
export function refreshBusy(): void {
  if (!hasBridge()) return;
  void invoke("update:busy", undefined).then(publishBusy, () => undefined);
}

/** Check the feed now. */
export function checkForUpdate(): void {
  void invoke("update:check", undefined).then(publishUpdate, () => undefined);
}

async function send(choice: UpdateRestartChoice): Promise<void> {
  try {
    const answer = await invoke("update:install", { when: choice });
    if (answer.installing) {
      restarting = true;
      notify();
    } else if (answer.busy !== undefined) {
      // "Update now" found work going after all: the menu offers the three choices by it next time.
      publishBusy(answer.busy);
    }
  } catch {
    // What went wrong arrives on `update:changed` as the error it is.
  }
}

/**
 * The Update button and its menu: download if needed, then restart the way `choice` says (Wait +
 * update when it is the click itself). While a download is running the choice is held and sent once it
 * has finished — see the module comment.
 */
export function applyUpdate(choice: UpdateRestartChoice = "wait"): void {
  if (update?.status === "downloading") {
    queued = choice;
    notify();
    return;
  }
  void send(choice);
}

/** The × on the sidebar row: hide the notice for this version. */
export function dismissUpdate(version: string): void {
  void invoke("update:dismiss", { version }).then(publishUpdate, () => undefined);
}

// --- the plugins' verbs ------------------------------------------------------------------------------

/** Download (or update) a plugin; progress and a failure arrive on `plugin:changed`. */
export function installPlugin(id: PluginId): void {
  void invoke("plugin:install", { id }).then(publishPlugins, () => undefined);
}

export function removePlugin(id: PluginId): void {
  void invoke("plugin:remove", { id }).then(publishPlugins, () => undefined);
}

/** A row's Check: read the store again, comparing what is installed with what this build names. */
export function checkPlugin(id: PluginId): void {
  void invoke("plugin:list", undefined).then(
    (next) => {
      pluginsChecked = { ...pluginsChecked, [id]: Date.now() };
      publishPlugins(next);
    },
    () => undefined,
  );
}

// --- the board's verbs -------------------------------------------------------------------------------

export function dismissHealth(id: string): void {
  void invoke("health:dismiss", { id }).then(publishHealth, () => undefined);
}

export function dismissAllHealth(): void {
  void invoke("health:dismissAll", undefined).then(publishHealth, () => undefined);
}
