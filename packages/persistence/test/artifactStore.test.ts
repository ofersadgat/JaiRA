/**
 * The durable artifact map (DESIGN §7.6, §4.2).
 *
 * Durability is the reason this is a table rather than a per-process map: a later
 * state, a later run, and the artifacts panel must all resolve the same logical
 * path, and "where did that file go" has to survive a restart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@jaira/runtime";
import { createReadFileTool, createWriteFileTool, parseDestination } from "@jaira/runtime";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { initProject, openProject, type Project } from "../src/project";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-artstore-"));
  initProject(dir);
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  taskId: "t-1",
  runId: 3,
  logicalPath: "docs/plan.md",
  physicalPath: join(dir, "jaira-artifacts", "t-1", "docs", "plan.md"),
  content: "# plan",
  hash: "abc123",
  bytes: 6,
  format: "text/markdown",
  instanceId: 7,
  stateId: "feature/plan",
  slot: "plan_doc",
  createdAt: 1_000,
  ...over,
});

describe("SqliteArtifactStore", () => {
  it("round-trips every field", () => {
    project.artifacts.put(record());
    expect(project.artifacts.get("t-1", "docs/plan.md")).toEqual(record());
  });

  it("replaces on rewrite, so a read resolves to the latest", () => {
    project.artifacts.put(record({ content: "v1", hash: "h1" }));
    project.artifacts.put(record({ content: "v2", hash: "h2", createdAt: 2_000 }));

    expect(project.artifacts.get("t-1", "docs/plan.md")).toMatchObject({ content: "v2", hash: "h2" });
    // One row, not two — consumers should not have to sort by time.
    expect(project.artifacts.list("t-1")).toHaveLength(1);
  });

  it("keeps a virtual artifact's content with no physical path", () => {
    project.artifacts.put(record({ physicalPath: undefined, logicalPath: "v.md" }));
    const stored = project.artifacts.get("t-1", "v.md")!;
    expect(stored.physicalPath).toBeUndefined();
    expect(stored.content).toBe("# plan");
  });

  it("keeps a large artifact's location with no inline copy", () => {
    project.artifacts.put(record({ content: undefined, bytes: 900_000, logicalPath: "big.bin" }));
    const stored = project.artifacts.get("t-1", "big.bin")!;
    expect(stored.content).toBeUndefined();
    expect(stored.physicalPath).toBeDefined();
  });

  it("scopes to a task and returns nothing for an unknown path", () => {
    project.artifacts.put(record());
    project.artifacts.put(record({ taskId: "t-2", logicalPath: "other.md" }));
    expect(project.artifacts.list("t-1").map((a) => a.logicalPath)).toEqual(["docs/plan.md"]);
    expect(project.artifacts.get("t-1", "nope.md")).toBeUndefined();
    // The same logical path in two tasks is two artifacts.
    project.artifacts.put(record({ taskId: "t-2" }));
    expect(project.artifacts.list("t-2")).toHaveLength(2);
  });

  it("survives a reopen — the point of the table", () => {
    project.artifacts.put(record());
    project.close();

    project = openProject(dir);
    expect(project.artifacts.get("t-1", "docs/plan.md")).toMatchObject({ hash: "abc123" });
  });
});

describe("the tools against the durable store", () => {
  it("resolves a logical path written in an earlier session", async () => {
    const options = {
      destination: parseDestination("$CENTRAL"),
      store: project.artifacts,
      vars: {
        worktree: dir,
        project: dir,
        jaira: join(dir, ".jaira"),
        artifactDir: "jaira-artifacts",
        taskId: "t-1",
      },
    };
    const ctx = { workspace: { root: dir } } as ExecServices;
    const write: Tool = createWriteFileTool(options);
    await write.run({ path: "docs/plan.md", content: "# the plan" } as never, ctx);

    // Reopen: a fresh store instance, backed by the same database.
    project.close();
    project = openProject(dir);
    const read: Tool = createReadFileTool({ ...options, store: project.artifacts });

    expect(await read.run({ path: "docs/plan.md" } as never, ctx)).toMatchObject({ content: "# the plan" });
  });
});
