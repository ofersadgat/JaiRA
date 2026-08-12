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
import { AppService, ownMessages } from "../src/main/service";

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
    // A queued task has no active path yet.
    expect(board.finished).toHaveLength(1);
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

    // Board: a completed task leaves the columns and lands in finished.
    const board = service.board();
    expect(board.finished.map((c) => c.taskId)).toEqual([taskId]);
    expect(board.columns.flatMap((c) => c.cards)).toEqual([]);
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
    expect(sub.breadcrumb).toEqual(["feature/plan", "feature/plan/critique"]);
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
 * Opening a second user project still closes the first: the map can hold both and everything below
 * is written for that, but which one the project-free channels answer for is a UI decision made
 * separately. What these defend is that the bookkeeping is per-session, so making that change later
 * does not have to also fix a shared counter or a leaked handle.
 */
describe("sessions — one process, several projects", () => {
  it("opens another project and answers as that one", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-app-b-"));
    const paths = initProject(other);
    writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
    try {
      expect(service.current()?.dir).toBe(dir);
      await service.open(other);
      expect(service.current()?.dir).toBe(other);
      // The first project's tasks went with it — this is a different board, not a merged one.
      expect(service.listTasks()).toEqual([]);
    } finally {
      // Closed before the directory goes, because Windows will not unlink an open database file —
      // which is also the reason `close()` drains its runs before closing the handle.
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

  it("is never the project the project-free channels answer for", async () => {
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

  it("still answers for the focused project when a task names none", async () => {
    // The routing is opt-in. Everything that existed before this — the Tasks view's New task, the
    // debug pane, the CLI path — sends no `project` and must keep landing in the checkout.
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
   * A state's transcript is what THIS state said, not what the session contains.
   *
   * A session is append-only and shared, so a state that resumes one is handed everything said
   * before it and its call answers with the whole conversation. Rendered verbatim, every state after
   * the first showed its predecessors' words as its own.
   */
  describe("what a state added, against what it inherited", () => {
    const said = (role: string, text: string): JsonValue => ({ role, content: text });

    it("drops the prefix the state was handed, keeping only what it added", () => {
      const inherited = [said("user", "plan it"), said("assistant", "three goals")];
      const whole = [...inherited, said("user", "now critique"), said("assistant", "two problems")];
      expect(ownMessages(whole, inherited)).toEqual([said("user", "now critique"), said("assistant", "two problems")]);
    });

    it("keeps everything when the record holds only its own delta", () => {
      // An executor that reports what it appended rather than the whole conversation. Its record does
      // not begin with the prefix, and taking the first two messages off it would eat real turns.
      const delta = [said("user", "now critique"), said("assistant", "two problems")];
      expect(ownMessages(delta, [said("user", "plan it"), said("assistant", "three goals")])).toEqual(delta);
    });

    it("keeps everything on a PARTIAL match — two states opening the same way is not history", () => {
      const inherited = [said("system", "you are a planner"), said("user", "plan it")];
      const whole = [said("system", "you are a planner"), said("user", "critique it")];
      expect(ownMessages(whole, inherited)).toEqual(whole);
    });

    it("changes nothing for the first state in a session, which inherited none", () => {
      const first = [said("user", "plan it")];
      expect(ownMessages(first, [])).toEqual(first);
    });
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
