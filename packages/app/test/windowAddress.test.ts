/**
 * Where the window stands survives a reload — `windowAddress.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAddress, writeAddress } from "../src/renderer/windowAddress";

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
});

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
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
