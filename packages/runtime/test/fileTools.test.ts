/**
 * `write_file` / `read_file` (DESIGN Â§7.6).
 *
 * The property under test is the illusion: **write(P) then read(P) returns the
 * content, under every destination**, and the agent is never told the bytes went
 * somewhere else. If that breaks, a workflow stops being portable across
 * destinations, which is the entire reason placement is configurable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
  registerFileTools,
  SeenFiles,
  EDIT_FILE,
  READ_FILE,
  WRITE_FILE,
} from "../src/fileTools";
import { newRegistry } from "../src/wiring";
import { noteCallAgent } from "../src/callAgent";
import type { AgentToolDeclaration } from "@jaira/shared";

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
      artifactDir: "artifacts",
      taskId: "t-1",
      runId: 1,
      instanceId: 7,
      stateId: "feature/plan",
      slot: "plan_doc",
    },
    now: () => 1_000,
  };
  return {
    write: createWriteFileTool(options),
    read: createReadFileTool(options),
    edit: createEditFileTool(options),
  };
}

/** Built per call, since `dir` is a fresh temp directory each test. */
const ctx = (): ExecServices => ({ workspace: { root: dir } }) as ExecServices;

const call = async (tool: Tool, input: unknown): Promise<Record<string, unknown>> =>
  (await tool.run(input as never, ctx())) as Record<string, unknown>;

describe("the round trip, under every destination", () => {
  for (const destination of ["$DEFAULT", "$CENTRAL", "$CENTRAL_FLAT", "$JAIRA/artifacts/$TASK_ID/$RELPATH", "virtual:"]) {
    it(`write(P) then read(P) returns the content â€” ${destination}`, async () => {
      const { write, read } = tools(destination);

      const written = await call(write, { path: "docs/plan.md", content: "# the plan" });
      // The agent is told about the path IT used, never the physical one.
      expect(written).toMatchObject({ path: "docs/plan.md" });
      expect(JSON.stringify(written)).not.toContain("system/artifacts");

      const readBack = await call(read, { path: "docs/plan.md" });
      expect(readBack).toMatchObject({ path: "docs/plan.md", content: "# the plan" });
    });
  }
});

