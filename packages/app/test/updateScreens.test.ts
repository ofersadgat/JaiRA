/**
 * The update screens, on the modules they draw from (decision 0011 §4–§6): the words About's Status
 * row takes from a model, which control a plugin's row carries, and the reason a log row reads
 * without being unfolded.
 *
 * These were read off the rendered pages while the desktop drew them itself. What is here is what a
 * pure module decides; the sidebar's Update row, its menu, the board's counts and fixes, and which log
 * entries are marked as not seen are held in `updatesModel.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ConfigView, LogEntry, MachinesView, PluginStatus, UpdateState } from "@jaira/shared";
import { aboutMachineOf, buildTailOf, pluginControlOf, remoteAboutWords, sentence, updateTrackOf } from "../src/renderer/aboutModel";
import { reasonOf } from "../src/renderer/logsModel";
import { checkedAgo, pluginFamilies } from "../src/renderer/updatesModel";

describe("About's Status row", () => {
  it("says why a build cannot update, as a sentence", () => {
    // Main's reason is a clause; the row prints it capitalised and closed.
    expect(sentence("a development build does not update itself")).toBe("A development build does not update itself.");
  });

  it("is up to date, saying when it last checked", () => {
    const now = Date.now();
    // The row reads "Up to date · checked 12 min ago"; the half after the dot is the model's.
    expect(checkedAgo(now - 12 * 60_000, now)).toBe("checked 12 min ago");
  });
});

describe("About, with a paired machine in Settings' path", () => {
  const machines = {
    self: { id: "desk", label: "desk", version: "0.3.300" },
    machines: [{ id: "mini", label: "build-01", state: "online", version: "0.3.290-nightly.20261117.1", canReachHere: true }],
  } as unknown as MachinesView;
  const view = (machine: Record<string, unknown> | null, you: Record<string, unknown> | null = null): ConfigView =>
    ({ system: null, base: null, project: null, machine, projectMachine: null, you, projectYou: null, machineFile: "/m/machine-settings.json", effective: { updates: { ...((you?.["updates"] as object) ?? {}), ...((machine?.["updates"] as object) ?? {}) } } }) as unknown as ConfigView;

  it("is about the machine the path names, and only a paired one", () => {
    expect(aboutMachineOf({}, machines)).toEqual({ remote: false });
    expect(aboutMachineOf({ project: "/x/atlas", you: true }, machines)).toEqual({ remote: false });
    expect(aboutMachineOf({ machine: { id: "desk", self: true } }, machines)).toEqual({ remote: false });
    expect(aboutMachineOf({ project: "/x/atlas", machine: { id: "mini" } }, machines)).toEqual({ remote: true, id: "mini", label: "build-01", version: "0.3.290-nightly.20261117.1", online: true });
    // Before the machines are read, or for one unpaired since: still that machine's, with nothing said of it.
    expect(aboutMachineOf({ machine: { id: "gone" } }, machines)).toEqual({ remote: true, id: "gone", label: "a paired machine", online: false });
  });

  it("shows that machine's version and track, never this updater's", () => {
    const here = { status: "up-to-date", version: "0.3.300", channel: "stable", checkedAt: 0 } as unknown as UpdateState;
    const track = updateTrackOf(view({ updates: { channel: "stable" } }), here, { version: "0.3.290-nightly.20261117.1" });
    expect(track).toMatchObject({ version: "0.3.290-nightly.20261117.1", own: "nightly", channel: "stable", stated: true });
    // Its own build's track when nothing is set there, whatever this machine's updater follows.
    expect(updateTrackOf(view(null), here, { version: "0.3.290-nightly.20261117.1" }).channel).toBe("nightly");
    expect(updateTrackOf(view(null), here, {}).version).toBe("");
  });

  it("says why checking, downloading and restarting are not offered, and says an offline one is", () => {
    const online = aboutMachineOf({ machine: { id: "mini" } }, machines);
    if (!online.remote) throw new Error("expected a paired machine");
    expect(remoteAboutWords(online).updates).toBe("Checking for an update, downloading it and restarting into it happen on build-01 itself, in JaiRA there: this window sets only its track.");
    expect(remoteAboutWords(online).lead).not.toContain("offline");
    expect(remoteAboutWords({ ...online, online: false }).lead).toContain("build-01 is offline");
    // Plugins and the command each say their own.
    expect(remoteAboutWords(online).plugins).toMatch(/^Plugins are downloaded on build-01 itself/);
    expect(remoteAboutWords(online).command).toMatch(/^The jaira command is installed on build-01 itself/);
  });

  it("says what hosts that machine's engine, once it has said: a server with no window is not a window's", () => {
    const online = aboutMachineOf({ machine: { id: "mini" } }, machines);
    if (!online.remote) throw new Error("expected a paired machine");
    expect(remoteAboutWords(online).runsIn).toBeUndefined();
    const served = remoteAboutWords({ ...online, host: "server" });
    expect(served.runsIn).toEqual({ name: "jaira serve", description: "build-01's engine is a server of its own, with no JaiRA window running it: the two switches below are for when a window starts there." });
    expect(remoteAboutWords({ ...online, host: "desktop", online: false }).runsIn?.description).toBe("build-01's engine runs in JaiRA's window there, when it last said.");
    expect(served.separate(false)).toBe("When JaiRA's window starts on build-01, the engine runs in the window's own process.");
    expect(served.keep(true)).toBe("A server JaiRA's window on build-01 starts keeps running after the window quits.");
  });
});

describe("About's Plugins", () => {
  it("shows a development checkout's own copy as present, with no Download, Update or Remove", () => {
    const plugins: PluginStatus[] = [
      { id: "claude-agent-sdk", version: "1.0.0", available: true, installed: "0.9.0", from: "workspace", downloadBytes: 1024 },
      { id: "llama", version: "3.0.0", available: true, installed: "3.1.0", from: "workspace" },
      { id: "llama-cpu", version: "3.0.0", available: true, installed: "3.1.0", from: "workspace" },
    ];
    const [sdk, llama] = pluginFamilies(plugins);
    // "✓ from this checkout", with the version the checkout has — not Download (the SDK's row), not
    // "pick a build below" (a family with builds), and not Update, though neither version is the one
    // this build names. Remove hangs off the installed and the outdated controls, so it is not here.
    expect(pluginControlOf(sdk!.base, false)).toBe("checkout");
    expect(pluginControlOf(llama!.base, true)).toBe("checkout");
    expect(llama!.builds.map((build) => [build.id, buildTailOf(build)])).toEqual([["llama-cpu", "checkout"]]);
    expect([sdk!.base.status.installed, llama!.base.status.installed, llama!.builds[0]!.status.installed]).toEqual(["0.9.0", "3.1.0", "3.1.0"]);
    // No "0.9.0 is installed; this build uses 1.0.0" under the row: the store does not own this copy.
    expect([sdk!.base.outdated, llama!.base.outdated, llama!.builds[0]!.outdated]).toEqual([false, false, false]);
  });
});

describe("the Logs panel's rows", () => {
  const entries: LogEntry[] = [
    { id: 3, at: 300, level: "warn", source: "app", message: "could not install the Local models: CUDA plugin", detail: { message: "EPERM: operation not permitted" }, raised: "plugin:llama-cuda" },
    { id: 2, at: 200, level: "warn", source: "runtime", message: "could not look at github for events" },
    { id: 1, at: 50, level: "error", source: "ipc", message: "an old failure" },
  ];

  it("reads a detail's reason on the row, without unfolding it", () => {
    // The EPERM lives only in the detail; an entry with no detail has nothing to add to its message.
    expect(entries.map(reasonOf)).toEqual(["EPERM: operation not permitted", undefined, undefined]);
  });
});
