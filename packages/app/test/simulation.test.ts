/**
 * Trying a change before it is offered (decision 0029 §5 step 5), against a real project and the shipped
 * layer, every model call scripted.
 *
 * The improver forks the conversation where the correction was made — at the message whose reply the
 * person corrected — hands the fork the proposed files as if they were written, sends the message again
 * for one pass in a throwaway copy of the workspace, and a judge reads what it did. Nothing it tried is
 * written anywhere, and the fork and its workspace are gone when the improver has its answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, type Project } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-simulate-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const finished = (taskId: string) => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);
const project = (): Project => (service as unknown as { session(): { project: Project } }).session().project;
const journal = (taskId: string): Array<{ type: string }> => project().events.list(taskId).map((row) => row.event as { type: string });
const outputsOf = (taskId: string): Record<string, unknown> => JSON.parse(project().runtime.get(taskId)!.outputsJson ?? "{}") as Record<string, unknown>;

const SHIPPED = join(__dirname, "..", "..", "shared", "builtin", "workflows", "session.ts");
/** The shipped `session` with its reply prompt marked — what a lesson proposes, here never written. */
const edited = (mark: string): string => {
  const shipped = readFileSync(SHIPPED, "utf8");
  const out = shipped.replace(/prompt: text,(\s+)system: SYSTEM,/, `prompt: "${mark}: " + text,$1system: SYSTEM,`);
  expect(out).not.toBe(shipped);
  return out;
};
const plan = (content: string, summary = "Prefix every reply.") => ({
  lesson: true,
  rule: "Say BANANA first",
  lever: "step",
  target: "session",
  why: "A step the reply must take every time.",
  summary,
  files: [{ path: "workflows/session.ts", content }],
});

/** A conversation of three messages, the third correcting the reply to the second. */
async function talk(rules: Array<{ promptIncludes: string; output: unknown }>, messages = ["write the readme", "always say BANANA first"]): Promise<string> {
  const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
  await service.startTask({ taskId, fake: rules as never });
  await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
  let replies = 1;
  for (const message of messages) {
    await service.sendChatMessage({ taskId, instanceId: "", message });
    replies += 1;
    const want = replies;
    await eventually(() => service.sessionHistory({ taskId }).length >= want, `the reply to "${message}"`, 20_000);
  }
  return taskId;
}

