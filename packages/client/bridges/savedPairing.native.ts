import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { newDeviceId, parsePairing, type SavedPairing } from "./pairingShape";

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
