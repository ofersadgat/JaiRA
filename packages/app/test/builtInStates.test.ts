/**
 * What JaiRA ships is the bottom of the search path, not files it writes (decision 0006, steps 2 and 4).
 *
 * Three claims, each with its own block:
 *
 *  1. The Chat view's states and the self-test resolve with NOTHING installed — an empty project over
 *     an empty shared root, and an empty shared root with no project at all — and running one writes
 *     no state file anywhere.
 *  2. What ships is never WRITTEN: the state editor offers no Save on it, and — copy-on-edit, the
 *     panel rulings of 2026-09-24 — its first change is a copy into Shared; with Shared already
 *     holding its copy it says "built in · read-only". Every shipped file, state or not, reports
 *     which layers hold it, which is what copy-on-edit reads; a person's file of a shipped id says
 *     "overrides built in".
 *  3. The Files tree ends with a "Built in" root, marks which rows are overridden and which override,
 *     and its menus offer reading and overriding.
 *
 * Unlike `builtInLayer.test.ts`, which registers a fixture layer, this file runs against the REAL
 * `packages/shared/builtin/` — what it asserts is about the files that ship. The shared root is a
 * temp directory (`testHome`), never the machine's `~/.jaira`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, resetUserModules, userModules } from "@jaira/persistence";
import { jairaBuiltInPaths, SHARED_SESSION, type FileNode, type FileRoot, type PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { layerBarOf, overrideTarget } from "../src/renderer/builtInModel";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

/** A state JaiRA ships as a JSON file — what overriding one is shown with. */
const SHIPPED_STATE = "debug/hello_world/say";
import { debugFileStatus } from "../src/renderer/debugModel";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestScript } from "../src/renderer/debugWorkflow";
import { builtInItems } from "../src/renderer/filesModel";
import type { MenuItem } from "../src/renderer/menuTypes";
import { runTargetOf } from "../src/renderer/runForm";
import { savesOf } from "../src/renderer/stateEditorModel";

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
const shippedText = (stateId: string): string => {
  const json = join(jairaBuiltInPaths().workflowsDir, `${stateId}.json`);
  // The conversation the Chat view starts is a workflow SCRIPT (decision 0029 §2).
  return readFileSync(existsSync(json) ? json : join(jairaBuiltInPaths().workflowsDir, `${stateId}.ts`), "utf8");
};

