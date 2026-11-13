/**
 * Where a quit attempt stands, as the window sees it: main pushes each change (`quit:changed`, to the
 * window alone), and a window that was reloaded asks once (`quit:state`). Read with a hook, in
 * `updatesStore.ts`'s arrangement. The verbs answer main (`quit:answer`), and `quitShown` tells it the
 * dialog was drawn, so it does not fall back to the OS's own box.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { QuitChoice, QuitState } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

const IDLE: QuitState = { phase: "idle", work: [] };
let state: QuitState = IDLE;
const watchers = new Set<() => void>();
let started = false;

const hasBridge = (): boolean => typeof window !== "undefined" && (window as { jaira?: unknown }).jaira !== undefined;

/** Replace the state — from main, or from a test drawing a still picture. */
export function publishQuit(next: QuitState): void {
  state = next;
  for (const w of [...watchers]) w();
}

function start(): void {
  if (started || !hasBridge()) return;
  started = true;
  subscribePush((message) => {
    if (message.type === "quit:changed") publishQuit(message.state);
  });
  // Only the desktop answers it; anywhere else there is no quit to ask about.
  void invoke("quit:state", undefined).then(publishQuit, () => undefined);
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

export function useQuit(): QuitState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function answerQuit(choice: QuitChoice): void {
  void invoke("quit:answer", { choice }).then(publishQuit, () => undefined);
}

export function quitShown(): void {
  void invoke("quit:shown", undefined).catch(() => undefined);
}
