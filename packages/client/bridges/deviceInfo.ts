import type { DeviceKind } from "@jaira/shared/browser";

/**
 * What this device says it is when it pairs (decision 0013, amended 2026-09-30): the row it gets on the
 * machine's Settings → Machines. In a browser, the browser and the system it runs on, read from the
 * user agent — a name for a person to recognise, not a fact anything depends on.
 * `deviceInfo.native.ts` is a phone's.
 */
export const DEVICE_KIND: DeviceKind = "browser";

export function deviceLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : undefined;
  return system === undefined ? browser : `${browser} on ${system}`;
}
