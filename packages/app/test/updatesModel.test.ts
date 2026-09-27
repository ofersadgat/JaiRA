/**
 * The rules the person set for the update, plugin and health screens (decision 0011 §4–§6, rulings on
 * the three rounds of mockups, 2026-09-26): when the sidebar's Update row shows and what it says, which
 * choices its menu offers, how a nightly is named, how the plugins are grouped, and how Settings'
 * warnings and errors are counted and grouped.
 */
import { describe, expect, it } from "vitest";
import type { HealthItem, PluginStatus, UpdateState } from "@jaira/shared";
import {
  buildDownloadBytes,
  busyWords,
  healthCounts,
  healthFixLabel,
  healthGroups,
  healthTally,
  pluginFamilies,
  sidebarUpdateOf,
  sizeWords,
  updateMenu,
  versionLabel,
  waitedFor,
} from "../src/renderer/updatesModel";

const NIGHTLY = "0.1.1-nightly.20260927.3";
const base: UpdateState = { status: "up-to-date", version: "0.1.1-nightly.20260927.1", channel: "nightly", checkedAt: 1 };
const available = (extra: Partial<UpdateState> = {}): UpdateState => ({
  ...base,
  status: "available",
  available: { version: NIGHTLY, url: "https://example.invalid/v", notes: "notes" },
  ...extra,
});

describe("a version's short name", () => {
  it("is just 'nightly' for a nightly, and itself for a release", () => {
    expect(versionLabel(NIGHTLY)).toBe("nightly");
    expect(versionLabel("0.2.0")).toBe("0.2.0");
  });
});

describe("the sidebar's Update row", () => {
  it("is hidden while there is nothing to do", () => {
    expect(sidebarUpdateOf(null)).toBeNull();
    for (const status of ["disabled", "idle", "checking", "up-to-date"] as const) expect(sidebarUpdateOf({ ...base, status })).toBeNull();
  });

  it("offers an available update as one click, with the version short, an × and a chevron", () => {
    const row = sidebarUpdateOf(available());
    expect(row).toMatchObject({ kind: "available", label: "Update", version: "nightly", dismissible: true, menu: true });
  });

  it("is hidden for the version the × dismissed, and back for a newer one", () => {
    expect(sidebarUpdateOf(available({ dismissed: NIGHTLY }))).toBeNull();
    expect(sidebarUpdateOf(available({ dismissed: "0.1.1-nightly.20260926.9" }))).not.toBeNull();
  });

  it("is hidden after Not now — About says it installs when JaiRA next closes", () => {
    expect(sidebarUpdateOf(available({ status: "downloaded", pending: "on-quit" }))).toBeNull();
  });

  it("says the download's progress, with no ×", () => {
    expect(sidebarUpdateOf(available({ status: "downloading", percent: 42 }))).toMatchObject({ kind: "downloading", percent: 42, dismissible: false, menu: true });
  });

  it("says what it is waiting for", () => {
    const row = sidebarUpdateOf(available({ status: "downloaded", pending: "waiting", busy: { runs: 2, turns: 0 } }));
    expect(row).toMatchObject({ kind: "waiting", label: "Waiting for 2 runs…", menu: true, dismissible: false });
  });

  it("opens the release page on a Mac that cannot install by itself, with no menu", () => {
    expect(sidebarUpdateOf(available({ manual: true }))).toMatchObject({ kind: "manual", menu: false, dismissible: true });
  });

  it("shows a failure", () => {
    expect(sidebarUpdateOf({ ...base, status: "error", error: "net::ERR_INTERNET_DISCONNECTED" })).toMatchObject({ kind: "error", menu: false, dismissible: false });
  });

  it("says it is restarting once this window asked for it", () => {
    expect(sidebarUpdateOf(available(), true)).toMatchObject({ kind: "restarting" });
  });
});

describe("the Update menu", () => {
  const names = (menu: ReturnType<typeof updateMenu>): string[] => menu.items.map((i) => i.name);
  const ticked = (menu: ReturnType<typeof updateMenu>): string[] => menu.items.filter((i) => i.kind === "choice" && i.on === true).map((i) => i.name);

  it("with runs going: Wait + update (the click), Pause + update, Not now, and Release notes in the sidebar", () => {
    const menu = updateMenu(available(), { runs: 2, turns: 1 }, "sidebar");
    expect(menu.head).toBe("2 runs working · 1 chat turn");
    expect(names(menu)).toEqual(["Wait + update", "Pause + update", "Not now", "Release notes"]);
    expect(ticked(menu)).toEqual(["Wait + update"]);
  });

  it("with nothing going: Update now and Not now", () => {
    const menu = updateMenu(available(), { runs: 0, turns: 0 }, "about");
    expect(menu.head).toBe("Nothing is going");
    expect(names(menu)).toEqual(["Update now", "Not now"]);
    expect(ticked(menu)).toEqual(["Update now"]);
  });

  it("while waiting: Pause + update, Not now, Cancel — nothing ticked", () => {
    const menu = updateMenu(available({ status: "downloaded", pending: "waiting", busy: { runs: 2, turns: 0 } }), undefined, "sidebar");
    expect(names(menu)).toEqual(["Pause + update", "Not now", "Cancel"]);
    expect(ticked(menu)).toEqual([]);
    expect(menu.head).toContain("Restarts when 2 runs finish");
  });

  it("after Not now: no Not now again", () => {
    const menu = updateMenu(available({ status: "downloaded", pending: "on-quit" }), { runs: 1, turns: 0 }, "about");
    expect(names(menu)).toEqual(["Wait + update", "Pause + update"]);
    expect(menu.items[0]!.hint).toBe("restarts when 1 run finishes");
  });

  it("never offers to hide the update — that is the × alone", () => {
    for (const busy of [{ runs: 0, turns: 0 }, { runs: 3, turns: 0 }]) expect(names(updateMenu(available(), busy, "sidebar"))).not.toContain("Hide until a newer version");
  });

  it("ticks a choice made while the download was running", () => {
    const menu = updateMenu(available({ status: "downloading", percent: 10 }), { runs: 1, turns: 0 }, "sidebar", "pause");
    expect(ticked(menu)).toEqual(["Pause + update"]);
  });
});

