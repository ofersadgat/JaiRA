/**
 * Settings' path — `Settings › [project] › [machine] › [Just you] › +` (the person's design,
 * 2026-11-17): the layer each path makes, what `+` offers next, how crumbs are taken out, and where a
 * path's layers are read and written — here, or on the machine they belong to.
 */
import { describe, expect, it } from "vitest";
import { remoteProjectKey, SHARED_SESSION, type ProjectSummary } from "@jaira/shared/browser";
import {
  addOptionsOf,
  configTargetOf,
  crumbsOf,
  layerOfPath,
  prunedPath,
  remoteMachineOf,
  sameTarget,
  settingsProjectOf,
  trimmedTo,
  viewKnowsLayer,
  withoutPart,
  withPart,
  type SettingsPart,
  type SettingsPath,
  type SettingsPathContext,
} from "../src/renderer/settingsScope";

const SELF = { id: "m-self", label: "desk" };
const BUILD = { id: "m-build", label: "build-01", state: "online" };
const MINI = { id: "m-mini", label: "mini", state: "offline" };

const here = (dir: string, identity?: string): ProjectSummary =>
  ({ project: dir, label: dir.split("/").pop(), kind: "user", ...(identity !== undefined ? { identity } : {}), machine: { id: SELF.id, label: SELF.label, state: "online", self: true } }) as ProjectSummary;
const there = (machine: { id: string; label: string }, dir: string, identity?: string): ProjectSummary =>
  ({ project: remoteProjectKey(machine.id, dir), label: dir.split("/").pop(), kind: "user", ...(identity !== undefined ? { identity } : {}), machine: { id: machine.id, label: machine.label, state: "online" } }) as ProjectSummary;

// atlas has a clone here and one on build-01; tools is only on build-01; notes only here.
const atlasHere = here("/code/atlas", "github.com/me/atlas");
const atlasBuild = there(BUILD, "/srv/atlas", "github.com/me/atlas");
const tools = there(BUILD, "/srv/tools", "github.com/me/tools");
const notes = here("/code/notes");
const shared = { project: SHARED_SESSION, label: "~/.jaira", kind: "shared" } as ProjectSummary;

const ctx: SettingsPathContext = { projects: [shared, atlasHere, atlasBuild, tools, notes], grouped: true, self: SELF, machines: [BUILD, MINI] };
const labels = (parts: SettingsPart[]): string[] => parts.map((p) => `${p.kind}:${p.label}`);

describe("the layer a path makes", () => {
  it("is Shared with no part, and each part narrows it", () => {
    expect(layerOfPath({})).toBe("base");
    expect(layerOfPath({ project: "/code/atlas" })).toBe("project");
    expect(layerOfPath({ machine: { id: BUILD.id } })).toBe("machine");
    expect(layerOfPath({ project: "/code/atlas", machine: { id: SELF.id, self: true } })).toBe("projectMachine");
    expect(layerOfPath({ you: true })).toBe("you");
    expect(layerOfPath({ project: "/code/atlas", you: true })).toBe("projectYou");
  });
});

describe("the crumbs", () => {
  it("keep their order whatever order the parts were added in", () => {
    let path: SettingsPath = {};
    path = withPart(path, { kind: "you", label: "Just you" });
    path = withPart(path, { kind: "project", key: atlasHere.project, label: "atlas" });
    expect(labels(crumbsOf(path, ctx))).toEqual(["project:atlas", "you:Just you"]);
  });

  it("name a paired machine by its label, and this one by its own", () => {
    expect(labels(crumbsOf({ machine: { id: BUILD.id } }, ctx))).toEqual(["machine:build-01"]);
    expect(labels(crumbsOf({ machine: { id: SELF.id, self: true } }, ctx))).toEqual(["machine:desk"]);
  });

  it("trim to the one pressed, and take one out by its ×", () => {
    const path: SettingsPath = { project: atlasHere.project, machine: { id: BUILD.id } };
    expect(trimmedTo(path, "project")).toEqual({ project: atlasHere.project });
    expect(trimmedTo(path, null)).toEqual({});
    expect(withoutPart(path, "project")).toEqual({ machine: { id: BUILD.id } });
  });
});

