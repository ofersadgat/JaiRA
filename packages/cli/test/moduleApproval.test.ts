/**
 * The three answers a headless surface can give when a workflow reaches an unapproved `.ts` module
 * (SPEC §7.5.5, WORKFLOWS.md §9.1).
 *
 * `CliIo.confirm` is the whole seam: its ABSENCE is what makes the CLI headless by default, so the
 * tests here are mostly about which of the three paths a given io shape and flag combination lands
 * on. Nothing about this needs a terminal — which is the point, since CI is one of the callers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths } from "@jaira/shared";
import { resetUserModules } from "@jaira/persistence";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

const SOURCE = `export const confidence = {
  score(rank: number): number {
    return 1 - rank / 3;
  },
};
`;

let dir: string;
let base: string;
let moduleFile: string;

beforeEach(() => {
  resetUserModules();
  base = mkdtempSync(join(tmpdir(), "jaira-base-"));
  process.env.JAIRA_HOME = base;
  dir = makePlanningProject();
  const paths = jairaPaths(dir);
  writeFileSync(
    join(paths.workflowsDir, "caller.json"),
    JSON.stringify({
      label: "Caller",
      inputs: { rank: { schema: { type: "integer" }, default: 0 } },
      outputs: { score: { binding: "confidence.score(.inputs.rank)", schema: { type: "number" } } },
    }),
    "utf8",
  );
  mkdirSync(join(paths.jairaDir, "functions"), { recursive: true });
  moduleFile = join(paths.jairaDir, "functions", "confidence.ts");
  writeFileSync(moduleFile, SOURCE, "utf8");
});

afterEach(() => {
  resetUserModules();
  delete process.env.JAIRA_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

/** `confirm` is omitted unless a test supplies one — exactly as `main.ts` omits it off a terminal. */
async function cli(args: string[], confirm?: (q: string) => Promise<boolean>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = {
    cwd: dir,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...(confirm !== undefined ? { confirm } : {}),
  };
  return { code: await runCli(args, io), out, err };
}

/** Creates the task and hands back the id the CLI minted for it. */
async function createCallerTask(): Promise<string> {
  const created = await cli(["task", "create", "--title", "t", "--workflow", "caller"]);
  expect(created.code).toBe(0);
  return (JSON.parse(created.out) as { taskId: string }).taskId;
}

describe("jaira workflow lint", () => {
  it("names the file to approve instead of the parse error the gate caused", async () => {
    const res = await cli(["workflow", "lint"]);
    expect(res.code).toBe(1);
    expect(res.err + res.out).toContain("have not been approved on this machine");
    expect(res.err + res.out).toContain("jaira functions approve");
    // The misleading half is REPLACED, not printed beside it.
    expect(res.err + res.out).not.toContain("not a known operation");
  });
});

describe("starting a task with nobody to ask", () => {
  it("refuses and prints the command that answers it", async () => {
    const taskId = await createCallerTask();
    const res = await cli(["task", "start", taskId]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("have not been approved on this machine");
    expect(res.err).toContain("jaira functions approve ");
    expect(res.err).toContain("confidence.ts");
  });

  it("refuses on --non-interactive even with a terminal attached", async () => {
    const taskId = await createCallerTask();
    let asked = 0;
    const res = await cli(["task", "start", taskId, "--non-interactive"], async () => {
      asked += 1;
      return true;
    });
    expect(res.code).toBe(1);
    // The flag means "answer nothing", not "answer no" — nobody was asked at all.
    expect(asked).toBe(0);
  });
});

describe("starting a task with somebody to ask", () => {
  it("shows the source and does not run when the answer is no", async () => {
    const taskId = await createCallerTask();
    const res = await cli(["task", "start", taskId], async () => false);
    expect(res.code).toBe(1);
    // Shown in full: a prompt that asks whether to run code without showing it is a rubber stamp.
    expect(res.err).toContain("score(rank: number): number");
    expect(res.err).toContain("never approved");
  });

  it("approves and starts when the answer is yes", async () => {
    const taskId = await createCallerTask();
    const res = await cli(["task", "start", taskId], async () => true);
    expect(res.err).toContain("approved 1 function file(s)");
    // Approved durably, so the NEXT invocation is not asked again.
    const again = await cli(["functions", "list"]);
    expect(again.out).toContain("confidence.ts");
  });
});

describe("--approve-functions", () => {
  it("approves without asking, and says which files it approved", async () => {
    const taskId = await createCallerTask();
    let asked = 0;
    const res = await cli(["task", "start", taskId, "--approve-functions"], async () => {
      asked += 1;
      return false;
    });
    expect(asked).toBe(0);
    expect(res.err).toContain("approved 1 function file(s)");
    expect(res.err).toContain("confidence.ts");
  });
});
