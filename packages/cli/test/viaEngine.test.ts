/**
 * `jaira` through a running engine (decision 0012 §5-§6): with a host up, the commands that touch the
 * engine are its clients — a task is created, started with its scripted wiring, followed to its end and
 * reported there; the board is the host's. `jaira server status|stop` ask it about itself and stop it.
 * A flag only this process's engine can honour is refused rather than dropped.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppService, hostEngine, type HostedEngine } from "@jaira/service";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";
import { happyRules, HUMAN_REVIEW_FUNCTION, makePlanningProject } from "./fixtures";

let dir: string;
let hosted: HostedEngine | undefined;

beforeEach(async () => {
  dir = makePlanningProject();
  let stop: (() => Promise<void>) | undefined;
  hosted = await hostEngine({
    baseDir: testHome(),
    kind: "server",
    version: "0.1.0",
    eager: true,
    service: (publish) => new AppService({ baseDir: testHome(), publish, watchWorkflows: false }),
    stop: () => stop!(),
  });
  stop = async () => {
    await hosted?.close();
    hosted = undefined;
  };
});

afterEach(async () => {
  await hosted?.close();
  hosted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out, err };
}

const gate = JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] });

describe("jaira through a running engine", () => {
  it("creates, runs and reports a task in the host's engine", async () => {
    const created = await cli(["task", "create", "--title", "Plan", "--workflow", "feature/plan", "--inputs", '{"issue":"x"}']);
    expect(created.code).toBe(0);
    const { taskId } = JSON.parse(created.out) as { taskId: string };
    // The host's engine has it: it was made there, not in this process.
    expect(hosted!.engine().listTasks(dir).map((t) => t.taskId)).toContain(taskId);

    const started = await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);
    expect(started.err).toContain("running in jaira serve");
    expect(started.code).toBe(0);
    expect(JSON.parse(started.out)).toMatchObject({ taskId, status: "completed" });

    const board = await cli(["board", "--json"]);
    expect(board.code).toBe(0);
    expect((JSON.parse(board.out) as { finished: Array<{ taskId: string }> }).finished.map((c) => c.taskId)).toContain(taskId);

    const listed = await cli(["task", "list"]);
    expect(JSON.parse(listed.out)).toEqual(expect.arrayContaining([expect.objectContaining({ taskId, status: "completed" })]));
  });

  it("refuses --repair-turns, which only this process's engine honours", async () => {
    const created = await cli(["task", "create", "--title", "Plan", "--workflow", "feature/plan", "--inputs", '{"issue":"x"}']);
    const { taskId } = JSON.parse(created.out) as { taskId: string };
    const res = await cli(["task", "start", taskId, "--repair-turns", "2"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("--repair-turns applies only to a run in this process");
  });

  it("says who hosts the engine, and nothing once it has stopped", async () => {
    const status = await cli(["server", "status"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ running: true, via: "pipe", host: { kind: "server", pid: process.pid } });
    // `server stop` waits for the host's PROCESS to end, and this test is that process: closed directly.
    await hosted!.close();
    hosted = undefined;
    const after = await cli(["server", "status"]);
    expect(after.code).toBe(1);
    expect(JSON.parse(after.out)).toMatchObject({ running: false });
  });
});
