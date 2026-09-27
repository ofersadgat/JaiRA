/**
 * The `jaira` command on the PATH (decision 0011 §7): what About's Command line row is told, and the
 * Windows install writing the forwarding script the installer writes.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliCommandStatus, installCliCommand } from "../src/main/cliCommand";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-cli-command-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the jaira command", () => {
  it("is not offered by a development build", () => {
    expect(cliCommandStatus({ packaged: false, platform: "win32", resources: dir })).toMatchObject({ state: "development", canInstall: false });
  });

  it("on Windows, is missing until the forwarding script names this app, and the install writes it", async () => {
    const context = { packaged: true, platform: "win32" as const, resources: join(dir, "app", "resources"), localAppData: join(dir, "local") };
    expect(cliCommandStatus(context)).toEqual({ state: "missing", canInstall: true });
    const status = await installCliCommand(context);
    const shim = join(dir, "local", "Microsoft", "WindowsApps", "jaira.cmd");
    expect(status).toEqual({ state: "installed", path: shim, canInstall: true });
    expect(readFileSync(shim, "utf8")).toContain(join(dir, "app", "resources", "bin", "jaira.cmd"));
    // Another install elsewhere took the name: this app's command is missing again.
    expect(cliCommandStatus({ ...context, resources: join(dir, "other", "resources") }).state).toBe("missing");
  });

  it("is not offered by an AppImage, which has no fixed place to run from", () => {
    expect(cliCommandStatus({ packaged: true, platform: "linux", resources: dir, appImage: "/home/me/JaiRA.AppImage" })).toMatchObject({ state: "unavailable", canInstall: false });
  });
});
