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
import type { LogEntry, PluginStatus } from "@jaira/shared";
import { buildTailOf, pluginControlOf, sentence } from "../src/renderer/aboutModel";
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
