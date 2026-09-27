/**
 * One project, however many clones (decision 0013 §4): workspaces grouped by the repository they are
 * clones of, this machine's first; a chip only where there is a question of where; the folder only
 * where one machine has two; and the boards merged by column, every card knowing its own workspace.
 */
import { describe, expect, it } from "vitest";
import { remoteProjectKey, type BoardCard, type BoardView, type ProjectSummary } from "@jaira/shared";
import { chipFor, groupProjects, groupOf, mergeBoards } from "../src/renderer/workspaceGroups";

const ID = "github.com/ofersadgat/jaira";
const self = { id: "m-desk", label: "desk", state: "online" as const, self: true as const };
const mac = { id: "m-mac", label: "mac-mini", state: "online" as const };
const box = { id: "m-box", label: "build-box", state: "offline" as const };

/** `identity: null` for a project without a remote — `undefined` would take the default. */
function summary(project: string, machine: ProjectSummary["machine"], identity: string | null = ID): ProjectSummary {
  return { project, label: project.split(/[\\/]/).pop()!, kind: "user", tasks: 0, running: 0, statuses: {}, waiting: 0, ended: [], ...(identity !== null ? { identity } : {}), ...(machine !== undefined ? { machine } : {}) };
}

const desk1 = summary("C:\\src\\jaira", self);
const desk2 = summary("C:\\src\\jaira-2", self);
const onMac = summary(remoteProjectKey("m-mac", "/Users/ofer/src/jaira"), mac);
const onBox = summary(remoteProjectKey("m-box", "/home/ofer/jaira"), box);
const dotfiles = summary("C:\\src\\dotfiles", self, null);
const shared = { ...summary("C:\\Users\\ofer\\.jaira", self, null), kind: "shared" as const, label: "~/.jaira" };

describe("grouping workspaces", () => {
  it("puts one repository's clones in one group, this machine's first, named for the repository", () => {
    const groups = groupProjects([onMac, desk2, dotfiles, desk1, onBox, shared], true);
    expect(groups.map((g) => [g.label, g.where, g.members.length])).toEqual([
      ["jaira", "3 machines · 4 workspaces", 4],
      ["dotfiles", undefined, 1],
      ["~/.jaira", undefined, 1],
    ]);
    expect(groups[0]!.key).toBe(desk2.project);
    expect(groupOf(groups, onBox.project)?.key).toBe(desk2.project);
  });

  it("lists every workspace on its own when grouping is off, a remote one with its machine", () => {
    const groups = groupProjects([desk1, onMac, onBox], false);
    expect(groups.map((g) => [g.label, g.where])).toEqual([
      ["jaira", undefined],
      ["jaira", "mac-mini"],
      ["jaira", "build-box · offline"],
    ]);
  });
});

describe("the chip", () => {
  const [group] = groupProjects([desk1, desk2, onMac, onBox], true);
  it("names the machine, and the folder where that machine has two", () => {
    expect(chipFor(onMac, group!)).toMatchObject({ label: "mac-mini", state: "on" });
    expect(chipFor(desk2, group!)).toMatchObject({ label: "desk / jaira-2", state: "on" });
    expect(chipFor(onBox, group!)).toMatchObject({ label: "build-box", state: "off", title: expect.stringContaining("offline") });
  });

  it("is not drawn for a project of one workspace", () => {
    const [alone] = groupProjects([desk1], true);
    expect(chipFor(desk1, alone!)).toBeUndefined();
  });
});

describe("the merged board", () => {
  const card = (taskId: string, updatedAt: number): BoardCard => ({ taskId, title: taskId, status: "running", workflow: "feature/plan", activePath: [], hasSubBoard: false, updatedAt });
  const board = (cards: Record<string, BoardCard[]>, finished: BoardCard[] = []): BoardView => ({
    level: "feature/plan",
    breadcrumb: [{ stateId: "feature/plan" }] as never,
    columns: Object.entries(cards).map(([key, list]) => ({ key, stateId: `feature/plan/${key}`, cards: list })),
    atLevel: [],
    finished,
  });

  it("merges columns by key, newest first, and stamps each card with its workspace and chip", () => {
    const [group] = groupProjects([desk1, onMac], true);
    const merged = mergeBoards(group!, {
      [desk1.project]: board({ goals: [card("t-desk", 5)] }, [card("t-done", 3)]),
      [onMac.project]: board({ goals: [card("t-mac", 9)], critique: [card("t-mac-2", 1)] }),
    })!;
    expect(merged.columns.map((c) => [c.key, c.cards.map((x) => x.taskId)])).toEqual([
      ["goals", ["t-mac", "t-desk"]],
      ["critique", ["t-mac-2"]],
    ]);
    expect(merged.columns[0]!.cards[0]).toMatchObject({ project: onMac.project, where: { label: "mac-mini" } });
    expect(merged.finished[0]).toMatchObject({ taskId: "t-done", project: desk1.project, where: { label: "desk" } });
  });

  it("is the workspace's own board, untouched, for a project of one", () => {
    const [group] = groupProjects([desk1], true);
    const own = board({ goals: [card("t-desk", 5)] });
    expect(mergeBoards(group!, { [desk1.project]: own })).toBe(own);
  });
});
