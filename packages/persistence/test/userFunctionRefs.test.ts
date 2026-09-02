/**
 * A run finds its module functions whether or not loading resolved them (SPEC §7.5).
 *
 * `UserFunctions.entries` is filled by RESOLUTION, and resolution happens while a bundle LOADS. Two
 * ordinary starts skip that: a task pinned to a snapshot reads the resolved definition back, and a
 * pair rebuilt after an approval begins empty. A host that merged `entries` into its registry at
 * such a start merged nothing, and the run failed at its first call with "no function is
 * registered" about a function it had approved and frozen. The property defended here is that a
 * host can ask for the bundle's references by name and get the entries the loader would have made.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { moduleHash, type WorkflowBundle } from "@declarative-ai/hw";
import {
  beginTaskRun,
  createTask,
  finishTaskRun,
  initProject,
  openProject,
  prepareUserModules,
  resetUserModules,
  resolveUserFunctions,
  userFunctionRefsOf,
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

const CALLER: Record<string, unknown> = {
  label: "Caller",
  inputs: { rank: { schema: { type: "integer" }, default: 0 } },
  outputs: { score: { binding: "confidence.score(.inputs.rank)", schema: { type: "number" } } },
};

describe("userFunctionRefsOf", () => {
  const bundleWith = (refs: readonly string[]): WorkflowBundle =>
    ({
      rootId: "root",
      states: {
        root: {
          id: "root",
          outputs: Object.fromEntries(refs.map((ref, i) => [`o${i}`, { binding: { op: { kind: "function", functionRef: ref, input: {} } } }])),
        },
      },
    }) as unknown as WorkflowBundle;

  it("splits a reference into its file and its dotted symbol", () => {
    const refs = userFunctionRefsOf(bundleWith(["user:C:/p/functions/confidence.ts#confidence.score"]));
    expect(refs).toEqual([
      { ref: "user:C:/p/functions/confidence.ts#confidence.score", file: "C:/p/functions/confidence.ts", property: ["confidence", "score"] },
    ]);
  });

  it("names each reference once, and leaves embedded bodies and host functions alone", () => {
    const refs = userFunctionRefsOf(
      bundleWith([
        "user:/p/a.ts#f",
        "user:/p/a.ts#f",
        "user:/p/a.ts#g.h",
        "user:<body>/inline.abc.ts#default",
        "on_user_event",
      ]),
    );
    expect(refs.map((r) => r.ref)).toEqual(["user:/p/a.ts#f", "user:/p/a.ts#g.h"]);
  });
});

describe("resolving a pinned task's functions", () => {
  let dir: string;
  let base: string;
  let project: Project | undefined;
  let moduleFile: string;

  async function open(): Promise<Project> {
    project = openProject(dir, { baseDir: testHome() });
    await prepareUserModules(project.paths, { rebuild: true });
    return project;
  }

  beforeEach(() => {
    resetUserModules();
    base = mkdtempSync(join(tmpdir(), "jaira-base-"));
    process.env.JAIRA_HOME = base;
    dir = mkdtempSync(join(tmpdir(), "jaira-pinned-"));
    const paths = initProject(dir, testHome());
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

  it("fills the facade a snapshot start left empty, and the entry is then preparable", async () => {
    const p = await open();
    userModules()!.approvals.approve(moduleFile, moduleHash(SOURCE));
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    // The first start reads live files and pins the snapshot; loading resolved the symbol on the way.
    const first = await beginTaskRun(p, "t-1");
    expect(first.pinned).toBe(false);
    expect(userModules()!.userFunctions.entries.size).toBe(1);
    // It died before journaling anything, so it may start again — this time from the PINNED snapshot.
    finishTaskRun(p, "t-1", "failed", { failure: { classification: "permanent", reason: "process died" } });

    // A new process: fresh pair, nothing resolved. The re-run loads the resolved definition and
    // resolves nothing, which is the state the app's registry was merged from.
    p.close();
    project = undefined;
    resetUserModules();
    const again = await open();
    const second = await beginTaskRun(again, "t-1");
    expect(second.pinned).toBe(true);
    const modules = userModules()!;
    expect(modules.userFunctions.entries.size).toBe(0);

    const refs = userFunctionRefsOf(second.bundle);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.property).toEqual(["confidence", "score"]);
    expect(resolveUserFunctions(modules, second.bundle)).toBe(1);
    expect([...modules.userFunctions.entries.keys()]).toEqual([refs[0]!.ref]);
    // And it runs: preparing compiles what was resolved, which is the step the run does next.
    await expect(modules.userFunctions.prepare()).resolves.toBeDefined();
  });

  it("is idempotent over a load that already resolved", async () => {
    const p = await open();
    userModules()!.approvals.approve(moduleFile, moduleHash(SOURCE));
    createTask(p, { title: "t", workflow: "caller", id: "t-2" });
    const started = await beginTaskRun(p, "t-2");
    const modules = userModules()!;
    expect(modules.userFunctions.entries.size).toBe(1);
    expect(resolveUserFunctions(modules, started.bundle)).toBe(1);
    expect(modules.userFunctions.entries.size).toBe(1);
  });
});
