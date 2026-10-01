import { newDeviceId, parsePairing, type SavedPairing } from "./pairingShape";

export type { SavedPairing } from "./pairingShape";

/**
 * The machine this device is paired with, kept across launches (decision 0013, amended 2026-09-30): in
 * a browser, `localStorage` — this origin's own, which is the machine's address when the page was
 * served by its engine. `savedPairing.native.ts` is the same over the phone's keystore.
 */
const PAIRING = "jaira.pairing";
const DEVICE = "jaira.device";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A browser that refuses storage pairs again next time; nothing else depends on it.
  }
};

export async function loadPairing(): Promise<SavedPairing | undefined> {
  return parsePairing(read(PAIRING));
}

export async function savePairing(pairing: SavedPairing): Promise<void> {
  write(PAIRING, JSON.stringify(pairing));
}

/** Forget the machine: the token goes; the device's id stays, so pairing again replaces its row there. */
export async function forgetPairing(): Promise<void> {
  write(PAIRING, null);
}

/** This device's id, made the first time it is asked for and kept. */
export async function deviceId(): Promise<string> {
  const kept = read(DEVICE);
  if (kept !== null && kept !== "") return kept;
  const made = newDeviceId();
  write(DEVICE, made);
  return made;
}
