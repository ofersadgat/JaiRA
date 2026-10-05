import { PAIRINGS_INDEX, newDeviceId, pairingKey, parseIndex, parsePairing, type SavedPairing } from "./pairingShape";

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

/**
 * Every machine this device is paired with, in pairing order (decision 0015, amended 2026-10-04): a
 * phone reaches all of them. The single pairing an older version kept is the first of them.
 */
export async function loadPairings(): Promise<SavedPairing[]> {
  const ids = parseIndex(read(PAIRINGS_INDEX));
  const out: SavedPairing[] = [];
  for (const id of ids) {
    const kept = parsePairing(read(pairingKey(id)));
    if (kept !== undefined) out.push(kept);
  }
  const legacy = parsePairing(read(PAIRING));
  if (legacy !== undefined && !out.some((p) => p.machine.id === legacy.machine.id)) out.unshift(legacy);
  return out;
}

/** Keep a pairing among the others: a machine paired again replaces its own, in its place. */
export async function addPairing(pairing: SavedPairing): Promise<void> {
  const ids = parseIndex(read(PAIRINGS_INDEX));
  write(pairingKey(pairing.machine.id), JSON.stringify(pairing));
  if (!ids.includes(pairing.machine.id)) write(PAIRINGS_INDEX, JSON.stringify([...ids, pairing.machine.id]));
}

/** Forget one machine: its token goes, and the others stay. */
export async function forgetMachine(machineId: string): Promise<void> {
  const ids = parseIndex(read(PAIRINGS_INDEX)).filter((id) => id !== machineId);
  write(PAIRINGS_INDEX, JSON.stringify(ids));
  write(pairingKey(machineId), null);
  const legacy = parsePairing(read(PAIRING));
  if (legacy?.machine.id === machineId) write(PAIRING, null);
}
