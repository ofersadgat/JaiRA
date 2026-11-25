/**
 * Workflows in the settings' six layers (decision 0023, amended 2026-11-18), through the service: a state
 * written, read, copied, switched off and taken away in any of them by the ordinary workflow channels; the
 * most specific copy is the one a run, the browser and a task start read; the Files view lays each
 * layer over the workspace's .jaira/, a row per copy, and marks a copy a nearer layer overrides with the layer that wins; and a
 * stack saved as a set into any of them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, loadWorkflowBundle, readWorkflowFiles, workflowLoadOptions } from "@jaira/persistence";
import { automationStateOf, jairaPaths, SHARED_SESSION, type FileNode, type FileRoot, type PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { newItems, rootNeedsName, standingRoot, treeMenus } from "../src/renderer/filesModel";
import type { MenuItem } from "../src/renderer/menuTypes";

let dir: string;
let service: AppService;

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-layer-files-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), publish: () => undefined, watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A state that says one word — what a load of it shows is which copy was read. */
const says = (word: string): string => JSON.stringify({ label: word, operation: { kind: "prompt", prompt: word } });
const STATE = "review/quick";

/** What the copy of `id` a project load reads says. */
function readIn(id: string): unknown {
  const paths = jairaPaths(dir, testHome());
  return loadWorkflowBundle(readWorkflowFiles(paths.workflowsDir), id, workflowLoadOptions(paths)).states[id]?.label;
}

const walk = (nodes: readonly FileNode[], out: FileNode[] = []): FileNode[] => {
  for (const node of nodes) {
    out.push(node);
    if (node.children !== undefined) walk(node.children, out);
  }
  return out;
};

describe("a workflow in any of the six layers", () => {
  it("is written where each layer keeps it, and the most specific copy is the one read — taken away, the next one is", () => {
    service.writeWorkflow({ stateId: STATE, layer: "base", text: says("shared") });
    service.writeWorkflow({ stateId: STATE, layer: "project", project: dir, text: says("project") });
    expect(readIn(STATE)).toBe("project");
    const machine = service.writeWorkflow({ stateId: STATE, layer: "machine", project: dir, text: says("machine") });
    expect(machine.file).toBe(join(testHome(), "machine", "workflows", "review", "quick.json"));
    expect(readIn(STATE)).toBe("machine");
    service.writeWorkflow({ stateId: STATE, layer: "projectMachine", project: dir, text: says("project on this machine") });
    // The project on this machine is this machine's: kept out of the repository before a file lands there.
    expect(readFileSync(join(dir, ".jaira", ".gitignore"), "utf8")).toMatch(/^local\/$/m);
    expect(readIn(STATE)).toBe("project on this machine");
    const mine = service.writeWorkflow({ stateId: STATE, layer: "you", project: dir, text: says("mine") });
    expect(mine.file).toBe(join(testHome(), "personal", "workflows", "review", "quick.json"));
    expect(readIn(STATE)).toBe("mine");
    service.writeWorkflow({ stateId: STATE, layer: "projectYou", project: dir, text: says("mine here") });
    expect(readIn(STATE)).toBe("mine here");
    expect(service.readWorkflow({ stateId: STATE, layer: "you", project: dir })).toMatchObject({ exists: true, layer: "you" });
    // The browser and a task start read the same copy.
    const entry = service.browseWorkflows(dir).workflows.find((w) => w.rootId === STATE);
    expect(entry).toMatchObject({ layer: "projectYou", label: "mine here" });
    service.deleteWorkflow({ stateId: STATE, layer: "projectYou", project: dir });
    expect(readIn(STATE)).toBe("mine");
    service.deleteWorkflow({ stateId: STATE, layer: "you", project: dir });
    expect(existsSync(mine.file)).toBe(false);
    expect(readIn(STATE)).toBe("project on this machine");
  });

  it("is copied into any layer ('edit a copy'), and switched off there by a file that follows the nearest it can see", () => {
    service.writeWorkflow({ stateId: STATE, layer: "project", project: dir, text: says("project") });
    expect(service.moveWorkflow({ stateId: STATE, layer: "project", project: dir, to: STATE, toLayer: "you", copy: true })).toMatchObject({ applied: true, layer: "you" });
    expect(readIn(STATE)).toBe("project");
    // A layer that is no project's never follows a project's copy: with nothing under it but the project's, it has none to switch.
    service.deleteWorkflow({ stateId: STATE, layer: "you", project: dir });
    expect(() => service.setWorkflowDisabled({ stateId: STATE, layer: "machine", project: dir, disabled: true })).toThrow(/no file in the machine layer or below it/);
    // The project on this machine follows the project's.
    const off = service.setWorkflowDisabled({ stateId: STATE, layer: "projectMachine", project: dir, disabled: true });
    expect(JSON.parse(off.text)).toEqual({ $ref: `$JAIRA/workflows/${STATE}`, disabled: true });
    // Over Shared's, this machine's follows Shared's.
    service.writeWorkflow({ stateId: "review/shared", layer: "base", text: says("shared") });
    const machineOff = service.setWorkflowDisabled({ stateId: "review/shared", layer: "machine", project: dir, disabled: true });
    expect(JSON.parse(machineOff.text)).toEqual({ $ref: "$BASE/workflows/review/shared", disabled: true });
  });

  it("refuses what ships, and a project's layer with none named", () => {
    expect(() => service.writeWorkflow({ stateId: STATE, layer: "system", text: "{}" })).toThrow(/read-only/);
    expect(() => service.writeWorkflow({ stateId: STATE, layer: "projectMachine", project: SHARED_SESSION, text: "{}" })).toThrow(/no projectMachine layer/);
    // Just you and this machine are this machine's, whichever project asks — or none.
    expect(service.writeWorkflow({ stateId: STATE, layer: "machine", project: SHARED_SESSION, text: says("machine") }).file).toBe(join(testHome(), "machine", "workflows", "review", "quick.json"));
  });
});

