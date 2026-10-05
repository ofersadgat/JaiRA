import { useSyncExternalStore } from "react";

/**
 * Where a phone stands with its machine, for the shell to say (decision 0015, amended 2026-10-04: the
 * shell is drawn at once, whether or not a machine is reached — its projects are those of the machines
 * it reaches). The phone's connection (`client/src/Remote.tsx`) sets it; `PhoneFrame` draws a line under
 * the title bar from it while it is not null, and pressing the line opens the Connect screen (`open`).
 *
 * - `none`: no machine paired yet;
 * - `connecting`: a paired machine being reached;
 * - `problem`: a paired machine that is not answering, or refused, with why.
 *
 * Null once connected — and on the desktop, which never sets it. A connection lost afterwards is
 * `Disconnected`'s to say.
 */
export type RemoteStatus = { state: "none" | "connecting" | "problem"; label?: string | undefined; detail?: string | undefined; open: () => void } | null;

let value: RemoteStatus = null;
const listeners = new Set<() => void>();

export const remoteStatus = {
  get: (): RemoteStatus => value,
  set: (next: RemoteStatus): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const on of listeners) on();
  },
  use: (): RemoteStatus =>
    useSyncExternalStore(
      (on) => {
        listeners.add(on);
        return () => listeners.delete(on);
      },
      () => value,
      () => value,
    ),
};

/**
 * The machines a phone is paired with, for its drawer's row (`ShellSidebar` on a phone): their names, how
 * many answer, and the way to the Connect screen that lists them and pairs another. Null where there is
 * no such phone (the desktop, a browser tab).
 */
export type PhoneMachines = { labels: readonly string[]; connected: number; open: () => void } | null;
let machinesValue: PhoneMachines = null;
const machinesListeners = new Set<() => void>();
export const phoneMachines = {
  get: (): PhoneMachines => machinesValue,
  set: (next: PhoneMachines): void => {
    if (Object.is(next, machinesValue)) return;
    machinesValue = next;
    for (const on of machinesListeners) on();
  },
  use: (): PhoneMachines =>
    useSyncExternalStore(
      (on) => {
        machinesListeners.add(on);
        return () => machinesListeners.delete(on);
      },
      () => machinesValue,
      () => machinesValue,
    ),
};
