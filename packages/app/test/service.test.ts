/**
 * The app surface, driven headlessly (no Electron): create → start → board →
 * detail, the live human gate through the interaction hub, and cancellation.
 *
 * This is the phase-3 milestone as a test — a task moving across board columns —
 * plus the phase-4 seam (a run parking on a human decision that only the UI
 * channel can answer).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { jairaBasePaths, SHARED_SESSION, SYSTEM_SESSION, systemProjectDir, type PushMessage } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-app-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  let n = 0;
  service = new AppService({ publish: (m) => pushes.push(m), nextInteractionId: () => `ui-${++n}` });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

function newTask(title = "Plan the feature"): string {
  return service.createTask({ title, workflow: "feature/plan", inputs: { issue: "the issue" } }).taskId;
}

/** Wait until `predicate` holds, driving the microtask/timer queue. */
async function until(predicate: () => boolean, label: string, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const finished = (taskId: string): boolean =>
  pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

describe("AppService reads", () => {
  it("opens a project and lists created tasks", () => {
    expect(service.current()).toEqual({ dir });
    const taskId = newTask();
    expect(service.listTasks()).toHaveLength(1);
    expect(service.listTasks()[0]).toMatchObject({ taskId, status: "queued", workflow: "feature/plan" });
    // Stamped with the project whose task list changed — see the `project` field on the push. A window
    // showing another project, or none, ignores it rather than asking for tasks it has not got.
    expect(pushes).toContainEqual({ type: "store:invalidate", scope: "tasks", project: dir });
  });

  it("projects the root board from the live workflow before any run", () => {
    newTask();
    const board = service.board();
    expect(board.level).toBe("feature/plan");
    expect(board.label).toBe("Planning");
    expect(board.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    // A queued task has entered no child yet, so it is AT the level it will begin at rather than in
    // one of its columns — and rather than in a tray named for a status.
    expect(board.atLevel).toHaveLength(1);
    expect(board.finished).toEqual([]);
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it("throws for an unknown task and when no project is open", () => {
    expect(() => service.taskDetail("nope")).toThrow(/unknown task/);
    const closed = new AppService();
    expect(() => closed.listTasks()).toThrow(/no project is open/);
  });
});

describe("AppService.startTask (scripted)", () => {
  it("runs to completion, streams events, and records the run", async () => {
    const taskId = newTask();
    const { runId } = await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    expect(runId).toBe(1);
    await until(() => finished(taskId), "the run to finish");

    // Stamped with the project it is about, so a window showing another one can ignore it — see the
    // `project` field on `store:invalidate`.
    expect(pushes).toContainEqual({ type: "run:finished", taskId, runId, status: "completed", project: dir });
    // The journal streamed live, in order, as engine events.
    const streamed = pushes.filter((m) => m.type === "engine:event");
    expect(streamed.length).toBeGreaterThan(5);
    expect(streamed.map((m) => (m as { seq: number }).seq)).toEqual(streamed.map((_, i) => i + 1));

    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ runId, outcome: "success" });
    expect(JSON.stringify(detail.runs[0]!.outputs)).toContain("# The Plan");
    // The instance tree is projected from the journal, not tracked separately.
    expect(detail.instances).toHaveLength(1);
    expect(detail.instances[0]!.stateId).toBe("feature/plan");
    expect(detail.instances[0]!.children.map((c) => c.childKey)).toEqual(["goals", "context", "critique"]);
    expect(detail.activePath).toEqual([]);
    expect(detail.timeline.length).toBeGreaterThan(5);

    // Board: a completed task STAYS on the board, in the column its run came to rest in. It used to
    // fall out of the columns into a tray, which filed the card under a status rather than a place.
    const board = service.board();
    expect(board.columns[2]!.cards.map((c) => c.taskId)).toEqual([taskId]);
    // And it is in the census of what has ended here, which is the same card, not a second place.
    expect(board.finished.map((c) => c.taskId)).toEqual([taskId]);
  });

  it("refuses to start the same task twice concurrently", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: happyRules(), interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] } });
    await expect(service.startTask({ taskId })).rejects.toThrow(/already running/);
    await until(() => finished(taskId), "the run to finish");
  });

  it("records a failed run and leaves the task retryable", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: [{ error: "provider exploded" }] });
    await until(() => finished(taskId), "the failing run to finish");
    expect(service.taskDetail(taskId).status).toBe("failed");

    // A retry is a fresh run against the pinned snapshot.
    await service.startTask({ taskId, fake: happyRules(), interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] } });
    await until(() => pushes.filter((m) => m.type === "run:finished").length === 2, "the retry to finish");
    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(detail.runs.map((r) => r.outcome)).toEqual(["error", "success"]);
  });
});

