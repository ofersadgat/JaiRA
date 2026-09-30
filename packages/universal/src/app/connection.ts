import { useSyncExternalStore } from "react";

/**
 * Whether the socket to the desktop went away, and why (decision 0015): what `Shell.tsx`'s banner says
 * on the DOM page. The host that opened the socket says so (`bridge.onClose(connectionLost)` in
 * `NativeApp.tsx` and the `/rn` page), and the shell draws it (`floats/Disconnected.tsx`) — so the host
 * need not reach inside the shell, nor the shell know what carries its requests.
 */
let lost: string | null = null;
const listeners = new Set<() => void>();

export function connectionLost(reason: string): void {
  lost = reason;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Why the desktop is gone, or `null` while it is there. */
export function useConnectionLost(): string | null {
  return useSyncExternalStore(subscribe, () => lost, () => lost);
}
