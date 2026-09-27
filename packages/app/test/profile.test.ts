/**
 * The Chromium profile pool (`src/main/profile.ts`): one profile per running process, 0 being
 * `userData` itself, and a dead holder's claim given to whoever asks next.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimProfile } from "../src/main/profile";

let userData: string;
const running = new Set<number>();
const alive = (pid: number): boolean => running.has(pid);

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "jaira-profile-"));
  running.clear();
});
afterEach(() => rmSync(userData, { recursive: true, force: true }));

function start(pid: number) {
  running.add(pid);
  return claimProfile(userData, pid, alive);
}

describe("claimProfile", () => {
  it("gives the first process Chromium's default profile, userData itself", () => {
    const first = start(100);
    expect(first.index).toBe(0);
    expect(first.dir).toBeUndefined();
  });

  it("gives each further running process a folder of its own, created", () => {
    const first = start(100);
    const second = start(200);
    const third = start(300);
    expect([first.index, second.index, third.index]).toEqual([0, 1, 2]);
    expect(second.dir).toBe(join(userData, "profiles", "1"));
    expect(existsSync(second.dir!)).toBe(true);
  });

  it("reuses a released profile rather than growing the pool", () => {
    start(100);
    const second = start(200);
    second.release();
    expect(start(300).index).toBe(1);
  });

  it("gives back 0 when its holder quits, so the next launch keeps the old caches and drafts", () => {
    const first = start(100);
    start(200);
    first.release();
    expect(start(300).index).toBe(0);
  });

  it("reclaims a profile whose holder died without releasing it, and removes the dead claim", () => {
    start(100);
    running.delete(100);
    expect(start(200).index).toBe(0);
    expect(readdirSync(join(userData, "profiles"))).toEqual(["0.200.lock"]);
  });

  it("yields an index a rival claimed after its first look said the index was free", () => {
    // A dead holder's file makes the first look ask `alive` — and while it asks, the rival (pid 100,
    // alive) writes its claim. The first look's listing is already taken, so only the second sees it.
    const profiles = join(userData, "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "0.999.lock"), "");
    running.add(100).add(200);
    const racing = (pid: number): boolean => {
      if (pid === 999) writeFileSync(join(profiles, "0.100.lock"), "");
      return alive(pid);
    };
    const claimed = claimProfile(userData, 200, racing);
    expect(claimed.index).toBe(1);
    expect(readdirSync(profiles).sort()).toEqual(["0.100.lock", "1", "1.200.lock"]);
  });

  it("treats a leftover claim under its own pid as its own", () => {
    mkdirSync(join(userData, "profiles"), { recursive: true });
    writeFileSync(join(userData, "profiles", "0.100.lock"), "");
    expect(start(100).index).toBe(0);
  });
});
