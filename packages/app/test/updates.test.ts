/**
 * The app's own updates (decision 0011 §4–§5), against a scripted stand-in for electron-updater.
 *
 * Nothing downloads or installs without being asked, the channel is the setting or else the build's
 * own, a switch may go back one version once, a version from the other channel is ignored, and a
 * build that cannot install by itself offers the release page instead.
 */
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@jaira/shared";
import { UpdateManager, type UpdateInfoLike, type UpdateManagerOptions, type UpdaterPort } from "../src/main/updates";

class FakeUpdater implements UpdaterPort {
  channel: string | null = null;
  allowPrerelease = false;
  allowDowngrade = false;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  /** What the next check answers, by the feed channel it was asked for. */
  feed: Record<string, UpdateInfoLike | undefined> = {};
  checks: Array<{ channel: string | null; allowPrerelease: boolean; allowDowngrade: boolean }> = [];
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  failNext: Error | undefined;
  private progress: ((p: { percent: number }) => void) | undefined;

  async checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike; isUpdateAvailable?: boolean } | null> {
    this.checks.push({ channel: this.channel, allowPrerelease: this.allowPrerelease, allowDowngrade: this.allowDowngrade });
    if (this.failNext !== undefined) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    const info = this.feed[this.channel ?? "latest"];
    return info === undefined ? null : { updateInfo: info, isUpdateAvailable: true };
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    this.progress?.({ percent: 42.4 });
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }

  on(_event: "download-progress", listener: (p: { percent: number }) => void): unknown {
    this.progress = listener;
    return this;
  }
}

type Extra = Partial<Pick<UpdateManagerOptions, "manual" | "busy" | "quit" | "suspendForUpdate" | "pollMs" | "dismissed" | "saveDismissed">>;

/** A manager with 0.2.0 found and downloaded. */
async function downloaded(extra: Extra = {}): Promise<{ updates: UpdateManager; port: FakeUpdater }> {
  const port = new FakeUpdater();
  port.feed = { latest: { version: "0.2.0" } };
  const { updates } = manager("0.1.0", port, extra);
  await updates.check();
  await updates.download();
  return { updates, port };
}

function manager(version: string, port?: FakeUpdater, extra: Extra = {}): { updates: UpdateManager; seen: UpdateState[] } {
  const seen: UpdateState[] = [];
  const updates = new UpdateManager({
    version,
    ...(port !== undefined ? { port } : { disabledReason: "a development build does not update itself" }),
    ...extra,
    releaseUrl: (v) => `https://github.com/ofersadgat/releases/releases/tag/v${v}`,
    publish: (s) => seen.push(s),
    now: () => 1000,
  });
  return { updates, seen };
}

