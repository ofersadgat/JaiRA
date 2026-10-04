import type { LanAnnouncement } from "@jaira/shared/browser";

/**
 * JaiRA machines on this device's local network, and Tailscale built in (decision 0013, amended
 * 2026-10-04) — what a phone has (`nearby.native.ts`, the `JairaNet` native module) and a browser does
 * not: a page cannot browse the network, and has no tailnet of its own. A browser pairs by address, as
 * before.
 */

/** A machine announcing a pairing code nearby. */
export interface NearbyMachine extends LanAnnouncement {
  /** Its name in the announcement: unique on the network. */
  key: string;
}

export interface NearbyState {
  machines: NearbyMachine[];
  /** Why none can be found: `denied` when local-network access was refused, else the system's words. */
  problem?: string;
}

/** The node's state, as the native module says it (packages/tailnet/mobile). */
export interface TailnetState {
  state: "stopped" | "starting" | "needs-login" | "running" | "error" | "unavailable";
  url?: string;
  dnsName?: string;
  message?: string;
}

/** Tailscale built into the app. */
export interface Tailnet {
  /** Start the node (again: no harm), named `hostname` on the tailnet. */
  start(hostname: string): Promise<void>;
  state(): TailnetState;
  onState(listener: (state: TailnetState) => void): () => void;
  /** A loopback port forwarding to the engine at `target` (`https://desk.tail4c2e.ts.net`) through the node. */
  proxy(target: string): Promise<number>;
  logout(): Promise<void>;
}

/** Whether this device can look for machines nearby. */
export const NEARBY_SUPPORTED = false;

/** Look for machines nearby until the returned function is called. */
export function browseNearby(_listener: (state: NearbyState) => void): () => void {
  return () => undefined;
}

/** Tailscale built in, where this build has it. */
export const tailnet: Tailnet | undefined = undefined;

/** Random bytes from the platform's secure source. */
export function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  globalThis.crypto.getRandomValues(out);
  return out;
}
