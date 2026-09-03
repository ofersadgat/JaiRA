/**
 * `uri:read` (CHANGESETS.md §8.5): one generalised read channel for the addresses a changeset's
 * chain speaks. The tests that matter are the REFUSALS — this channel is renderer-reachable, and a
 * `file:` resolver without an anchor is a sandbox escape — plus the one honesty feature `file:`
 * carries: a content hash that no longer matches reports drift instead of pretending.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { SqliteSessionStore } from "@jaira/persistence";
import { NodeExec, Git } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-uriread-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("anchored file reads", () => {
  it("resolves $PROJECT and $JAIRA relative paths", async () => {
    writeFileSync(join(dir, "notes.md"), "hello\n", "utf8");
    expect((await service.readUri({ uri: "$PROJECT/notes.md" })).text).toBe("hello\n");

    service.createFile({ layer: "project", path: ".jaira/prompts/goals.md", kind: "file", text: "# Goals\n" });
    const jaira = await service.readUri({ uri: "$JAIRA/prompts/goals.md" });
    expect(jaira.text).toBe("# Goals\n");
    expect(jaira.mime).toBe("text/markdown");
  });

  it("refuses an escape from its anchor — the artifact-destination rule, on the read side", async () => {
    await expect(service.readUri({ uri: "$PROJECT/../outside.txt" })).rejects.toThrow(/escapes|refused/);
  });

  it("refuses an unrecognised scheme rather than guessing", async () => {
    await expect(service.readUri({ uri: "https://example.com/x" })).rejects.toThrow(/refused rather than guessed/);
  });

  it("confines an absolute file: URI to the anchors the project owns", async () => {
    writeFileSync(join(dir, "inside.md"), "in\n", "utf8");
    const inside = await service.readUri({ uri: `file:${join(dir, "inside.md").replace(/\\/g, "/")}` });
    expect(inside.text).toBe("in\n");
    await expect(service.readUri({ uri: "file:C:/Windows/win.ini" })).rejects.toThrow(/outside every anchor/);
  });

  it("reports drift when a file: URI's content hash no longer matches (§3.2)", async () => {
    writeFileSync(join(dir, "pinned.md"), "original\n", "utf8");
    const hash = createHash("sha256").update("original\n").digest("hex");
    const uri = `file:${join(dir, "pinned.md").replace(/\\/g, "/")}#sha256=${hash}`;
    expect((await service.readUri({ uri })).drifted).toBeUndefined();

    writeFileSync(join(dir, "pinned.md"), "moved\n", "utf8");
    const moved = await service.readUri({ uri });
    expect(moved.drifted).toBe(true);
    // The TEXT is what is there now; the flag is what says the pin no longer holds.
    expect(moved.text).toBe("moved\n");
  });
});

describe("git: blob reads", () => {
  it("reads a blob at a pinned commit from the project's own repository", async () => {
    const exec = new NodeExec();
    const git = new Git({ exec, repoDir: dir });
    await git.run(["init", "--initial-branch=main"]);
    await git.run(["config", "user.email", "t@example.com"]);
    await git.run(["config", "user.name", "T"]);
    writeFileSync(join(dir, "pinned.md"), "committed\n", "utf8");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "pin"]);
    const head = (await git.head())!;

    // The worktree moves; the pin does not — §1.2's whole point.
    writeFileSync(join(dir, "pinned.md"), "drifted\n", "utf8");
    expect((await service.readUri({ uri: `git:${head}:pinned.md` })).text).toBe("committed\n");
    await expect(service.readUri({ uri: `git:${head}` })).rejects.toThrow(/commit, not a blob/);
  });
});

describe("db:// record reads", () => {
  it("resolves a recorded value through session_positions, pointer and all", async () => {
    // Write a record the way a run would: through the store, at a claimed position.
    const project = openProject(dir, { baseDir: testHome() });
    try {
      const store = new SqliteSessionStore(project.db, { taskId: "t1" });
      const at = store.resolve({ ref: "review" }).at;
      const ref = store.append({ id: "r1", source: undefined as never, session: at, startMs: 1 });
      store.finish(ref, { result: { value: { changeset: { source: "git:abcd1234", changes: [] } } } as never });
    } finally {
      project.close();
    }

    const content = await service.readUri({
      uri: "db://operation_records/review@0.result.value.changeset",
      taskId: "t1",
    });
    expect(content.mime).toBe("application/json");
    expect(JSON.parse(content.text)).toEqual({ source: "git:abcd1234", changes: [] });

    await expect(
      service.readUri({ uri: "db://operation_records/review@7.result", taskId: "t1" }),
    ).rejects.toThrow(/no record has claimed/);
    await expect(service.readUri({ uri: "db://artifacts/x@0.y" })).rejects.toThrow(/operation_records/);
  });
});
