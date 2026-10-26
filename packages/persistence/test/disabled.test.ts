/**
 * Disabled workflows (decision 0021): `"disabled": true` in a state file switches off the state and
 * every state under its id, read from the WINNING file on the workflow path — a file that follows
 * another answering with what it follows.
 *
 * What is pinned: which file decides; that a follow file switches a built-in off in one project and
 * a Shared one back on; that the browse marks the root, the winning file and the list; that every
 * start refuses with one sentence; that a move onto one is refused before it is planned; and that the
 * field never reaches what a run follows, so switching it does not change a snapshot.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disabledBy, setBuiltInDir } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import {
  beginTaskRun,
  browseWorkflows,
  connectTask,
  createTask,
  disabledRefusalOf,
  disabledStatesOf,
  initProject,
  openProject,
  pinWorkflow,
  resetUserModules,
  type Project,
} from "../src/index";

let dir: string;
let builtIn: string;
let project: Project | undefined;

const leaf = (label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  label,
  outputs: { text: { schema: { type: "string" }, binding: ".operation.output.text" } },
  operation: { kind: "prompt", prompt: "hello", model: "anthropic/claude-sonnet-5", output: { text: { schema: { type: "string" } } } },
  ...extra,
});

function write(root: string, relPath: string, body: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

function open(): Project {
  project = openProject(dir, { baseDir: testHome(), builtInDir: builtIn });
  return project;
}

beforeEach(() => {
  resetUserModules();
  dir = mkdtempSync(join(tmpdir(), "jaira-disabled-"));
  builtIn = mkdtempSync(join(tmpdir(), "jaira-disabled-shipped-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  resetUserModules();
  setBuiltInDir(undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(builtIn, { recursive: true, force: true });
});

describe("which states are switched off", () => {
  it("reads the project's own file, and switches off every state under its id", () => {
    const p = open();
    write(p.paths.workflowsDir, "release/notes.json", leaf("Release notes", { disabled: true }));
    write(p.paths.workflowsDir, "release/tag.json", leaf("Tag"));
    expect(disabledStatesOf(p)).toEqual(["release/notes"]);
    expect(disabledBy(disabledStatesOf(p), "release/notes")).toBe("release/notes");
    expect(disabledBy(disabledStatesOf(p), "release/notes/draft")).toBe("release/notes");
    expect(disabledBy(disabledStatesOf(p), "release/notes#2")).toBe("release/notes");
    expect(disabledBy(disabledStatesOf(p), "release/tag")).toBeUndefined();
    expect(disabledBy(disabledStatesOf(p), "release")).toBeUndefined();
  });

  it("switches a built-in off in one project with a file that follows it", () => {
    write(builtIn, "workflows/chat/hello.json", leaf("Hello"));
    const p = open();
    expect(disabledStatesOf(p)).toEqual([]);
    write(p.paths.workflowsDir, "chat/hello.json", { $ref: "$SYSTEM/workflows/chat/hello", disabled: true });
    expect(disabledStatesOf(p)).toEqual(["chat/hello"]);
  });

  it("follows a file that says nothing itself, and lets a project switch a Shared one back on", () => {
    const p = open();
    write(p.paths.base.workflowsDir, "shared/flow.json", leaf("Flow", { disabled: true }));
    expect(disabledStatesOf(p)).toEqual(["shared/flow"]);
    write(p.paths.workflowsDir, "shared/flow.json", { $ref: "$BASE/workflows/shared/flow" });
    expect(disabledStatesOf(p)).toEqual(["shared/flow"]);
    write(p.paths.workflowsDir, "shared/flow.json", { $ref: "$BASE/workflows/shared/flow", disabled: false });
    expect(disabledStatesOf(p)).toEqual([]);
  });

  it("is marked in the browse: the root, the winning file, and the list", () => {
    write(builtIn, "workflows/chat/hello.json", leaf("Hello"));
    const p = open();
    write(p.paths.workflowsDir, "chat/hello.json", { $ref: "$SYSTEM/workflows/chat/hello", disabled: true });
    write(p.paths.workflowsDir, "other.json", leaf("Other"));
    const browser = browseWorkflows(p);
    expect(browser.disabled).toEqual(["chat/hello"]);
    expect(browser.workflows.find((w) => w.rootId === "chat/hello")?.disabled).toBe(true);
    expect(browser.workflows.find((w) => w.rootId === "other")?.disabled).toBeUndefined();
    const files = browser.files.filter((f) => f.stateId === "chat/hello");
    expect(files.map((f) => [f.layer, f.disabled ?? false])).toEqual([
      ["project", true],
      ["system", false],
    ]);
  });
});

describe("a start", () => {
  it("is refused at the pin, whoever asks, with one sentence", async () => {
    const p = open();
    write(p.paths.workflowsDir, "notes.json", leaf("Notes", { disabled: true }));
    const task = createTask(p, { title: "Write the notes", workflow: "notes" });
    await expect(beginTaskRun(p, task.id)).rejects.toThrow("Not run: 'notes' is disabled.");
    await expect(pinWorkflow(p, "notes")).rejects.toThrow("Not run: 'notes' is disabled.");
    expect(p.runtime.get(task.id)?.status).toBe("queued");
  });

  it("names the state above that switched it off", () => {
    const p = open();
    write(p.paths.workflowsDir, "feature.json", leaf("Feature", { disabled: true, children: {} }));
    write(p.paths.workflowsDir, "feature/review.json", leaf("Review"));
    expect(disabledRefusalOf(p, "feature/review")).toBe("Not run: 'feature/review' is under 'feature', which is disabled.");
    expect(disabledRefusalOf(p, "feature/review", "moved")).toBe("Not moved: 'feature/review' is under 'feature', which is disabled.");
  });

  it("goes ahead once the field is gone, and the field never reaches the snapshot", async () => {
    const p = open();
    write(p.paths.workflowsDir, "notes.json", leaf("Notes", { disabled: false }));
    const switched = await pinWorkflow(p, "notes");
    expect("disabled" in switched.bundle.states["notes"]!).toBe(false);
    write(p.paths.workflowsDir, "notes.json", leaf("Notes"));
    const plain = await pinWorkflow(p, "notes");
    expect(plain.hash).toBe(switched.hash);
  });
});

describe("a conversation", () => {
  it("is one because the Chat view started it, and a task file from before is stamped at open", () => {
    const p = open();
    const before = createTask(p, { title: "an old conversation", workflow: "chat/session", inputs: { message: "hi" } });
    const board = createTask(p, { title: "a plain task", workflow: "notes" });
    p.close();
    project = undefined;
    const again = open();
    expect(again.tasks.read(before.id).startedBy).toEqual({ by: "chat" });
    expect(again.tasks.read(board.id).startedBy).toBeUndefined();
    // Once: a second open writes nothing more.
    expect(again.tasks.stampConversations()).toBe(0);
  });

  it("stamps at open past a task file that does not read, rather than failing the open", () => {
    const p = open();
    const before = createTask(p, { title: "an old conversation", workflow: "chat/session", inputs: { message: "hi" } });
    writeFileSync(join(p.paths.tasksDir, "t-broken0000.json"), "{ not json", "utf8");
    p.close();
    project = undefined;
    expect(open().tasks.read(before.id).startedBy).toEqual({ by: "chat" });
  });

  it("can run any workflow with one required text input", () => {
    const p = open();
    write(p.paths.workflowsDir, "planning/plan.json", { ...leaf("Planning"), inputs: { goal: { schema: { type: "string" } }, depth: { schema: { type: "number" }, default: 2 } } });
    write(p.paths.workflowsDir, "two.json", { ...leaf("Two"), inputs: { a: { schema: { type: "string" } }, b: { schema: { type: "string" } } } });
    write(p.paths.workflowsDir, "counted.json", { ...leaf("Counted"), inputs: { n: { schema: { type: "number" } } } });
    const of = (rootId: string): string | undefined => browseWorkflows(p).workflows.find((w) => w.rootId === rootId)?.conversationInput;
    expect(of("planning/plan")).toBe("goal");
    expect(of("two")).toBeUndefined();
    expect(of("counted")).toBeUndefined();
  });
});

describe("a move", () => {
  it("onto a disabled state is refused before anything is planned", async () => {
    const p = open();
    write(p.paths.workflowsDir, "draft.json", leaf("Draft"));
    write(p.paths.workflowsDir, "notes.json", leaf("Notes", { disabled: true }));
    const task = createTask(p, { title: "Draft it", workflow: "draft" });
    // No host: the refusal comes before anything a host would be asked to do.
    const result = await connectTask(p, { taskId: task.id, target: "notes", dryRun: true }, {} as never);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toEqual({ code: "disabled", message: "Not moved: 'notes' is disabled." });
  });
});
