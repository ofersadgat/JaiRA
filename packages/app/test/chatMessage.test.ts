/**
 * Continuing a run's conversation by hand, against a real project.
 *
 * Every layer below this is unit-tested against fakes, which leaves exactly one thing unproven: that
 * the pieces meet. This drives the service the way the renderer will — start a real run, pick the
 * instance whose transcript is on screen, send a message — and checks that the reply lands where the
 * panel reads from. The failures it exists to catch are the integration ones: a position computed off
 * the wrong row, a snapshot that cannot be found, a child that projects under the wrong parent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { happyRules, HUMAN_REVIEW_FUNCTION, specPlanningFiles, writeWorkflowFiles, CHAT_INSTANCE_BASE } from "@jaira/runtime";
import type { InstanceNode, PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-chat-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m) });
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

/** A finished run, and the instance whose conversation a reader would be looking at. */
async function ranTask(): Promise<{ taskId: string; instanceId: number }> {
  const { taskId } = service.createTask({ title: "Plan it", workflow: "feature/plan", inputs: { issue: "the issue" } });
  await service.startTask({
    taskId,
    fake: happyRules(),
    interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
  });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
  // Whichever instance actually held a conversation — the same row `sessionView` reads, which is what
  // the panel is showing when somebody types.
  const history = service.sessionHistory({ taskId });
  const row = history.at(-1);
  if (row === undefined) throw new Error("the run recorded no conversation to continue");
  return { taskId, instanceId: row.instanceId };
}

/**
 * A plan that must exist, for the tests about what one CONTAINS.
 *
 * `chatPlan` answers `null` for a state that holds no conversation, so every reader now has to say
 * which of the two questions it is asking. These are asking about a state that certainly speaks, and
 * a `null` here would mean the fixture broke rather than the assertion below being wrong — so it
 * fails with that, instead of with `Cannot read property 'origin' of null` twelve lines later.
 */
function planOf(request: Parameters<AppService["chatPlan"]>[0]): NonNullable<ReturnType<AppService["chatPlan"]>> {
  const plan = service.chatPlan(request);
  if (plan === null) throw new Error(`instance ${request.instanceId} unexpectedly holds no conversation`);
  return plan;
}

describe("the settings a message would run under", () => {
  it("are the ones the run actually used, read from its pinned snapshot", async () => {
    const { taskId, instanceId } = await ranTask();
    const plan = planOf({ taskId, instanceId });
    // Inherited rather than defaulted: the state that wrote the transcript names the model, and a
    // continuation calling something else would make the record two agents pretending to be one.
    expect(plan.origin.model).toBe("inherited");
    expect(plan.settings.model).toBeDefined();
    expect(plan.from).toBeDefined();
  });

  it("lets the composer override one without losing the rest", async () => {
    const { taskId, instanceId } = await ranTask();
    const plan = planOf({ taskId, instanceId, overrides: { model: "picked/model" } });
    expect(plan.settings.model).toBe("picked/model");
    expect(plan.origin.model).toBe("override");
  });

  it("offers each gateable tool with what it can DO, which is what a preset reads", async () => {
    // `readOnly` per tool is how `read-only` assigns a mode without knowing tool names — so a tool
    // added later is classified by what it does rather than by somebody remembering a list.
    const { taskId, instanceId } = await ranTask();
    const offered = planOf({ taskId, instanceId }).available.tools;
    expect(offered).toEqual(
      expect.arrayContaining([
        { name: "bash", readOnly: false },
        { name: "read_file", readOnly: true },
        { name: "write_file", readOnly: false },
      ]),
    );
  });

  it("names the permission posture after the per-tool MAP, which is what reaches the executor", async () => {
    const { taskId, instanceId } = await ranTask();
    const posture = (permissions?: Parameters<typeof service.chatPlan>[0]["overrides"]) =>
      planOf({ taskId, instanceId, ...(permissions !== undefined ? { overrides: permissions } : {}) }).effective.permissions;

    // Nothing set: every tool falls to the ledger's own last resort.
    expect(posture()).toBe("ask first");
    // A preset's modes are reported by the preset's name…
    const readOnly = { bash: "deny", read_file: "allow", write_file: "deny" } as const;
    expect(posture({ permissions: { tools: { ...readOnly } } })).toBe("read-only");
    // …and one tool changed makes it nobody's preset, which is what `custom` says.
    expect(posture({ permissions: { tools: { ...readOnly, bash: "ask" } } })).toBe("custom");
  });

  it("ANSWERS null for a COMPOSITE rather than failing at being asked", async () => {
    // A composite orchestrates and says nothing: no session, no position. Its ancestors are
    // composites too — a state that speaks has no children to be an ancestor of — so there is
    // nothing to walk out to. Saying so is what lets the composer disable itself instead of
    // offering a send that fails.
    //
    // `null` and NOT a throw, which is the fix this asserts. Planning is a question, and "there is
    // no conversation here" is one of its two ordinary answers — a workflow is half composites, so
    // throwing wrote a stack trace into the main log every time one was selected, for a condition
    // the composer was already rendering calmly as a disabled box.
    const { taskId } = await ranTask();
    const root = service.taskDetail(taskId).instances[0]!;
    expect(root.children.length).toBeGreaterThan(0); // it really is a composite
    expect(service.chatPlan({ taskId, instanceId: root.instanceId })).toBeNull();
  });

  it("still answers null, not a plan, for an instance this run does not have", async () => {
    // The renderer holds an instance id from a projection main may have re-read since, so a
    // selection one refresh stale lands here routinely. Ordinary, therefore not an error.
    const { taskId } = await ranTask();
    expect(service.chatPlan({ taskId, instanceId: 999_999 })).toBeNull();
  });

  it("keeps SENDING a refusal, because a typed message deserves a reason", async () => {
    // The other half of the same change. Asking whether you can type here may answer no; pressing
    // Enter and being told nothing would leave the message to vanish silently.
    const { taskId } = await ranTask();
    const root = service.taskDetail(taskId).instances[0]!;
    await expect(
      service.sendChatMessage({ taskId, instanceId: root.instanceId, message: "hello", fake: happyRules() }),
    ).rejects.toThrow(/not part of any conversation/);
  });
});