/** Whether a program conversation is waiting at `input()` for the person's next message. */
function waitingForMessage(on: AppService, taskId: string, project?: string): boolean {
  return (on as unknown as { session(p?: string): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
    .session(project)
    .hub.list()
    .some((r) => r.component === "input" && r.taskId === taskId);
}

/** Put a copy of a state into the test's shared root. */
function installInShared(stateId: string, text: string): string {
  const file = join(testHome(), "workflows", `${stateId}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

describe("starting with nothing installed", () => {
  it("ships every state the Chat view and the self-test name", () => {
    for (const stateId of [CHAT_SESSION, ...SELF_TEST_STATES]) {
      expect(service.readWorkflow({ stateId, layer: "system" }).exists).toBe(true);
    }
  });

  it("offers the shipped conversation — a workflow script — as one, by the text it opens with", () => {
    const session = service.browseWorkflows().workflows.find((w) => w.rootId === CHAT_SESSION);
    expect(session).toMatchObject({ layer: "system", conversationInput: "message" });
    expect(session?.loadError).toBeUndefined();
  });

  it("starts a conversation in an empty project over an empty shared root, and writes no state file", async () => {
    const message = "What is in this repository?";
    const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, inputs: { message } });
    await service.startTask({ taskId, fake: [{ output: "an answer" }] });
    // A program (decision 0029 §2): its first reply lands, and it waits at `input()` for the next message.
    await until(() => service.sessionHistory({ taskId }).length >= 1 && waitingForMessage(service, taskId), "the opening reply to land");

    // Waiting for the next message, it reads as its reply ended (decision 0029 §2), its run live all the same.
    expect(service.taskDetail(taskId).status).toBe("completed");
    const thread = service.chatThread({ taskId });
    expect(thread?.session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // The install step is gone, not moved: neither root gained a state file by having a conversation.
    expect(stateFiles(join(testHome(), "workflows"))).toEqual([]);
    expect(stateFiles(join(dir, ".jaira", "workflows"))).toEqual([]);
  });

  it("offers it in a process that never opened a project — a window on an empty address", async () => {
    // The setup above opened a project, which built the module pair; a window that opened none never
    // had one, and listed no workflow script: a new chat said "'session' cannot be a conversation: it
    // does not take one text input" (2026-11-20). Needing the script now compiles it.
    resetUserModules();
    const home = mkdtempSync(join(tmpdir(), "jaira-shipped-empty-"));
    const bare = new AppService({ publish: () => undefined, baseDir: home, watchWorkflows: false });
    try {
      const session = bare.browseWorkflows(SHARED_SESSION).workflows.find((w) => w.rootId === CHAT_SESSION);
      expect(session).toMatchObject({ layer: "system", conversationInput: "message" });
      expect(session?.loadError).toBeUndefined();
      expect(userModules()).toBeUndefined();
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts one with NO project open, in a shared root that does not exist yet", async () => {
    // In a process that never opened one: starting it compiles it.
    resetUserModules();
    const home = mkdtempSync(join(tmpdir(), "jaira-shipped-bare-"));
    const base = join(home, "never-created");
    const bare = new AppService({ publish: () => undefined, baseDir: base, watchWorkflows: false });
    try {
      const { taskId } = bare.createTask({
        title: "hello",
        workflow: CHAT_SESSION,
        inputs: { message: "hello" },
        project: SHARED_SESSION,
      });
      await bare.startTask({ taskId, project: SHARED_SESSION, fake: [{ output: "hi" }] });
      await until(() => bare.sessionHistory({ taskId, project: SHARED_SESSION }).length >= 1, "the shared conversation's first reply");
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
    installInShared(CHAT_SESSION, JSON.stringify({ label: "Mine" }));
    const entry = service.browseWorkflows().files.find((f) => f.stateId === CHAT_SESSION && f.shadowed !== true);
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
    expect(service.readWorkflow({ stateId: SHIPPED_STATE, layer: "system" }).builtIn).toEqual({ layers: ["system"] });
    installInShared(SHIPPED_STATE, shippedText(SHIPPED_STATE));
    const project = join(dir, ".jaira", "workflows", `${SHIPPED_STATE}.json`);
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, JSON.stringify({ label: "Here" }), "utf8");

    expect(service.readWorkflow({ stateId: SHIPPED_STATE, layer: "system" }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
    expect(service.readFile({ layer: "base", path: `workflows/${SHIPPED_STATE}.json` }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
    expect(service.readFile({ layer: "project", path: `.jaira/workflows/${SHIPPED_STATE}.json` }).builtIn).toEqual({
      layers: ["project", "base", "system"],
    });
  });

  it("says nothing about a state JaiRA does not ship", () => {
    installInShared("mine/own", "{}");
    expect(service.readWorkflow({ stateId: "mine/own", layer: "base" }).builtIn).toBeUndefined();
  });
});

describe("the state editor on the three kinds of file", () => {
  // What the editor SAYS about each kind of file is `layerBarOf`'s, and whether it offers Save is
  // `savesOf`'s; both are held here. Whether a built-in opens as a live form or as a reading —
  // copy-on-edit, which is off once Shared has its own copy — is decided inside `useWorkflowEditor`,
  // which is a hook, so these cases hand the bar that decision rather than reach it.

  it("with copy-on-edit, says of a built-in that its first change copies it to Shared", () => {
    const bar = layerBarOf({ layer: "system", builtIn: { layers: ["system"] } }, true, true);
    expect(bar?.chip.text).toBe("built in · an edit copies it to Shared");
    expect(bar?.chip.text).not.toContain("read-only");
  });

  it("stays read-only when Shared already has a copy — that copy is the one that runs", () => {
    const bar = layerBarOf({ layer: "system", builtIn: { layers: ["system", "base"] } }, true);
    expect(bar?.chip.text).toBe("built in · read-only");
    expect(bar?.chip.title).toBe("Shared already has a copy of this state, and it is the one that runs — edit that.");
  });

  it("says a built-in is read-only, with the two overrides and no Save", () => {
    const bar = layerBarOf({ layer: "system", builtIn: { layers: ["system"] } }, true);
    expect(bar?.chip.text).toBe("built in · read-only");
    // The two it has always offered as links, then the settings' four newer layers behind `Elsewhere…`
    // (decision 0023, amended 2026-11-18) — the tree's menu's six.
    expect(bar?.actions.filter((a) => a.more !== true).map((a) => a.label)).toEqual(["Edit a copy in Shared", "Override here"]);
    expect(bar?.actions.filter((a) => a.more === true).map((a) => a.label)).toEqual([
      "Edit a copy for you in this project",
      "Edit a copy for just you",
      "Edit a copy in this project on this machine",
      "Edit a copy on this machine",
    ]);
    // The bar that holds Save and Revert is not drawn for what ships, whether the form over it is a
    // reading or, with copy-on-edit, live.
    expect(savesOf(true, true)).toBe(false);
    expect(savesOf(false, true)).toBe(false);
  });

  it("says a file that shadows a built-in overrides it, with the comparison one click away", () => {
    const bar = layerBarOf({ layer: "project", builtIn: { layers: ["project", "system"] } }, true);
    expect(bar?.chip.text).toBe("overrides built in");
    expect(bar?.actions.map((a) => a.label)).toEqual(["Compare with what ships"]);
  });

  it("decides the bar from the file alone", () => {
    const actions = (model: ReturnType<typeof layerBarOf>): string[] =>
      (model?.actions ?? []).map((a) => `${a.id}${a.disabled === true ? " (off)" : ""}`);

    expect(actions(layerBarOf({ layer: "system", builtIn: { layers: ["system"] } }, true))).toEqual([
      "override-base",
      "override-project",
      "override-projectYou",
      "override-you",
      "override-projectMachine",
      "override-machine",
    ]);
    // A layer that already has its copy is offered disabled, and so is a project's with none open.
    expect(actions(layerBarOf({ layer: "system", builtIn: { layers: ["you", "base", "system"] } }, false))).toEqual([
      "override-base (off)",
      "override-project (off)",
      "override-projectYou (off)",
      "override-you (off)",
      "override-projectMachine (off)",
      "override-machine",
    ]);
    expect(overrideTarget("override-you")).toBe("you");
    expect(overrideTarget("compare")).toBeNull();
    // An override, shared or in a project, offers the comparison and nothing else.
    expect(actions(layerBarOf({ layer: "base", builtIn: { layers: ["base", "system"] } }, true))).toEqual(["compare"]);
    expect(actions(layerBarOf({ layer: "project", builtIn: { layers: ["project", "system"] } }, true))).toEqual(["compare"]);
    // What the bar always said about a shared file, and nothing at all about an ordinary project one.
    expect(layerBarOf({ layer: "base" }, true)?.chip.text).toBe("shared copy");
    expect(layerBarOf({ layer: "project" }, true)).toBeNull();
  });

  it("says which layers hold ANY shipped file, not only a state — what copy-on-edit reads", () => {
    expect(service.readFile({ layer: "system", path: "README.md" }).builtIn).toEqual({ layers: ["system"] });
    service.writeFile({ layer: "base", path: "README.md", text: "mine" });
    expect(service.readFile({ layer: "system", path: "README.md" }).builtIn).toEqual({ layers: ["base", "system"] });
    expect(service.readFile({ layer: "base", path: "README.md" }).builtIn).toEqual({ layers: ["base", "system"] });
    // A file JaiRA does not ship stands against nothing.
    service.writeFile({ layer: "base", path: "notes/mine.md", text: "x" });
    expect(service.readFile({ layer: "base", path: "notes/mine.md" }).builtIn).toBeUndefined();
  });

  it("refuses the save the editor no longer offers", () => {
    expect(() => service.writeWorkflow({ stateId: CHAT_SESSION, layer: "system", text: "{}" })).toThrow(/read-only/);
    expect(shippedText(CHAT_SESSION)).toContain('name: "Session"');
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

  it("closes a project's tree with a read-only Built in root", async () => {
    const tree = (await service.filesTree({ project: dir }));
    // The project's checkout and the settings' newer layers over it (decision 0023, amended 2026-11-18), then what ships.
    expect(tree.roots.map((root) => root.layer)).toEqual(["project", "projectMachine", "projectYou", "you", "machine", "system"]);
    const shipped = tree.roots.at(-1)!;
    expect(shipped.label).toBe("Built in");
    expect(shipped.dir).toBe(jairaBuiltInPaths().dir);
    expect(shipped.project).toBeUndefined();
    const node = find(shipped.nodes, SHIPPED_STATE);
    expect(node?.layer).toBe("system");
    expect(node?.shadowed).toBeUndefined();
  });

  it("marks a workflow SCRIPT as a state — the shipped conversation, and a project's copy overriding it", async () => {
    const shipped = (await service.filesTree({ project: dir })).roots.at(-1)!;
    expect(find(shipped.nodes, CHAT_SESSION)).toMatchObject({ kind: "workflow", layer: "system", name: `${CHAT_SESSION}.ts` });
    service.moveWorkflow({ stateId: CHAT_SESSION, layer: "system", to: CHAT_SESSION, toLayer: "project", copy: true });
    // A helper beside it, which declares no `meta`, is code and not a state.
    writeFileSync(join(dir, ".jaira", "workflows", "helper.ts"), "export function twice(n: number) { return n * 2; }\n", "utf8");
    const tree = await service.filesTree({ project: dir });
    expect(find(tree.roots[0]!.nodes, CHAT_SESSION)).toMatchObject({ kind: "workflow", layer: "project", overridesBuiltIn: true });
    expect(find(tree.roots.at(-1)!.nodes, CHAT_SESSION)).toMatchObject({ shadowed: true, shadowedBy: "project" });
    const helper = tree.roots[0]!.nodes.flatMap(function all(n: FileNode): FileNode[] { return [n, ...(n.children ?? []).flatMap(all)]; }).find((n) => n.name === "helper.ts");
    expect(helper?.kind).not.toBe("workflow");
    expect(helper?.stateId).toBeUndefined();
  });

  it("marks a shipped FILE a person has a copy of as overridden, as it marks a state", async () => {
    const readme = (roots: FileRoot[]): FileNode | undefined => roots.find((root) => root.layer === "system")?.nodes.find((node) => node.path === "README.md");
    expect(readme((await service.filesTree({ project: dir })).roots)?.shadowed).toBeUndefined();
    service.writeFile({ layer: "base", path: "README.md", text: "mine" });
    expect(readme((await service.filesTree({ project: dir })).roots)?.shadowed).toBe(true);
    expect(readme((await service.filesTree({ project: SHARED_SESSION })).roots)?.shadowed).toBe(true);
  });

  it("closes the shared root's tree, and an empty window's, with it too", async () => {
    expect((await service.filesTree({ project: SHARED_SESSION })).roots.map((root) => root.layer)).toEqual(["base", "you", "machine", "system"]);
  });

  it("lists it ONCE beside several projects", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-shipped-other-"));
    // Removed in `afterEach`, once the service has let go of its database.
    extraDirs.push(other);
    initProject(other, testHome());
    await service.open(other);
    // Each project with its own two layers; Just you and this machine once, as what ships is.
    expect((await service.filesTree()).roots.map((root) => root.layer)).toEqual(["project", "projectMachine", "projectYou", "project", "projectMachine", "projectYou", "you", "machine", "system"]);
  });

  it("marks which layer supplied a state: the shipped row overridden, the person's row overriding", async () => {
    const file = join(dir, ".jaira", "workflows", `${SHIPPED_STATE}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ label: "Here" }), "utf8");

    const tree = (await service.filesTree({ project: dir }));
    const shippedRoot = tree.roots.find((root) => root.layer === "system")!;
    expect(find(tree.roots[0]!.nodes, SHIPPED_STATE)).toMatchObject({ layer: "project", overridesBuiltIn: true });
    expect(find(shippedRoot.nodes, SHIPPED_STATE)).toMatchObject({ layer: "system", shadowed: true, shadowedBy: "project" });
    // A shipped state nobody overrode is marked as neither.
    const untouched = find(shippedRoot.nodes, SELF_TEST_ROOT)!;
    expect(untouched.shadowed).toBeUndefined();
    expect(untouched.overridesBuiltIn).toBeUndefined();

    // The same from the shared root's side.
    installInShared(SELF_TEST_ROOT, JSON.stringify({ label: "Shared" }));
    const shared = (await service.filesTree({ project: SHARED_SESSION }));
    expect(find(shared.roots[0]!.nodes, SELF_TEST_ROOT)).toMatchObject({ layer: "base", overridesBuiltIn: true });
    expect(find(shared.roots.find((root) => root.layer === "system")!.nodes, SELF_TEST_ROOT)).toMatchObject({ shadowed: true });
  });

  it("offers reading and overriding on that root, and nothing that writes to it", () => {
    const root: FileRoot = { layer: "system", label: "Built in", dir: "/app/builtin", prefix: "", exists: true, nodes: [] };
    const state: FileNode = {
      path: "workflows/chat/session.json",
      name: "session.json",
      kind: "workflow",
      mime: "application/vnd.jaira.workflow+json",
      layer: "system",
      stateId: CHAT_SESSION,
    };
    const calls: string[] = [];
    let second: { title: string; items: MenuItem[] } | null = null;
    const act = {
      hasProject: true,
      onOpen: (id: string, layer: string) => calls.push(`open ${id} ${layer}`),
      onOverride: (id: string, to: string) => calls.push(`override ${id} -> ${to}`),
      onCopy: (text: string) => calls.push(`copy ${text}`),
      onReveal: (file: string) => calls.push(`reveal ${file}`),
      more: (menu: { title: string; items: MenuItem[] }) => (second = menu),
    };
    const items = builtInItems(state, root, act);
    expect(items.map((i) => i.label)).toEqual([
      "Open",
      "Edit a copy in Shared",
      "Override here",
      // The settings' other layers (decision 0023, amended 2026-11-18), after the two it has always
      // offered — behind one item, as the editor's bar has them behind `Elsewhere…`.
      "Edit a copy elsewhere…",
      "Copy state id",
      "Copy path",
      "Reveal in file explorer",
    ]);
    for (const item of items.slice(0, 3)) item.onSelect();
    expect(calls).toEqual([
      `open ${CHAT_SESSION} system`,
      `override ${CHAT_SESSION} -> base`,
      `override ${CHAT_SESSION} -> project`,
    ]);
    // A menu of their own, titled with the verb, each saying only where — in the editor's words, short
    // enough to read whole at a menu's width, and no folder beside them.
    items.find((i) => i.label === "Edit a copy elsewhere…")!.onSelect();
    const opened = second as { title: string; items: MenuItem[] } | null;
    expect(opened?.title).toBe("Edit a copy");
    expect(opened?.items.map((i) => i.label)).toEqual(["for you in this project", "for just you", "in this project on this machine", "on this machine"]);
    expect(opened?.items.every((i) => i.note === undefined && i.disabled !== true)).toBe(true);
    opened!.items[1]!.onSelect();
    expect(calls.at(-1)).toBe(`override ${CHAT_SESSION} -> you`);
    // With nothing open there is no "here" to override in, nor a project's layer to copy into.
    const closed = builtInItems(state, root, { ...act, hasProject: false });
    expect(closed.find((i) => i.label === "Override here")?.disabled).toBe(true);
    closed.find((i) => i.label === "Edit a copy elsewhere…")!.onSelect();
    expect((second as { items: MenuItem[] } | null)?.items.map((i) => i.disabled === true)).toEqual([true, false, true, false]);
    // A folder or a README has nothing to override: it can be looked at, and that is all.
    const folder: FileNode = { path: "workflows", name: "workflows", kind: "directory", mime: "inode/directory", layer: "system" };
    expect(builtInItems(folder, root, act).map((i) => i.label)).toEqual(["Copy path", "Reveal in file explorer"]);
  });

  it("copies a shipped state up a layer, which is the override, and then reads it as one", () => {
    const moved = service.moveWorkflow({ stateId: CHAT_SESSION, layer: "system", to: CHAT_SESSION, toLayer: "project", copy: true });
    expect(moved).toMatchObject({ applied: true, layer: "project" });
    const copy = service.readWorkflow({ stateId: CHAT_SESSION, layer: "project" });
    expect(copy.text).toBe(shippedText(CHAT_SESSION));
    // The conversation is a script, and its copy is one: the file the comment in it says to edit.
    expect(copy.file.endsWith(`${CHAT_SESSION}.ts`)).toBe(true);
    expect(copy.builtIn?.layers).toEqual(["project", "system"]);
    // A second override of the same layer is refused rather than clobbering the first.
    expect(() =>
      service.moveWorkflow({ stateId: CHAT_SESSION, layer: "system", to: CHAT_SESSION, toLayer: "project", copy: true }),
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