describe("a stack saved as a set", () => {
  it("goes into any of the six layers — Just you's here — and refuses a name that is there", () => {
    const saved = service.savePermissionStack({ project: dir, layer: "you", bucket: "", name: "mine", permissionSet: { "git status": "allow" } });
    expect(saved).toMatchObject({ id: "mine" });
    expect(JSON.parse(readFileSync(join(testHome(), "personal", "permission-sets", "mine.json"), "utf8"))).toEqual({ "git status": "allow" });
    expect(() => service.savePermissionStack({ project: dir, layer: "you", bucket: "", name: "mine", permissionSet: {} })).toThrow(/already exists/);
    service.savePermissionStack({ project: dir, layer: "projectMachine", bucket: "", name: "here", permissionSet: { "git log": "allow" } });
    expect(existsSync(join(dir, ".jaira", "local", "permission-sets", "here.json"))).toBe(true);
  });
});

describe("the Files view lays every layer over the workspace's .jaira/", () => {
  it("draws one root for the project, each other layer's copies as rows of its own in .jaira/ — `.jaira/local/` not walked as a folder of the checkout", async () => {
    execFileSync("git", ["init", "-q", dir], { windowsHide: true });
    service.writeWorkflow({ stateId: STATE, layer: "projectMachine", project: dir, text: says("here") });
    service.writeWorkflow({ stateId: STATE, layer: "you", project: dir, text: says("mine") });
    const tree = await service.filesTree({ project: dir });
    // A root per workspace (the person, 2026-11-24): the layers are not roots of their own.
    expect(tree.roots.map((root) => root.layer)).toEqual(["project"]);
    expect(walk(tree.roots[0]!.nodes).some((node) => node.path === ".jaira/local")).toBe(false);
    // One row per layer that has the file, in the order the search path reads them: Just you's leads.
    const rows = walk(tree.roots[0]!.nodes).filter((node) => node.stateId === STATE);
    expect(rows.map((row) => [row.layer, row.shadowed === true])).toEqual([
      ["you", false],
      ["projectMachine", true],
    ]);
    // Each is addressed under its own layer root, and says where that is.
    expect(rows[0]).toMatchObject({ path: "workflows/review/quick.json", layerDir: join(testHome(), "personal") });
    expect(rows[1]).toMatchObject({ path: "workflows/review/quick.json", project: dir, shadowedBy: "you", layerDir: join(dir, ".jaira", "local") });
    // Drawn in the project's own `.jaira/workflows/review`, which only other layers have: a virtual folder.
    expect(walk(tree.roots[0]!.nodes).find((node) => node.path === ".jaira/workflows/review")).toMatchObject({ layer: "project", virtual: true });
    // A file in a layer opens as that layer's file.
    expect(service.readFile({ layer: "you", path: "workflows/review/quick.json" }).file).toBe(join(testHome(), "personal", "workflows", "review", "quick.json"));
    expect(service.readFile({ layer: "projectMachine", project: dir, path: "workflows/review/quick.json" }).file).toBe(join(dir, ".jaira", "local", "workflows", "review", "quick.json"));
  });

  it("shadows a project copy with Just you's, and says which layer wins, in the browser and the tree", async () => {
    service.writeWorkflow({ stateId: STATE, layer: "project", project: dir, text: says("project") });
    service.writeWorkflow({ stateId: STATE, layer: "base", text: says("shared") });
    service.writeWorkflow({ stateId: STATE, layer: "you", project: dir, text: says("mine") });
    const files = service.browseWorkflows(dir).files.filter((f) => f.stateId === STATE).map((f) => [f.layer, f.shadowed === true, f.shadowedBy]);
    expect(files).toEqual([
      ["base", true, "you"],
      ["project", true, "you"],
      ["you", false, undefined],
    ]);
    const tree = await service.filesTree({ project: dir });
    expect(walk(tree.roots[0]!.nodes).filter((node) => node.stateId === STATE).map((row) => [row.layer, row.shadowed === true, row.shadowedBy])).toEqual([
      ["you", false, undefined],
      ["project", true, "you"],
      ["base", true, "you"],
    ]);
    // Standing in Shared, Just you's copy stands over Shared's too, in Shared's one root.
    const shared = await service.filesTree({ project: SHARED_SESSION });
    expect(shared.roots.map((root) => root.layer)).toEqual(["base"]);
    expect(walk(shared.roots[0]!.nodes).filter((node) => node.stateId === STATE).map((row) => [row.layer, row.shadowed === true])).toEqual([
      ["you", false],
      ["base", true],
    ]);
    // …and Just you's folder is not also drawn as a folder of Shared's.
    expect(walk(shared.roots[0]!.nodes).some((node) => node.path === "personal")).toBe(false);
  });

  it("introduces every root but the project's own checkout, and stands the tree's `+` on the checkout", () => {
    const project: FileRoot = { layer: "project", project: "/p", label: "p", dir: "/p", prefix: ".jaira", exists: true, nodes: [] };
    const local: FileRoot = { layer: "projectMachine", project: "/p", label: "p on this machine", dir: "/p/.jaira/local", prefix: "", exists: true, nodes: [] };
    const mine: FileRoot = { layer: "you", label: "Just you", dir: "/home/.jaira/personal", prefix: "", exists: false, nodes: [] };
    expect(rootNeedsName(project, "/p")).toBe(false);
    expect(rootNeedsName(local, "/p")).toBe(true);
    expect(standingRoot({ roots: [local, project, mine] }, "/p")).toBe(project);
    // A layer root offers a new workflow in its own `workflows/`, as a project's does.
    expect(newItems(mine, "", () => undefined).map((item) => [item.label, item.note])).toContainEqual(["New workflow…", "workflows"]);
  });
});

