import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { PAIRINGS_INDEX, newDeviceId, pairingKey, parseIndex, parsePairing, type SavedPairing } from "./pairingShape";

export type { SavedPairing } from "./pairingShape";

/**
 * The machine this phone is paired with, kept across launches in the platform's keystore
 * (`expo-secure-store`: the Android Keystore, the iOS Keychain) — see `savedPairing.ts`. The token
 * opens the machine's engine, so it is not left in plain storage.
 */
const PAIRING = "jaira.pairing";
const DEVICE = "jaira.device";

export async function loadPairing(): Promise<SavedPairing | undefined> {
  return parsePairing(await getItemAsync(PAIRING).catch(() => null));
}

export async function savePairing(pairing: SavedPairing): Promise<void> {
  // A keystore that refuses pairs again next launch; the connection made now does not depend on it.
  await setItemAsync(PAIRING, JSON.stringify(pairing)).catch(() => undefined);
}

export async function forgetPairing(): Promise<void> {
  await deleteItemAsync(PAIRING).catch(() => undefined);
}

export async function deviceId(): Promise<string> {
  const kept = await getItemAsync(DEVICE).catch(() => null);
  if (kept !== null && kept !== "") return kept;
  const made = newDeviceId();
  await setItemAsync(DEVICE, made).catch(() => undefined);
  return made;
}

/**
 * Every machine this device is paired with, in pairing order (decision 0015, amended 2026-10-04): a
 * phone reaches all of them. The single pairing an older version kept is the first of them.
 */
export async function loadPairings(): Promise<SavedPairing[]> {
  const ids = parseIndex(await getItemAsync(PAIRINGS_INDEX).catch(() => null));
  const out: SavedPairing[] = [];
  for (const id of ids) {
    const kept = parsePairing(await getItemAsync(pairingKey(id)).catch(() => null));
    if (kept !== undefined) out.push(kept);
  }
  const legacy = parsePairing(await getItemAsync(PAIRING).catch(() => null));
  if (legacy !== undefined && !out.some((p) => p.machine.id === legacy.machine.id)) out.unshift(legacy);
  return out;
}

/** Keep a pairing among the others: a machine paired again replaces its own, in its place. */
export async function addPairing(pairing: SavedPairing): Promise<void> {
  const ids = parseIndex(await getItemAsync(PAIRINGS_INDEX).catch(() => null));
  await setItemAsync(pairingKey(pairing.machine.id), JSON.stringify(pairing)).catch(() => undefined);
  if (!ids.includes(pairing.machine.id)) await setItemAsync(PAIRINGS_INDEX, JSON.stringify([...ids, pairing.machine.id])).catch(() => undefined);
}

/** Forget one machine: its token goes, and the others stay. */
export async function forgetMachine(machineId: string): Promise<void> {
  const ids = parseIndex(await getItemAsync(PAIRINGS_INDEX).catch(() => null)).filter((id) => id !== machineId);
  await setItemAsync(PAIRINGS_INDEX, JSON.stringify(ids)).catch(() => undefined);
  await deleteItemAsync(pairingKey(machineId)).catch(() => undefined);
  const legacy = parsePairing(await getItemAsync(PAIRING).catch(() => null));
  if (legacy?.machine.id === machineId) await deleteItemAsync(PAIRING).catch(() => undefined);
}