describe("AppService.rerunTask and deleteTask", () => {
  const approve = { interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" } as JsonValue] } };

  it("reruns a failed task in place — same task, fresh run", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: [{ error: "provider exploded" }] });
    await until(() => finished(taskId), "the failing run to finish");

    const started = await service.rerunTask({ taskId, fake: happyRules(), ...approve });
    expect(started.taskId).toBe(taskId);
    await until(() => pushes.filter((m) => m.type === "run:finished").length === 2, "the rerun to finish");
    expect(service.taskDetail(taskId).status).toBe("completed");
  });

  it("reruns a completed task as a fresh copy, since a finished lifecycle cannot restart", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: happyRules(), ...approve });
    await until(() => finished(taskId), "the first run to finish");

    const started = await service.rerunTask({ taskId, fake: happyRules(), ...approve });
    expect(started.taskId).not.toBe(taskId);
    await until(() => finished(started.taskId), "the copy's run to finish");

    // The copy carries the original's identity — title, workflow, inputs — under its own id.
    const copy = service.taskDetail(started.taskId);
    expect(copy).toMatchObject({ title: "Plan the feature", workflow: "feature/plan", status: "completed" });
    expect(service.listTasks().map((t) => t.taskId).sort()).toEqual([taskId, started.taskId].sort());
    // The original is untouched: still one run, still completed.
    expect(service.taskDetail(taskId).runs).toHaveLength(1);
  });

  it("refuses to delete a running task, then deletes it once it has finished", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    // Parked on a human is still running, and running is the one undeletable status.
    await expect(service.deleteTask(taskId)).rejects.toThrow(/cancel it before deleting/);

    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { decision: "block" });
    await until(() => finished(taskId), "the run to finish");

    await service.deleteTask(taskId);
    expect(service.listTasks()).toHaveLength(0);
    expect(() => service.taskDetail(taskId)).toThrow(/unknown task/);
    expect(pushes).toContainEqual({ type: "store:invalidate", scope: "board", project: dir });
  });

  it("delete of an unknown task says so", async () => {
    await expect(service.deleteTask("t-nowhere000")).rejects.toThrow(/unknown task/);
  });
});

