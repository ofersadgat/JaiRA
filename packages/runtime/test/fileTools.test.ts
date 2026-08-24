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
import { viewsFor } from "@jaira/shared";
import { MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import {
  createEditFileTool,
  createReadFileTool,
  createShowArtifactTool,
  createWriteFileTool,
  registerFileTools,
  EDIT_FILE,
  READ_FILE,
  SHOW_ARTIFACT,
  WRITE_FILE,
} from "../src/fileTools";
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
    show: createShowArtifactTool(options),
  };
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
    // sha-256 of "hello" — identity that does not depend on where it was put.
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
    expect(await call(write, { path: ".jaira/settings.json", content: "{}" })).toMatchObject({
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
 * `edit` — the same file surface, with intent instead of a replacement.
 *
 * The distinction from `write_file` is the whole reason both exist. A write says "the file is now
 * this", so a model that meant to change one line and returned the file whole has silently reverted
 * everything it did not think to include. An edit says "this became that", which fails loudly when
 * the file is not what the model believed — and being wrong about the current content is the failure
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
    // …unless the caller says it meant all of them.
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

describe("show_artifact", () => {
  it("creates an artifact and reports what it is, not where it went", async () => {
    const { show } = tools("$DEFAULT");
    const result = await call(show, { path: "mockups/dash.html", content: "<h1>hi</h1>" });
    expect(result).toMatchObject({
      path: "mockups/dash.html",
      mediaType: "text/html",
      bytes: 11,
      uri: "artifact://t-1/mockups/dash.html",
      content: "<h1>hi</h1>",
    });
    // The illusion `write_file` maintains applies here too — the physical path is never reported.
    expect(result).not.toHaveProperty("physicalPath");
    // Under the ARTIFACT directory, not the workspace path the producer named — even though the
    // configured destination is `$DEFAULT`, which for `write_file` means the workspace itself.
    expect(existsSync(join(dir, "mockups", "dash.html"))).toBe(false);
    expect(readFileSync(join(dir, ".jaira", "system", "artifacts", "t-1", "mockups", "dash.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("cannot overwrite source — the property that makes it read-only", async () => {
    // The whole basis of the classification. `$DEFAULT` is `$WORKTREE/$RELPATH`, so left on the
    // configured destination this call would have replaced the file outright.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "the real source\n");
    const { show } = tools("$DEFAULT");
    await call(show, { path: "src/index.ts", content: "<h1>not source</h1>" });
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toBe("the real source\n");
  });

  it("refuses a path that climbs out of the artifact directory", async () => {
    const { show } = tools("$DEFAULT");
    expect(await call(show, { path: "../../escape.html", content: "x" })).toMatchObject({
      error: expect.stringMatching(/outside the destination root/) as unknown as string,
    });
  });

  it("writes nothing at all when the project chose a virtual destination", async () => {
    const { show, read } = tools("virtual:");
    await call(show, { path: "mockups/dash.html", content: "<h1>hi</h1>" });
    expect(existsSync(join(dir, ".jaira", "system", "artifacts"))).toBe(false);
    // Still round-trips, because the map is what answers — the illusion holds here too.
    expect(await call(read, { path: "mockups/dash.html" })).toMatchObject({ content: "<h1>hi</h1>" });
  });

  it("infers the media type from the extension and lets a declaration overrule it", async () => {
    const { show } = tools("virtual:");
    expect(await call(show, { path: "a/chart.svg", content: "<svg/>" })).toMatchObject({ mediaType: "image/svg+xml" });
    expect(await call(show, { path: "a/notes.md", content: "# hi" })).toMatchObject({ mediaType: "text/markdown" });
    // A name is a guess; a declaration is a statement, and the statement wins.
    expect(await call(show, { path: "a/thing.txt", content: "<svg/>", mediaType: "image/svg+xml" })).toMatchObject({
      mediaType: "image/svg+xml",
    });
  });

  it("keeps the interactive claim on the RECORD, and only when it was made", async () => {
    // The claim has to outlive the call, because the grant that lets a page run consults the record
    // rather than the tool result. Absent by default: a page is static unless it asked not to be.
    const { show } = tools("virtual:");
    await call(show, { path: "a/widget.html", content: "<p>x</p>", interactive: true });
    expect(store.get("t-1", "a/widget.html")?.interactive).toBe(true);

    await call(show, { path: "a/page.html", content: "<p>x</p>" });
    expect(store.get("t-1", "a/page.html")?.interactive).toBeUndefined();

    // And only `true` counts — a truthy-looking value is not a claim.
    await call(show, { path: "a/sneak.html", content: "<p>x</p>", interactive: "yes" });
    expect(store.get("t-1", "a/sneak.html")?.interactive).toBeUndefined();
  });

  it("reports the claim back, so the value a run carries says what it is", async () => {
    const { show } = tools("virtual:");
    expect(await call(show, { path: "a/widget.html", content: "<p>x</p>", interactive: true })).toMatchObject({
      interactive: true,
    });
    expect(await call(show, { path: "a/page.html", content: "<p>x</p>" })).not.toHaveProperty("interactive");
  });

  it("records the declared type, so what the bytes ARE outlives the run", async () => {
    const { show } = tools("virtual:");
    await call(show, { path: "a/thing.txt", content: "<svg/>", mediaType: "image/svg+xml" });
    expect(store.get("t-1", "a/thing.txt")?.format).toBe("image/svg+xml");
  });

  it("shows what is already there when given no content — the 'send this file' case", async () => {
    const { show, write } = tools("virtual:");
    // Through the map: a virtual artifact is not on disk at the path the agent knows it by.
    await call(write, { path: "docs/plan.md", content: "# done\n" });
    expect(await call(show, { path: "docs/plan.md" })).toMatchObject({
      path: "docs/plan.md",
      mediaType: "text/markdown",
      content: "# done\n",
    });
    // And an ordinary workspace file, which never went through the map at all.
    writeFileSync(join(dir, "README.md"), "# real\n");
    expect(await call(show, { path: "README.md" })).toMatchObject({ content: "# real\n" });
  });

  it("reports honestly when there is nothing at the path", async () => {
    const { show } = tools("$DEFAULT");
    expect(await call(show, { path: "nope.html" })).toMatchObject({
      error: expect.stringMatching(/could not read/) as unknown as string,
    });
  });

  it("keeps the reference but drops the content once it is too big to inline", async () => {
    // The journal holds what a call returned, so a large artifact travels as a reference — the URI is
    // what Stage 3's reader resolves. Small ones carry their bytes and render with nothing to fetch.
    const { show } = tools("$DEFAULT", 8);
    const big = await call(show, { path: "big.html", content: "<p>0123456789</p>" });
    expect(big).toMatchObject({ uri: "artifact://t-1/big.html", bytes: 17 });
    expect(big).not.toHaveProperty("content");
  });

  it("refuses `.jaira/` like every other producing tool", async () => {
    const { show } = tools("$DEFAULT");
    expect(await call(show, { path: ".jaira/sneak.html", content: "x" })).toMatchObject({
      error: expect.stringMatching(/\.jaira/) as unknown as string,
    });
  });

  it("returns something the renderer reads as an artifact — the seam between the tool and the view", async () => {
    // The end-to-end claim of this work: a tool call comes back, the transcript runs it through
    // `viewsFor` with NO hint, and the page renders rather than being printed as tags. If the
    // envelope's spelling ever drifts from what `artifactOf` recognises, this is what says so.
    const { show } = tools("virtual:");
    const html = await call(show, { path: "mockups/dash.html", content: "<h1>hi</h1>" });
    expect(viewsFor(html)).toEqual(["html", "code", "text", "json"]);

    const svg = await call(show, { path: "mockups/chart.svg", content: `<svg xmlns="http://www.w3.org/2000/svg"/>` });
    expect(viewsFor(svg)).toEqual(["media", "code", "text", "json"]);

    // And an artifact too large to inline has only its envelope to show, which is honest: the bytes
    // are not here, and Stage 3's reader is what resolves the `uri`.
    const { show: tiny } = tools("virtual:", 4);
    expect(viewsFor(await call(tiny, { path: "big.html", content: "<h1>hi</h1>" }))).toEqual(["json"]);
  });

  it("is read-only, and is registered with the rest", () => {
    // Which is what lets `plan` mode draw: the profile allows a read-only tool, and nothing that was
    // already in the workspace is different after this runs.
    expect(tools("$DEFAULT").show.readOnly).toBe(true);
    const registry = newRegistry();
    registerFileTools(registry, {
      destination: parseDestination("virtual:"),
      store,
      vars: { worktree: dir, project: dir, jaira: join(dir, ".jaira"), artifactDir: "a", taskId: "t-1" },
    });
    expect(registry.tools.has(SHOW_ARTIFACT)).toBe(true);
  });
});