describe("updates", () => {
  it("never downloads or installs on its own", () => {
    const port = new FakeUpdater();
    manager("0.1.0", port);
    expect(port.autoDownload).toBe(false);
    expect(port.autoInstallOnAppQuit).toBe(false);
  });

  it("is disabled, with the reason, when the build cannot update", async () => {
    const { updates } = manager("0.1.0");
    expect(updates.current()).toMatchObject({ status: "disabled", reason: "a development build does not update itself" });
    expect(await updates.check()).toMatchObject({ status: "disabled" });
  });

  it("follows the build's own channel until the setting says otherwise", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0", releaseNotes: "notes" } };
    const { updates } = manager("0.1.0", port);
    const state = await updates.check();
    expect(port.checks[0]).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false });
    expect(state).toMatchObject({
      status: "available",
      channel: "stable",
      available: { version: "0.2.0", notes: "notes", url: "https://github.com/ofersadgat/releases/releases/tag/v0.2.0" },
    });
  });

  it("reads the nightly feed with prereleases allowed on a nightly build", async () => {
    const port = new FakeUpdater();
    port.feed = { nightly: { version: "0.1.2-nightly.20260927.3" } };
    const { updates } = manager("0.1.2-nightly.20260927.1", port);
    const state = await updates.check();
    expect(port.checks[0]).toEqual({ channel: "nightly", allowPrerelease: true, allowDowngrade: false });
    expect(state).toMatchObject({ status: "available", channel: "nightly" });
  });

  it("allows one downgrade after a switch, and not on the checks after it", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.1.1" } };
    const { updates } = manager("0.1.2-nightly.20260927.1", port);
    updates.configure({ channel: "stable" });
    expect(updates.current().channel).toBe("stable");
    expect(await updates.check()).toMatchObject({ status: "available", available: { version: "0.1.1" } });
    expect(port.checks[0]).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: true });
    port.feed = {};
    await updates.check();
    expect(port.checks[1]?.allowDowngrade).toBe(false);
  });

  it("ignores a version the feed offers from the other channel", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0-nightly.20260927.1" } };
    const { updates } = manager("0.1.0", port);
    expect(await updates.check()).toMatchObject({ status: "up-to-date", checkedAt: 1000 });
  });

  it("is up to date when the feed has nothing newer", async () => {
    const port = new FakeUpdater();
    const { updates } = manager("0.1.0", port);
    expect(await updates.check()).toMatchObject({ status: "up-to-date" });
  });

  it("downloads only when asked, reports progress, and restarts to install only once downloaded", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0" } };
    let quits = 0;
    const { updates, seen } = manager("0.1.0", port, { quit: () => (quits += 1) });
    expect(updates.restart("now")).toEqual({ installing: false });
    updates.installOnQuit();
    expect(port.installs).toEqual([]);
    await updates.check();
    expect(port.downloads).toBe(0);
    expect(await updates.download()).toMatchObject({ status: "downloaded" });
    expect(seen.some((s) => s.status === "downloading" && s.percent === 42)).toBe(true);
    expect(updates.restart("now")).toEqual({ installing: true });
    expect(quits).toBe(1);
    updates.installOnQuit();
    expect(port.installs).toEqual([[true, true]]); // silent, and started again
  });

  it("installs a downloaded update at ANY quit, without starting again", async () => {
    const { updates, port } = await downloaded();
    updates.installOnQuit();
    expect(port.installs).toEqual([[true, false]]);
  });

  it("asks before restarting while runs or chat turns are going, and quits nothing", async () => {
    let quits = 0;
    const { updates } = await downloaded({ busy: () => ({ runs: 2, turns: 1 }), quit: () => (quits += 1) });
    expect(updates.restart("now")).toEqual({ installing: false, busy: { runs: 2, turns: 1 } });
    expect(quits).toBe(0);
  });

  it("Not now leaves it to install when JaiRA closes", async () => {
    const { updates, port } = await downloaded({ busy: () => ({ runs: 1, turns: 0 }) });
    expect(updates.restart("later")).toEqual({ installing: false, pending: "on-quit" });
    expect(updates.current().pending).toBe("on-quit");
    updates.installOnQuit();
    expect(port.installs).toEqual([[true, false]]);
  });

  it("Pause + update suspends the runs, then restarts to install", async () => {
    const calls: string[] = [];
    const { updates, port } = await downloaded({
      busy: () => ({ runs: 1, turns: 0 }),
      suspendForUpdate: () => calls.push("suspend"),
      quit: () => calls.push("quit"),
    });
    expect(updates.restart("pause")).toEqual({ installing: true });
    expect(calls).toEqual(["suspend", "quit"]);
    updates.installOnQuit();
    expect(port.installs).toEqual([[true, true]]);
  });

  it("Wait + update restarts by itself once nothing is going, and can be canceled", async () => {
    vi.useFakeTimers();
    try {
      let busy = { runs: 2, turns: 0 };
      let quits = 0;
      const { updates } = await downloaded({ busy: () => busy, quit: () => (quits += 1), pollMs: 100 });
      expect(updates.restart("wait")).toEqual({ installing: false, pending: "waiting" });
      expect(updates.current()).toMatchObject({ pending: "waiting", busy: { runs: 2, turns: 0 } });
      busy = { runs: 1, turns: 0 };
      vi.advanceTimersByTime(100);
      expect(updates.current().busy).toEqual({ runs: 1, turns: 0 });
      busy = { runs: 0, turns: 0 };
      vi.advanceTimersByTime(100);
      expect(quits).toBe(1);

      busy = { runs: 3, turns: 0 };
      updates.restart("wait");
      expect(updates.restart("cancel")).toEqual({ installing: false, pending: "on-quit" });
      busy = { runs: 0, turns: 0 };
      vi.advanceTimersByTime(500);
      expect(quits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Wait + update with nothing going restarts at once", async () => {
    let quits = 0;
    const { updates } = await downloaded({ busy: () => ({ runs: 0, turns: 0 }), quit: () => (quits += 1) });
    expect(updates.restart("wait")).toEqual({ installing: true });
    expect(quits).toBe(1);
  });

  it("the Update button downloads first, then waits and restarts", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0" } };
    let quits = 0;
    const { updates } = manager("0.1.0", port, { busy: () => ({ runs: 0, turns: 0 }), quit: () => (quits += 1) });
    await updates.check();
    expect(await updates.apply("wait")).toEqual({ installing: true });
    expect(port.downloads).toBe(1);
    expect(quits).toBe(1);
  });

  it("Not now from the button downloads, and leaves the install to the next quit", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0" } };
    const { updates } = manager("0.1.0", port, { busy: () => ({ runs: 1, turns: 0 }) });
    await updates.check();
    expect(await updates.apply("later")).toEqual({ installing: false, pending: "on-quit" });
    updates.installOnQuit();
    expect(port.installs).toEqual([[true, false]]);
  });

  it("remembers the version whose notice was dismissed", async () => {
    const saved: string[] = [];
    const { updates } = manager("0.1.0", new FakeUpdater(), { dismissed: "0.1.9", saveDismissed: (v) => saved.push(v) });
    expect(updates.current().dismissed).toBe("0.1.9");
    expect(updates.dismiss("0.2.0").dismissed).toBe("0.2.0");
    expect(saved).toEqual(["0.2.0"]);
  });

  it("does not check again once an update is downloaded", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0" } };
    const { updates } = manager("0.1.0", port);
    await updates.check();
    await updates.download();
    await updates.check();
    expect(port.checks).toHaveLength(1);
  });

  it("offers the release page instead of a download where the platform cannot install", async () => {
    const port = new FakeUpdater();
    port.feed = { latest: { version: "0.2.0" } };
    const { updates } = manager("0.1.0", port, { manual: true });
    expect(await updates.check()).toMatchObject({ status: "available", manual: true });
    expect(await updates.download()).toMatchObject({ status: "available" });
    expect(port.downloads).toBe(0);
  });

  it("says what failed and checks again later", async () => {
    const port = new FakeUpdater();
    port.failNext = new Error("net::ERR_INTERNET_DISCONNECTED");
    const { updates } = manager("0.1.0", port);
    expect(await updates.check()).toMatchObject({ status: "error", error: "net::ERR_INTERNET_DISCONNECTED" });
    port.feed = { latest: { version: "0.2.0" } };
    const next = await updates.check();
    expect(next.status).toBe("available");
    expect(next.error).toBeUndefined();
  });

  it("shares one check between callers that ask at once", async () => {
    const port = new FakeUpdater();
    const { updates } = manager("0.1.0", port);
    await Promise.all([updates.check(), updates.check()]);
    expect(port.checks).toHaveLength(1);
  });
});
