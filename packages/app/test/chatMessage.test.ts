/**
 * Typing into a conversation, against a real project — what the composer offers, and what a message does.
 *
 * Every layer below this is unit-tested against fakes, which leaves exactly one thing unproven: that
 * the pieces meet. This drives the service the way the renderer does. The composer's settings are
 * planned for whichever instance is on screen — a run's state that spoke, read off its pinned
 * snapshot. A message goes to a conversation that is a PROGRAM (decision 0029 §2) — the shipped
 * `session`, a loop over `input()` — as the answer to its `input()`, and the reply is the run's next
 * call, on the same chain; a run that is not one takes no message, and says so. The failures it exists
 * to catch are the integration ones: a position computed off the wrong row, a snapshot that cannot be
 * found, a reply that lands somewhere the panel does not read.
 *
 * Every model call is scripted (`fake`): the rules a run starts with answer every call it makes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { happyRules, HUMAN_REVIEW_FUNCTION, JAIRA_TOOLS, specPlanningFiles, writeWorkflowFiles, type FakeRule } from "@jaira/runtime";
import { resolvePermissionSetDecl, subjectKindOf, type ChatSettings, type PushMessage, type PermissionMode, type PermissionSetDecl } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

/** The permission set files that ship — the source of truth the built-in layer is copied from. */
const SHIPPED_PERMISSION_SETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin", "permission-sets");

let dir: string;
let service: AppService;
let pushes: PushMessage[];

/**
 * A project and the service over it. `shipped`: on what JaiRA really ships (`shippedLayer`), where the
 * Chat view's conversation — the `session` program — is; otherwise on the suite's empty built-in layer,
 * with the spec-planning workflow written into the project.
 */
async function openProject(shipped: boolean): Promise<void> {
  if (shipped) shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-chat-"));
  const paths = initProject(dir, testHome());
  if (!shipped) writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
}

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

