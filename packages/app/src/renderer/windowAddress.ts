/**
 * Where this window stands — the project, the view, the task and the conversation open in it — the
 * window's own data (decision 0018 §9), kept so a reload, and a restart, come back to the same place.
 *
 * The window is the truth; two copies are kept of it:
 *
 *  - in the window's `sessionStorage`, which a RELOAD finds — this window's own place, whatever other
 *    windows have done since;
 *  - by the engine, per device and window (`window:keep`), which a window OPENING with nothing of its
 *    own asks for: it stands where the device's most recently used window did (`window:last`).
 *
 * A device is this install or browser profile (an id kept in `localStorage`); a window, this tab or
 * window (an id kept in `sessionStorage`). Ids only — the engine finds a task from its id alone
 * (`AppService.homeOf`), so nothing here names a project for it. A storage that throws or is gone costs
 * the restore, never the window.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { View } from "./store";

const STORE = "jaira.window.address";
const DEVICE = "jaira.device";
const WINDOW = "jaira.window";

export interface WindowAddress {
  at: string | null;
  view: View;
  selected: string | null;
  conversation: string | null;
}

export interface WindowIo {
  invoke(channel: "window:keep", request: { device: string; window: string; state: JsonValue }): Promise<void>;
  invoke(channel: "window:last", request: { device: string }): Promise<JsonValue | null>;
}

/** Ids made where no storage keeps them (a phone has none): the same for the whole run. */
const held = new Map<string, string>();
const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function idIn(storage: Storage | undefined, key: string): string {
  try {
    const known = storage?.getItem(key);
    if (known !== null && known !== undefined && known !== "") return known;
    if (storage !== undefined) {
      const made = newId();
      storage.setItem(key, made);
      if (storage.getItem(key) === made) return made;
    }
  } catch {
    // Refused or gone: held for the run below.
  }
  let id = held.get(key);
  if (id === undefined) held.set(key, (id = newId()));
  return id;
}

let device: string | undefined;
let deviceFrom: Promise<unknown> | undefined;

/**
 * Name this device from the host's own record of it — a phone's keystore (`savedPairing`), which a
 * phone has where a browser has \`localStorage\` — before the window reads or writes anything of its own.
 */
export function deviceIdFrom(source: Promise<string>): void {
  deviceFrom = source.then(
    (id) => void (device = id),
    () => undefined,
  );
}

/**
 * This install's or browser profile's id — the host's, when it named one; else kept in `localStorage`,
 * or held for the run where nothing keeps it.
 */
export const deviceId = (): string => device ?? idIn(globalThis.localStorage, DEVICE);
/** This device's id, once the host has said what it is. */
export async function deviceIdReady(): Promise<string> {
  if (deviceFrom !== undefined) await deviceFrom;
  return deviceId();
}
/** This window's id: kept in `sessionStorage`, so a reload is the same window; held for the run where nothing keeps it. */
export const windowId = (): string => idIn(globalThis.sessionStorage, WINDOW);

function asAddress(saved: unknown): WindowAddress | null {
  if (saved === null || typeof saved !== "object") return null;
  const s = saved as Partial<WindowAddress>;
  if (typeof s.view !== "string") return null;
  const id = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  return { at: id(s.at), view: s.view, selected: id(s.selected), conversation: id(s.conversation) };
}

/** This window's own place, as its last reload left it. */
export function readAddress(): WindowAddress | null {
  try {
    return asAddress(JSON.parse(globalThis.sessionStorage?.getItem(STORE) ?? "null"));
  } catch {
    return null;
  }
}

/** Where the device's most recently used window stood — for a window with nothing of its own. */
export async function lastAddress(io: WindowIo): Promise<WindowAddress | null> {
  try {
    return asAddress(await io.invoke("window:last", { device: await deviceIdReady() }));
  } catch {
    return null;
  }
}

let keeping: ReturnType<typeof setTimeout> | undefined;

/** Keep where this window stands: in the window now, with the engine a moment after it stops moving. */
export function writeAddress(address: WindowAddress, io?: WindowIo): void {
  try {
    globalThis.sessionStorage?.setItem(STORE, JSON.stringify(address));
  } catch {
    // Full or refused: this window still stands where it does.
  }
  if (io === undefined) return;
  clearTimeout(keeping);
  keeping = setTimeout(() => void deviceIdReady().then((id) => io.invoke("window:keep", { device: id, window: windowId(), state: address as unknown as JsonValue })).catch(() => undefined), 500);
}
