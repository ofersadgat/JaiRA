/**
 * A workspace whose setup brought its container up (decision 0027): the engine says so in that
 * workspace's own settings on this machine (`.jaira/settings.local.json`, which git ignores), its open
 * session reads it at once, and an unchanged one is not written again. Another workspace, and the
 * machine's own layers, are untouched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { containerLine, execDistroOf } from "../src/renderer/configWriter";

let dir: string;
let other: string;
let baseDir: string;
let service: AppService;
let pushes: PushMessage[];

/** The engine's own record of a workspace's container — what the setup's container port calls. */
const record = (at: string, env: unknown): void => (service as unknown as { recordWorkspaceEnv(dir: string, env: unknown): void }).recordWorkspaceEnv(at, env);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-box-"));
  other = mkdtempSync(join(tmpdir(), "jaira-box-other-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-box-base-"));
  pushes = [];
  initProject(dir, testHome());
  service = new AppService({ baseDir, watchWorkflows: false, publish: (m) => pushes.push(m) });
});

afterEach(async () => {
  await service.close();
  for (const one of [dir, other, baseDir]) rmSync(one, { recursive: true, force: true });
});

describe("a workspace's container, in its settings on this machine", () => {
  it("is written into the open workspace's settings.local.json, read at once, and not written again unchanged", async () => {
    await service.open(dir);
    const env = { container: "jaira-1a2b3c4d", user: "node", from: "devcontainer" };
    record(dir, env);
    const file = join(dir, ".jaira", "settings.local.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ execEnvironment: env });
    expect(readFileSync(join(dir, ".jaira", ".gitignore"), "utf8").split("\n")).toContain("settings.local.json");
    const view = service.readConfig(dir);
    expect(view.effective).toMatchObject({ execEnvironment: env });
    // Only this workspace on this machine: the machine's own layer says nothing of it.
    expect(view.machine).toBeNull();

    const written = pushes.filter((p) => p.type === "store:invalidate" && (p as { scope?: string }).scope === "config").length;
    record(dir, { ...env });
    expect(pushes.filter((p) => p.type === "store:invalidate" && (p as { scope?: string }).scope === "config").length).toBe(written);
  });

  it("keeps what else the workspace's settings on this machine say", async () => {
    await service.open(dir);
    service.writeConfig({ layer: "projectMachine", project: dir, config: { artifacts: { dir: "here" } } });
    record(dir, { container: "jaira-1a2b3c4d", from: "docker" });
    expect(JSON.parse(readFileSync(join(dir, ".jaira", "settings.local.json"), "utf8"))).toEqual({ artifacts: { dir: "here" }, execEnvironment: { container: "jaira-1a2b3c4d", from: "docker" } });
  });

  it("is written straight to the file of a workspace that is not open", () => {
    record(other, { container: "jaira-0f0f0f0f", from: "docker" });
    expect(JSON.parse(readFileSync(join(other, ".jaira", "settings.local.json"), "utf8"))).toEqual({ execEnvironment: { container: "jaira-0f0f0f0f", from: "docker" } });
    expect(existsSync(join(other, ".jaira", ".gitignore"))).toBe(true);
  });
});

describe("the Where commands run row", () => {
  it("reads a workspace's container as itself, not as a distro", () => {
    expect(execDistroOf({ execEnvironment: { container: "jaira-1a2b3c4d", user: "node", from: "devcontainer" } })).toMatchObject({
      distro: "",
      container: { name: "jaira-1a2b3c4d", user: "node", from: "devcontainer" },
    });
    expect(containerLine({ name: "jaira-1a2b3c4d", user: "node", from: "devcontainer" })).toBe("In the container jaira-1a2b3c4d (Dev Container), as node");
    expect(containerLine({ name: "jaira-0f0f0f0f", from: "docker" })).toBe("In the container jaira-0f0f0f0f (Docker)");
    expect(execDistroOf({ execEnvironment: { wsl: "Ubuntu" } })).toEqual({ value: { wsl: "Ubuntu" }, distro: "Ubuntu" });
    expect(execDistroOf({ execEnvironment: "windows" })).toEqual({ value: "windows", distro: "" });
  });
});
