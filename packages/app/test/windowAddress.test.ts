/**
 * Where the window stands survives a reload — `windowAddress.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceId, deviceIdFrom, deviceIdReady, lastAddress, readAddress, windowId, writeAddress, type WindowIo } from "../src/renderer/windowAddress";

let stored: Map<string, string>;
let local: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  local = new Map();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
  };
});

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the window's address", () => {
  it("comes back as it was written", () => {
    writeAddress({ at: "C:\\UbuntuCode\\JaiRA", view: "chat", selected: "t-ts9ckeqo1c", conversation: "t-ts9ckeqo1c" });
    expect(readAddress()).toEqual({ at: "C:\\UbuntuCode\\JaiRA", view: "chat", selected: "t-ts9ckeqo1c", conversation: "t-ts9ckeqo1c" });
  });

  it("is nothing in a window that never wrote one", () => {
    expect(readAddress()).toBeNull();
  });

  it("is nothing rather than a throw when the storage is unreadable or gone", () => {
    stored.set("jaira.window.address", "{not json");
    expect(readAddress()).toBeNull();
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(readAddress()).toBeNull();
    expect(() => writeAddress({ at: null, view: "tasks", selected: null, conversation: null })).not.toThrow();
  });

  it("drops what is not an id", () => {
    stored.set("jaira.window.address", JSON.stringify({ at: "", view: "tasks", selected: 7, conversation: null }));
    expect(readAddress()).toEqual({ at: null, view: "tasks", selected: null, conversation: null });
  });
});

describe("the engine's copy", () => {
  it("is written per device and window a moment after the window stops moving, and read for a window with nothing of its own", async () => {
    const kept: Array<{ device: string; window: string; state: unknown }> = [];
    const io: WindowIo = {
      invoke: (async (channel: string, request: { device: string; window?: string; state?: unknown }) => {
        if (channel === "window:keep") kept.push(request as { device: string; window: string; state: unknown });
        return channel === "window:last" ? (kept.filter((k) => k.device === request.device).at(-1)?.state ?? null) : undefined;
      }) as WindowIo["invoke"],
    };
    writeAddress({ at: "/w/a", view: "tasks", selected: null, conversation: null }, io);
    writeAddress({ at: "/w/a", view: "chat", selected: "t-a", conversation: "t-a" }, io);
    await new Promise((r) => setTimeout(r, 600));
    expect(kept).toEqual([{ device: deviceId(), window: windowId(), state: { at: "/w/a", view: "chat", selected: "t-a", conversation: "t-a" } }]);
    // A new window on this device: nothing of its own, the device's last.
    stored.clear();
    expect(readAddress()).toBeNull();
    expect(await lastAddress(io)).toEqual({ at: "/w/a", view: "chat", selected: "t-a", conversation: "t-a" });
  });

  it("keeps one device id across windows, and one window id per window", () => {
    const device = deviceId();
    const window = windowId();
    stored.clear();
    expect(deviceId()).toBe(device);
    expect(windowId()).not.toBe(window);
  });
});

describe("the device", () => {
  it("is held for the run where no storage keeps it — a phone has none", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(deviceId()).toBe(deviceId());
    expect(windowId()).toBe(windowId());
  });

  it("is the one its host names, once the host has said", async () => {
    deviceIdFrom(Promise.resolve("phone-from-its-keystore"));
    expect(await deviceIdReady()).toBe("phone-from-its-keystore");
    expect(deviceId()).toBe("phone-from-its-keystore");
  });
});