/** The program waits at its `input()` for the next message — between replies, idle. */
const parked = (taskId: string): boolean =>
  (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
    .session()
    .hub.list()
    .some((r) => r.component === "input" && r.taskId === taskId);

/** The program's replies so far — one per message it answered, whether the call settled or failed. */
const replies = (taskId: string): number => service.sessionHistory({ taskId }).length;

/** What the model answers each message. */
const SCRIPT: FakeRule[] = [
  { promptIncludes: "hello there", output: "hi" },
  { promptIncludes: "one", output: "the first reply" },
  { promptIncludes: "two", output: "the second reply" },
  { promptIncludes: "hello", output: "hello back" },
  { promptIncludes: "have a look around", output: "looked" },
];

/** A conversation as the Chat view starts one, its opening reply in, waiting for the next message. */
async function conversation(fake: FakeRule[] = SCRIPT): Promise<string> {
  const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
  await service.startTask({ taskId, fake });
  await eventually(() => replies(taskId) >= 1 && parked(taskId), "the opening reply", 20_000);
  return taskId;
}

/** Send a message and wait for its reply, and for the program to wait again. */
async function send(taskId: string, message: string, extra: { instanceId?: string; overrides?: ChatSettings } = {}): Promise<void> {
  const before = replies(taskId);
  const sent = await service.sendChatMessage({ taskId, instanceId: extra.instanceId ?? "", message, ...(extra.overrides !== undefined ? { overrides: extra.overrides } : {}) });
  // Taken by the program: the answer to its `input()`, never a turn beside the run.
  expect(sent).toMatchObject({ program: true });
  await eventually(() => replies(taskId) > before && parked(taskId), `the reply to "${message}"`, 20_000);
}

describe("the settings a message would run under", () => {
  beforeEach(() => openProject(false));

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
        // Codex is served ours over its bridge, so keeping its own shell is a pick on its line too.
        { name: "shell", natives: { "claude-code": "Bash", "claude-cli": "Bash", "codex-cli": "shell" } },
        { name: "read_file", natives: { "claude-code": "Read", "claude-cli": "Read" } },
        { name: "write_file", natives: { "claude-code": "Write", "claude-cli": "Write" } },
        // Claude Code's own publishes to claude.ai (decision 0020), so there is nothing to pick.
        { name: "show_artifact" },
      ]),
    );
  });

  it("names the permission posture after the PERMISSION_SET the map exactly is — a match, never a memory", async () => {
    // The suite runs over an empty built-in layer, so the permission sets that ship are put where a project
    // would override them: the match is the same whichever layer supplies the file. Each stands on a
    // security profile it names in what ships (`"layers": ["$SYSTEM/permission-sets/security/…"]`,
    // 2026-11-25), so what ships is put back under them for the profiles to be read — and the project
    // opened again, whose layers were resolved before it was.
    await service.close();
    shippedLayer();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    for (const id of ["ask-first", "read-only", "auto", "full", "improve/simulation"]) {
      const file = join(dir, ".jaira", "permission-sets", `${id}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, readFileSync(join(SHIPPED_PERMISSION_SETS, `${id}.json`), "utf8"));
    }
    const shipped = (id: string): PermissionSetDecl => JSON.parse(readFileSync(join(SHIPPED_PERMISSION_SETS, `${id}.json`), "utf8")) as PermissionSetDecl;
    const { taskId, instanceId } = await ranTask();
    const planned = (overrides?: ChatSettings) => planOf({ taskId, instanceId, ...(overrides !== undefined ? { overrides } : {}) });
    const posture = (overrides?: ChatSettings): string => planned(overrides).effective.permissions;

    // A permission set's map is reported by the permission set's name…
    expect(posture({ permissionSet: shipped("read-only") })).toBe("read-only");
    expect(posture({ permissionSet: shipped("full") })).toBe("full access");
    // …and one line changed makes it nobody's, which is what `custom` says.
    expect(posture({ permissionSet: { ...shipped("read-only"), shell: "ask" } })).toBe("custom");
    const { edit: _edit, ...unticked } = shipped("read-only") as Record<string, PermissionSetDecl[string]>;
    expect(posture({ permissionSet: unticked })).toBe("custom");

    // The same map as the lowered fields a state's declaration arrives as is the same permission set: read FROM the shipped file rather
    // than derived, because the file is what the match is against and the modes it gives the workflow
    // tools (decision 0005 step 6) are its own — `READ_ONLY_PRESET_TOOLS` predates them.
    // Its command, runner and script lines arrive where lowering writes them, in `subjects`. What a state
    // is handed is the set RESOLVED — the security profile it stands on (`security/guarded`) merged in.
    const readOnly = resolvePermissionSetDecl(
      shipped("read-only"),
      (reference) => ({ value: shipped(reference.replace("$SYSTEM/permission-sets/", "")), key: reference, from: reference }),
      "",
      [],
    ) as Record<string, PermissionMode>;
    const shellLine = (subject: string): boolean => subject === "shell" || ["command", "script", "runner"].includes(subjectKindOf(subject));
    // A command line written as a place map (guarded's `rm -r` by where it removes) arrives under `places`.
    const commandPlaces = (subject: string): boolean => subject !== "shell" && shellLine(subject) && typeof readOnly[subject] === "object";
    const subjects = Object.fromEntries(Object.entries(readOnly).filter(([subject]) => shellLine(subject) && !commandPlaces(subject)));
    const places = Object.fromEntries(Object.entries(readOnly).filter(([subject]) => commandPlaces(subject))) as unknown as Record<string, Record<string, PermissionMode>>;
    const toolLines = Object.fromEntries(Object.entries(readOnly).filter(([subject]) => subject === "shell" || !shellLine(subject)));
    expect(posture({ tools: JAIRA_TOOLS.map((t) => t.name), permissions: { tools: toolLines, other: "deny", subjects, places } })).toBe("read-only");
    // A map naming three of the seventeen is not that permission set — it is a map with the rest unticked.
    expect(posture({ tools: ["read_file", "shell", "write_file"], permissions: { tools: toolLines, other: "deny", subjects, places } })).toBe("custom");

    // The card opens on the bucket whose permission set the map is, and the label is that bucket's: the top level's is "".
    expect(planned({ permissionSet: shipped("read-only") }).available.bucket).toBe("");
    const bucketed = planned({ permissionSet: shipped("improve/simulation") });
    expect(bucketed.available.bucket).toBe("improve");
    // A set JaiRA has no words for is called by its file's name.
    expect(bucketed.effective.permissions).toBe("simulation");
    expect(bucketed.available.permissionSets?.filter((t) => t.bucket === "improve").map((t) => [t.name, t.layer])).toEqual([["simulation", "project"]]);
    // The workflow tools are offered a line, and since step 6 something answers when one is called.
    expect(bucketed.available.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_workflows", "start_task", "stop_task"]));
  });

  it("keeps a map as a NEW permission set — in a writable layer, under a name a reference can carry, never over another", async () => {
    const { taskId, instanceId } = await ranTask();
    const mine: PermissionSetDecl = { read_file: "allow", shell: "ask", "git commit": "allow", other: "deny" };
    const saved = service.savePermissionSet({ bucket: "chat", name: "ask-but-commit", layer: "project", permissionSet: mine });
    expect(saved).toEqual({ id: "chat/ask-but-commit", bucket: "chat", name: "ask-but-commit", layer: "project", decl: mine });
    expect(JSON.parse(readFileSync(join(dir, ".jaira", "permission-sets", "chat", "ask-but-commit.json"), "utf8"))).toEqual(mine);
    // The next plan lists it, and the map that was kept now reads its name.
    const plan = planOf({ taskId, instanceId, overrides: { permissionSet: mine } });
    expect(plan.available.permissionSets?.map((t) => t.id)).toContain("chat/ask-but-commit");
    expect(plan.effective.permissions).toBe("ask-but-commit");

    // For all projects: the shared root.
    service.savePermissionSet({ bucket: "feature/implementation", name: "mine", layer: "base", permissionSet: mine });
    expect(existsSync(join(testHome(), "permission-sets", "feature", "implementation", "mine.json"))).toBe(true);

    expect(() => service.savePermissionSet({ bucket: "chat", name: "x", layer: "system", permissionSet: mine })).toThrow(/read-only/);
    expect(() => service.savePermissionSet({ bucket: "chat", name: "ask-but-commit", layer: "project", permissionSet: mine })).toThrow(/already exists/);
    expect(() => service.savePermissionSet({ bucket: "chat", name: "../../escape", layer: "project", permissionSet: mine })).toThrow(/a name is/);
    expect(() => service.savePermissionSet({ bucket: "../up", name: "x", layer: "project", permissionSet: mine })).toThrow(/not a bucket/);
    expect(() => service.savePermissionSet({ bucket: "chat", name: "bad", layer: "project", permissionSet: { shell: 7 } as never })).toThrow(/not a permission set/);
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
    // Enter and being told nothing would leave the message to vanish silently. A run that is not a
    // program waits for no message — not at its composite root, and not at the state that spoke.
    const { taskId, instanceId } = await ranTask();
    const root = service.taskDetail(taskId).instances[0]!;
    for (const at of [root.instanceId, instanceId]) {
      await expect(service.sendChatMessage({ taskId, instanceId: at, message: "hello", fake: happyRules() })).rejects.toThrow(
        /takes no more messages: it is not a program that waits for them/,
      );
    }
  });
});

describe("sending a message to a conversation", { timeout: 60_000 }, () => {
  beforeEach(() => openProject(true));

  it("continues the conversation rather than starting one beside it", async () => {
    const taskId = await conversation();
    await send(taskId, "one");
    await send(taskId, "two");
    // Every reply is the next position of ONE conversation — never a second one beside it, and never a
    // branch of it, either of which the panel would show as a separate conversation or not at all.
    const history = service.sessionHistory({ taskId });
    expect(new Set(history.map((h) => h.sessionId)).size).toBe(1);
    expect(history.map((h) => h.seq)).toEqual([0, 1, 2]);
    expect(history.every((h) => h.branch === undefined)).toBe(true);
    expect(service.chatThread({ taskId })!.session.turns.map((t) => t.text)).toEqual(["hello there", "hi", "one", "the first reply", "two", "the second reply"]);
    service.cancelTask(taskId);
  });

  it("continues the conversation when the REPLY is what was addressed, rather than nesting inside it", async () => {
    // Clicking the answer on screen and typing is the ordinary way to carry on. The reply is a call
    // state of the program, below its root — and addressing it must reach the same conversation, not
    // mount a second one inside it.
    const taskId = await conversation();
    const reply = service.sessionHistory({ taskId })[0]!.instanceId;
    const thread = service.chatThread({ taskId })!;
    expect(reply).not.toBe(thread.instanceId);
    await send(taskId, "one", { instanceId: reply });
    const history = service.sessionHistory({ taskId });
    expect(history).toHaveLength(2);
    expect(new Set(history.map((h) => h.sessionId)).size).toBe(1);
    expect(service.chatThread({ taskId })!.session.turns.map((t) => t.text)).toEqual(["hello there", "hi", "one", "the first reply"]);
    // And the plan for the reply is the conversation's — the same inherited settings.
    expect(planOf({ taskId, instanceId: reply }).settings).toEqual(planOf({ taskId, instanceId: thread.instanceId }).settings);
    service.cancelTask(taskId);
  });

  it("does not move the task's status — waiting for the next message is not a second execution", async () => {
    const taskId = await conversation();
    const before = service.listTasks().find((t) => t.taskId === taskId)!.status;
    expect(before).toBe("completed");
    await send(taskId, "hello");
    expect(service.listTasks().find((t) => t.taskId === taskId)!.status).toBe(before);
    service.cancelTask(taskId);
  });

  it("hands over every tool the composer offers — all of them registered, none of them fatal", async () => {
    // A tool the composer offers that the run cannot resolve would throw `not registered` when the
    // message's set is handed to the run, and the reply would never be made. Granting all of them —
    // offered by the very same plan — is the assertion that the two halves of the registry are wired.
    const taskId = await conversation();
    const offered = planOf({ taskId, instanceId: service.chatThread({ taskId })!.instanceId }).available.tools.map((t) => t.name);
    await send(taskId, "have a look around", {
      overrides: {
        tools: offered,
        // Denied outright, so the reply cannot actually reach a shell from a test — the point here is
        // that resolving the tools succeeds at all.
        permissions: { tools: Object.fromEntries(offered.map((name) => [name, "deny" as const])) },
      },
    });
    expect(service.sessionHistory({ taskId }).at(-1)!.status).toBe("success");
    expect(service.chatThread({ taskId })!.session.turns.at(-1)?.text).toBe("looked");
    service.cancelTask(taskId);
  });

  it("refuses an empty message rather than sending a reply that says nothing", async () => {
    const taskId = await conversation();
    await expect(service.sendChatMessage({ taskId, instanceId: "", message: "   " })).rejects.toThrow(/cannot be empty/);
    expect(replies(taskId)).toBe(1);
    service.cancelTask(taskId);
  });
});

/**
 * A reply that ended badly — which is what pressing stop on a transport that can only cancel
 * produces, minus the timing. The program catches it and waits for the next message.
 */
describe("a reply that was stopped", { timeout: 60_000 }, () => {
  beforeEach(() => openProject(true));

  it("keeps its place, so the next message continues the same conversation", async () => {
    const taskId = await conversation([
      { promptIncludes: "hello there", output: "hi" },
      { promptIncludes: "do the thing", error: "stopped" },
      { promptIncludes: "carry on then", output: "carrying on" },
    ]);
    await send(taskId, "do the thing");
    await send(taskId, "carry on then");
    // The SAME conversation, one position further on — never a fork, and never over the stopped reply:
    // the failed call's record keeps its seat, and the next one is the seat after it.
    const history = service.sessionHistory({ taskId });
    expect(history.map((h) => h.status)).toEqual(["success", "error", "success"]);
    expect(new Set(history.map((h) => h.sessionId)).size).toBe(1);
    expect(history.map((h) => h.seq)).toEqual([0, 1, 2]);
    service.cancelTask(taskId);
  });

  it("appears in the session history, which is what the panel finds a conversation BY", async () => {
    const taskId = await conversation([
      { promptIncludes: "hello there", output: "hi" },
      { promptIncludes: "the one that got stopped", error: "stopped" },
    ]);
    await send(taskId, "the one that got stopped");
    const history = service.sessionHistory({ taskId });
    // Listed, and listed as what it was — in the same conversation as the reply before it.
    expect(history).toHaveLength(2);
    expect(history[1]!.status).toBe("error");
    expect(history[1]!.sessionId).toBe(history[0]!.sessionId);
    service.cancelTask(taskId);
  });
});