describe("AppService live human gate", () => {
  it("parks on the gate, shows it as pending, and completes once the UI answers", async () => {
    const taskId = newTask();
    // No scripted interactions: the gate must come to the UI.
    await service.startTask({ taskId, fake: blockedRules() });

    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;
    expect(pending.component).toBe(HUMAN_REVIEW_FUNCTION);
    expect(pending.taskId).toBe(taskId);
    // The authored `config` surface reaches the UI, so it can render the choices.
    expect(JSON.stringify(pending.inputs)).toContain("Review the critique result.");
    expect(pushes).toContainEqual({ type: "interaction:requested", pending });

    // While parked, the board shows the task waiting on a human.
    const board = service.board();
    const card = board.columns.find((c) => c.key === "critique")!.cards[0]!;
    expect(card.taskId).toBe(taskId);
    expect(card.activeStatus).toBe("waiting_for_user");
    expect(card.activeStateId).toBe("feature/plan/critique/human_review");
    expect(card.hasSubBoard).toBe(true);
    // …and the sub-board places it in the human_review column.
    const sub = service.board("feature/plan/critique");
    expect(sub.breadcrumb.map((c) => c.stateId)).toEqual(["feature/plan", "feature/plan/critique"]);
    expect(sub.columns.find((c) => c.key === "human_review")!.cards.map((c) => c.taskId)).toEqual([taskId]);

    service.submitInteraction(pending.requestId, { decision: "block" });
    await until(() => finished(taskId), "the run to finish after answering");

    expect(pushes).toContainEqual({ type: "interaction:resolved", requestId: pending.requestId });
    expect(service.pendingInteractions()).toEqual([]);
    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(JSON.stringify(detail.runs[0]!.outputs)).toContain("\"human_decision\":\"block\"");
  });

  it("rejects an unknown interaction id", () => {
    expect(() => service.submitInteraction("nope", { decision: "approve" })).toThrow(/no pending interaction/);
  });

  it("refuses an out-of-contract answer, and the gate stays open for a valid one", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;

    // The renderer is the untrusted half of the boundary: an undeclared decision
    // must not reach the engine (DESIGN §7.1).
    expect(() => service.submitInteraction(pending.requestId, { decision: "ship-it" })).toThrow(
      /invalid choose_option response.*not one of/,
    );
    expect(() => service.submitInteraction(pending.requestId, "approve")).toThrow(/must be an object/);
    // Still parked, so a rejected answer loses nothing.
    expect(service.pendingInteractions()).toHaveLength(1);

    service.submitInteraction(pending.requestId, { decision: "approve" });
    await until(() => finished(taskId), "the run to finish after a valid answer");
    expect(service.pendingInteractions()).toEqual([]);
  });

  it("hands the renderer a parsed component contract", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;
    // Normalized in main, so the renderer never re-derives the contract.
    expect(pending.config).toMatchObject({
      component: "choose_option",
      prompt: "Review the critique result.",
      options: [{ value: "approve" }, { value: "request_changes" }, { value: "block" }],
    });
    expect(pending.configError).toBeUndefined();
    service.submitInteraction(pending.requestId, { decision: "block" });
    await until(() => finished(taskId), "the run to finish");
  });

  it("canceling a parked run fails the gate rather than hanging", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");

    service.cancelTask(taskId);
    await until(() => finished(taskId), "the canceled run to finish");
    expect(service.pendingInteractions()).toEqual([]);
    // The gate failing is a state-level failure, so the run ends non-completed.
    expect(service.taskDetail(taskId).status).not.toBe("completed");
  });

  it("closing the project releases parked gates", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    await service.close();
    // The hub rejected it, so nothing is left waiting on a human.
    expect(service.pendingInteractions()).toEqual([]);
  });
});

describe("AppService.cancelTask (not running here)", () => {
  it("records a terminal canceled status for a queued task", () => {
    const taskId = newTask();
    service.cancelTask(taskId);
    expect(service.taskDetail(taskId).status).toBe("canceled");
  });
});

/**
 * A process now holds SEVERAL projects, keyed by directory — so the things that used to be
 * singletons on the service (the runs in flight, the hubs they park on, the sync in flight) belong
 * to a session instead.
 *
 * Opening a second user project now ADDS a session rather than evicting one (SHELL.md §2.3), and
 * what these defend is the rule that replaced the focus: an unqualified call is answerable exactly
 * while there is nothing to choose between, and reports rather than guessing the moment there is.
 * The bookkeeping stays per-session, so no shared counter or leaked handle survives a second open.
 */
