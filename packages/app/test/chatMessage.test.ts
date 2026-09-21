/**
 * Continuing a run's conversation by hand, against a real project.
 *
 * Every layer below this is unit-tested against fakes, which leaves exactly one thing unproven: that
 * the pieces meet. This drives the service the way the renderer will — start a real run, pick the
 * instance whose transcript is on screen, send a message — and checks that the reply lands where the
 * panel reads from. The failures it exists to catch are the integration ones: a position computed off
 * the wrong row, a snapshot that cannot be found, a child that projects under the wrong parent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { happyRules, HUMAN_REVIEW_FUNCTION, JAIRA_TOOLS, specPlanningFiles, writeWorkflowFiles, chatInstanceIdOf, isChatInstance } from "@jaira/runtime";
import { READ_ONLY_PRESET_TOOLS, type ChatSettings, type InstanceNode, type PushMessage, type PermissionMode, type ToolsetDecl } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

/** The toolset files that ship — the source of truth the built-in layer is copied from. */
const SHIPPED_TOOLSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin", "toolsets");

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-chat-"));
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

/** A finished run, and the instance whose conversation a reader would be looking at. */
async function ranTask(): Promise<{ taskId: string; instanceId: string }> {
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

  it("offers each gateable tool with what each agent route calls ITS OWN, off the executors' declarations", async () => {
    // The vocabulary holds no agent's names (decision 0007 §3): which built-in is which standard tool
    // is what an executor declares, and the composer is handed it per route — so the implementation
    // is a choice only where an agent has a built-in to choose. `readOnly` is gone; a preset names
    // the tools it lets through.
    const { taskId, instanceId } = await ranTask();
    const offered = planOf({ taskId, instanceId }).available.tools;
    expect(offered).toEqual(
      expect.arrayContaining([
        { name: "bash", natives: { "claude-code": "Bash", "claude-cli": "Bash" } },
        { name: "read_file", natives: { "claude-code": "Read", "claude-cli": "Read" } },
        { name: "write_file", natives: { "claude-code": "Write", "claude-cli": "Write" } },
        // No agent has a built-in doing this job, so there is nothing to pick.
        { name: "show_artifact" },
      ]),
    );
  });

  it("names the permission posture after the TOOLSET the map exactly is — a match, never a memory", async () => {
    // The suite runs over an empty built-in layer, so the toolsets that ship are put where a project
    // would override them: the match is the same whichever layer supplies the file.
    for (const name of ["ask-first", "read-only", "auto", "full"]) {
      for (const bucket of ["chat", "chat_control"]) {
        const file = join(dir, ".jaira", "toolsets", bucket, `${name}.json`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, readFileSync(join(SHIPPED_TOOLSETS, bucket, `${name}.json`), "utf8"));
      }
    }
    const shipped = (id: string): ToolsetDecl => JSON.parse(readFileSync(join(SHIPPED_TOOLSETS, `${id}.json`), "utf8")) as ToolsetDecl;
    const { taskId, instanceId } = await ranTask();
    const planned = (overrides?: ChatSettings) => planOf({ taskId, instanceId, ...(overrides !== undefined ? { overrides } : {}) });
    const posture = (overrides?: ChatSettings): string => planned(overrides).effective.permissions;

    // A toolset's map is reported by the toolset's name…
    expect(posture({ toolset: shipped("chat/read-only") })).toBe("read-only");
    expect(posture({ toolset: shipped("chat/full") })).toBe("full access");
    // …and one line changed makes it nobody's, which is what `custom` says.
    expect(posture({ toolset: { ...shipped("chat/read-only"), bash: "ask" } })).toBe("custom");
    const { edit: _edit, ...unticked } = shipped("chat/read-only") as Record<string, ToolsetDecl[string]>;
    expect(posture({ toolset: unticked })).toBe("custom");

    // The same map in the three legacy fields is the same toolset: read FROM the shipped file rather
    // than derived, because the file is what the match is against and the modes it gives the workflow
    // tools (decision 0005 step 6) are its own — `READ_ONLY_PRESET_TOOLS` predates them.
    const readOnly = shipped("chat/read-only") as Record<string, PermissionMode>;
    expect(posture({ tools: JAIRA_TOOLS.map((t) => t.name), permissions: { tools: { ...readOnly }, other: "deny" } })).toBe("read-only");
    // A map naming three of the seventeen is not that toolset — it is a map with the rest unticked.
    expect(posture({ tools: ["read_file", "bash", "write_file"], permissions: { tools: { ...readOnly }, other: "deny" } })).toBe("custom");

    // The card opens on the bucket whose toolset the map is, and the label is that bucket's.
    expect(planned({ toolset: shipped("chat/read-only") }).available.bucket).toBe("chat");
    const control = planned({ toolset: shipped("chat_control/ask-first") });
    expect(control.available.bucket).toBe("chat_control");
    expect(control.effective.permissions).toBe("ask first");
    expect(control.available.toolsets?.filter((t) => t.bucket === "chat_control").map((t) => [t.name, t.layer])).toEqual([
      ["ask-first", "project"],
      ["auto", "project"],
      ["full", "project"],
      ["read-only", "project"],
    ]);
    // The workflow tools are offered a line, and since step 6 something answers when one is called.
    expect(control.available.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["workflows", "start", "stop"]));
  });

  it("keeps a map as a NEW toolset — in a writable layer, under a name a reference can carry, never over another", async () => {
    const { taskId, instanceId } = await ranTask();
    const mine: ToolsetDecl = { read_file: "allow", bash: "ask", "git commit": "allow", other: "deny" };
    const saved = service.saveToolset({ bucket: "chat", name: "ask-but-commit", layer: "project", toolset: mine });
    expect(saved).toEqual({ id: "chat/ask-but-commit", bucket: "chat", name: "ask-but-commit", layer: "project", decl: mine });
    expect(JSON.parse(readFileSync(join(dir, ".jaira", "toolsets", "chat", "ask-but-commit.json"), "utf8"))).toEqual(mine);
    // The next plan lists it, and the map that was kept now reads its name.
    const plan = planOf({ taskId, instanceId, overrides: { toolset: mine } });
    expect(plan.available.toolsets?.map((t) => t.id)).toContain("chat/ask-but-commit");
    expect(plan.effective.permissions).toBe("ask-but-commit");

    // For all projects: the shared root.
    service.saveToolset({ bucket: "feature/implementation", name: "mine", layer: "base", toolset: mine });
    expect(existsSync(join(testHome(), "toolsets", "feature", "implementation", "mine.json"))).toBe(true);

    expect(() => service.saveToolset({ bucket: "chat", name: "x", layer: "system", toolset: mine })).toThrow(/read-only/);
    expect(() => service.saveToolset({ bucket: "chat", name: "ask-but-commit", layer: "project", toolset: mine })).toThrow(/already exists/);
    expect(() => service.saveToolset({ bucket: "chat", name: "../../escape", layer: "project", toolset: mine })).toThrow(/a name is/);
    expect(() => service.saveToolset({ bucket: "../up", name: "x", layer: "project", toolset: mine })).toThrow(/not a bucket/);
    expect(() => service.saveToolset({ bucket: "chat", name: "bad", layer: "project", toolset: { bash: "sometimes" } as never })).toThrow(/not a toolset/);
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
    expect(service.chatPlan({ taskId, instanceId: "no-such-instance" })).toBeNull();
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
    expect(sent.instanceId).toBe(chatInstanceIdOf(instanceId));
    expect(sent.index).toBe(0);

    // Where the panel reads from: the child must be in the tree, under the right parent.
    const detail = service.taskDetail(taskId);
    const parent = findNode(detail.instances, instanceId);
    expect(parent).toBeDefined();
    const chat = parent!.children.find((c) => c.instanceId === chatInstanceIdOf(instanceId));
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
    expect(second.index).toBe(1);

    const detail = service.taskDetail(taskId);
    const parent = findNode(detail.instances, instanceId);
    const chats = parent!.children.filter((c) => isChatInstance(c.instanceId));
    expect(chats).toHaveLength(1);
    expect(chats[0]!.index).toBe(1);
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
    expect(second.index).toBe(1);
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

/**
 * A turn that ended badly — which is what pressing stop produces, minus the timing.
 *
 * The bug this pins was one missing field: `runChatTurn` emitted `operation.failed` without the
 * call's metrics, and `session_ref` is generated from `$.metrics.sessionRef`. So the turn named no
 * position, `stateSessions` could not see it, and the conversation's end was computed as the position
 * the failed record was ALREADY HOLDING. The next message collided with it and forked — onto a branch
 * the panel does not read, so everything sent after a stop vanished, the stopped turn went with it,
 * and the fork inherited no provider handle, so the agent started a fresh session instead of
 * resuming what it had been interrupted in the middle of.
 */
describe("a turn that was stopped", () => {
  it("keeps its place, so the next message continues the same conversation", async () => {
    const { taskId, instanceId } = await ranTask();

    const stopped = await service.sendChatMessage({ taskId, instanceId, message: "do the thing", fake: [{ error: "stopped" }] });
    expect(stopped.failure).toContain("stopped");
    // The position it ended at, which is the fact the journal has to carry for anything to find it.
    expect(stopped.sessionRef).toBeDefined();

    const after = await service.sendChatMessage({ taskId, instanceId, message: "carry on then", fake: happyRules() });
    expect(after.failure).toBeUndefined();

    // The SAME conversation, one position further on — never a fork. A fork is what a collided
    // position produces, and it mints a session id nothing on screen is reading from.
    const [session, seq] = [stopped.sessionRef!.slice(0, -2), Number(stopped.sessionRef!.slice(-1))];
    expect(after.sessionRef).toBe(`${session}@${seq + 1}`);
  });

  it("appears in the session history, which is what the panel finds a conversation BY", async () => {
    const { taskId, instanceId } = await ranTask();
    await service.sendChatMessage({ taskId, instanceId, message: "the one that got stopped", fake: [{ error: "stopped" }] });
    const chat = service.sessionHistory({ taskId }).find((h) => h.instanceId === chatInstanceIdOf(instanceId));
    // Listed, and listed as what it was. Unlisted, its position was invisible and the next message
    // was sent straight into it.
    expect(chat).toBeDefined();
    expect(chat!.status).toBe("error");
  });
});

/** Depth-first by instance id — the projection's tree is only navigable downward. */
function findNode(roots: readonly InstanceNode[], id: string): InstanceNode | undefined {
  for (const node of roots) {
    if (node.instanceId === id) return node;
    const found = findNode(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}
