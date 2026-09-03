/**
 * The four surfaces the new shell asks for, driven headlessly (no Electron).
 *
 * Each is wired to a channel the renderer calls on every selection change, so a break here is a
 * blank panel rather than a crash — which is exactly the kind of failure a typecheck cannot see.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { happyRules, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { SHARED_SESSION, type PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-shell-"));
  const paths = initProject(dir, testHome());
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the Files view's surfaces", () => {
  it("lists the project's own root, with the workflow files carrying their state ids", () => {
    const tree = service.filesTree();

    // ONE root: the project's own folder. `~/.jaira` is a layer this project resolves against and
    // is browsed by standing in it, not by appearing inside every checkout.
    expect(tree.roots.map((r) => r.layer)).toEqual(["project"]);

    // The tree nests the way the filesystem does — and the filesystem puts the layer inside the
    // checkout, so `.jaira/workflows/feature/plan.json` is three levels down rather than a flat id
    // list. That is what makes it navigable rather than just enumerable.
    const layer = tree.roots[0]!.nodes.find((n) => n.name === ".jaira");
    const workflows = layer?.children?.find((n) => n.name === "workflows");
    expect(workflows?.kind).toBe("directory");
    const feature = workflows?.children?.find((n) => n.name === "feature");
    expect(feature?.children?.find((n) => n.name === "plan.json")?.stateId).toBe("feature/plan");
  });

  it("gives a composite state a board and a leaf state none", () => {
    const composite = service.stateView("feature/plan");
    expect(composite.board?.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);

    const leaf = service.stateView("feature/plan/goals");
    expect(leaf.board).toBeNull();
    expect(leaf.children).toEqual([]);
  });

  it("opens the board of a state in a workflow other than the newest task's", () => {
    service.createTask({ title: "plan it", workflow: "feature/plan", inputs: { issue: "x" } });

    // `board:view` used to resolve every level against the newest task's workflow, so this is the
    // regression the Files view would hit the moment a project had two workflows.
    const board = service.board("feature/plan/critique");
    expect(board.level).toBe("feature/plan/critique");
    expect(board.breadcrumb.map((c) => c.stateId)).toEqual(["feature/plan", "feature/plan/critique"]);
  });

  it("puts one column per workflow root at the top, with no order between them", () => {
    const roots = service.boardRoots();

    expect(roots.columns.map((c) => c.stateId)).toEqual(["feature/plan"]);
    expect(roots.level).toBe("");
    expect(roots.breadcrumb).toEqual([]);
  });
});

describe("the conversation inside a task", () => {
  it("is empty before a run rather than throwing", () => {
    const taskId = service.createTask({ title: "plan it", workflow: "feature/plan", inputs: { issue: "x" } }).taskId;

    const convo = service.conversation(taskId);
    expect(convo.taskId).toBe(taskId);
    expect(convo.title).toBe("plan it");
    expect(convo.turns).toEqual([]);
  });

  it("reads a finished run back out of the journal as turns", async () => {
    const taskId = service.createTask({ title: "plan it", workflow: "feature/plan", inputs: { issue: "x" } }).taskId;
    await service.startTask({ taskId, fake: happyRules() });
    await until(() => pushes.some((m) => m.type === "run:finished"), "the run to finish");

    const convo = service.conversation(taskId);

    expect(convo.turns.length).toBeGreaterThan(0);
    // The states that ran are named, and the output turns say whether they validated — which is the
    // whole reason to read the journal this way rather than as raw events.
    const states = new Set(convo.turns.map((t) => t.stateId));
    expect(states).toContain("feature/plan/goals");
    expect(convo.turns.some((t) => t.kind === "output" && t.ok === true)).toBe(true);
    // Time-ordered, so it reads top to bottom.
    const times = convo.turns.map((t) => t.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("with no project open", () => {
  /**
   * The rail is clickable on an empty window, so the views it can reach have to answer rather than
   * throw. Switching to Files used to raise "no project is open" as an error toast — an error
   * reporting a condition already visible on screen.
   */
  it("gives an empty board rather than throwing", async () => {
    const bare = new AppService({ baseDir: testHome(), publish: () => undefined });
    try {
      const roots = bare.boardRoots();
      // A board is about tasks, and tasks belong to a project — so with none open there is nothing
      // to show, and that is an answer rather than a fault.
      expect(roots.columns).toEqual([]);
      expect(roots.finished).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it("still shows the shared root, because it belongs to the machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const bare = new AppService({ publish: () => undefined, baseDir: join(home, "shared") });
    try {
      const tree = bare.filesTree();
      // Not `{roots: []}`: `~/.jaira` exists independently of any checkout, and it is where you put
      // a workflow that should outlive this one. Hiding it with no project open would hide it
      // exactly when someone is looking for a place to start.
      expect(tree.roots).toHaveLength(1);
      expect(tree.roots[0]).toMatchObject({ layer: "base", exists: false });
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("views a shared state from its file, because the shared root is authorable without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const base = join(home, "shared");
    const bare = new AppService({ publish: () => undefined, baseDir: base });
    try {
      bare.writeWorkflow({
        stateId: "review",
        layer: "base",
        text: JSON.stringify({ label: "Shared review", children: { step: {} } }),
      });

      const view = bare.stateView("review");

      // NOT `fileOnly`: the shared root is a project in its own right now, so this is the full view —
      // lint, dependants, drift and the runs that have passed through — rather than a reading of the
      // file alone. `layer` is still `base`, which is what routes its runs back to the shared root.
      expect(view).toMatchObject({ stateId: "review", label: "Shared review", layer: "base" });
      expect(view.fileOnly).toBeUndefined();
      expect(view.board?.columns.map((c) => c.key)).toEqual(["step"]);
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still refuses a read that names a task, because tasks need a project", async () => {
    const bare = new AppService({ baseDir: testHome(), publish: () => undefined });
    try {
      // Unlike a state, a task cannot exist without a project — so an empty answer would hide a
      // real mistake rather than describe a real situation.
      expect(() => bare.conversation("t-nope")).toThrow(/no project/);
    } finally {
      await bare.close();
    }
  });
});

describe("authoring into the shared root", () => {
  it("creates the directory chain on the way, so an absent root is still writable", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const base = join(home, "shared");
    const other = mkdtempSync(join(tmpdir(), "jaira-shared-"));
    initProject(other, testHome());
    const svc = new AppService({ publish: () => undefined, baseDir: base });
    try {
      await svc.open(other);
      // Opening a project materialises the base root, so remove it again: the point is that a write
      // does not depend on the directory already being there.
      rmSync(base, { recursive: true, force: true });
      expect(existsSync(base)).toBe(false);

      const written = svc.writeWorkflow({
        stateId: "review/step",
        layer: "base",
        text: JSON.stringify({ label: "Shared review step" }),
      });

      expect(written.exists).toBe(true);
      expect(existsSync(written.file)).toBe(true);
      expect(written.file.startsWith(base)).toBe(true);
      // And it is immediately browsable — by STANDING in the shared root, which is a sidebar row of
      // its own. Asking from a checkout gives that checkout, which is the whole point of the change:
      // a shared workflow is reached by going to where it lives.
      const tree = svc.filesTree({ project: SHARED_SESSION });
      expect(tree.roots.find((r) => r.layer === "base")?.exists).toBe(true);
      expect(svc.filesTree({ project: other }).roots.map((r) => r.layer)).toEqual(["project"]);
    } finally {
      await svc.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("file operations", () => {
  const read = (file: string): string => readFileSync(file, "utf8");

  it("renames a state, and the file moves with it", () => {
    const before = service.readWorkflow({ stateId: "feature/plan/goals", layer: "project" });

    const result = service.moveWorkflow({
      stateId: "feature/plan/goals",
      layer: "project",
      to: "feature/plan/aims",
      toLayer: "project",
      // `goals` is a declared child of `feature/plan`, so this is the refused case unless forced.
      force: true,
    });

    expect(result.applied).toBe(true);
    expect(result.stateId).toBe("feature/plan/aims");
    expect(existsSync(before.file)).toBe(false);
    expect(service.readWorkflow({ stateId: "feature/plan/aims", layer: "project" }).text).toBe(before.text);
  });

  it("refuses a rename that would break the states naming it, and says which", () => {
    const result = service.moveWorkflow({
      stateId: "feature/plan/goals",
      layer: "project",
      to: "feature/plan/aims",
      toLayer: "project",
    });

    expect(result.applied).toBe(false);
    expect(result.referencedBy).toContain("feature/plan");
    // Nothing moved — a refusal that had already half-applied would be worse than no check at all.
    expect(existsSync(service.readWorkflow({ stateId: "feature/plan/goals", layer: "project" }).file)).toBe(true);
  });

  it("duplicates without touching the original, and without asking about references", () => {
    const source = service.readWorkflow({ stateId: "feature/plan/goals", layer: "project" });

    const result = service.moveWorkflow({
      stateId: "feature/plan/goals",
      layer: "project",
      to: "feature/plan/goals-copy",
      toLayer: "project",
      copy: true,
    });

    // A copy breaks nothing, so it is never refused however many states point at the original.
    expect(result.applied).toBe(true);
    expect(existsSync(source.file)).toBe(true);
    expect(read(service.readWorkflow({ stateId: "feature/plan/goals-copy", layer: "project" }).file)).toBe(source.text);
  });

  it("overrides a shared state into the project under the same id", () => {
    service.writeWorkflow({ stateId: "review/step", layer: "base", text: JSON.stringify({ label: "Shared" }) });

    const result = service.moveWorkflow({
      stateId: "review/step",
      layer: "base",
      to: "review/step",
      toLayer: "project",
      copy: true,
    });

    expect(result).toMatchObject({ applied: true, stateId: "review/step", layer: "project" });
    // Both copies exist: that is what an override IS — the project's shadows the shared one, and
    // later edits to the rest of the shared workflow still reach this project.
    expect(existsSync(service.readWorkflow({ stateId: "review/step", layer: "base" }).file)).toBe(true);
    expect(existsSync(service.readWorkflow({ stateId: "review/step", layer: "project" }).file)).toBe(true);
  });

  it("deletes a state nothing references", () => {
    service.writeWorkflow({ stateId: "spare", layer: "project", text: JSON.stringify({ label: "Spare" }) });
    const file = service.readWorkflow({ stateId: "spare", layer: "project" }).file;

    const result = service.deleteWorkflow({ stateId: "spare", layer: "project" });

    expect(result.applied).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to delete a state something still declares as a child", () => {
    const result = service.deleteWorkflow({ stateId: "feature/plan/critique", layer: "project" });

    expect(result.applied).toBe(false);
    expect(result.referencedBy).toContain("feature/plan");
    expect(existsSync(service.readWorkflow({ stateId: "feature/plan/critique", layer: "project" }).file)).toBe(true);
  });

  it("refuses a destination outside the layer's root", () => {
    // The destination of a move is a write, so it needs the same containment check the source has.
    // `../` in an id is a perfectly good relative path and must not become a perfectly good escape.
    expect(() =>
      service.moveWorkflow({
        stateId: "feature/plan/goals",
        layer: "project",
        to: "../../../escaped",
        toLayer: "project",
        force: true,
      }),
    ).toThrow(/does not name a state inside/);
  });

  it("will not overwrite an existing state, and will not move something that is not there", () => {
    expect(() =>
      service.moveWorkflow({
        stateId: "feature/plan/goals",
        layer: "project",
        to: "feature/plan/critique",
        toLayer: "project",
        force: true,
      }),
    ).toThrow(/already exists/);

    expect(() =>
      service.moveWorkflow({ stateId: "nope", layer: "project", to: "also-nope", toLayer: "project" }),
    ).toThrow(/does not exist/);
  });

  it("creates a plain file and a directory anywhere under a layer root", () => {
    const created = service.createFile({ layer: "project", path: ".jaira/prompts/critique.md", kind: "file", text: "# Critique\n" });

    expect(existsSync(created.file)).toBe(true);
    expect(read(created.file)).toBe("# Critique\n");
    // A directory that did not exist on the way is created too — `prompts/` was not there.
    expect(existsSync(service.createFile({ layer: "project", path: ".jaira/skills/changelog", kind: "directory" }).file)).toBe(true);
  });

  it("refuses to clobber, and refuses to escape the layer root", () => {
    service.createFile({ layer: "project", path: ".jaira/prompts/goals.md", kind: "file", text: "x" });

    // "New file" that quietly emptied an existing one is the worst reading of the verb.
    expect(() => service.createFile({ layer: "project", path: ".jaira/prompts/goals.md", kind: "file" })).toThrow(/already exists/);
    // Addressed by path, so it needs its own containment check — the state-id one does not apply.
    expect(() => service.createFile({ layer: "project", path: "../../escaped.md", kind: "file" })).toThrow(/not inside/);
  });

  it("renames a plain file, which no state can reference", () => {
    const created = service.createFile({ layer: "project", path: ".jaira/prompts/goals.md", kind: "file", text: "# Goals\n" });

    const result = service.renameFile({ layer: "project", path: ".jaira/prompts/goals.md", to: ".jaira/prompts/aims.md" });

    expect(result).toMatchObject({ applied: true, path: ".jaira/prompts/aims.md", states: [] });
    expect(existsSync(created.file)).toBe(false);
    expect(read(join(dir, ".jaira", "prompts", "aims.md"))).toBe("# Goals\n");
  });

  it("moves a file into a directory that does not exist yet", () => {
    service.createFile({ layer: "project", path: "notes.md", kind: "file", text: "x" });

    const result = service.renameFile({ layer: "project", path: "notes.md", to: ".jaira/prompts/drafts/notes.md" });

    expect(result.applied).toBe(true);
    expect(existsSync(join(dir, ".jaira", "prompts", "drafts", "notes.md"))).toBe(true);
  });

  it("renames a whole workflow directory, because its states name each other relatively", () => {
    // A directory under `workflows/` IS an id prefix, so this renames every state inside at once.
    // Nothing is refused: the fixture declares children by KEY (WORKFLOWS.md §6), which resolves
    // against the declaring state, so the subtree stays consistent under its new prefix.
    const result = service.renameFile({ layer: "project", path: ".jaira/workflows/feature", to: ".jaira/workflows/epic" });

    expect(result).toMatchObject({ applied: true, referencedBy: [] });
    expect(result.states).toContain("feature/plan/goals");
    expect(existsSync(join(dir, ".jaira", "workflows", "feature"))).toBe(false);
    expect(service.readWorkflow({ stateId: "epic/plan", layer: "project" }).exists).toBe(true);
  });

  it("refuses a directory rename that leaves an absolute reference naming the old id", () => {
    service.writeWorkflow({
      stateId: "wrapper",
      layer: "project",
      text: JSON.stringify({ children: { plan: { state: "feature/plan" } } }),
    });

    const result = service.renameFile({ layer: "project", path: ".jaira/workflows/feature", to: ".jaira/workflows/epic" });

    expect(result.applied).toBe(false);
    expect(result.referencedBy).toEqual(["wrapper"]);
    expect(existsSync(join(dir, ".jaira", "workflows", "feature"))).toBe(true);

    const forced = service.renameFile({
      layer: "project",
      path: ".jaira/workflows/feature",
      to: "workflows/epic",
      force: true,
    });
    expect(forced.applied).toBe(true);
  });

  it("refuses to move a children directory out from under the state that declares it", () => {
    // `workflows/feature/plan/` holds the children of `feature/plan`, which stays where it is —
    // so this is the case a relative declaration does NOT survive.
    const result = service.renameFile({ layer: "project", path: ".jaira/workflows/feature/plan", to: ".jaira/workflows/steps" });

    expect(result.applied).toBe(false);
    expect(result.states).toContain("feature/plan/goals");
    expect(result.referencedBy).toContain("feature/plan");
  });

  it("deletes a plain file, and a directory takes everything in it", () => {
    const file = service.createFile({ layer: "project", path: ".jaira/skills/changelog/prompt.md", kind: "file", text: "x" });

    expect(service.deleteFile({ layer: "project", path: ".jaira/skills/changelog/prompt.md" }).applied).toBe(true);
    expect(existsSync(file.file)).toBe(false);

    service.createFile({ layer: "project", path: ".jaira/skills/changelog/notes.md", kind: "file", text: "x" });
    expect(service.deleteFile({ layer: "project", path: ".jaira/skills" }).applied).toBe(true);
    expect(existsSync(join(dir, ".jaira", "skills"))).toBe(false);
  });

  it("deletes a self-contained workflow directory, because nothing is left pointing at it", () => {
    // Every state that named something in `workflows/feature/` was itself in `workflows/feature/`.
    const result = service.deleteFile({ layer: "project", path: ".jaira/workflows/feature" });

    expect(result).toMatchObject({ applied: true, referencedBy: [] });
    expect(existsSync(join(dir, ".jaira", "workflows", "feature"))).toBe(false);
  });

  it("refuses to delete a directory something outside it still declares as a child", () => {
    service.writeWorkflow({
      stateId: "wrapper",
      layer: "project",
      text: JSON.stringify({ children: { plan: { state: "feature/plan" } } }),
    });

    const result = service.deleteFile({ layer: "project", path: ".jaira/workflows/feature" });

    expect(result.applied).toBe(false);
    expect(result.referencedBy).toEqual(["wrapper"]);
    expect(existsSync(join(dir, ".jaira", "workflows", "feature"))).toBe(true);

    expect(service.deleteFile({ layer: "project", path: ".jaira/workflows/feature", force: true }).applied).toBe(true);
    expect(existsSync(join(dir, ".jaira", "workflows", "feature"))).toBe(false);
  });

  it("keeps a path-addressed rename and delete inside the layer root", () => {
    expect(() => service.renameFile({ layer: "project", path: ".jaira/prompts", to: "../../escaped" })).toThrow(/not inside/);
    expect(() => service.deleteFile({ layer: "project", path: "../../" })).toThrow(/not inside/);
    // The root itself resolves to an empty relative path, which is the case that would delete `.jaira`.
    expect(() => service.deleteFile({ layer: "project", path: "" })).toThrow(/not inside/);
  });

  it("will not move a directory into itself, or over something that is already there", () => {
    service.createFile({ layer: "project", path: ".jaira/prompts/goals.md", kind: "file", text: "x" });
    service.createFile({ layer: "project", path: ".jaira/prompts/aims.md", kind: "file", text: "y" });

    expect(() => service.renameFile({ layer: "project", path: ".jaira/prompts", to: ".jaira/prompts/inner" })).toThrow(/is inside/);
    expect(() => service.renameFile({ layer: "project", path: ".jaira/prompts/goals.md", to: ".jaira/prompts/aims.md" })).toThrow(
      /already exists/,
    );
    expect(() => service.renameFile({ layer: "project", path: "nope.md", to: "also-nope.md" })).toThrow(
      /does not exist/,
    );
  });

  it("passes a reveal through to the host, and does nothing when there is no host", () => {
    const revealed: string[] = [];
    const withHost = new AppService({ baseDir: testHome(), publish: () => undefined, reveal: (f) => revealed.push(f) });
    try {
      withHost.revealFile({ file: "C:/somewhere/plan.json" });
      expect(revealed).toEqual(["C:/somewhere/plan.json"]);
      // No host — a headless run has no file manager, and quietly doing nothing beats throwing.
      expect(() => service.revealFile({ file: "C:/somewhere/plan.json" })).not.toThrow();
    } finally {
      void withHost.close();
    }
  });
});

describe("creating a state", () => {
  it("writes the file immediately, so it is in the tree before anything is saved", () => {
    // The old flow opened an editor over a file that did not exist until Save — a state you have
    // named and cannot see in the tree is a state you will name again.
    const written = service.writeWorkflow({ stateId: "triage/bug", layer: "project", text: "{}" });

    expect(existsSync(written.file)).toBe(true);
    expect(service.readWorkflow({ stateId: "triage/bug", layer: "project" }).exists).toBe(true);
    const ids: string[] = [];
    const walk = (nodes: ReturnType<typeof service.filesTree>["roots"][number]["nodes"]): void => {
      for (const node of nodes) {
        if (node.stateId !== undefined) ids.push(node.stateId);
        if (node.children) walk(node.children);
      }
    };
    service.filesTree().roots.forEach((r) => walk(r.nodes));
    expect(ids).toContain("triage/bug");
  });
});

describe("executor availability", () => {
  it("does not flag a state whose function is a UI component rather than a runtime", () => {
    // Nothing in the shipped planning workflow names an executor, so nothing here should be an
    // error — a state view that cried wolf on every human gate would be unusable.
    const view = service.stateView("feature/plan/critique");
    expect(view.issues.filter((i) => i.message.includes("not available"))).toEqual([]);
  });
});
