/**
 * A script run as a plain program REPORTS here (decision 0029, ruling 12): declarative-ai's own client
 * and standalone host (`@declarative-ai/script`) against this engine's script endpoint. The run is a
 * task — its calls written in as any run's are, its agents' tool uses decided by the permission set the
 * script declares — and it cannot be resumed. Nothing reaches a model: the program's calls are scripted.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, type Project } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { eventually, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { startScriptEndpoint, type ScriptEndpoint } from "../../service/src/scriptEndpoint";

/** declarative-ai's script package, from its sources beside this checkout. */
type ScriptPackage = typeof import("../../../../declarative-ai/packages/script/src/index");
const scriptPackage = (): Promise<ScriptPackage> => import(pathToFileURL(join(__dirname, "..", "..", "..", "..", "declarative-ai", "packages", "script", "src", "index.ts")).href) as Promise<ScriptPackage>;

let dir: string;
let service: AppService;
let endpoint: ScriptEndpoint;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-reported-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
  endpoint = await startScriptEndpoint({ engine: () => service, baseDir: testHome(), version: "test", advertDir: join(testHome(), "dai", "endpoints") });
});

afterEach(async () => {
  await endpoint.close();
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const project = (): Project => (service as unknown as { session(): { project: Project } }).session().project;
const env = (): NodeJS.ProcessEnv => ({ DAI_HOME: join(testHome(), "dai") });
const run = (file: string, meta?: Record<string, unknown>) => ({ file: join(dir, file), args: ["first"], cwd: dir, pid: process.pid, ...(meta !== undefined ? { meta } : {}) });

describe("a script run as a program, reported here (ruling 12)", { timeout: 60_000 }, () => {
  it("is advertised where declarative-ai looks, and taken by its client", async () => {
    const { findEndpoints } = await scriptPackage();
    const found = findEndpoints(env());
    expect(found).toEqual([expect.objectContaining({ name: "JaiRA", socket: endpoint.socket, protocol: 1, pid: process.pid })]);
    expect(JSON.parse(readFileSync(endpoint.advert, "utf8"))).toMatchObject({ name: "JaiRA", version: "test" });
  });

  it("is a task: each call written in as a run's, a conversation continued where it ended, and how the run ended", async () => {
    const { connectReport, findEndpoints, createStandaloneHost } = await scriptPackage();
    const report = (await connectReport(findEndpoints(env())[0]!, run("chat.ts", { name: "Chat" })))!;
    expect(report).toMatchObject({ name: "JaiRA" });
    const taskId = report.run;
    let n = 0;
    const host = createStandaloneHost({ model: "test/model", execute: async () => ({ value: `reply ${++n}`, costUsd: 0.02 }), write: () => undefined, report });
    const one = (await host.llm({ prompt: "first", withSession: true }, undefined)) as { value: string; session: { id: string } };
    await host.llm({ prompt: "second", session: one.session, withSession: true }, undefined);
    host.phase("talking");
    expect(service.listTasks().find((t) => t.taskId === taskId)).toMatchObject({ title: "Chat", workflow: "chat", status: "running" });
    // Both calls are records of the task, the second continuing the conversation the first ended at.
    const history = service.sessionHistory({ taskId });
    expect(history).toHaveLength(2);
    expect(new Set(history.map((h) => h.sessionId)).size).toBe(1);
    const said = JSON.stringify(project().db.prepare(`SELECT result_json FROM operation_records WHERE task_id = ?`).all(taskId));
    expect(said).toContain("reply 1");
    expect(said).toContain("reply 2");
    await report.end({ value: ["reply 1", "reply 2"] });
    report.close();
    await eventually(() => project().runtime.get(taskId)?.status === "completed", "the run to end", 10_000);
    expect(JSON.parse(project().runtime.get(taskId)!.outputsJson!)).toEqual({ value: ["reply 1", "reply 2"] });
    expect(project().tasks.read(taskId).reported).toMatchObject({ file: join(dir, "chat.ts"), cwd: dir });
  });

  it("decides each tool an agent wants under the permission set the script declares — and a person, where it asks", async () => {
    const { connectReport, findEndpoints, createStandaloneHost } = await scriptPackage();
    const report = (await connectReport(findEndpoints(env())[0]!, run("work.ts", { environment: { tools: { read_file: "allow", shell: "deny", write_file: "ask", other: "deny" } } })))!;
    const answers: unknown[] = [];
    const agentQuery = ((opts: { canUseTool?: (req: { toolName: string; input: unknown }, o: { signal: AbortSignal }) => Promise<unknown> }) =>
      (async function* () {
        const ask = (toolName: string, input: unknown) => opts.canUseTool!({ toolName, input }, { signal: new AbortController().signal });
        answers.push(await ask("Read", { file_path: join(dir, "README.md") }));
        answers.push(await ask("Bash", { command: "rm -rf /" }));
        answers.push(await ask("Write", { file_path: join(dir, "notes.md"), content: "x" }));
        yield { type: "result", result: { text: "done", costUsd: 0 } };
      })()) as never;
    const host = createStandaloneHost({ agentQuery, write: () => undefined, report, cwd: dir });
    const working = host.agent("tidy up", {}, undefined);
    // The write ASKS: put to the person on the task, as a run's call is.
    const approvals = (service as unknown as { session(): { approvals: { list(): Array<{ requestId: string; taskId?: string; tool: string }>; decide(id: string, d: "allow" | "deny"): boolean } } }).session().approvals;
    await eventually(() => approvals.list().some((r) => r.taskId === report.run), "the write to be asked", 10_000);
    approvals.decide(approvals.list().find((r) => r.taskId === report.run)!.requestId, "allow");
    expect(await working).toBe("done");
    expect(answers).toEqual([{ allow: true }, expect.objectContaining({ allow: false }), { allow: true }]);
    report.close();
  });

  it("ends interrupted when its program goes away without saying, and cannot be resumed", async () => {
    const { connectReport, findEndpoints } = await scriptPackage();
    const report = (await connectReport(findEndpoints(env())[0]!, run("chat.ts")))!;
    report.close();
    await eventually(() => project().runtime.get(report.run)?.status === "interrupted", "the run to be interrupted", 10_000);
    await expect(service.resumeTask({ taskId: report.run })).rejects.toThrow(/cannot be resumed — run the script again/);
  });

  it("is refused for a directory in no project, and the program runs unreported", async () => {
    const { connectReport, findEndpoints } = await scriptPackage();
    const elsewhere = mkdtempSync(join(tmpdir(), "jaira-noproject-"));
    expect(await connectReport(findEndpoints(env())[0]!, { file: join(elsewhere, "x.ts"), args: [], cwd: elsewhere, pid: process.pid })).toBeUndefined();
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
