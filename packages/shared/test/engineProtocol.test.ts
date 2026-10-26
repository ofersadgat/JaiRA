/**
 * The engine's protocol (`engineFrames.ts`'s `ENGINE_PROTOCOL`): sides that speak the same one talk,
 * whatever versions or builds they run, so a change that breaks an older side must raise it. Removing or
 * renaming a channel is the break this can see: `engineProtocol.json` holds the channels of the current
 * protocol, and every one of them must still be answered. A new channel is no break, but it is written
 * down there too, so that taking it away later is seen. Raising the protocol records the channels again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_PROTOCOL, protocolMismatch } from "../src/engineFrames";
import { IPC_CHANNELS } from "../src/ipc";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "engineProtocol.json"), "utf8")) as { protocol: number; channels: string[] };

describe("the engine's protocol", () => {
  it("is recorded as it is now", () => {
    expect(recorded.protocol, "ENGINE_PROTOCOL was raised: write its channels to engineProtocol.json again").toBe(ENGINE_PROTOCOL);
  });

  it("still answers every channel of its protocol: one removed or renamed is a break, so raise ENGINE_PROTOCOL", () => {
    const now = new Set<string>(IPC_CHANNELS);
    expect(recorded.channels.filter((c) => !now.has(c))).toEqual([]);
  });

  it("has every new channel written down, so that taking it away later is seen (adding one is no break)", () => {
    const known = new Set(recorded.channels);
    expect([...IPC_CHANNELS].filter((c) => !known.has(c))).toEqual([]);
  });

  it("says which side to update: the one on the older protocol", () => {
    expect(protocolMismatch("desk", ENGINE_PROTOCOL - 1, "this app")).toBe("desk runs an older JaiRA, whose protocol this app no longer speaks: update JaiRA on desk");
    expect(protocolMismatch("desk", undefined, "this app")).toMatch(/older JaiRA.*update JaiRA on desk$/);
    expect(protocolMismatch("desk", ENGINE_PROTOCOL + 1, "this app")).toBe("desk runs a newer JaiRA, whose protocol this app does not speak yet: update this app");
  });
});