describe("sessions — one process, several projects", () => {
  it("opens another project ALONGSIDE the first, and refuses to guess between them", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-app-b-"));
    const paths = initProject(other);
    writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
    try {
      const taskId = newTask();
      expect(service.current()?.dir).toBe(dir);
      await service.open(other);
      // Opening ADDS a session; it does not evict one (SHELL.md §2.3). Both are listed, and both
      // still answer — for whoever names them. The first project's task is still THERE, which is
      // the whole change: it used to be closed out from under the window.
      expect(service.listProjects().filter((p) => p.kind === "user").map((p) => p.project).sort()).toEqual([dir, other].sort());
      expect(service.listTasks(dir).map((t) => t.taskId)).toEqual([taskId]);
      // And still a different board rather than a merged one.
      expect(service.listTasks(other)).toEqual([]);
      // And the property that replaces the focus: with two open, a call that names neither reports
      // rather than picking. A guess here reads the wrong database and answers about another
      // project's task, which is the bug the whole crumb-as-address model exists to make impossible.
      expect(() => service.listTasks()).toThrow(/must name one/);
      // `current` survives as a STARTING POINT for a fresh window's address, and nothing more.
      expect(service.current()?.dir).toBe(other);
    } finally {
      // Closed before the directory goes, because Windows will not unlink an open database file —
      // which is also the reason `close()` drains its runs before closing the handle.
      await service.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("puts both projects in the files tree, with the shared root listed once beside them", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-app-c-"));
    initProject(other);
    try {
      await service.open(other);
      const tree = service.filesTree();
      // The projects ARE the top level (SHELL.md §2.2) — one root each, stamped with the project
      // every call about a file in it will have to name.
      const projects = tree.roots.filter((r) => r.layer === "project");
      expect(projects.map((r) => r.project).sort()).toEqual([dir, other].sort());
      // And `~/.jaira` exactly once, not once per project: repeating a machine-global directory
      // invites somebody to wonder which copy they are editing.
      expect(tree.roots.filter((r) => r.layer === "base")).toHaveLength(1);
    } finally {
      await service.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("lists every project's tasks as one recency-ordered list, each stamped with its project", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-app-d-"));
    const paths = initProject(other);
    writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
    try {
      const here = newTask("here");
      await service.open(other);
      const there = service.createTask({ title: "there", workflow: "feature/plan", project: other }).taskId;

      // The ROOT of the address is a place, and this is what it holds. One list, not one per
      // project: a list spanning four databases has no order until something imposes one, and
      // recency is the only order that means the same thing in all of them.
      const all = service.listAllTasks();
      const mine = all.filter((t) => t.taskId === here || t.taskId === there);
      expect(mine.map((t) => t.taskId)).toEqual([there, here]);
      // Stamped, because a row that cannot say whose task it is cannot be opened — the same fault
      // the inbox strip had (SHELL.md §2.4).
      expect(mine.map((t) => t.project)).toEqual([other, dir]);

      // Narrowed by workflow, which is how the Chat view asks for conversations without this
      // channel having to know what a conversation is.
      expect(service.listAllTasks({ workflows: ["feature/plan"] }).map((t) => t.taskId)).toEqual(
        expect.arrayContaining([here, there]),
      );
      expect(service.listAllTasks({ workflows: ["chat/agent"] })).toEqual([]);
    } finally {
      await service.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("re-opening the same directory under another spelling does not open it twice", async () => {
    // Two `better-sqlite3` handles on one file is the failure `sessionKey` exists to prevent, and it
    // is invisible until two writers disagree — so it is asserted on the way in, not after.
    await service.open(join(dir, "..", basename(dir)));
    expect(service.current()?.dir).toBe(dir);
    expect(() => service.listTasks()).not.toThrow();
  });

  it("closes everything, and says so rather than throwing", async () => {
    await service.close();
    expect(service.current()).toBeNull();
    expect(() => service.listTasks()).toThrow(/no project is open/);
    // Idempotent: closing what is already closed is how a window teardown is allowed to be sloppy.
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("keeps two services with different base roots out of each other's state", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-b-"));
    const other = new AppService({ baseDir: home, watchWorkflows: false });
    try {
      expect(other.current()).toBeNull();
      // The first service is still open and unaffected — no shared singleton between them.
      expect(service.current()?.dir).toBe(dir);
    } finally {
      await other.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * JaiRA's own project — the shared root, opened when something first needs it.
 *
 * The two properties worth defending: it is never what the project-free channels answer for (or a
 * window with no project open would list JaiRA's tasks as the user's), and it survives a checkout
 * being switched underneath it (or a sync in flight against it would be abandoned by an unrelated
 * action).
 */
describe("the system project", () => {
  it("is not opened merely by constructing a service", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-sys-"));
    const base = join(home, "shared");
    const bare = new AppService({ baseDir: base, watchWorkflows: false });
    try {
      // Opening it eagerly meant a person who never runs a sync still got a database, and every
      // caller became responsible for closing a handle it never asked for.
      expect(existsSync(join(base, "jaira.db"))).toBe(false);
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is never what an unqualified call resolves to", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-sys-b-"));
    const bare = new AppService({ baseDir: join(home, "shared"), watchWorkflows: false });
    try {
      expect(bare.current()).toBeNull();
      // Not "here are JaiRA's own tasks" — which is exactly the pollution giving them their own
      // project was meant to prevent.
      expect(() => bare.listTasks()).toThrow(/no project is open/);
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("survives switching the open project, because it is machine-global", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-app-c-"));
    initProject(other);
    try {
      // A base-layer status read materializes it; switching checkouts must not then discard it.
      service.syncStatus({ layer: "base", path: "workflows/workflow.md" });
      await service.open(other);
      expect(() => service.syncStatus({ layer: "base", path: "workflows/workflow.md" })).not.toThrow();
    } finally {
      await service.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  /**
   * A workflow that lives in the shared root, run there.
   *
   * The shared root is where a workflow meant to outlive one checkout gets authored, and until this
   * it was the one place you could write a workflow and never start it: `createTask` answered for
   * the focused project, so a shared state was unrunnable with nothing open and — with a project
   * open — recorded a machine-wide workflow's run in one person's checkout.
   */
  it("runs a workflow that lives in the shared root, with no user project open", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-sys-run-"));
    const base = join(home, "shared");
    const bare = new AppService({ publish: () => undefined, baseDir: base, watchWorkflows: false });
    try {
      writeWorkflowFiles(jairaBasePaths(base).workflowsDir, specPlanningFiles());
      const task = bare.createTask({
        title: "shared plan #1",
        workflow: "feature/plan",
        inputs: { issue: "the issue" },
        project: SHARED_SESSION,
      });

      // Recorded in the ROOT's own project and nowhere else. Not JaiRA's: that one holds the
      // installation's own runs and must survive a root switch, which these deliberately do not.
      expect(bare.listTasks(SHARED_SESSION).map((t) => t.taskId)).toEqual([task.taskId]);
      expect(bare.listSystemTasks()).toEqual([]);
      expect(() => bare.listTasks()).toThrow(/no project is open/);

      const { runId } = await bare.startTask({
        taskId: task.taskId,
        project: SHARED_SESSION,
        fake: happyRules(),
        interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
      });
      expect(runId).toBe(1);
      await until(() => bare.listTasks(SHARED_SESSION)[0]?.status === "completed", "the shared run to finish");
      expect(bare.taskDetail(task.taskId, SHARED_SESSION).status).toBe("completed");
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * The property the whole split exists for.
   *
   * Shared runs belong to the ROOT: repoint it and they are not yours any more, because a different
   * root is a different library with a different history. JaiRA's own runs are about the
   * installation and must survive exactly that switch. One project could not be both.
   */
  it("leaves a root's tasks behind when the root is repointed, but keeps JaiRA's own", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-roots-"));
    const first = new AppService({ publish: () => undefined, baseDir: join(home, "one"), watchWorkflows: false });
    const second = new AppService({
      publish: () => undefined,
      baseDir: join(home, "two"),
      // The same installation, a different selected root — which is what repointing IS. Passed
      // explicitly here because a test's `baseDir` otherwise stands in for the whole installation.
      systemDir: join(home, "system"),
      watchWorkflows: false,
    });
    try {
      writeWorkflowFiles(jairaBasePaths(join(home, "one")).workflowsDir, specPlanningFiles());
      first.createTask({ title: "in root one", workflow: "feature/plan", project: SHARED_SESSION });
      expect(first.listTasks(SHARED_SESSION)).toHaveLength(1);

      // A different root: none of the first root's runs are listed. They were that library's.
      expect(second.listTasks(SHARED_SESSION)).toEqual([]);
    } finally {
      await first.close();
      await second.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps JaiRA's own project out of the selected root entirely", () => {
    // So that repointing the root cannot take it along — the directory is beside the root, not in
    // it, and `systemProjectDir` is the one place that decides where.
    // `resolve`d, so the expectation is too — on Windows a rooted path still gains a drive letter.
    const install = resolve(join(tmpdir(), "install"));
    expect(systemProjectDir({ JAIRA_HOME: install })).toBe(join(install, "system"));
  });

  it("shows a shared SUBSTATE what has run through it, not just the root", async () => {
    // The reported bug: history appeared on the top-level file and nowhere below it. With no checkout
    // open the state view fell back to a file-only reading, whose task lists are empty by
    // construction — so a substate could never say anything about the runs that had gone through it,
    // and a root only looked right because its own runs come from the task list instead.
    const home = mkdtempSync(join(tmpdir(), "jaira-sub-"));
    const base = join(home, "shared");
    const bare = new AppService({ publish: () => undefined, baseDir: base, watchWorkflows: false });
    try {
      writeWorkflowFiles(jairaBasePaths(base).workflowsDir, specPlanningFiles());
      const task = bare.createTask({
        title: "shared plan #1",
        workflow: "feature/plan",
        inputs: { issue: "the issue" },
        project: SHARED_SESSION,
      });
      await bare.startTask({
        taskId: task.taskId,
        project: SHARED_SESSION,
        fake: happyRules(),
        interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
      });
      await until(() => bare.listTasks(SHARED_SESSION)[0]?.status === "completed", "the shared run to finish");

      // The substate knows the run went through it, and is no longer flagged as unknowable.
      const child = bare.stateView("feature/plan/goals");
      expect(child.fileOnly).toBeUndefined();
      expect([...child.tasksHere, ...child.tasksRecent].map((c) => c.taskId)).toContain(task.taskId);
      // And it is still the BASE layer, which is what routes its runs back to the shared root rather
      // than to whichever checkout happens to be open.
      expect(child.layer).toBe("base");
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still answers for the only user project when a task names none", async () => {
    // The routing is opt-in. Everything that existed before this — the Tasks view's New task, the
    // debug pane, the CLI path — sends no `project` and must keep landing in the checkout.
    //
    // Note what it is NOT: with a second user project open this throws rather than picking (see
    // "opens another project ALONGSIDE the first"). One open project is not a focus, it is the
    // absence of anything to choose between — which is what makes the unqualified call safe.
    const taskId = service.createTask({ title: "Plan", workflow: "feature/plan" }).taskId;
    expect(service.listTasks().map((t) => t.taskId)).toEqual([taskId]);
  });
});

/**
 * The conversation a state actually ran — kept, and findable from the task that ran it.
 *
 * Both halves of what selecting a task at a leaf must answer: every state the executor went through
 * with its session, and the session itself. Neither existed before: `sessionServicesFor` built a
 * `MapSessionStore` per run, the engine wrote every model call into it complete, and the process
 * dropped the lot — which is why `conversation.ts` could say "there is no separate transcript to
 * show" and be right.
 */
describe("sessions — the transcript a run produced", () => {
  it("keeps every state's conversation, and says which state each belongs to", async () => {
    const taskId = newTask();
    await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    await until(() => finished(taskId), "the run to finish");

    const history = service.sessionHistory({ taskId });
    // One row per operation that ran in a conversation — derived from the journal, which has carried
    // the position on `operation.completed`'s metrics all along.
    expect(history.length).toBeGreaterThan(0);
    expect(history.map((h) => h.stateId)).toContain("feature/plan/goals");
    expect(history.every((h) => h.sessionId.length > 0)).toBe(true);
    // Ordered as the run went, which is what makes it a history rather than a set.
    expect([...history].sort((a, b) => a.at - b.at).map((h) => h.instanceId)).toEqual(history.map((h) => h.instanceId));
  });

  it("says when each call BEGAN, not only when it landed", async () => {
    const taskId = newTask();
    await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    await until(() => finished(taskId), "the run to finish");

    const history = service.sessionHistory({ taskId });
    // What decides whether two conversations were running at the same time — the conversation panel
    // lays sessions out with vertical space standing for time, and a completion alone cannot say
    // whether the call before it overlapped the one beside it. See `sessionBands.ts`.
    expect(history.every((h) => h.startedAt !== undefined)).toBe(true);
    expect(history.every((h) => h.startedAt! <= h.at)).toBe(true);
  });

  it("reads one state's conversation back, whole", async () => {
    const taskId = newTask();
    await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    await until(() => finished(taskId), "the run to finish");

    const goals = service.sessionHistory({ taskId }).find((h) => h.stateId === "feature/plan/goals")!;
    const view = service.sessionView({ taskId, instanceId: goals.instanceId });

    expect(view.stateId).toBe("feature/plan/goals");
    expect(view.status).toBe("success");
    expect(view.turns.length).toBeGreaterThan(0);
    // The prompt that was sent and the answer that came back — not a summary of either.
    expect(view.turns.map((t) => t.role)).toContain("assistant");
    expect(view.empty).toBeUndefined();
  });

  it("says so rather than rendering blank when a state ran no model call", () => {
    const taskId = newTask();
    const view = service.sessionView({ taskId });
    // A queued task has run nothing. Empty is an ANSWER — a blank panel would look like a bug.
    expect(view.turns).toEqual([]);
    expect(view.empty).toMatch(/no conversation/);
  });

  /**
   * A state's transcript is what THIS state said — and that is simply what its record holds.
   *
   * This used to be a suite about SUBTRACTION: `ownMessages` dropped a leading run of messages
   * whenever a record began with the previous record's list in full, against the possibility that a
   * record carried the history it was called with rather than its own delta. Nothing writes that
   * shape — `LlmOutput.messages` is "the messages this call APPENDED", and the store's own
   * `materialize` concatenates records without subtracting anything, so a cumulative record would
   * already have been replayed into providers with its history doubled. What the subtraction did
   * instead was erase a repeated exchange: two byte-identical consecutive turns and the second one
   * was read as history and dropped. The suite went with the function.
   */
  it("reads a state's turns straight off its record, without subtracting a phantom prefix", async () => {
    const taskId = newTask();
    await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    await until(() => finished(taskId), "the run to finish");

    // Two states of one run, each with its own record on the same shared session. Neither shows the
    // other's words, and neither loses its own — which is the property the subtraction was for.
    const history = service.sessionHistory({ taskId });
    const views = history.map((h) => service.sessionView({ taskId, instanceId: h.instanceId }));
    expect(views.every((v) => v.turns.length > 0)).toBe(true);
    const first = views[0]!.turns.map((t) => t.text).join("\n");
    expect(views.slice(1).every((v) => v.turns.every((t) => t.text === undefined || !first.includes(t.text)))).toBe(true);
  });
});

/**
 * The app can say what it did.
 *
 * There was no logger, no console output and no channel: an IPC handler's failure died in a renderer
 * catch, a workflow that would not load was swallowed so the board did not blank, and an agent's
 * stderr went to `/dev/null`. Each silence is defensible alone; together a broken machine had no
 * story at all.
 */
describe("diagnostics", () => {
  it("records a failed IPC call by channel, and still rejects to the renderer", () => {
    // RECORDED, then RETHROWN — the renderer's contract is unchanged. That pair is the whole design:
    // the caller still sees the error, and everyone else can now see it too.
    service.recordIpcFailure("task:detail", new Error("unknown task 't-1'"));

    const entry = service.listLogs({ source: "ipc" }).at(-1);
    expect(entry).toMatchObject({ level: "error", source: "ipc" });
    expect(entry?.message).toBe("task:detail: unknown task 't-1'");
  });

  it("records opening a project, which is where a recovery would be reported", async () => {
    const entry = service.listLogs({ source: "project" }).at(-1);
    expect(entry?.message).toContain(dir);
  });

  it("records a child process against the task that started it", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: happyRules(), interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] } });
    await until(() => finished(taskId), "the run to finish");

    // A scripted run spawns nothing, so this asserts the SHAPE the panel links through rather than a
    // count: `taskId` opens the task and `jobId` opens what that process printed.
    const rows = service.listLogs({ source: "process" });
    for (const row of rows) expect(row.taskId).toBeDefined();
    // …and the run itself said something, which is the point of having a log at all.
    expect(service.listLogs().length).toBeGreaterThan(0);
  });

  it("returns no jobs and no output rather than throwing when nothing has run", () => {
    expect(service.listJobs({ taskId: newTask() })).toEqual([]);
    expect(service.jobOutput({ jobId: 999 })).toEqual([]);
  });
});
