import type { Pairing } from "./engineBridge";

/**
 * A device's remembered pairing (decision 0013, amended 2026-09-30), and the two things both of its
 * stores do alike: read one back, and mint the device's id. The stores are `savedPairing.ts` (a
 * browser's `localStorage`) and `savedPairing.native.ts` (a phone's keystore).
 *
 * `address` is what the person typed (or the link carried), shown again on the Connect screen; `url`
 * and `token` are what the engine's `hello` needs. `tailnet`: paired over the local network, and
 * reached through Tailscale built into the app (amended 2026-10-04) rather than the phone's own network.
 */
export interface SavedPairing extends Pairing {
  address: string;
  tailnet?: true;
}

/** A stored pairing, when it is one: a file someone edited, or an older shape, is no pairing. */
export function parsePairing(text: string | null): SavedPairing | undefined {
  if (text === null) return undefined;
  try {
    const p = JSON.parse(text) as Partial<SavedPairing>;
    if (typeof p.url !== "string" || typeof p.token !== "string" || typeof p.address !== "string" || typeof p.machine?.id !== "string" || typeof p.machine.label !== "string") return undefined;
    return { address: p.address, url: p.url, token: p.token, machine: { id: p.machine.id, label: p.machine.label }, ...(p.tailnet === true ? { tailnet: true as const } : {}) };
  } catch {
    return undefined;
  }
}

/** An id only this device has. Not a secret — the token is — so it need not come from a strong source. */
export function newDeviceId(): string {
  let id = "";
  while (id.length < 24) id += Math.floor(Math.random() * 0x1_0000_0000).toString(36);
  return `d-${id.slice(0, 24)}`;
}

/**
 * A phone paired with several machines (decision 0015, amended 2026-10-04) keeps each pairing under a
 * key of its own — a keystore entry is small — and an index of them in pairing order.
 */
export const PAIRINGS_INDEX = "jaira.pairings";
export function pairingKey(machineId: string): string {
  return `jaira.pairing.${machineId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
export function parseIndex(text: string | null): string[] {
  if (text === null) return [];
  try {
    const ids = JSON.parse(text) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
