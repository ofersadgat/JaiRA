import { useSyncExternalStore } from "react";

/**
 * Whether the connection to the machine went away, and why. The host that holds the bridge says so as
 * its state changes (`packages/client/src/Remote.tsx`: lost when the bridge starts waiting to reconnect,
 * restored when it is welcomed again), and the shell draws it (`floats/Disconnected.tsx`) — so the host
 * need not reach inside the shell, nor the shell know what carries its requests.
 */
let lost: string | null = null;
const listeners = new Set<() => void>();

const set = (next: string | null): void => {
  if (next === lost) return;
  lost = next;
  for (const listener of listeners) listener();
};

export function connectionLost(reason: string): void {
  set(reason);
}

/** The bridge is connected again, or the window is no longer on that machine at all. */
export function connectionRestored(): void {
  set(null);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Why the machine is gone, or `null` while it is there. */
export function useConnectionLost(): string | null {
  return useSyncExternalStore(subscribe, () => lost, () => lost);
}
