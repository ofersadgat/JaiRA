/**
 * What JaiRA ships is the bottom of the search path, not files it writes (decision 0006, steps 2 and 4).
 *
 * Three claims, each with its own block:
 *
 *  1. The Chat view's states and the self-test resolve with NOTHING installed — an empty project over
 *     an empty shared root, and an empty shared root with no project at all — and running one writes
 *     no state file anywhere.
 *  2. The state editor does not edit what ships: it says "built in · read-only", offers the two
 *     overrides and no Save; a person's file of a shipped id says "overrides built in".
 *  3. The Files tree ends with a read-only "Built in" root, marks which rows are overridden and which
 *     override, and its menus offer reading and overriding only.
 *
 * Unlike `builtInLayer.test.ts`, which registers a fixture layer, this file runs against the REAL
 * `packages/shared/builtin/` — what it asserts is about the files that ship. The shared root is a
 * temp directory (`testHome`), never the machine's `~/.jaira`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { jairaBuiltInPaths, SHARED_SESSION, type FileNode, type FileRoot, type PushMessage, type WorkflowSource } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { layerBarOf } from "../src/renderer/builtIn";
import { CHAT_AGENT, CHAT_STATES, titleOf } from "../src/renderer/chatWorkflow";
import { debugFileStatus } from "../src/renderer/debugPane";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestScript } from "../src/renderer/debugWorkflow";
import { builtInItems } from "../src/renderer/files";
import { runTargetOf } from "../src/renderer/runForm";
import { WorkflowEditor } from "../src/renderer/stateEditor";

let dir: string;
let service: AppService;
let pushes: PushMessage[];
let extraDirs: string[] = [];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-shipped-states-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  for (const one of [dir, ...extraDirs]) rmSync(one, { recursive: true, force: true });
  extraDirs = [];
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every state file under a `workflows/` directory — what "nothing was installed" is asserted against. */
function stateFiles(workflowsDir: string, rel = ""): string[] {
  if (!existsSync(join(workflowsDir, rel))) return [];
  return readdirSync(join(workflowsDir, rel), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? stateFiles(workflowsDir, join(rel, entry.name)) : [join(rel, entry.name).replace(/\\/g, "/")],
  );
}

/** The shipped file of one state, as text. */
const shippedText = (stateId: string): string =>
  readFileSync(join(jairaBuiltInPaths().workflowsDir, `${stateId}.json`), "utf8");

