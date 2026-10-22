/**
 * The System tools on Windows itself (decision 0019 §2): what only reads — so it runs on any Windows,
 * a CI runner's included, and changes nothing. What changes the machine (power, a service, the
 * clipboard, the mouse) is covered over a fake machine in `systemTools.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { runPowerShell } from "../src/system/powershell";
import { registryPath } from "../src/system/windows";
import { createSystemTools } from "../src/systemTools";

describe("registryPath — a key as the provider reads it", () => {
  it("takes the hive's short and long names, a drive's colon, and either slash", () => {
    expect(registryPath("HKCU\\Software\\X")).toBe("Registry::HKEY_CURRENT_USER\\Software\\X");
    expect(registryPath("HKEY_LOCAL_MACHINE\\SOFTWARE")).toBe("Registry::HKEY_LOCAL_MACHINE\\SOFTWARE");
    expect(registryPath("HKLM:\\SOFTWARE\\Microsoft\\")).toBe("Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft");
    expect(registryPath("hkcu/Software/X")).toBe("Registry::HKEY_CURRENT_USER\\Software\\X");
    expect(registryPath("HKCR")).toBe("Registry::HKEY_CLASSES_ROOT");
  });

  it("refuses what names no hive", () => {
    expect(() => registryPath("Software\\X")).toThrow(/start it with a hive/);
    expect(() => registryPath("C:\\Windows")).toThrow(/start it with a hive/);
  });
});

describe.skipIf(process.platform !== "win32")("on this Windows", () => {
  const tools = createSystemTools();
  const run = async (name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await tools[name]!.run(input as never, undefined as never)) as Record<string, unknown>;

  it("carries a call's arguments into PowerShell as data, never as code", async () => {
    const text = `$(Remove-Item x) '; exit; "\` héllo ✓`;
    expect(await runPowerShell(`Out-Result @{ echo = [string]$A.text; list = @($A.list) }`, { text, list: ["one"] })).toEqual({ echo: text, list: ["one"] });
    await expect(runPowerShell(`throw "boom"`, null)).rejects.toThrow("boom");
  });

  it("reads what the machine is", async () => {
    const summary = await run("read_system");
    expect(summary["os"]).toMatchObject({ name: expect.stringMatching(/^Windows/) });
    expect(summary["processors"]).toBeGreaterThan(0);
    expect(Array.isArray(await run("read_system", { about: "disks" }))).toBe(true);
  });

  it("lists the processes, this one among them and marked as JaiRA's", async () => {
    const listed = await run("list_processes", { sort: "pid", limit: 500, name: String(process.title).includes("node") ? "node" : "" });
    const rows = listed["processes"] as Array<{ pid: number; protected?: string }>;
    expect(rows.find((row) => row.pid === process.pid)?.protected).toMatch(/engine/);
    expect((await run("stop_process", { pid: process.pid }))["error"]).toMatch(/refused/);
  });

  it("lists the services", async () => {
    const listed = await run("list_services", { limit: 3 });
    expect(listed["count"]).toBeGreaterThan(0);
  });

  it("reads the time and a registry key every Windows has", async () => {
    expect(await run("read_settings", { area: "time" })).toMatchObject({ time_zone: expect.any(String) });
    const key = await run("read_settings", { area: "registry", key: "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", name: "CurrentBuild" });
    expect(key["values"]).toEqual([{ name: "CurrentBuild", type: "string", value: expect.stringMatching(/^\d+$/) }]);
    expect((await run("read_settings", { area: "registry", key: "HKCU\\Software\\JaiRA-no-such-key" }))["error"]).toMatch(/no registry key/);
  });
});
