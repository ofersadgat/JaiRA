/**
 * The project panel's title narrows to a machine, or to a workspace on one (boards 49–50): a workspace
 * is one clone on one machine, so choosing it chooses its machine; the scope is kept per project and
 * made to agree with what the project holds now; and the title keeps one line, the steps before the
 * current one shrinking to icons first.
 */
import { describe, expect, it } from "vitest";
import { remoteProjectKey, type JairaUiState, type ProjectSummary } from "@jaira/shared";
import { groupProjects } from "../src/renderer/workspaceGroups";
import { addTargetsOf, addWorkspaceQuestion, chooseMachine, chooseWorkspace, crumbFit, inScope, machineOfKey, machinesOf, machinesWithout, placesOf, runTargetOf, scopeModes, scopeOf, SELF_MACHINE } from "../src/renderer/scopeModel";

const ID = "github.com/ofersadgat/jaira";
const self = { id: "m-desk", label: "ofer-desk", state: "online" as const, self: true as const };
const box = { id: "m-box", label: "build-box", state: "online" as const };

function summary(project: string, machine: ProjectSummary["machine"]): ProjectSummary {
  return { project, label: project.split(/[\\/]/).pop()!, kind: "user", tasks: 0, running: 0, statuses: {}, waiting: 0, ended: [], identity: ID, ...(machine !== undefined ? { machine } : {}) };
}

const desk1 = summary("C:\\src\\JaiRA", self);
const desk2 = summary("C:\\src\\JaiRA-2", self);
const onBox = summary(remoteProjectKey("m-box", "/home/ofer/JaiRA"), box);
const group = groupProjects([desk1, desk2, onBox], true)[0]!;
const ui = (modes: Record<string, string>): JairaUiState => ({ modes }) as unknown as JairaUiState;
const kept = (scope: Parameters<typeof scopeModes>[1]): JairaUiState => ui(Object.fromEntries(scopeModes(group.key, scope)));

describe("the machines and workspaces a project spans", () => {
  it("lists each machine once, this one first, its workspaces by folder name", () => {
    expect(machinesOf(group).map((m) => [m.id, m.label, m.workspaces.map((w) => w.label)])).toEqual([
      [SELF_MACHINE, "ofer-desk", ["JaiRA", "JaiRA-2"]],
      ["m-box", "build-box", ["JaiRA"]],
    ]);
  });
});

describe("the machine menu's Add rows", () => {
  const paired = [
    { id: "m-box", label: "build-box", online: true },
    { id: "m-old", label: "old-mini", online: false },
  ];

  it("ticks the machine a lone workspace is on, which is not this one when it lives elsewhere", () => {
    expect(machineOfKey("C:\\src\\JaiRA")).toBe(SELF_MACHINE);
    expect(machineOfKey(remoteProjectKey("m-box", "/home/ofer/JaiRA"))).toBe("m-box");
  });

  it("lists every machine holding none, this one first when it holds none", () => {
    expect(machinesWithout(paired, new Set([SELF_MACHINE])).map((m) => m.id)).toEqual(["m-box", "m-old"]);
    expect(machinesWithout(paired, new Set(["m-box"]))).toEqual([
      { id: SELF_MACHINE, label: "This machine", online: true, self: true },
      { id: "m-old", label: "old-mini", online: false, self: false },
    ]);
    expect(machinesWithout(paired, new Set(machinesOf(group).map((m) => m.id))).map((m) => m.id)).toEqual(["m-old"]);
  });
});

describe("Add a workspace, with no machine chosen", () => {
  const paired = [
    { id: "m-box", label: "build-box", online: true },
    { id: "m-old", label: "old-mini", online: false },
  ];

  it("asks among every machine: this one first, then those holding a workspace, then the rest", () => {
    expect(addTargetsOf(machinesOf(group), paired).map((m) => [m.id, m.holds])).toEqual([
      [SELF_MACHINE, 2],
      ["m-box", 1],
      ["m-old", 0],
    ]);
    const lone = groupProjects([onBox], true)[0]!;
    expect(addTargetsOf(machinesOf(lone), paired).map((m) => [m.label, m.holds])).toEqual([
      ["This machine", 0],
      ["build-box", 1],
      ["old-mini", 0],
    ]);
  });

  it("adds on the machine picked, dims one that is offline, and ends with the full form", () => {
    const picked: string[] = [];
    let full = 0;
    const items = addWorkspaceQuestion(addTargetsOf(machinesOf(group), paired), (m) => picked.push(m.id), () => full++);
    expect(items.map((i) => [i.label, i.note ?? "", i.disabled === true])).toEqual([
      ["ofer-desk", "this machine · 2 workspaces", false],
      ["build-box", "1 workspace", false],
      ["old-mini", "offline · no workspace", true],
      ["More options…", "", false],
    ]);
    items[1]!.onSelect();
    items[3]!.onSelect();
    expect(picked).toEqual(["m-box"]);
    expect(full).toBe(1);
  });
});

