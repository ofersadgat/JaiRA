/**
 * Where a project's conversations can run, as the renderer holds it (`environment:view`) — read by the
 * bar under the composer, the list it opens, the chip beside the title and the start page's sentence,
 * none of which is handed it. Published here and read with a hook, as `limitsStore.ts` is.
 *
 * Kept per workspace asked about, and only while something on screen reads it: the first reader fetches,
 * and it is fetched again when the engine says a checkout moved (`environment:changed`), when what waits
 * or runs changed (`placement:changed`, `run:finished`) and when a machine came or went
 * (`machines:changed`). With nothing reading, nothing is asked.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { EnvironmentView } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

const views = new Map<string, EnvironmentView>();
/** How many readers each workspace has on screen. */
const reading = new Map<string, number>();
const watchers = new Set<() => void>();
const asking = new Map<string, Promise<void>>();
const again = new Set<string>();
let started = false;

function notify(): void {
  for (const w of [...watchers]) w();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

const hasBridge = (): boolean => typeof window !== "undefined" && (window as { jaira?: unknown }).jaira !== undefined;

/** Ask for one workspace's view. One call at a time for each: a second ask while one is out runs after it. */
function ask(workspace: string): void {
  if (!hasBridge()) return;
  if (asking.has(workspace)) {
    again.add(workspace);
    return;
  }
  const call = invoke("environment:view", { workspace })
    .then(
      (next) => publishEnvironment(workspace, next),
      () => undefined,
    )
    .finally(() => {
      asking.delete(workspace);
      if (again.delete(workspace) && reading.has(workspace)) ask(workspace);
    });
  asking.set(workspace, call);
}

/** Whether a view holds a workspace, by its directory or its key. */
function holds(view: EnvironmentView, project: string): boolean {
  return view.machines.some((m) => m.workspaces.some((w) => w.project === project || w.dir === project));
}

function start(): void {
  if (started || !hasBridge()) return;
  started = true;
  subscribePush((message) => {
    if (message.type === "environment:changed") {
      for (const key of reading.keys()) {
        const view = views.get(key);
        if (key === message.project || view === undefined || holds(view, message.project)) ask(key);
      }
    } else if (message.type === "placement:changed" || message.type === "machines:changed" || message.type === "run:finished") {
      for (const key of reading.keys()) ask(key);
    }
  });
}

/** Replace a workspace's view — from the engine, or from a specimen drawing a still picture. */
export function publishEnvironment(workspace: string, next: EnvironmentView): void {
  const was = views.get(workspace);
  if (was !== undefined && JSON.stringify(was) === JSON.stringify(next)) return;
  views.set(workspace, next);
  notify();
}

/** Where `workspace`'s conversations can run; `undefined` until the engine has answered, or with none named. */
export function useEnvironment(workspace: string | undefined): EnvironmentView | undefined {
  useEffect(() => {
    if (workspace === undefined) return;
    start();
    reading.set(workspace, (reading.get(workspace) ?? 0) + 1);
    ask(workspace);
    return () => {
      const left = (reading.get(workspace) ?? 1) - 1;
      if (left <= 0) reading.delete(workspace);
      else reading.set(workspace, left);
    };
  }, [workspace]);
  const read = (): EnvironmentView | undefined => (workspace !== undefined ? views.get(workspace) : undefined);
  return useSyncExternalStore(subscribe, read, read);
}