/** Put a copy of a state into the test's shared root. */
function installInShared(stateId: string, text: string): string {
  const file = join(testHome(), "workflows", `${stateId}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

describe("starting with nothing installed", () => {
  it("ships every state the Chat view and the self-test name", () => {
    for (const stateId of [...CHAT_STATES, ...SELF_TEST_STATES]) {
      expect(service.readWorkflow({ stateId, layer: "system" }).exists).toBe(true);
    }
  });

  it("starts a conversation in an empty project over an empty shared root, and writes no state file", async () => {
    const message = "What is in this repository?";
    const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_AGENT, inputs: { message } });
    await service.startTask({ taskId, fake: [{ output: "an answer" }] });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");

    expect(service.taskDetail(taskId).status).toBe("completed");
    const thread = service.chatThread({ taskId });
    expect(thread?.session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // The install step is gone, not moved: neither root gained a state file by having a conversation.
    expect(stateFiles(join(testHome(), "workflows"))).toEqual([]);
    expect(stateFiles(join(dir, ".jaira", "workflows"))).toEqual([]);
  });

  it("starts one with NO project open, in a shared root that does not exist yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-shipped-bare-"));
    const base = join(home, "never-created");
    const bare = new AppService({ publish: () => undefined, baseDir: base, watchWorkflows: false });
    try {
      const { taskId } = bare.createTask({
        title: "hello",
        workflow: CHAT_AGENT,
        inputs: { message: "hello" },
        project: SHARED_SESSION,
      });
      await bare.startTask({ taskId, project: SHARED_SESSION, fake: [{ output: "hi" }] });
      await until(() => bare.listTasks(SHARED_SESSION)[0]?.status === "completed", "the shared conversation to finish");
      expect(stateFiles(join(base, "workflows"))).toEqual([]);
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs the self-test from what ships, with the scripted replies matching the shipped prompts", async () => {
    const { taskId } = service.createTask({ title: "Self-test", workflow: SELF_TEST_ROOT });
    await service.startTask({ taskId, fake: selfTestScript() });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the self-test to finish");
    const detail = service.taskDetail(taskId);
    expect(detail.runs[detail.runs.length - 1]?.outputs).toMatchObject({ greeting: "Hello, world!", passed: true });
  });

  it("lets a copy in the shared root win, as an override of any built-in does", () => {
    installInShared(CHAT_AGENT, JSON.stringify({ label: "Mine" }));
    const entry = service.browseWorkflows().files.find((f) => f.stateId === CHAT_AGENT && f.shadowed !== true);
    expect(entry?.layer).toBe("base");
    expect(entry?.label).toBe("Mine");
  });

  it("runs a shipped state where the person is standing: the checkout, or the shared root with none open", () => {
    expect(runTargetOf("system", "/w/atlas")).toMatchObject({ open: true });
    expect(runTargetOf("system", "/w/atlas").project).toBeUndefined();
    expect(runTargetOf("system", null)).toMatchObject({ project: SHARED_SESSION, open: true });
  });
});

describe("how a file stands against what ships", () => {
  it("says which layers hold a shipped state, in search order", () => {
    expect(service.readWorkflow({ stateId: CHAT_AGENT, layer: "system" }).builtIn).toEqual({ layers: ["system"] });
    installInShared(CHAT_AGENT, shippedText(CHAT_AGENT));
    const project = join(dir, ".jaira", "workflows", `${CHAT_AGENT}.json`);
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, JSON.stringify({ label: "Here" }), "utf8");

    expect(service.readWorkflow({ stateId: CHAT_AGENT, layer: "system" }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
    expect(service.readFile({ layer: "base", path: `workflows/${CHAT_AGENT}.json` }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
    expect(service.readFile({ layer: "project", path: `.jaira/workflows/${CHAT_AGENT}.json` }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
  });

  it("says nothing about a state JaiRA does not ship", () => {
    installInShared("mine/own", "{}");
    expect(service.readWorkflow({ stateId: "mine/own", layer: "base" }).builtIn).toBeUndefined();
  });
});

describe("the state editor on the three kinds of file", () => {
  const source = (patch: Partial<WorkflowSource>): WorkflowSource => ({
    stateId: CHAT_AGENT,
    layer: "system",
    file: "$SYSTEM/workflows/chat/agent.json",
    text: shippedText(CHAT_AGENT),
    exists: true,
    ...patch,
  });
  const editor = (src: WorkflowSource, saved: string[] = []): string =>
    renderToStaticMarkup(
      createElement(WorkflowEditor, {
        source: src,
        tree: null,
        executors: [],
        busy: false,
        onSave: (stateId: string) => saved.push(stateId),
        layerActions: { hasProject: true, onOverride: () => undefined },
      } as unknown as Parameters<typeof WorkflowEditor>[0]),
    );

  it("draws a built-in as read-only, with the two overrides and no Save", () => {
    const html = editor(source({ builtIn: { layers: ["system"] } }));
    expect(html).toContain("built in · read-only");
    expect(html).toContain("Override for all projects");
    expect(html).toContain("Override here");
    // The form is the inert reading, and the bar that holds Save and Revert is not drawn at all.
    expect(html).toContain("<fieldset");
    expect(html).not.toContain("edit-actions");
    expect(html).not.toMatch(/>\s*Save\s*</);
  });

  it("still edits a project file, and says nothing about layers on one that overrides nothing", () => {
    const html = editor(source({ layer: "project", file: "/w/atlas/.jaira/workflows/mine.json", stateId: "mine" }));
    expect(html).not.toContain("built in");
    expect(html).not.toContain("<fieldset");
    expect(html).toMatch(/>\s*Save\s*</);
  });

  it("draws a file that shadows a built-in as an override, with the comparison one click away", () => {
    const html = editor(source({ layer: "project", builtIn: { layers: ["project", "system"] } }));
    expect(html).toContain("overrides built in");
    expect(html).toContain("Compare with what ships");
  });

  it("decides the bar from the file alone", () => {
    const actions = (model: ReturnType<typeof layerBarOf>): string[] =>
      (model?.actions ?? []).map((a) => `${a.id}${a.disabled === true ? " (off)" : ""}`);

    expect(actions(layerBarOf({ layer: "system", builtIn: { layers: ["system"] } }, true))).toEqual([
      "override-base",
      "override-project",
    ]);
    // A layer that already has its copy is offered disabled, and so is the project with none open.
    expect(actions(layerBarOf({ layer: "system", builtIn: { layers: ["base", "system"] } }, false))).toEqual([
      "override-base (off)",
      "override-project (off)",
    ]);
    // An override, shared or in a project, offers the comparison and nothing else.
    expect(actions(layerBarOf({ layer: "base", builtIn: { layers: ["base", "system"] } }, true))).toEqual(["compare"]);
    expect(actions(layerBarOf({ layer: "project", builtIn: { layers: ["project", "system"] } }, true))).toEqual(["compare"]);
    // What the bar always said about a shared file, and nothing at all about an ordinary project one.
    expect(layerBarOf({ layer: "base" }, true)?.chip.text).toBe("shared copy");
    expect(layerBarOf({ layer: "project" }, true)).toBeNull();
  });

  it("refuses the save the editor no longer offers", () => {
    expect(() => service.writeWorkflow({ stateId: CHAT_AGENT, layer: "system", text: "{}" })).toThrow(/read-only/);
    expect(shippedText(CHAT_AGENT)).toContain("Working conversation");
  });
});

describe("the tree's third root", () => {
  const find = (nodes: FileNode[], stateId: string): FileNode | undefined => {
    for (const node of nodes) {
      if (node.stateId === stateId) return node;
      const hit = node.children ? find(node.children, stateId) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };

  it("closes a project's tree with a read-only Built in root", () => {
    const tree = service.filesTree({ project: dir });
    expect(tree.roots.map((root) => root.layer)).toEqual(["project", "system"]);
    const shipped = tree.roots[1]!;
    expect(shipped.label).toBe("Built in");
    expect(shipped.dir).toBe(jairaBuiltInPaths().dir);
    expect(shipped.project).toBeUndefined();
    const node = find(shipped.nodes, CHAT_AGENT);
    expect(node?.layer).toBe("system");
    expect(node?.shadowed).toBeUndefined();
  });

  it("closes the shared root's tree, and an empty window's, with it too", () => {
    expect(service.filesTree({ project: SHARED_SESSION }).roots.map((root) => root.layer)).toEqual(["base", "system"]);
  });

  it("lists it ONCE beside several projects", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-shipped-other-"));
    // Removed in `afterEach`, once the service has let go of its database.
    extraDirs.push(other);
    initProject(other, testHome());
    await service.open(other);
    expect(service.filesTree().roots.map((root) => root.layer)).toEqual(["project", "project", "system"]);
  });

  it("marks which layer supplied a state: the shipped row overridden, the person's row overriding", () => {
    const file = join(dir, ".jaira", "workflows", `${CHAT_AGENT}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ label: "Here" }), "utf8");

    const tree = service.filesTree({ project: dir });
    expect(find(tree.roots[0]!.nodes, CHAT_AGENT)).toMatchObject({ layer: "project", overridesBuiltIn: true });
    expect(find(tree.roots[1]!.nodes, CHAT_AGENT)).toMatchObject({ layer: "system", shadowed: true });
    // A shipped state nobody overrode is marked as neither.
    const untouched = find(tree.roots[1]!.nodes, "chat/assistant")!;
    expect(untouched.shadowed).toBeUndefined();
    expect(untouched.overridesBuiltIn).toBeUndefined();

    // The same from the shared root's side.
    installInShared("chat/assistant", JSON.stringify({ label: "Shared" }));
    const shared = service.filesTree({ project: SHARED_SESSION });
    expect(find(shared.roots[0]!.nodes, "chat/assistant")).toMatchObject({ layer: "base", overridesBuiltIn: true });
    expect(find(shared.roots[1]!.nodes, "chat/assistant")).toMatchObject({ shadowed: true });
  });

  it("offers reading and overriding on that root, and nothing that writes to it", () => {
    const root: FileRoot = { layer: "system", label: "Built in", dir: "/app/builtin", prefix: "", exists: true, nodes: [] };
    const state: FileNode = {
      path: "workflows/chat/agent.json",
      name: "agent.json",
      kind: "workflow",
      mime: "application/vnd.jaira.workflow+json",
      layer: "system",
      stateId: CHAT_AGENT,
    };
    const calls: string[] = [];
    const act = {
      hasProject: true,
      onOpen: (id: string, layer: string) => calls.push(`open ${id} ${layer}`),
      onOverride: (id: string, to: string) => calls.push(`override ${id} -> ${to}`),
      onCopy: (text: string) => calls.push(`copy ${text}`),
      onReveal: (file: string) => calls.push(`reveal ${file}`),
    };
    const items = builtInItems(state, root, act);
    expect(items.map((i) => i.label)).toEqual([
      "Open",
      "Override for all projects",
      "Override here",
      "Copy state id",
      "Copy path",
      "Reveal in file explorer",
    ]);
    for (const item of items.slice(0, 3)) item.onSelect();
    expect(calls).toEqual([
      `open ${CHAT_AGENT} system`,
      `override ${CHAT_AGENT} -> base`,
      `override ${CHAT_AGENT} -> project`,
    ]);
    // With nothing open there is no "here" to override in.
    expect(builtInItems(state, root, { ...act, hasProject: false }).find((i) => i.label === "Override here")?.disabled).toBe(true);
    // A folder or a README has nothing to override: it can be looked at, and that is all.
    const folder: FileNode = { path: "workflows", name: "workflows", kind: "directory", mime: "inode/directory", layer: "system" };
    expect(builtInItems(folder, root, act).map((i) => i.label)).toEqual(["Copy path", "Reveal in file explorer"]);
  });

  it("copies a shipped state up a layer, which is the override, and then reads it as one", () => {
    const moved = service.moveWorkflow({ stateId: CHAT_AGENT, layer: "system", to: CHAT_AGENT, toLayer: "project", copy: true });
    expect(moved).toMatchObject({ applied: true, layer: "project" });
    const copy = service.readWorkflow({ stateId: CHAT_AGENT, layer: "project" });
    expect(copy.text).toBe(shippedText(CHAT_AGENT));
    expect(copy.builtIn?.layers).toEqual(["project", "system"]);
    // A second override of the same layer is refused rather than clobbering the first.
    expect(() =>
      service.moveWorkflow({ stateId: CHAT_AGENT, layer: "system", to: CHAT_AGENT, toLayer: "project", copy: true }),
    ).toThrow(/already exists/);
  });
});

describe("the Debug pane's rows", () => {
  it("names the layer the copy that loads is in", () => {
    expect(debugFileStatus({ layer: "system" })).toEqual({ word: "built in", tone: "success" });
    expect(debugFileStatus({ layer: "base" })).toEqual({ word: "overridden", tone: "unknown" });
    expect(debugFileStatus({ layer: null })).toEqual({ word: "missing", tone: "error" });
  });
});
