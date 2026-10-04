import { getRandomBytes } from "expo-crypto";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import { announcementOf } from "@jaira/shared/browser";
import type { NearbyMachine, NearbyState, Tailnet, TailnetState } from "./nearby";

export type { NearbyMachine, NearbyState, Tailnet, TailnetState } from "./nearby";

/**
 * The phone's half of `nearby.ts`: the `JairaNet` native module (`packages/client/modules/jaira-net`) —
 * Bonjour on iOS, NSD on Android, and Tailscale built in with gomobile. A build without the module (an
 * old dev client) can neither look nor join, and says so by `NEARBY_SUPPORTED` and `tailnet`.
 */
interface JairaNetModule {
  tailnetAvailable(): boolean;
  startBrowsing(): void;
  stopBrowsing(): void;
  localAddresses(): string[];
  tailnetStart(hostname: string): Promise<void>;
  tailnetProxy(target: string): Promise<number>;
  tailnetState(): string;
  tailnetLogout(): Promise<void>;
  addListener(event: "onNearby", listener: (event: { machines: Array<{ name: string; txt?: Record<string, string>; host?: string; port?: number }>; state?: NearbyState["state"]; problem?: string }) => void): EventSubscription;
  addListener(event: "onTailnetState", listener: (event: { state: string }) => void): EventSubscription;
}

const native = requireOptionalNativeModule<JairaNetModule>("JairaNet");

export const NEARBY_SUPPORTED = native !== null;

export function browseNearby(listener: (state: NearbyState) => void): () => void {
  if (native === null) return () => undefined;
  const subscription = native.addListener("onNearby", (event) => {
    const machines: NearbyMachine[] = [];
    for (const found of event.machines ?? []) {
      const announced = announcementOf(found.txt, { ...(found.host !== undefined ? { host: found.host } : {}), ...(found.port !== undefined ? { port: found.port } : {}) });
      if (announced !== undefined) machines.push({ ...announced, key: found.name });
    }
    listener({ machines, state: event.state ?? "browsing", ...(event.problem !== undefined ? { problem: event.problem } : {}) });
  });
  native.startBrowsing();
  return () => {
    subscription.remove();
    native.stopBrowsing();
  };
}

export function localAddresses(): string[] {
  try {
    return native?.localAddresses() ?? [];
  } catch {
    return [];
  }
}

function parseState(text: string): TailnetState {
  try {
    const state = JSON.parse(text) as TailnetState;
    return typeof state.state === "string" ? state : { state: "error", message: "the tailnet said something unreadable" };
  } catch {
    return { state: "error", message: "the tailnet said something unreadable" };
  }
}

export const tailnet: Tailnet | undefined =
  native !== null && native.tailnetAvailable()
    ? {
        start: (hostname) => native.tailnetStart(hostname),
        state: () => parseState(native.tailnetState()),
        onState(listener) {
          const subscription = native.addListener("onTailnetState", (event) => listener(parseState(event.state)));
          return () => subscription.remove();
        },
        proxy: (target) => native.tailnetProxy(target),
        logout: () => native.tailnetLogout(),
      }
    : undefined;

export function randomBytes(count: number): Uint8Array {
  return getRandomBytes(count);
}