describe("what + offers", () => {
  it("offers every project, every machine and Just you on Shared — never the shared root as a project", () => {
    expect(labels(addOptionsOf({}, ctx))).toEqual(["project:atlas", "project:tools", "project:notes", "machine:desk", "machine:build-01", "machine:mini", "you:Just you"]);
  });

  it("offers no machine once Just you is in the path, and no Just you once a machine is", () => {
    expect(labels(addOptionsOf({ you: true }, ctx)).filter((l) => l.startsWith("machine") || l.startsWith("you"))).toEqual([]);
    expect(labels(addOptionsOf({ machine: { id: BUILD.id } }, ctx)).filter((l) => l.startsWith("you") || l.startsWith("machine"))).toEqual([]);
    // And a machine is refused where Just you already is.
    expect(withPart({ you: true }, { kind: "machine", id: BUILD.id, self: false, label: "build-01" })).toEqual({ you: true });
  });

  it("offers only the machines a project is on, and only the projects a machine has", () => {
    expect(labels(addOptionsOf({ project: atlasHere.project }, ctx)).filter((l) => l.startsWith("machine"))).toEqual(["machine:desk", "machine:build-01"]);
    expect(labels(addOptionsOf({ project: tools.project }, ctx)).filter((l) => l.startsWith("machine"))).toEqual(["machine:build-01"]);
    expect(labels(addOptionsOf({ machine: { id: BUILD.id } }, ctx)).filter((l) => l.startsWith("project"))).toEqual(["project:atlas", "project:tools"]);
    expect(labels(addOptionsOf({ machine: { id: SELF.id, self: true } }, ctx)).filter((l) => l.startsWith("project"))).toEqual(["project:atlas", "project:notes"]);
  });

  it("offers nothing more on a full path", () => {
    expect(addOptionsOf({ project: atlasHere.project, machine: { id: BUILD.id } }, ctx)).toEqual([]);
    expect(addOptionsOf({ project: atlasHere.project, you: true }, ctx)).toEqual([]);
  });
});

describe("where a path's layers are read and written", () => {
  it("reads Shared, Just you and this machine's here, for the project the shell stands on", () => {
    expect(configTargetOf({}, ctx, atlasHere.project)).toEqual({ project: atlasHere.project });
    expect(configTargetOf({ you: true }, ctx, atlasHere.project)).toEqual({ project: atlasHere.project });
    expect(configTargetOf({ machine: { id: SELF.id, self: true } }, ctx, null)).toEqual({ project: SHARED_SESSION });
  });

  it("reads them for no project when the shell stands on another machine's workspace", () => {
    expect(configTargetOf({}, ctx, tools.project)).toEqual({ project: SHARED_SESSION });
  });

  it("reads a paired machine's layers on it, for no project", () => {
    expect(configTargetOf({ machine: { id: BUILD.id } }, ctx, atlasHere.project)).toEqual({ project: SHARED_SESSION, machine: BUILD.id });
    expect(remoteMachineOf({ machine: { id: BUILD.id } }, ctx, null)).toBe(BUILD.id);
  });

  it("reads a project in its workspace on the machine named — forwarded there by its key", () => {
    expect(configTargetOf({ project: atlasHere.project, machine: { id: BUILD.id } }, ctx, null)).toEqual({ project: atlasBuild.project });
    expect(configTargetOf({ project: atlasBuild.project, machine: { id: SELF.id, self: true } }, ctx, null)).toEqual({ project: atlasHere.project });
    expect(remoteMachineOf({ project: atlasHere.project, machine: { id: BUILD.id } }, ctx, null)).toBe(BUILD.id);
  });

  it("reads a project with no machine in the workspace the shell stands on, else this machine's", () => {
    expect(configTargetOf({ project: atlasHere.project }, ctx, atlasBuild.project)).toEqual({ project: atlasBuild.project });
    expect(configTargetOf({ project: atlasBuild.project }, ctx, null)).toEqual({ project: atlasHere.project });
    expect(configTargetOf({ project: tools.project }, ctx, null)).toEqual({ project: tools.project });
    expect(settingsProjectOf({ project: tools.project }, ctx, atlasHere.project)).toBe(tools.project);
    expect(settingsProjectOf({}, ctx, atlasHere.project)).toBe(atlasHere.project);
  });

  it("has nothing to read for a project with no workspace on the machine named", () => {
    expect(configTargetOf({ project: notes.project, machine: { id: BUILD.id } }, ctx, null)).toBeUndefined();
    expect(prunedPath({ project: notes.project, machine: { id: BUILD.id } }, ctx)).toEqual({ project: notes.project });
  });

  it("takes out a project the window closed and a machine no longer paired", () => {
    const path: SettingsPath = { project: "/code/gone", machine: { id: "m-old" } };
    expect(prunedPath(path, ctx)).toEqual({});
    const unchanged: SettingsPath = { project: atlasHere.project };
    expect(prunedPath(unchanged, ctx)).toBe(unchanged);
    // Before the machines are known, a paired machine is not taken for an unpaired one.
    expect(prunedPath({ machine: { id: BUILD.id } }, { ...ctx, self: undefined, machines: [] })).toEqual({ machine: { id: BUILD.id } });
  });

  it("tells whether two targets read one view", () => {
    expect(sameTarget({ project: "/a" }, { project: "/a" })).toBe(true);
    expect(sameTarget({}, { project: SHARED_SESSION })).toBe(false);
    expect(sameTarget({ project: SHARED_SESSION, machine: BUILD.id }, { project: SHARED_SESSION })).toBe(false);
  });

  it("does not write a machine's own layers through an engine that predates them", () => {
    expect(viewKnowsLayer({}, "machine")).toBe(false);
    expect(viewKnowsLayer({}, "you")).toBe(true);
    expect(viewKnowsLayer({ machineFile: "/b/machine-settings.json" }, "projectYou")).toBe(true);
    expect(viewKnowsLayer(null, "base")).toBe(false);
  });
});