describe("sending a message", () => {
  it("records a reply as a child of the instance being read", async () => {
    const { taskId, instanceId } = await ranTask();
    const sent = await service.sendChatMessage({
      taskId,
      instanceId,
      message: "why did you pick that approach?",
      // The run is scripted, so the continuation is too — otherwise this needs a provider. Same
      // executor path either way; only the leaf differs.
      fake: happyRules(),
    });

    expect(sent.failure).toBeUndefined();
    expect(sent.instanceId).toBe(CHAT_INSTANCE_BASE + instanceId);
    expect(sent.iteration).toBe(0);

    // Where the panel reads from: the child must be in the tree, under the right parent.
    const detail = service.taskDetail(taskId);
    const parent = findNode(detail.instances, instanceId);
    expect(parent).toBeDefined();
    const chat = parent!.children.find((c) => c.instanceId === CHAT_INSTANCE_BASE + instanceId);
    expect(chat).toBeDefined();
    expect(chat!.childKey).toBe("ask");
    expect(chat!.superseded).toBe(false);
  });

  it("continues the conversation rather than starting one beside it", async () => {
    const { taskId, instanceId } = await ranTask();
    const first = await service.sendChatMessage({ taskId, instanceId, message: "one", fake: happyRules() });
    const second = await service.sendChatMessage({ taskId, instanceId, message: "two", fake: happyRules() });

    // The second message reopens the SAME node at the next iteration. A new instance under this key
    // would supersede the first and the panel filters those out.
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.iteration).toBe(1);

    const detail = service.taskDetail(taskId);
    const parent = findNode(detail.instances, instanceId);
    const chats = parent!.children.filter((c) => c.instanceId >= CHAT_INSTANCE_BASE);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.iteration).toBe(1);
  });

  it("continues the conversation when the REPLY is what was addressed, rather than nesting inside it", async () => {
    // Clicking the answer on screen and typing is the ordinary way to carry on. The chat child is
    // recorded under its host's state id, so it passes the "does this state speak" test on the state
    // alone — and matching it would mount a second conversation inside the first, at iteration 0,
    // under `2_000_000 + n`. A chat child IS a conversation; it does not host one.
    const { taskId, instanceId } = await ranTask();
    const first = await service.sendChatMessage({ taskId, instanceId, message: "one", fake: happyRules() });
    const second = await service.sendChatMessage({ taskId, instanceId: first.instanceId, message: "two", fake: happyRules() });

    expect(second.instanceId).toBe(first.instanceId);
    expect(second.iteration).toBe(1);
    // And the plan for the reply is the HOST's plan — same state, same inherited settings.
    expect(planOf({ taskId, instanceId: first.instanceId }).from).toBe(planOf({ taskId, instanceId }).from);
  });

  it("does not move the task's status — a conversation is not a second execution", async () => {
    const { taskId, instanceId } = await ranTask();
    const before = service.listTasks().find((t) => t.taskId === taskId)!.status;
    await service.sendChatMessage({ taskId, instanceId, message: "hello", fake: happyRules() });
    expect(service.listTasks().find((t) => t.taskId === taskId)!.status).toBe(before);
  });

  it("hands over every tool the composer offers — all of them registered, none of them fatal", async () => {
    // `gateTools` throws on a name it cannot resolve, which is the right answer for a name nobody
    // registered and the wrong one for a wiring gap. `sendChatMessage` registered `bash` only, so
    // ticking a file tool — offered by the very same plan — threw `not registered` and the turn never
    // ran. Granting all three is the assertion that the two halves of the registry are both wired.
    const { taskId, instanceId } = await ranTask();
    const offered = planOf({ taskId, instanceId }).available.tools.map((t) => t.name);
    const sent = await service.sendChatMessage({
      taskId,
      instanceId,
      message: "have a look around",
      overrides: {
        tools: offered,
        // Denied outright, so the turn cannot actually reach a shell from a test — the point here is
        // that resolving the tools succeeds at all.
        permissions: { tools: Object.fromEntries(offered.map((name) => [name, "deny" as const])) },
      },
      fake: happyRules(),
    });
    expect(sent.failure).toBeUndefined();
  });

  it("refuses an empty message rather than sending a turn that says nothing", async () => {
    const { taskId, instanceId } = await ranTask();
    await expect(service.sendChatMessage({ taskId, instanceId, message: "   " })).rejects.toThrow(/cannot be empty/);
  });
});

/** Depth-first by instance id — the projection's tree is only navigable downward. */
function findNode(roots: readonly InstanceNode[], id: number): InstanceNode | undefined {
  for (const node of roots) {
    if (node.instanceId === id) return node;
    const found = findNode(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}