describe("a row's copies into the other layers, in the tree's menu", () => {
  /** A row's menu, and the second one its `Copy elsewhere…` opens; `moves` is what a pick asked for. */
  function menusOf(layer: FileNode["layer"], hasProject: boolean): { items: MenuItem[]; second: () => { title: string; items: MenuItem[] } | null; moves: string[] } {
    let second: { title: string; items: MenuItem[] } | null = null;
    const moves: string[] = [];
    const { itemsFor } = treeMenus({
      hasProject,
      onOpen: () => undefined,
      onMove: async (request) => {
        moves.push(`${request.layer} -> ${String(request.toLayer)}`);
        return null;
      },
      onDelete: async () => null,
      onRenameFile: async () => null,
      onDeleteFile: async () => null,
      onReveal: () => undefined,
      copy: () => undefined,
      setAsk: () => undefined,
      startDraft: () => undefined,
      more: (menu) => (second = menu),
    });
    const node: FileNode = { path: "workflows/review/quick.json", name: "quick.json", kind: "workflow", mime: "application/vnd.jaira.workflow+json", layer, stateId: STATE };
    const root: FileRoot = { layer, label: layer, dir: "/x", prefix: "", exists: true, nodes: [node] };
    return { items: itemsFor(node, root), second: () => second, moves };
  }

  it("offers the first copy as it always has, then `Copy elsewhere…`: a menu titled `Copy` of every other layer, saying only where", () => {
    const shared = menusOf("base", true);
    const labels = shared.items.map((i) => i.label);
    expect(labels.slice(labels.indexOf("Override in this project"), labels.indexOf("Override in this project") + 2)).toEqual(["Override in this project", "Copy elsewhere…"]);
    expect(labels.some((label) => /^Copy (for|in this project on|on this machine)/.test(label))).toBe(false);
    shared.items.find((i) => i.label === "Copy elsewhere…")!.onSelect();
    expect(shared.second()?.title).toBe("Copy");
    // Not Shared (where it is) nor the project (the first item's): the other four, most specific first.
    expect(shared.second()?.items.map((i) => i.label)).toEqual(["for you in this project", "for just you", "in this project on this machine", "on this machine"]);
    expect(shared.second()?.items.every((i) => i.note === undefined)).toBe(true);
    shared.second()!.items[2]!.onSelect();
    expect(shared.moves).toEqual(["base -> projectMachine"]);

    // Just you's copy: first to Shared, then the project's three and this machine's — not its own.
    const mine = menusOf("you", false);
    expect(mine.items.some((i) => i.label === "Copy to shared root")).toBe(true);
    mine.items.find((i) => i.label === "Copy elsewhere…")!.onSelect();
    expect(mine.second()?.items.map((i) => [i.label, i.disabled === true])).toEqual([
      ["for you in this project", true],
      ["in this project on this machine", true],
      ["on this machine", false],
      ["in this project", true],
    ]);
  });
});