describe("narrowing", () => {
  it("a workspace chooses its machine, and two same-named clones are never one workspace", () => {
    const scope = chooseWorkspace(group, {}, onBox.project);
    expect(scope).toEqual({ machine: "m-box", workspace: onBox.project });
    expect(inScope(group, scope, onBox.project)).toBe(true);
    expect(inScope(group, scope, desk1.project)).toBe(false);
  });

  it("a machine alone shows every workspace on it", () => {
    const scope = chooseMachine(group, {}, SELF_MACHINE);
    expect([desk1, desk2, onBox].map((p) => inScope(group, scope, p.project))).toEqual([true, true, false]);
    // A row naming no workspace is the primary's, which is this machine's.
    expect(inScope(group, scope, undefined)).toBe(true);
  });

  it("choosing another machine lets a workspace go; the same machine keeps it", () => {
    const scope = chooseWorkspace(group, {}, desk2.project);
    expect(chooseMachine(group, scope, "m-box")).toEqual({ machine: "m-box" });
    expect(chooseMachine(group, scope, SELF_MACHINE)).toEqual(scope);
    expect(chooseMachine(group, scope, undefined)).toEqual({});
    expect(chooseWorkspace(group, scope, undefined)).toEqual({ machine: SELF_MACHINE });
  });

  it("is kept per project, and what is gone from the project is no narrowing", () => {
    expect(scopeOf(kept({ machine: "m-box", workspace: onBox.project }), group)).toEqual({ machine: "m-box", workspace: onBox.project });
    expect(scopeOf(kept({ machine: "m-gone" }), group)).toEqual({});
    expect(scopeOf(kept({ workspace: "C:\\src\\gone" }), group)).toEqual({});
    expect(scopeOf(ui({}), group)).toEqual({});
  });
});

describe("where a new conversation runs", () => {
  it("in the workspace chosen, else on the machine chosen, else wherever there is room", () => {
    expect(runTargetOf(group, chooseWorkspace(group, {}, desk2.project))).toEqual({ project: desk2.project });
    expect(runTargetOf(group, { machine: "m-box" })).toEqual({ machine: "m-box" });
    expect(runTargetOf(group, { machine: SELF_MACHINE })).toEqual({ machine: "m-desk" });
    expect(runTargetOf(group, {})).toBeUndefined();
  });
});

describe("what a row says of its workspace", () => {
  it("names the others where several are in view, and nothing when one is", () => {
    expect(placesOf(group, {})).toEqual({ [desk2.project]: "JaiRA-2", [onBox.project]: "build-box" });
    expect(placesOf(group, { machine: SELF_MACHINE })).toEqual({ [desk2.project]: "JaiRA-2" });
    expect(placesOf(group, { machine: "m-box" })).toEqual({});
    expect(placesOf(group, chooseWorkspace(group, {}, desk2.project))).toEqual({});
  });
});

describe("the title on one line", () => {
  it("keeps every name when there is room", () => {
    expect(crumbFit({ project: "JaiRA", machine: "ofer-desk", workspace: "JaiRA-2" }, 400)).toEqual({ project: "name", machine: "name", workspace: "name", current: "workspace" });
  });

  it("shrinks the project first, then the machine, never the current step", () => {
    expect(crumbFit({ project: "JaiRA", machine: "ofer-desk", workspace: "JaiRA-2" }, 230).project).toBe("icon");
    expect(crumbFit({ project: "JaiRA", machine: "ofer-desk", workspace: "JaiRA-2" }, 160)).toEqual({ project: "icon", machine: "icon", workspace: "name", current: "workspace" });
    expect(crumbFit({ project: "JaiRA", machine: "ofer-desk" }, 120)).toEqual({ project: "icon", machine: "name", workspace: "icon", current: "machine" });
  });

  it("draws a half that narrows nothing as its icon, the project as the title", () => {
    expect(crumbFit({ project: "declarative-ai" }, 200)).toEqual({ project: "name", machine: "icon", workspace: "icon", current: "project" });
  });
});