describe("trying a change before it is offered (decision 0029 §5 step 5)", { timeout: 90_000 }, () => {
  const RULES = [
    { promptIncludes: "hello there", output: "hi" },
    { promptIncludes: "AGAIN: write the readme", output: "BANANA! here is the readme" },
    { promptIncludes: "EDITED: write the readme", output: "here is the readme, edited" },
    { promptIncludes: "write the readme", output: "here is the readme" },
    { promptIncludes: "always say BANANA first", output: "noted" },
  ];

  it("forks the conversation at the corrected reply's message, runs the proposed code there unwritten, in a throwaway worktree, and judges it", async () => {
    writeFileSync(join(dir, "README.md"), "# project\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Uncommitted work the conversation had: the pass starts where the conversation stood.
    writeFileSync(join(dir, "README.md"), "# project, edited\n");
    writeFileSync(join(dir, "notes.txt"), "draft\n");
    const conversation = await talk(RULES);
    const { taskId } = service.createTask({
      title: "Learn",
      workflow: "improve/lesson",
      inputs: { lesson: "Always say BANANA first", workflow: "session", context: { task: conversation }, simulate: true, approval: "return" },
    });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "## What it did with the change", output: { stillNeeded: false, why: "It says BANANA first now." } },
        { promptIncludes: "## The lesson", output: plan(edited("AGAIN")) },
      ],
    });
    await eventually(() => finished(taskId), "the improver to finish", 60_000);
    const out = outputsOf(taskId) as { status: string; tried: { simulated: boolean; message: string; before: unknown; after: unknown; version: { taken: boolean }; ended: string } };
    expect(out.status).toBe("proposed");
    expect(out.tried).toMatchObject({ simulated: true, message: "write the readme", version: { taken: true, kind: "taken" }, ended: "waiting for the next message" });
    // What it said the first time, and what it says with the change.
    expect(out.tried.before).toEqual([expect.objectContaining({ role: "assistant", text: "here is the readme" })]);
    expect(out.tried.after).toEqual([{ role: "assistant", text: "BANANA! here is the readme" }]);
    // Written nowhere: not in the project's layer.
    expect(existsSync(join(dir, ".jaira", "workflows", "session.ts"))).toBe(false);
    // The fork and its workspace are gone, and git keeps no record of the worktree.
    expect(project().tasks.list().filter((t) => t.simulation !== undefined)).toEqual([]);
    const simulations = join(project().paths.worktreesDir, "simulations");
    expect(existsSync(simulations) ? readdirSync(simulations) : []).toEqual([]);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
    // The conversation itself took nothing, and the person's uncommitted work is as they left it.
    expect(journal(conversation).some((e) => e.type === "version.adopted")).toBe(false);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# project, edited\n");
    expect(service.listTasks().map((t) => t.title).sort()).toEqual(["Learn", "Talk"]);
  });

  it("sends the change back to be written again while the person would still have had to say it, and shows the trial at the review", async () => {
    const conversation = await talk(RULES);
    const { taskId } = service.createTask({
      title: "Learn",
      workflow: "improve/lesson",
      inputs: { lesson: "Always say BANANA first", workflow: "session", context: { task: conversation }, simulate: true },
    });
    let asked: string | undefined;
    await service.startTask({
      taskId,
      fake: [
        // The judge: the first change still answers without BANANA, the second does not.
        { promptIncludes: "BANANA! here is the readme", output: { stillNeeded: false, why: "It opens with BANANA." } },
        { promptIncludes: "## What it did with the change", output: { stillNeeded: true, why: "It still opens without BANANA." } },
        // The author: once, then again with what the trial showed.
        { promptIncludes: "would STILL have had to make the correction", output: plan(edited("AGAIN"), "Prefix every reply, second try.") },
        { promptIncludes: "## The lesson", output: plan(edited("EDITED")) },
      ],
      interactions: { choose_option: [{ decision: "discard", comment: "not now" }] },
    });
    await eventually(() => finished(taskId), "the improver to finish", 60_000);
    const out = outputsOf(taskId) as { status: string; proposal: { summary: string } };
    expect(out).toMatchObject({ status: "discarded", proposal: { summary: "Prefix every reply, second try." } });
    // What the person was shown: the change, and how it did on the conversation.
    const shown = project().db.prepare(`SELECT request_json FROM operation_records WHERE task_id = ? AND request_json LIKE '%choose_option%'`).all(taskId) as Array<{ request_json: string }>;
    asked = shown.map((row) => row.request_json).join("\n");
    expect(asked).toContain("Tried first");
    expect(asked).toContain("It no longer needed the correction");
    expect(existsSync(join(dir, ".jaira", "workflows", "session.ts"))).toBe(false);
  });

  it("sends back a change the running conversation could not switch to — one that changes what its loop carries across the wait", async () => {
    const conversation = await talk(RULES);
    // A new variable alive across the wait for the next message: a running conversation cannot take it.
    const incompatible = edited("EDITED").replace("let since = 0;", "let since = 0;\n  let extra = 0;").replace("turns = turns + 1;", "turns = turns + 1;\n    extra = extra + 1;");
    const { taskId } = service.createTask({
      title: "Learn",
      workflow: "improve/lesson",
      inputs: { lesson: "Always say BANANA first", workflow: "session", context: { task: conversation }, simulate: true, approval: "return" },
    });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "## What it did with the change", output: { stillNeeded: false, why: "It opens with BANANA." } },
        { promptIncludes: "a running conversation could not switch to it", output: plan(edited("AGAIN"), "Prefix every reply, keeping what the loop carries.") },
        { promptIncludes: "## The lesson", output: plan(incompatible) },
      ],
    });
    await eventually(() => finished(taskId), "the improver to finish", 60_000);
    const out = outputsOf(taskId) as { status: string; proposal: { summary: string }; tried: { version: { kind: string }; after: unknown } };
    expect(out).toMatchObject({ status: "proposed", proposal: { summary: "Prefix every reply, keeping what the loop carries." }, tried: { version: { kind: "taken" } } });
    expect(out.tried.after).toEqual([{ role: "assistant", text: "BANANA! here is the readme" }]);
    const told = project().db.prepare(`SELECT request_json FROM operation_records WHERE task_id = ? AND request_json LIKE '%could not switch to it%'`).all(taskId) as Array<{ request_json: string }>;
    expect(told).toHaveLength(1);
  });

  it("tries a correction of the reply to the OPENING message on a fresh run of the conversation — nothing is kept before it", async () => {
    const conversation = await talk(
      [
        { promptIncludes: "AGAIN: hello there", output: "BANANA! hi" },
        { promptIncludes: "hello there", output: "hi" },
        { promptIncludes: "always say BANANA first", output: "noted" },
      ],
      ["always say BANANA first"],
    );
    const { taskId } = service.createTask({
      title: "Learn",
      workflow: "improve/lesson",
      inputs: { lesson: "Always say BANANA first", workflow: "session", context: { task: conversation }, simulate: true, approval: "return" },
    });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "## What it did with the change", output: { stillNeeded: false, why: "It opens with BANANA." } },
        { promptIncludes: "## The lesson", output: plan(edited("AGAIN")) },
      ],
    });
    await eventually(() => finished(taskId), "the improver to finish", 60_000);
    const out = outputsOf(taskId) as { tried: { simulated: boolean; message: string; after: unknown } };
    expect(out.tried).toMatchObject({ simulated: true, message: "hello there" });
    expect(JSON.stringify(out.tried.after)).toContain("BANANA! hi");
    expect(project().tasks.list().filter((t) => t.simulation !== undefined)).toEqual([]);
  });

  it("says why it could not try one: a correction made in the conversation's first message has no reply before it", async () => {
    const conversation = await talk([{ promptIncludes: "hello there", output: "hi" }], []);
    const { taskId } = service.createTask({
      title: "Learn",
      workflow: "improve/lesson",
      inputs: { lesson: "Always say BANANA first", workflow: "session", context: { task: conversation }, simulate: true, approval: "return" },
    });
    await service.startTask({ taskId, fake: [{ promptIncludes: "## The lesson", output: plan(edited("AGAIN")) }] });
    await eventually(() => finished(taskId), "the improver to finish", 60_000);
    expect(outputsOf(taskId)).toMatchObject({ status: "proposed", tried: { simulated: false, reason: expect.stringMatching(/first message/) } });
  });
});