describe("what is going, in words", () => {
  it("names runs and chat turns", () => {
    expect(busyWords({ runs: 1, turns: 0 })).toBe("1 run working");
    expect(busyWords({ runs: 0, turns: 2 })).toBe("2 chat turns");
    expect(waitedFor({ runs: 2, turns: 1 })).toBe("2 runs and 1 chat turn");
  });
});

describe("the plugins", () => {
  const status = (id: PluginStatus["id"], extra: Partial<PluginStatus> = {}): PluginStatus => ({ id, version: "1.0.0", available: true, downloadBytes: 10 * 1024 * 1024, ...extra });

  it("are one row per family, with the builds this machine can use under Local models — installed first, then the suggested one", () => {
    const families = pluginFamilies([
      status("claude-agent-sdk", { installed: "1.0.0" }),
      status("llama"),
      status("llama-cpu"),
      status("llama-vulkan", { installed: "1.0.0" }),
      status("llama-cuda", { recommended: true }),
      status("llama-cuda-ext"),
      status("llama-metal", { available: false }),
    ]);
    expect(families.map((f) => f.base.id)).toEqual(["claude-agent-sdk", "llama"]);
    expect(families[0]!.builds).toEqual([]);
    expect(families[0]!.base.current).toBe(true);
    expect(families[1]!.builds.map((b) => b.name)).toEqual(["Vulkan", "CUDA", "CPU", "CUDA (extended)"]);
  });

  it("leave out a family this machine cannot use", () => {
    expect(pluginFamilies([status("claude-agent-sdk", { available: false })])).toEqual([]);
  });

  it("say when what is installed is not this build's version", () => {
    const [sdk] = pluginFamilies([status("claude-agent-sdk", { installed: "0.9.0" })]);
    expect(sdk!.base).toMatchObject({ current: false, outdated: true });
  });

  it("count the base in a build's download until the base is installed", () => {
    const [llama] = pluginFamilies([status("llama", { downloadBytes: 37 }), status("llama-cpu", { downloadBytes: 9 })]);
    expect(buildDownloadBytes(llama!, llama!.builds[0]!)).toBe(46);
    const [installed] = pluginFamilies([status("llama", { installed: "1.0.0", downloadBytes: 0 }), status("llama-cpu", { downloadBytes: 9 })]);
    expect(buildDownloadBytes(installed!, installed!.builds[0]!)).toBe(9);
  });

  it("name a size", () => {
    expect(sizeWords(106 * 1024 * 1024)).toBe("106 MB");
    expect(sizeWords(9.4 * 1024 * 1024)).toBe("9.4 MB");
    expect(sizeWords(820 * 1024)).toBe("820 KB");
  });
});

describe("Settings' warnings and errors", () => {
  const item = (id: string, level: HealthItem["level"], page: HealthItem["page"]): HealthItem => ({ id, level, page, title: id, detail: "stopped", since: 1 });
  const items = [item("executor:claude-cli", "error", "connections"), item("forge:gitlab", "error", "connections"), item("log:errors", "error", "logs"), item("plugin:llama-cuda", "warning", "about"), item("update", "warning", "about")];

  it("count errors and warnings, of every page or of one", () => {
    expect(healthCounts(items)).toEqual({ error: 3, warning: 2 });
    expect(healthCounts(items, "connections")).toEqual({ error: 2 });
    expect(healthCounts(items, "about")).toEqual({ warning: 2 });
    expect(healthCounts([])).toEqual({});
    expect(healthTally(items)).toBe("3 errors · 2 warnings");
  });

  it("group by page in the card's order, leaving out empty ones", () => {
    expect(healthGroups(items).map((g) => [g.label, g.items.length])).toEqual([
      ["Connections", 2],
      ["Logs", 1],
      ["About", 2],
    ]);
    expect(healthGroups(items.slice(3)).map((g) => g.label)).toEqual(["About"]);
  });

  it("label each fix", () => {
    expect(healthFixLabel("sign-in")).toBe("Sign in again");
    expect(healthFixLabel("open-logs")).toBe("Open logs");
    expect(healthFixLabel("retry-plugin")).toBe("Try again");
  });
});