describe("automations, through the workflow channels", () => {
  it("are read and written in any layer, and the most specific state is what runs", () => {
    const line = { name: "push_main", when: "on_event('git.pushed')", to: "push_main", inputs: { event: ".event" } };
    service.writeWorkflow({ stateId: "system/events", layer: "base", text: JSON.stringify({ $ref: "$SYSTEM/workflows/system/events", transitions: [line], children: { push_main: { async: true } } }) });
    service.writeWorkflow({ stateId: "system/events/push_main", layer: "base", text: JSON.stringify(automationStateOf("push_main", [{ kind: "notify", text: "Shared's" }])) });
    service.writeWorkflow({ stateId: "system/events/push_main", layer: "you", project: dir, text: JSON.stringify(automationStateOf("push_main", [{ kind: "notify", text: "mine" }])) });
    const paths = jairaPaths(dir, testHome());
    const state = loadWorkflowBundle(readWorkflowFiles(paths.workflowsDir), "system/events", workflowLoadOptions(paths)).states["system/events/push_main"];
    expect(JSON.stringify(state?.operation)).toContain("mine");
  });
});

describe("a newer layer made after the project opened", () => {
  it("is watched from the moment it appears, and what lands in it is read", async () => {
    // A service that watches, as the app's does.
    const pushes: PushMessage[] = [];
    const watching = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchDebounceMs: 20 });
    const other = mkdtempSync(join(tmpdir(), "jaira-layer-watch-"));
    initProject(other, testHome());
    try {
      await watching.open(other);
      const personal = join(testHome(), "personal");
      rmSync(personal, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 200));
      pushes.length = 0;
      const invalidated = (): boolean => pushes.some((m) => m.type === "store:invalidate" && (m as { scope?: string }).scope === "workflows");
      // Just you's root appears — made by hand, or by the settings sync bringing a file from a paired machine.
      mkdirSync(join(personal, "workflows", "review"), { recursive: true });
      writeFileSync(join(personal, "workflows", "review", "late.json"), says("late"), "utf8");
      await eventually(invalidated, "the workflows to be invalidated once Just you's root appeared");
      // …and a later change inside it is seen too.
      pushes.length = 0;
      writeFileSync(join(personal, "workflows", "review", "later.json"), says("later"), "utf8");
      await eventually(invalidated, "the workflows to be invalidated for a file written inside it");
      // What arrived is read: listed by the browser and loaded by a run.
      expect(watching.browseWorkflows(other).workflows.map((w) => w.rootId)).toEqual(expect.arrayContaining(["review/late", "review/later"]));
    } finally {
      await watching.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});

