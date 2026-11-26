import { createContext, useCallback, useSyncExternalStore } from "react";
import type { ConnectProps } from "../screens/Connect";
import { useShell } from "./shell";
import { phoneInbox } from "./viewState";

/**
 * Where a phone stands with its machine, for the shell to say (decision 0015, amended 2026-10-04: the
 * shell is drawn at once, whether or not a machine is reached — its projects are those of the machines
 * it reaches). The phone's connection (`client/src/Remote.tsx`) sets it; `PhoneFrame` draws a line under
 * the title bar from it while it is not null, and pressing the line opens Settings → Machines, where the
 * phone's machines are listed and another is paired (`PhoneConnect`).
 *
 * - `none`: no machine paired yet;
 * - `connecting`: a paired machine being reached;
 * - `problem`: a paired machine that is not answering, or refused, with why.
 *
 * Null once connected — and on the desktop, which never sets it. A connection lost afterwards is
 * `Disconnected`'s to say.
 */
export type RemoteStatus = { state: "none" | "connecting" | "problem"; label?: string | undefined; detail?: string | undefined } | null;

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
 * The machines a phone is paired with, for its drawer's row (`ShellSidebar` on a phone): their names and
 * how many answer; pressed, Settings → Machines. Null where there is no such phone (the desktop, a
 * browser tab).
 */
export type PhoneMachines = { labels: readonly string[]; connected: number } | null;
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

/**
 * The phone's own machines and the way to pair another, as Settings → Machines draws them in its This
 * phone section (`MachinesPage`): what the phone's connection (`client/src/Remote.tsx`, which wraps the
 * shell) gives the `Connect` panel, and `shown`, told while the section is on screen — the phone looks
 * for machines on its Wi-Fi only then. Null where there is no such phone.
 */
export type PhoneConnect = { props: ConnectProps; shown: (on: boolean) => void } | null;
export const PhoneConnectContext = createContext<PhoneConnect>(null);

/** The way to the phone's machines: Settings → Machines, out of the Inbox room if it is open. */
export function useOpenPhoneMachines(): () => void {
  const { actions } = useShell();
  return useCallback(() => {
    phoneInbox.set(false);
    actions.setSection("machines");
    actions.setView("settings");
  }, [actions]);
}
