/**
 * The pre-run approval gate as a QUESTION rather than a message (SPEC §7.5.5).
 *
 * The behaviour under test is not "an unapproved module refuses" — `userModules.test.ts` covers
 * that, and it was never in doubt. It is that the refusal can say WHICH FILE, which is the thing an
 * unapproved module structurally cannot tell you: it contributes no symbol, so its call site fails
 * to resolve, so the bundle never loads and there is nothing left to walk. Everything here is about
 * the diagnosis surviving that.
 *
 * The line the tests defend hardest is the one between an unapproved module and a TYPO. Both fail
 * the load identically, and reporting a typo as something to approve would teach people to approve
 * their way past authoring errors.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalRequired } from "@jaira/shared";
import { moduleHash } from "@declarative-ai/hw";
import {
  beginTaskRun,
  browseWorkflows,
  createTask,
  initProject,
  openProject,
  prepareUserModules,
  resetUserModules,
  userModules,
  type Project,
} from "../src/index";

const SOURCE = `export const confidence = {
  /** @param rank blocker=3 … note=0. */
  score(rank: number): number {
    return 1 - rank / 3;
  },
};
`;

/** A one-state workflow whose only output is a call into the module above. */
const CALLER: Record<string, unknown> = {
  label: "Caller",
  inputs: { rank: { schema: { type: "integer" }, default: 0 } },
  outputs: { score: { binding: "confidence.score(.inputs.rank)", schema: { type: "number" } } },
};

let dir: string;
let base: string;
let project: Project | undefined;
let moduleFile: string;

async function open(): Promise<Project> {
  project = openProject(dir);
  // The pair a real host builds at process start. Rebuilt per test so one test's approvals — and one
  // test's directory listing — cannot leak into the next.
  await prepareUserModules(project.paths, { rebuild: true });
  return project;
}

beforeEach(() => {
  resetUserModules();
  base = mkdtempSync(join(tmpdir(), "jaira-base-"));
  process.env.JAIRA_HOME = base;
  dir = mkdtempSync(join(tmpdir(), "jaira-approve-"));
  const paths = initProject(dir);
  writeFileSync(join(paths.workflowsDir, "caller.json"), JSON.stringify(CALLER), "utf8");
  mkdirSync(join(dir, ".jaira", "functions"), { recursive: true });
  moduleFile = join(dir, ".jaira", "functions", "confidence.ts");
  writeFileSync(moduleFile, SOURCE, "utf8");
});

afterEach(() => {
  project?.close();
  project = undefined;
  resetUserModules();
  delete process.env.JAIRA_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("starting a task that calls an unapproved module", () => {
  it("raises an answerable refusal naming the file and the symbol, not a parse error", async () => {
    const p = await open();
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApprovalRequired);
    const pending = (error as ApprovalRequired).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.file).toContain("confidence.ts");
    // The call site, recovered from a load that FAILED — the whole point of the ungated index.
    expect(pending[0]!.symbols).toEqual(["confidence.score"]);
    // Never approved, so there is nothing to diff against and the question is "should this run".
    expect(pending[0]!.previousHash).toBeUndefined();
    expect(pending[0]!.source).toBe(SOURCE);
  });

  it("leaves the task startable — the refusal comes before anything is pinned", async () => {
    const p = await open();
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    await beginTaskRun(p, "t-1").catch(() => undefined);
    const runtime = p.runtime.get("t-1");
    expect(runtime?.status).toBe("queued");
    expect(runtime?.snapshotHash).toBeUndefined();
  });

  it("starts once the file is approved, so the answer is all that was missing", async () => {
    const p = await open();
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    await beginTaskRun(p, "t-1").catch(() => undefined);
    userModules()!.approvals.approve(moduleFile, moduleHash(SOURCE));
    // The rebuild the host owes: the index was built gated on an approval that did not exist.
    await prepareUserModules(p.paths, { rebuild: true });
    const started = await beginTaskRun(p, "t-1");
    expect(started.snapshotHash).toBeTruthy();
  });

  it("asks again after the file changes, and says it CHANGED rather than that it is unknown", async () => {
    const p = await open();
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    userModules()!.approvals.approve(moduleFile, moduleHash(SOURCE));
    const edited = SOURCE.replace("1 - rank / 3", "1");
    writeFileSync(moduleFile, edited, "utf8");
    await prepareUserModules(p.paths, { rebuild: true });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApprovalRequired);
    const pending = (error as ApprovalRequired).pending;
    // `previousHash` present is what turns "should this run at all" into "here is what moved".
    expect(pending[0]!.previousHash).toBe(moduleHash(SOURCE));
    expect(pending[0]!.hash).toBe(moduleHash(edited));
  });
});

describe("the line between an unapproved module and a typo", () => {
  it("does NOT ask about a name no module declares", async () => {
    writeFileSync(join(dir, ".jaira", "workflows", "caller.json"),
      JSON.stringify({ ...CALLER, outputs: { score: { binding: "confidence.nope(.inputs.rank)", schema: { type: "number" } } } }),
      "utf8");
    const p = await open();
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    // An authoring error, and it stays one. Approving `confidence.ts` would not make `nope` exist.
    expect(error).not.toBeInstanceOf(ApprovalRequired);
    expect((error as Error).message).toContain("not a known operation");
  });
});

describe("the lint surface", () => {
  it("reports the file to approve instead of the parse error it caused", async () => {
    const p = await open();
    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "caller");
    expect(entry?.needsApproval?.[0]?.file).toContain("confidence.ts");
    expect(entry?.needsApproval?.[0]?.symbols).toEqual(["confidence.score"]);
    // The load error is still there — it is what actually happened — but it is no longer the only
    // thing a reader has to go on.
    expect(entry?.loadError).toContain("not a known operation");
  });

  it("says nothing about approvals once the file is approved", async () => {
    const p = await open();
    userModules()!.approvals.approve(moduleFile, moduleHash(SOURCE));
    await prepareUserModules(p.paths, { rebuild: true });
    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "caller");
    expect(entry?.needsApproval).toBeUndefined();
    expect(entry?.loadError).toBeUndefined();
  });
});
