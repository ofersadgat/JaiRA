/**
 * `write_file` / `read_file` (DESIGN §7.6).
 *
 * The property under test is the illusion: **write(P) then read(P) returns the
 * content, under every destination**, and the agent is never told the bytes went
 * somewhere else. If that breaks, a workflow stops being portable across
 * destinations, which is the entire reason placement is configurable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import { createReadFileTool, createWriteFileTool, registerFileTools, READ_FILE, WRITE_FILE } from "../src/fileTools";
import { newRegistry } from "../src/wiring";

let dir: string;
let store: MemoryArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-files-"));
  store = new MemoryArtifactStore();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tools(destination: string, inlineMaxBytes = 65_536) {
  const options = {
    destination: parseDestination(destination),
    store,
    inlineMaxBytes,
    vars: {
      worktree: dir,
      project: dir,
      jaira: join(dir, ".jaira"),
      artifactDir: "jaira-artifacts",
      taskId: "t-1",
      runId: 1,
      instanceId: 7,
      stateId: "feature/plan",
      slot: "plan_doc",
    },
    now: () => 1_000,
  };
  return { write: createWriteFileTool(options), read: createReadFileTool(options) };
}

/** Built per call, since `dir` is a fresh temp directory each test. */
const ctx = (): ExecServices => ({ workspace: { root: dir } }) as ExecServices;

const call = async (tool: Tool, input: unknown): Promise<Record<string, unknown>> =>
  (await tool.run(input as never, ctx())) as Record<string, unknown>;

describe("the round trip, under every destination", () => {
  for (const destination of ["$DEFAULT", "$CENTRAL", "$CENTRAL_FLAT", "$JAIRA/artifacts/$TASK_ID/$RELPATH", "virtual:"]) {
    it(`write(P) then read(P) returns the content — ${destination}`, async () => {
      const { write, read } = tools(destination);

      const written = await call(write, { path: "docs/plan.md", content: "# the plan" });
      // The agent is told about the path IT used, never the physical one.
      expect(written).toMatchObject({ path: "docs/plan.md" });
      expect(JSON.stringify(written)).not.toContain("jaira-artifacts");

      const readBack = await call(read, { path: "docs/plan.md" });
      expect(readBack).toMatchObject({ path: "docs/plan.md", content: "# the plan" });
    });
  }
});

describe("placement", () => {
  it("puts the file exactly where the destination says", async () => {
    const { write } = tools("$CENTRAL");
    await call(write, { path: "docs/plan.md", content: "x" });

    expect(existsSync(join(dir, "jaira-artifacts", "t-1", "docs", "plan.md"))).toBe(true);
    // NOT at the path the agent used.
    expect(existsSync(join(dir, "docs", "plan.md"))).toBe(false);
  });

  it("derives the filename when the destination says to", async () => {
    const { write } = tools("$CENTRAL_FLAT");
    await call(write, { path: "docs/plan.md", content: "x" });
    expect(existsSync(join(dir, "jaira-artifacts", "t-1", "7-plan_doc.md"))).toBe(true);
  });

  it("writes nothing to disk under virtual:", async () => {
    const { write } = tools("virtual:");
    await call(write, { path: "docs/plan.md", content: "x" });
    expect(existsSync(join(dir, "docs", "plan.md"))).toBe(false);
    const record = store.get("t-1", "docs/plan.md")!;
    expect(record.content).toBe("x");
    expect(record.physicalPath).toBeUndefined();
  });

  it("creates parent directories rather than failing", async () => {
    const { write } = tools("$DEFAULT");
    await call(write, { path: "a/deeply/nested/file.md", content: "x" });
    expect(readFileSync(join(dir, "a", "deeply", "nested", "file.md"), "utf8")).toBe("x");
  });
});

describe("the record", () => {
  it("hashes content and keeps small files inline", async () => {
    const { write } = tools("$CENTRAL");
    await call(write, { path: "a.md", content: "hello" });

    const record = store.get("t-1", "a.md")!;
    // sha-256 of "hello" — identity that does not depend on where it was put.
    expect(record.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(record.bytes).toBe(5);
    expect(record.content).toBe("hello");
    expect(record.physicalPath).toContain("jaira-artifacts");
  });

  it("drops the inline copy for a large file, so the journal does not carry it", async () => {
    const { write, read } = tools("$CENTRAL", 4);
    await call(write, { path: "big.md", content: "0123456789" });

    const record = store.get("t-1", "big.md")!;
    expect(record.content).toBeUndefined();
    expect(record.bytes).toBe(10);
    // …and the round trip still works, by reading the file back.
    expect(await call(read, { path: "big.md" })).toMatchObject({ content: "0123456789" });
  });
});

describe("reads that are not artifacts", () => {
  it("falls through to the workspace for an ordinary source file", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};", "utf8");
    const { read } = tools("$CENTRAL");
    expect(await call(read, { path: "src/index.ts" })).toMatchObject({ content: "export {};" });
  });

  it("reports a missing file rather than throwing", async () => {
    const { read } = tools("$DEFAULT");
    expect(await call(read, { path: "nope.md" })).toMatchObject({ error: expect.stringContaining("could not read") });
  });
});

describe("refusals", () => {
  it("refuses .jaira/ on the LOGICAL path, before any destination is applied", async () => {
    // Checked on what the agent asked for, because that is what the author wrote
    // policy against and what an approval dialog would show.
    const { write, read } = tools("$CENTRAL");
    expect(await call(write, { path: ".jaira/config.json", content: "{}" })).toMatchObject({
      error: expect.stringContaining("may not write"),
    });
    expect(await call(read, { path: ".jaira/jaira.db" })).toMatchObject({ error: expect.stringContaining(".jaira") });
  });

  it("refuses a path that escapes the destination root", async () => {
    const { write } = tools("$CENTRAL");
    const result = await call(write, { path: "../../etc/passwd", content: "x" });
    expect(result).toMatchObject({ error: expect.stringContaining("outside the destination root") });
    expect(existsSync(join(dir, "etc", "passwd"))).toBe(false);
  });

  it("refuses an empty path", async () => {
    const { write } = tools("$DEFAULT");
    expect(await call(write, { path: "  ", content: "x" })).toMatchObject({ error: "no path given" });
  });
});

describe("registration", () => {
  it("registers both tools, with write marked mutating", () => {
    const registry = newRegistry();
    registerFileTools(registry, {
      store,
      vars: {
        worktree: dir,
        project: dir,
        jaira: join(dir, ".jaira"),
        artifactDir: "jaira-artifacts",
        taskId: "t-1",
      },
    });
    expect(registry.tools.has(WRITE_FILE)).toBe(true);
    expect(registry.tools.has(READ_FILE)).toBe(true);
    // `readOnly` is what the read-only and plan permission profiles gate on.
    expect(registry.tools.get(WRITE_FILE)!.readOnly).toBe(false);
    expect(registry.tools.get(READ_FILE)!.readOnly).toBe(true);
  });
});
