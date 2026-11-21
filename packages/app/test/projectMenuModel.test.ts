/**
 * A project's right-click menu (`projectMenuModel.ts`): which verbs a project offers, which folder the
 * ones that need one mean, and what Delete says it does — take the project out of JaiRA, leave the disk.
 */
import { describe, expect, it } from "vitest";
import { remoteProjectKey, type ProjectSummary } from "@jaira/shared";
import { groupProjects } from "../src/renderer/workspaceGroups";
import { folderOf, projectMenuItems, removeAsk, type ProjectMenuVerbs } from "../src/renderer/projectMenuModel";

const ID = "github.com/ofersadgat/jaira";
const self = { id: "m-desk", label: "ofer-desk", state: "online" as const, self: true as const };
const box = { id: "m-box", label: "build-box", state: "online" as const };

function summary(project: string, machine: ProjectSummary["machine"], kind: ProjectSummary["kind"] = "user"): ProjectSummary {
  return { project, label: project.split(/[\\/]/).pop()!, kind, tasks: 0, running: 0, statuses: {}, waiting: 0, ended: [], identity: ID, ...(machine !== undefined ? { machine } : {}) };
}

const desk1 = summary("/src/JaiRA", self);
const desk2 = summary("/src/JaiRA-2", self);
const onBox = summary(remoteProjectKey("m-box", "/home/ofer/JaiRA"), box);
const group = groupProjects([desk1, desk2, onBox], true)[0]!;

function verbs(done: string[]): ProjectMenuVerbs {
  return {
    newChat: () => done.push("chat"),
    addWorkspace: () => done.push("add"),
    settings: () => done.push("settings"),
    reveal: (dir) => done.push(`reveal ${dir}`),
    copy: (text) => done.push(`copy ${text}`),
    markSeen: () => done.push("seen"),
    remove: () => done.push("remove"),
  };
}

describe("a project's menu", () => {
  it("offers the project's verbs, Delete last and marked as destructive", () => {
    const items = projectMenuItems(group, null, verbs([]));
    expect(items.map((i) => i.label)).toEqual(["New conversation", "Add a workspace…", "Settings", "Mark all as seen", "Reveal in file explorer", "Copy path", "Delete…"]);
    expect(items.at(-1)).toMatchObject({ danger: true, separator: true });
  });

  it("reveals and copies the workspace the window stands on, else this machine's first", () => {
    expect(folderOf(group, desk2.project)?.project).toBe(desk2.project);
    expect(folderOf(group, null)?.project).toBe(desk1.project);
    expect(folderOf(group, "/elsewhere")?.project).toBe(desk1.project);
    const done: string[] = [];
    const items = projectMenuItems(group, desk2.project, verbs(done));
    expect(items.find((i) => i.label === "Copy path")?.note).toBe("JaiRA-2");
    for (const i of items) if (i.label === "Reveal in file explorer" || i.label === "Copy path") i.onSelect();
    expect(done).toEqual(["reveal /src/JaiRA-2", "copy /src/JaiRA-2"]);
  });

  it("does not reveal a folder on another machine, but copies its path", () => {
    const remote = groupProjects([onBox], true)[0]!;
    const done: string[] = [];
    const items = projectMenuItems(remote, null, verbs(done));
    expect(items.map((i) => i.label)).not.toContain("Reveal in file explorer");
    items.find((i) => i.label === "Copy path")!.onSelect();
    expect(done).toEqual(["copy /home/ofer/JaiRA"]);
  });

  it("leaves out what the project cannot do: the shared root is never deleted", () => {
    const shared = groupProjects([summary("/home/ofer/.jaira", self, "shared")], true)[0]!;
    const { addWorkspace: _a, markSeen: _s, ...rest } = verbs([]);
    expect(projectMenuItems(shared, null, rest).map((i) => i.label)).toEqual(["New conversation", "Settings", "Reveal in file explorer", "Copy path"]);
  });
});

describe("Delete's question", () => {
  it("says every workspace leaves JaiRA, on each machine, and that the folders stay", () => {
    let confirmed = 0;
    const ask = removeAsk(group, () => confirmed++);
    expect(ask.title).toBe(`Delete ${group.label}?`);
    expect(ask.note).toMatch(/^Its 3 workspaces are closed and taken out of JaiRA, on every machine that holds one\. The folders and their history stay on disk/);
    expect(ask).toMatchObject({ confirmLabel: "Delete", danger: true });
    ask.onConfirm("");
    expect(confirmed).toBe(1);
    expect(removeAsk(groupProjects([desk1], true)[0]!, () => undefined).note).toMatch(/^Its workspace is closed and taken out of JaiRA\. /);
  });
});
