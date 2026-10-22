/**
 * The System tools on macOS (decision 0019, ruling 3): what macOS's own programs print, read — on any
 * machine, from what they print — and, on a Mac, the tools that only read, run for real.
 */
import { describe, expect, it } from "vitest";
import { parseBrewList, parseDf, parseLaunchctlList, parsePs } from "../src/system/macos";
import { createSystemTools } from "../src/systemTools";

describe("what macOS's programs print, read", () => {
  it("reads `ps`: a five-word start, a path with spaces, cpu time in its three spellings", () => {
    const rows = parsePs(
      [
        "    1     0  12345   1:23.45 Mon Oct 20 08:01:02 2026     /sbin/launchd",
        "  612     1 204800 1-02:03:04 Mon Oct  6 09:00:00 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "  900   612   1024  10:00:00 Tue Oct 21 10:11:12 2026     zsh",
        "garbage",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 1, parent_pid: 0, name: "launchd", memory_mb: 12.1, cpu_seconds: 83.5, started: new Date("Mon Oct 20 08:01:02 2026").toISOString(), path: "/sbin/launchd" },
      { pid: 612, parent_pid: 1, name: "Google Chrome", memory_mb: 200, cpu_seconds: 93_784, started: new Date("Mon Oct 6 09:00:00 2026").toISOString(), path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { pid: 900, parent_pid: 612, name: "zsh", memory_mb: 1, cpu_seconds: 36_000, started: new Date("Tue Oct 21 10:11:12 2026").toISOString() },
    ]);
  });

  it("reads `launchctl list`: a running job has a pid", () => {
    expect(parseLaunchctlList("PID\tStatus\tLabel\n-\t0\tcom.apple.SafariHistoryServiceAgent\n1234\t0\tcom.apple.Finder\n")).toEqual([
      { name: "com.apple.SafariHistoryServiceAgent", status: "stopped" },
      { name: "com.apple.Finder", status: "running" },
    ]);
  });

  it("reads `df -kP`: real disks only, by where each is mounted", () => {
    const text = [
      "Filesystem     1024-blocks      Used Available Capacity  Mounted on",
      "/dev/disk3s1s1   971350180  10483192 567326592     2%    /",
      "devfs                  217       217         0   100%    /dev",
      "/dev/disk3s6     971350180   2097172 567326592     1%    /System/Volumes/VM",
      "map auto_home            0         0         0   100%    /System/Volumes/Data/home",
    ].join("\n");
    expect(parseDf(text)).toEqual([
      { name: "/", device: "/dev/disk3s1s1", size_gb: 926.4, free_gb: 541 },
      { name: "/System/Volumes/VM", device: "/dev/disk3s6", size_gb: 926.4, free_gb: 541 },
    ]);
  });

  it("reads `brew list --versions`, the latest version last", () => {
    expect(parseBrewList("jq 1.7.1\npython@3.12 3.12.6 3.12.7\n", false)).toEqual([
      { name: "jq", id: "jq", version: "1.7.1", kind: "package", publisher: "Homebrew" },
      { name: "python@3.12", id: "python@3.12", version: "3.12.7", kind: "package", publisher: "Homebrew" },
    ]);
  });
});

describe.skipIf(process.platform !== "darwin")("on this Mac", () => {
  const tools = createSystemTools();
  const run = async (name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await tools[name]!.run(input as never, undefined as never)) as Record<string, unknown>;

  it("reads what the machine is", async () => {
    expect((await run("read_system"))["os"]).toMatchObject({ name: expect.stringMatching(/macOS|Mac OS/) });
  });

  it("lists the processes, this one among them and marked as JaiRA's", async () => {
    const rows = (await run("list_processes", { name: "node", limit: 500 }))["processes"] as Array<{ pid: number; protected?: string }>;
    expect(rows.find((row) => row.pid === process.pid)?.protected).toMatch(/engine/);
  });

  it("lists the launchd jobs, and reads the time", async () => {
    expect((await run("list_services", { limit: 3 }))["count"]).toBeGreaterThan(0);
    expect(await run("read_settings", { area: "time" })).toMatchObject({ time_zone: expect.any(String) });
  });
});