describe("placement", () => {
  it("puts the file exactly where the destination says", async () => {
    const { write } = tools("$CENTRAL");
    await call(write, { path: "docs/plan.md", content: "x" });

    expect(existsSync(join(dir, ".jaira", "system", "artifacts", "t-1", "docs", "plan.md"))).toBe(true);
    // NOT at the path the agent used.
    expect(existsSync(join(dir, "docs", "plan.md"))).toBe(false);
  });

  it("derives the filename when the destination says to", async () => {
    const { write } = tools("$CENTRAL_FLAT");
    await call(write, { path: "docs/plan.md", content: "x" });
    expect(existsSync(join(dir, ".jaira", "system", "artifacts", "t-1", "7-plan_doc.md"))).toBe(true);
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
    // sha-256 of "hello" â€” identity that does not depend on where it was put.
    expect(record.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(record.bytes).toBe(5);
    expect(record.content).toBe("hello");
    expect(record.physicalPath).toContain("artifacts");
  });

  it("drops the inline copy for a large file, so the journal does not carry it", async () => {
    const { write, read } = tools("$CENTRAL", 4);
    await call(write, { path: "big.md", content: "0123456789" });

    const record = store.get("t-1", "big.md")!;
    expect(record.content).toBeUndefined();
    expect(record.bytes).toBe(10);
    // â€¦and the round trip still works, by reading the file back.
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

describe("an absolute path inside the workspace (decision 0020: the Design type's instructions ask for them)", () => {
  it("is the workspace-relative path, written, read and edited as one", async () => {
    const { write, read, edit } = tools("$DEFAULT");
    const absolute = join(dir, "canvas", "project", "Main.dc.html");
    expect(await call(write, { path: absolute, content: "<x-dc>a</x-dc>" })).toMatchObject({ path: "canvas/project/Main.dc.html" });
    expect(readFileSync(absolute, "utf8")).toBe("<x-dc>a</x-dc>");
    expect(await call(edit, { path: absolute, old: "a", new: "b" })).toMatchObject({ replaced: 1 });
    expect(await call(read, { path: "canvas/project/Main.dc.html" })).toMatchObject({ content: "<x-dc>b</x-dc>" });
  });

  it("is still refused for a WRITE when it lies outside the workspace", async () => {
    const { write } = tools("$DEFAULT");
    expect(await call(write, { path: join(tmpdir(), "elsewhere.txt"), content: "x" })).toHaveProperty("error");
  });

  it("is refused for a write or an edit from the filesystem's root, not written as the project's own", async () => {
    // The logical key drops a leading `/`, so `/elsewhere.txt` (and on Linux every absolute path,
    // `/tmp/…` included) was written into the workspace as `elsewhere.txt`.
    const { write, edit } = tools("$DEFAULT");
    const rooted = resolve(sep, "elsewhere.txt");
    expect(await call(write, { path: rooted, content: "x" })).toMatchObject({ error: expect.stringContaining("outside the workspace") });
    writeFileSync(join(dir, "elsewhere.txt"), "a", "utf8");
    expect(await call(edit, { path: rooted, old: "a", new: "b" })).toMatchObject({ error: expect.stringContaining("outside the workspace") });
    expect(readFileSync(join(dir, "elsewhere.txt"), "utf8")).toBe("a");
  });
});

describe("a read outside the workspace (decision 0023 §3.2: where is the permission set's to say)", () => {
  it("is read where it is, by the path the call named", async () => {
    // The gate judged the call at its places before the tool ran — as it judges a shell's
    // `Get-Content` of the same file, which ran. Refusing it here as well asked a person and then
    // refused what they allowed.
    const { read } = tools("$DEFAULT");
    const outside = mkdtempSync(join(tmpdir(), "jaira-read-outside-"));
    try {
      const file = join(outside, "memory.md");
      writeFileSync(file, "remember", "utf8");
      expect(await call(read, { path: file })).toMatchObject({ path: file, content: "remember" });
      expect(await call(read, { path: join(outside, "missing.md") })).toMatchObject({ error: expect.stringContaining("could not read") });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a .jaira folder where it is, as any file — whether it may is the permission set's", async () => {
    // The sets JaiRA ships let `.jaira/` be read and refuse only the machine key, at the gate, before
    // the tool runs (`permissionPresets.test.ts`); the tool itself knows nothing of `.jaira/`.
    const { read } = tools("$DEFAULT");
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    try {
      mkdirSync(join(home, ".jaira", "system"), { recursive: true });
      const file = join(home, ".jaira", "settings.json");
      writeFileSync(file, "{}", "utf8");
      expect(await call(read, { path: file })).toMatchObject({ path: file, content: "{}" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("refusals", () => {
  it("leaves .jaira/ to the permission set: the tool writes and reads it as any path of the workspace", async () => {
    // Where an agent may write is the set's to say, at its places, judged on the path the call wrote
    // before the tool runs — the sets JaiRA ships refuse `$PROJECT/.jaira` (`permissionPresets.test.ts`,
    // `policy.test.ts`). What the tool still refuses on its own is a path that names nothing.
    const { write, read } = tools("$DEFAULT");
    expect(await call(write, { path: ".jaira/notes.md", content: "kept" })).toMatchObject({ path: ".jaira/notes.md" });
    expect(await call(read, { path: ".jaira/notes.md" })).toMatchObject({ content: "kept" });
    expect(await call(write, { path: "", content: "x" })).toMatchObject({ error: "no path given" });
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
        artifactDir: "artifacts",
        taskId: "t-1",
      },
    });
    expect(registry.tools.has(WRITE_FILE)).toBe(true);
    expect(registry.tools.has(READ_FILE)).toBe(true);
    expect(registry.tools.has(EDIT_FILE)).toBe(true);
    expect(registry.tools.get(EDIT_FILE)!.readOnly).toBe(false);
    // `readOnly` is what the read-only and plan permission profiles gate on.
    expect(registry.tools.get(WRITE_FILE)!.readOnly).toBe(false);
    expect(registry.tools.get(READ_FILE)!.readOnly).toBe(true);
  });
});

/**
 * `edit` â€” the same file surface, with intent instead of a replacement.
 *
 * The distinction from `write_file` is the whole reason both exist. A write says "the file is now
 * this", so a model that meant to change one line and returned the file whole has silently reverted
 * everything it did not think to include. An edit says "this became that", which fails loudly when
 * the file is not what the model believed â€” and being wrong about the current content is the failure
 * that actually happens.
 */
describe("edit", () => {
  it("replaces exact text and leaves the rest alone", async () => {
    const { write, edit, read } = tools("$DEFAULT");
    await call(write, { path: "a.ts", content: "const a = 1;\nconst b = 2;\n" });
    expect(await call(edit, { path: "a.ts", old: "const b = 2;", new: "const b = 3;" })).toMatchObject({
      path: "a.ts",
      replaced: 1,
    });
    expect(await call(read, { path: "a.ts" })).toMatchObject({ content: "const a = 1;\nconst b = 3;\n" });
  });

  it("refuses an ambiguous match rather than picking one", async () => {
    // Two identical fragments mean the caller has not identified the one it meant, and choosing for
    // it is how an edit lands in the wrong function.
    const { write, edit } = tools("$DEFAULT");
    await call(write, { path: "a.ts", content: "x = 1;\nx = 1;\n" });
    expect(await call(edit, { path: "a.ts", old: "x = 1;", new: "x = 2;" })).toMatchObject({
      error: expect.stringMatching(/appears 2 times/) as unknown as string,
    });
    // â€¦unless the caller says it meant all of them.
    expect(await call(edit, { path: "a.ts", old: "x = 1;", new: "x = 2;", all: true })).toMatchObject({ replaced: 2 });
  });

  it("refuses text that is not there, and an edit that would change nothing", async () => {
    const { write, edit } = tools("$DEFAULT");
    await call(write, { path: "a.ts", content: "hello\n" });
    expect(await call(edit, { path: "a.ts", old: "goodbye", new: "hi" })).toMatchObject({
      error: expect.stringMatching(/does not contain/) as unknown as string,
    });
    expect(await call(edit, { path: "a.ts", old: "hello", new: "hello" })).toMatchObject({
      error: expect.stringMatching(/identical/) as unknown as string,
    });
    expect(await call(edit, { path: "a.ts", old: "", new: "x" })).toMatchObject({
      error: expect.stringMatching(/use write_file/) as unknown as string,
    });
  });

  it("edits an artifact wherever it was PLACED, not where the agent thinks it is", async () => {
    // The illusion `read_file` maintains has to hold here too: an edit that went straight to the
    // filesystem would miss a virtual artifact, or create a second copy beside it.
    const { write, edit, read } = tools("virtual:");
    await call(write, { path: "docs/plan.md", content: "# draft\n" });
    expect(await call(edit, { path: "docs/plan.md", old: "draft", new: "final" })).toMatchObject({ replaced: 1 });
    expect(await call(read, { path: "docs/plan.md" })).toMatchObject({ content: "# final\n" });
    expect(existsSync(join(dir, "docs", "plan.md"))).toBe(false);
  });

  it("is mutating, which is what a narrowing profile gates on", () => {
    expect(tools("$DEFAULT").edit.readOnly).toBe(false);
  });
});

/** An agent whose own folder (`$AGENT_WORKSPACE`) is a sibling of the workspace, noted on each call as its wrapper notes it. */
const agentHome = (): string => join(dir, "..", `${dir.split(sep).pop()}-agent`);
const AGENT: AgentToolDeclaration = { channel: "tools", natives: {}, workspace: () => agentHome() };
const byAgent = (input: Record<string, unknown>): Record<string, unknown> => {
  noteCallAgent(input, AGENT);
  return input;
};

describe("a write over a file the agent has not read (t-elvj5dhzoy, 2026-11-11)", () => {
  it("refuses replacing a file the agent never read, and writes it once it has", async () => {
    const { write, read } = tools("$DEFAULT");
    writeFileSync(join(dir, "Sidebar.tsx"), "export const a = 1;\n");
    expect(await call(write, byAgent({ path: "Sidebar.tsx", content: "x" }))).toMatchObject({
      error: expect.stringMatching(/already exists and you have not read it.*Nothing was changed/) as unknown as string,
    });
    expect(readFileSync(join(dir, "Sidebar.tsx"), "utf8")).toBe("export const a = 1;\n");
    await call(read, byAgent({ path: "Sidebar.tsx" }));
    expect(await call(write, byAgent({ path: "Sidebar.tsx", content: "export const a = 2;\n" }))).toMatchObject({ path: "Sidebar.tsx" });
    expect(readFileSync(join(dir, "Sidebar.tsx"), "utf8")).toBe("export const a = 2;\n");
  });

  it("refuses replacing a file changed since the agent read or wrote it", async () => {
    const { write, read } = tools("$DEFAULT");
    await call(write, byAgent({ path: "a.md", content: "one" }));
    // What it wrote it knows: writing it again needs no read.
    expect(await call(write, byAgent({ path: "a.md", content: "two" }))).toMatchObject({ path: "a.md" });
    writeFileSync(join(dir, "a.md"), "the person's");
    expect(await call(write, byAgent({ path: "a.md", content: "three" }))).toMatchObject({
      error: expect.stringMatching(/has changed since you last read or wrote it/) as unknown as string,
    });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("the person's");
    await call(read, byAgent({ path: "a.md" }));
    expect(await call(write, byAgent({ path: "a.md", content: "three" }))).toMatchObject({ path: "a.md" });
  });

  it("counts an edit as knowing the file, and holds no new file and no call of JaiRA's own to it", async () => {
    const { write, edit } = tools("$DEFAULT");
    writeFileSync(join(dir, "b.ts"), "let x = 1;\n");
    expect(await call(edit, byAgent({ path: "b.ts", old: "1", new: "2" }))).toMatchObject({ replaced: 1 });
    expect(await call(write, byAgent({ path: "b.ts", content: "let x = 3;\n" }))).toMatchObject({ path: "b.ts" });
    expect(await call(write, byAgent({ path: "new/c.ts", content: "c" }))).toMatchObject({ path: "new/c.ts" });
    // A workflow writing its output is not a model that may have forgotten the file.
    writeFileSync(join(dir, "out.md"), "last run's");
    expect(await call(write, { path: "out.md", content: "this run's" })).toMatchObject({ path: "out.md" });
  });

  it("keeps what it saw per task: another task's read is not this one's", async () => {
    const seen = new SeenFiles();
    seen.saw("t-1", join(dir, "a.md"), "x");
    expect(seen.hashOf("t-1", join(dir, "a.md"))).toBeDefined();
    expect(seen.hashOf("t-2", join(dir, "a.md"))).toBeUndefined();
  });
});

describe("the calling agent's own folder ($AGENT_WORKSPACE)", () => {
  afterEach(() => rmSync(agentHome(), { recursive: true, force: true }));

  it("writes and edits there by the absolute path the call named, where any other outside path is refused", async () => {
    const { write, edit, read } = tools("$DEFAULT");
    const note = join(agentHome(), "memory", "notes.md");
    expect(await call(write, byAgent({ path: note, content: "# notes\n- one\n" }))).toMatchObject({ path: note });
    expect(readFileSync(note, "utf8")).toBe("# notes\n- one\n");
    expect(await call(edit, byAgent({ path: note, old: "- one", new: "- one\n- two" }))).toMatchObject({ replaced: 1 });
    expect(readFileSync(note, "utf8")).toBe("# notes\n- one\n- two\n");
    // Not the project's: no artifact is placed for it.
    expect(store.get("t-1", note)).toBeUndefined();
    // A file there it has not read is held to the read like any other.
    writeFileSync(join(agentHome(), "MEMORY.md"), "- [a](a.md)\n");
    expect(await call(write, byAgent({ path: join(agentHome(), "MEMORY.md"), content: "x" }))).toMatchObject({
      error: expect.stringMatching(/have not read it/) as unknown as string,
    });
    await call(read, byAgent({ path: join(agentHome(), "MEMORY.md") }));
    expect(await call(write, byAgent({ path: join(agentHome(), "MEMORY.md"), content: "- [a](a.md)\n- [b](b.md)\n" }))).toMatchObject({ bytes: 24 });
  });

  it("is the calling agent's alone: a call no agent made, or a path beside the folder, is outside the workspace", async () => {
    const { write } = tools("$DEFAULT");
    const note = join(agentHome(), "notes.md");
    expect(await call(write, { path: note, content: "x" })).toMatchObject({ error: expect.stringMatching(/outside the workspace/) as unknown as string });
    expect(await call(write, byAgent({ path: join(dir, "..", "elsewhere.md"), content: "x" }))).toMatchObject({
      error: expect.stringMatching(/outside the workspace/) as unknown as string,
    });
    expect(existsSync(note)).toBe(false);
  });
});

describe("read_file on a picture (2026-11-13)", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

  it("hands it over as a picture the model sees — `$images` — not as text, in the workspace and outside it", async () => {
    mkdirSync(join(dir, "shots"), { recursive: true });
    writeFileSync(join(dir, "shots", "a.png"), png);
    const { read } = tools("$DEFAULT");
    expect(await call(read, { path: "shots/a.png" })).toEqual({ path: "shots/a.png", mediaType: "image/png", bytes: png.length, $images: [{ mimeType: "image/png", data: png.toString("base64") }] });
    const outside = mkdtempSync(join(tmpdir(), "jaira-pic-"));
    try {
      writeFileSync(join(outside, "b.jpg"), png);
      expect(await call(read, { path: join(outside, "b.jpg") })).toMatchObject({ mediaType: "image/jpeg", $images: [{ mimeType: "image/jpeg" }] });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    // An SVG is markup: read as text, as before.
    writeFileSync(join(dir, "shots", "c.svg"), "<svg/>", "utf8");
    expect(await call(read, { path: "shots/c.svg" })).toEqual({ path: "shots/c.svg", content: "<svg/>" });
  });

  it("says so, with no picture, when one is too large for a model to take", async () => {
    writeFileSync(join(dir, "big.png"), Buffer.concat([png, Buffer.alloc(3_800_000)]));
    const answer = await call(tools("$DEFAULT").read, { path: "big.png" });
    expect(answer).not.toHaveProperty("$images");
    expect(String(answer["note"])).toMatch(/more than a model takes as one image .* show_artifact/);
  });
});
