/**
 * Artifacts, end to end through `jaira task start` (DESIGN §7.6).
 *
 * The unit tests cover placement and the round trip in isolation. This proves the
 * two things only a real run can: that a state's returned blob content actually
 * reaches the filesystem at the configured destination, and that changing the
 * destination moves the file without touching the workflow.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { jairaPaths } from "@jaira/shared";
import { writeWorkflowFiles } from "@jaira/runtime";
import { runCli, type CliIo } from "../src/cli";

let dir: string;

/** One prompt state producing a markdown artifact. */
const WORKFLOW = {
  report: {
    label: "Report",
    inputs: { topic: { schema: { type: "string" } } },
    outputs: { summary: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    operation: {
      kind: "prompt",
      prompt: "Summarize {{inputs.topic}}.",
      model: "writer",
      output: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } },
    },
  },
};

const FAKE = [{ promptIncludes: "Summarize", output: "# Widgets\n\nA plan." }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-artifacts-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, WORKFLOW);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(args, io);
  return { code, out, err };
}

function configure(artifacts: Record<string, unknown>): void {
  writeFileSync(jairaPaths(dir).configFile, JSON.stringify({ artifacts }, null, 2), "utf8");
}

/** Create and run a task, returning its id and the run report. */
async function runTask(): Promise<{ taskId: string; report: Record<string, unknown> }> {
  const created = await cli(["task", "create", "--title", "Report", "--workflow", "report", "--inputs", '{"topic":"widgets"}']);
  const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;
  const started = await cli(["task", "start", taskId, "--fake", JSON.stringify(FAKE)]);
  expect(started.code, started.out + started.err).toBe(0);
  return { taskId, report: JSON.parse(started.out) as Record<string, unknown> };
}

describe("a returned artifact reaches the filesystem", () => {
  it("lands at $DEFAULT — the workspace, under the slot name", async () => {
    const { taskId, report } = await runTask();

    expect(existsSync(join(dir, "summary.md"))).toBe(true);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toBe("# Widgets\n\nA plan.");
    expect(report.artifacts).toMatchObject([{ path: "summary.md", bytes: 18 }]);

    // …and it is recorded, so a later state or run can resolve the path.
    const project = openProject(dir);
    try {
      const record = project.artifacts.get(taskId, "summary.md")!;
      expect(record.format).toBe("text/markdown");
      expect(record.slot).toBe("summary");
      expect(record.hash).toHaveLength(64);
    } finally {
      project.close();
    }
  });

  it("moves to the central directory on a config change alone", async () => {
    // The workflow is untouched: only `artifacts.destination` differs.
    configure({ destination: "$CENTRAL" });
    const { taskId } = await runTask();

    expect(existsSync(join(dir, "jaira-artifacts", taskId, "summary.md"))).toBe(true);
    expect(existsSync(join(dir, "summary.md"))).toBe(false);
  });

  it("derives the filename under $CENTRAL_FLAT", async () => {
    configure({ destination: "$CENTRAL_FLAT" });
    const { taskId } = await runTask();
    // <instanceId>-<slot>.<ext>, with the instance the engine assigned.
    const dirPath = join(dir, "jaira-artifacts", taskId);
    expect(existsSync(dirPath)).toBe(true);
    const files = readFileSync(join(dirPath, "1-summary.md"), "utf8");
    expect(files).toContain("Widgets");
  });

  it("writes nothing under virtual:, but still records the content", async () => {
    configure({ destination: "virtual:" });
    const { taskId, report } = await runTask();

    expect(existsSync(join(dir, "summary.md"))).toBe(false);
    expect(report.artifacts).toMatchObject([{ path: "summary.md" }]);

    const project = openProject(dir);
    try {
      const record = project.artifacts.get(taskId, "summary.md")!;
      expect(record.physicalPath).toBeUndefined();
      expect(record.content).toContain("Widgets");
    } finally {
      project.close();
    }
  });

  it("honours a hand-written destination outside the repo", async () => {
    configure({ destination: "$JAIRA/artifacts/$TASK_ID/$RELPATH" });
    const { taskId } = await runTask();
    expect(existsSync(join(dir, ".jaira", "artifacts", taskId, "summary.md"))).toBe(true);
  });
});

describe("configuration errors", () => {
  it("refuses an unknown variable at run time rather than writing somewhere odd", async () => {
    configure({ destination: "$WORKTRE/$RELPATH" });
    const created = await cli(["task", "create", "--title", "R", "--workflow", "report", "--inputs", '{"topic":"x"}']);
    const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;

    const started = await cli(["task", "start", taskId, "--fake", JSON.stringify(FAKE)]);

    expect(started.code).toBe(1);
    expect(started.err).toMatch(/unknown variable '\$WORKTRE'/);
  });
});
