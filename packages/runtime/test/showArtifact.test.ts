/**
 * `show_artifact` answering Claude Code's `Artifact` calls (decision 0020 §1–§2).
 *
 * The calls here are the ones the Design type's instructions tell the model to make — quickstart, a
 * create with `type_url`, publishes with `url`/`root`/`file_path`/`files` — and a page's publish, so
 * what is under test is that a model following those instructions word for word gets a canvas, and a
 * person's edit in between is not silently overwritten.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { filesAt, MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import { createWriteFileTool } from "../src/fileTools";
import { artifactIdOf, createShowArtifactTool, DESIGN_TYPE_URL, inlineCanvasNote, publishedFetchesOf, publishedReadsOf, showItemsOf } from "../src/showArtifact";

let dir: string;
let store: MemoryArtifactStore;
let tool: Tool;
let minted: number;

/** The repository's own built-in layer: the tests' home registers an empty one. */
const builtInDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-show-"));
  store = new MemoryArtifactStore();
  minted = 0;
  tool = createShowArtifactTool({
    destination: parseDestination("virtual:"),
    store,
    vars: { worktree: dir, project: dir, jaira: join(dir, ".jaira"), artifactDir: "artifacts", taskId: "t-1" },
    now: () => 1_000,
    mintId: () => `a-${++minted}`,
    builtInDir,
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): ExecServices => ({ workspace: { root: dir } }) as ExecServices;
const call = async (input: unknown): Promise<Record<string, unknown>> => (await tool.run(input as never, ctx())) as Record<string, unknown>;
const write = (rel: string, text: string): string => {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
};
const typeText = (name: string): string => readFileSync(join(builtInDir, "artifact-types", "design", name), "utf8");

describe("a page", () => {
  it("publishes the file it is given, named by its <title>, and a second publish of the same file is the next version", async () => {
    const path = write("out/chart.html", "<!doctype html><title>Pipeline durations</title><p>1</p>");
    const first = await call({ file_path: path, title: "ignored", icon: "chart" });
    expect(first["artifact"]).toMatchObject({ url: "artifact://t-1/@a-1", version: 1, kind: "page", title: "Pipeline durations", icon: "chart", entry: "chart.html" });
    write("out/chart.html", "<!doctype html><title>Pipeline durations</title><p>2</p>");
    const second = await call({ file_path: path });
    expect(second["artifact"]).toMatchObject({ url: "artifact://t-1/@a-1", version: 2 });
    expect(second["artifact"]).not.toHaveProperty("files");
    expect(filesAt(store, "t-1", "a-1")).toEqual({ "chart.html": "<!doctype html><title>Pipeline durations</title><p>2</p>" });
    expect(String(second["answer"])).toMatch(/version 2/);
  });

  it("takes the call's title only when the page has none, and a Markdown file keeps its file name", async () => {
    expect((await call({ file_path: write("a.html", "<p>no title</p>"), title: "Given" }))["artifact"]).toMatchObject({ title: "Given" });
    expect((await call({ file_path: write("notes.md", "# Notes"), title: "Given" }))["artifact"]).toMatchObject({ kind: "markdown", entry: "notes.md" });
    expect((await call({ file_path: write("notes.md", "# Notes"), title: "Given" }))["artifact"]).not.toHaveProperty("title");
  });

  it("refuses what Claude Code refuses: text that is not UTF-8, the replacement character, a file that is not there — and shows another extension as itself", async () => {
    // `file_path` is the one-item spelling of `artifacts` (2026-11-13): a file that is not a page is shown.
    expect(await call({ file_path: write("x.txt", "x") })).toMatchObject({ shown: [{ kind: "file", entry: "x.txt" }] });
    const bad = join(dir, "bad.html");
    writeFileSync(bad, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x0a]));
    expect(await call({ file_path: bad })).toMatchObject({ error: expect.stringMatching(/not UTF-8.*line 1, column 4/) as unknown as string });
    expect(await call({ file_path: write("r.html", "a\n\uFFFDb") })).toMatchObject({ error: expect.stringMatching(/U\+FFFD \(line 2, column 1\)/) as unknown as string });
    // Absolute on every platform: `C:/…` is a relative path on Linux.
    expect(await call({ file_path: resolve(sep, "jaira-not-there", "x.html") })).toMatchObject({ error: expect.stringMatching(/could not be read/) as unknown as string });
  });

  it("reads a file where it is — the gate judged it as a read — `.jaira/` like any other", async () => {
    // The agent's own folder, say: no fixed list of folders decides; `read_file`'s line did, before the
    // call ran — and the sets JaiRA ships read `.jaira/` as any of the project, but for the machine key.
    const elsewhere = mkdtempSync(join(tmpdir(), "jaira-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "mock.html"), "<title>From scratch</title>", "utf8");
      expect((await call({ file_path: join(elsewhere, "mock.html") }))["artifact"]).toMatchObject({ title: "From scratch" });
      mkdirSync(join(elsewhere, ".jaira"), { recursive: true });
      writeFileSync(join(elsewhere, ".jaira", "x.html"), "<title>Theirs</title>", "utf8");
      expect((await call({ file_path: join(elsewhere, ".jaira", "x.html") }))["artifact"]).toMatchObject({ title: "Theirs" });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect((await call({ file_path: write(".jaira/settings.html", "<title>Settings</title>") }))["artifact"]).toMatchObject({ title: "Settings" });
    // What this task's tools wrote into its own artifact folder (a screenshot, a page) is its own to show.
    expect((await call({ file_path: write(".jaira/system/artifacts/t-1/system/shot.html", "<title>Shot</title>") }))["artifact"]).toMatchObject({ title: "Shot" });
  });

  it("publishes a page sent in the call: no file, `file_path` only naming it, a new artifact unless a `url` is given", async () => {
    const first = await call({ content: "<!doctype html><title>Six directions</title><p>1</p>" });
    expect(first["artifact"]).toMatchObject({ url: "artifact://t-1/@a-1", version: 1, kind: "page", title: "Six directions", entry: "page.html" });
    expect(String(first["answer"])).toMatch(/give this url with its new `content`/);
    // Read back, changed, and sent again as the next version of the same artifact.
    const read = await call({ action: "read", url: "artifact://t-1/@a-1", path: "page.html" });
    expect(read["content"]).toBe("<!doctype html><title>Six directions</title><p>1</p>");
    expect((await call({ url: "artifact://t-1/@a-1", content: String(read["content"]).replace("<p>1</p>", "<p>2</p>") }))["artifact"]).toMatchObject({ id: "a-1", version: 2 });
    expect(filesAt(store, "t-1", "a-1")["page.html"]).toBe("<!doctype html><title>Six directions</title><p>2</p>");
    // Another page sent in the call, with no url, is another artifact; `file_path` names it and is never read.
    expect((await call({ content: "# Notes", file_path: "C:/nowhere/notes.md" }))["artifact"]).toMatchObject({ id: "a-2", kind: "markdown", entry: "notes.md" });
    expect(await call({ content: "x", file_path: "notes.txt" })).toMatchObject({ shown: [{ kind: "file", entry: "notes.txt", title: "notes.txt" }] });
    expect(await call({ content: "a\uFFFD" })).toMatchObject({ error: expect.stringMatching(/U\+FFFD/) as unknown as string });
    expect(await call({})).toMatchObject({ error: expect.stringMatching(/give `content`/) as unknown as string });
  });

  it("reads a UTF-16 file by its byte-order mark", async () => {
    const path = join(dir, "w.html");
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<title>Wide</title>", "utf16le")]));
    expect((await call({ file_path: path }))["artifact"]).toMatchObject({ title: "Wide" });
  });

  it("reads what write_file wrote where write_file put it — a virtual destination has nothing on disk", async () => {
    const writer = createWriteFileTool({ destination: parseDestination("virtual:"), store, vars: { worktree: dir, project: dir, jaira: join(dir, ".jaira"), artifactDir: "artifacts", taskId: "t-1" } });
    await writer.run({ path: "pages/plan.html", content: "<title>Plan</title>" } as never, ctx());
    expect((await call({ file_path: "pages/plan.html" }))["artifact"]).toMatchObject({ title: "Plan" });
    expect(filesAt(store, "t-1", "a-1")).toEqual({ "plan.html": "<title>Plan</title>" });
    expect((await call({ file_path: join(dir, "pages", "plan.html") }))["artifact"]).toMatchObject({ version: 2 });
  });

  it("is read-only: it reads files and adds versions to the task's own store", () => {
    expect(tool.readOnly).toBe(true);
  });
});

describe("a design canvas, as the Design type's instructions make one", () => {
  const canvasJson = JSON.stringify({ v: 3, createdOnFiles: { v: 1, at: "2026-10-30T00:00:00Z" }, title: "Video picker", boards: { "Main.dc.html": { x: 0, y: 0, w: 420, h: 900 } }, order: ["Main.dc.html"], notes: {}, pages: [], launch: { view: "canvas" } });

  async function started(): Promise<string> {
    expect(await call({ action: "quickstart", intent: "design" })).toEqual({ answer: typeText("quickstart-result.md") });
    const created = await call({ action: "publish", type_url: DESIGN_TYPE_URL, title: "Video picker", auto_open: "after_first_write" });
    return (created["artifact"] as { url: string }).url;
  }

  it("answers the create with the type's own answer — its instructions inside — and only the canvas's url and version filled in", async () => {
    await call({ action: "quickstart", intent: "design" });
    const created = await call({ action: "publish", type_url: DESIGN_TYPE_URL, title: "Video picker", auto_open: "after_first_write" });
    expect(created["answer"]).toBe(
      `${typeText("created-result.md").replaceAll("{{canvas_url}}", "artifact://t-1/@a-1").replaceAll("{{version_id}}", "1").trimEnd()}\n\n${inlineCanvasNote("artifact://t-1/@a-1")}`,
    );
    expect(String(created["answer"])).toContain("<artifact-type-instructions>");
    expect(created["artifact"]).toMatchObject({ kind: "canvas", type: "design", title: "Video picker", version: 1, entry: "project/canvas.json" });
  });

  it("refuses a create with no title, or another type", async () => {
    expect(await call({ action: "publish", type_url: DESIGN_TYPE_URL })).toMatchObject({ error: expect.stringMatching(/title/) as unknown as string });
    expect(await call({ action: "publish", type_url: "https://claude.ai/artifact/other", title: "x" })).toMatchObject({ error: expect.stringMatching(/one Artifact type/) as unknown as string });
  });

  it("takes the index and the entry artboard in one call, the rest in the next, and keeps what a later call did not send", async () => {
    const url = await started();
    const root = join(dir, "scratch", "videopicker");
    const index = write("scratch/videopicker/project/canvas.json", canvasJson);
    write("scratch/videopicker/project/Main.dc.html", "<x-dc>A</x-dc>");
    const first = await call({ action: "publish", url, root, file_path: index, files: { "project/Main.dc.html": "project/Main.dc.html" } });
    expect(first["answer"]).toBe(
      typeText("updated-result.md")
        .replaceAll("{{canvas_url}}", url)
        .replaceAll("{{version}}", "2")
        .replaceAll("{{version_id}}", "2")
        .replaceAll("{{file_path}}", index)
        .replaceAll("{{own_files}}", `"project/Main.dc.html", "project/canvas.json"`),
    );
    const tabs = write("scratch/videopicker/project/Tabs.dc.html", "<x-dc>B</x-dc>");
    await call({ action: "publish", url, root, file_path: tabs });
    expect(filesAt(store, "t-1", "a-1")).toEqual({ "project/canvas.json": canvasJson, "project/Main.dc.html": "<x-dc>A</x-dc>", "project/Tabs.dc.html": "<x-dc>B</x-dc>" });
    // The index's title names the artifact.
    expect(store.latest("t-1")[0]).toMatchObject({ title: "Video picker", version: 3 });
  });

  it("removes a file sent as null, and refuses a path outside project/ or one of the type's own files", async () => {
    const url = await started();
    const root = join(dir, "c");
    write("c/project/Main.dc.html", "A");
    await call({ action: "publish", url, root, file_path: join(root, "project/Main.dc.html") });
    write("c/project/canvas.json", canvasJson);
    await call({ action: "publish", url, root, file_path: join(root, "project/canvas.json"), files: { "project/Main.dc.html": null } });
    expect(Object.keys(filesAt(store, "t-1", "a-1"))).toEqual(["project/canvas.json"]);
    expect(await call({ action: "publish", url, root, file_path: write("c/other/x.html", "x") })).toMatchObject({ error: expect.stringMatching(/under `project\/`/) as unknown as string });
    expect(await call({ action: "publish", url, root, file_path: write("c/project/../project/x y.html", "x") })).toMatchObject({ error: expect.stringMatching(/under `project\/`/) as unknown as string });
    // Every file named is read where it is — the gate judged each at `read_file`'s line, `.jaira/` too.
    const kept = await call({ action: "publish", url, root, file_path: join(root, "project/canvas.json"), files: { "project/Kept.dc.html": write(".jaira/kept.dc.html", "<x-dc>K</x-dc>") } });
    expect(kept["error"]).toBeUndefined();
    expect(Object.keys(filesAt(store, "t-1", "a-1"))).toContain("project/Kept.dc.html");
  });

  it("takes each file's text in the call — no file written, no `root` — and a later publish keeps what it did not send", async () => {
    const url = await started();
    const first = await call({ action: "publish", url, files: { "project/canvas.json": { content: canvasJson }, "project/Main.dc.html": { content: "<x-dc>A</x-dc>" } } });
    expect(first["artifact"]).toMatchObject({ kind: "canvas", version: 2, title: "Video picker" });
    // One file by `file_path` + `content`, as the instructions' "one new file per call" has it.
    await call({ action: "publish", url, file_path: "project/Tabs.dc.html", content: "<x-dc>B</x-dc>" });
    expect(filesAt(store, "t-1", "a-1")).toEqual({ "project/canvas.json": canvasJson, "project/Main.dc.html": "<x-dc>A</x-dc>", "project/Tabs.dc.html": "<x-dc>B</x-dc>" });
    // Read, changed, sent again: only the changed file.
    const main = await call({ action: "read", url, path: "project/Main.dc.html" });
    await call({ action: "publish", url, files: { "project/Main.dc.html": { content: String(main["content"]).replace("A", "A2") } } });
    expect(filesAt(store, "t-1", "a-1")["project/Main.dc.html"]).toBe("<x-dc>A2</x-dc>");
    expect(filesAt(store, "t-1", "a-1")["project/Tabs.dc.html"]).toBe("<x-dc>B</x-dc>");
    // The canvas this conversation is filling, without its url.
    expect((await call({ action: "publish", file_path: "project/Main.dc.html", content: "<x-dc>A3</x-dc>" }))["artifact"]).toMatchObject({ id: "a-1", version: 5 });
    // The same rules as a file's: under project/, not the type's own, no replacement character.
    expect(await call({ action: "publish", url, files: { "project/index.html": { content: "x" } } })).toMatchObject({ error: expect.stringMatching(/type's own files/) as unknown as string });
    expect(await call({ action: "publish", url, files: { "project/Bad.dc.html": { content: "�" } } })).toMatchObject({ error: expect.stringMatching(/U\+FFFD/) as unknown as string });
  });

  it("names, for the gate, `file_path` and every `files` entry that names a file — under `root` where relative — and nothing sent in the call", () => {
    expect(publishedReadsOf({ file_path: "/s/p/project/canvas.json", root: "/s/p/", files: { "project/Main.dc.html": "project/Main.dc.html", "project/Gone.dc.html": null, "project/In.dc.html": { content: "x" }, "project/Abs.dc.html": "/else/A.dc.html" } })).toEqual([
      "/s/p/project/canvas.json",
      "/s/p/project/Main.dc.html",
      "/else/A.dc.html",
    ]);
    expect(publishedReadsOf({ url: "u", files: ["/a/project/Main.dc.html", "/a/project/canvas.json"] })).toEqual(["/a/project/Main.dc.html", "/a/project/canvas.json"]);
    expect(publishedReadsOf({ content: "<p>x</p>", file_path: "/named/only.html" })).toEqual([]);
    expect(publishedReadsOf({ url: "u", file_path: "/x/hero.png", asset: true })).toEqual(["/x/hero.png"]);
    for (const input of [{ action: "read", url: "u", path: "project/x" }, { action: "list" }, { action: "quickstart", intent: "design" }, { type_url: DESIGN_TYPE_URL, title: "t", file_path: "/x" }, null, "x"]) {
      expect(publishedReadsOf(input)).toEqual([]);
    }
  });

  it("refuses to publish over a file a person saved since, naming it — and publishes once it has been read again", async () => {
    const url = await started();
    const root = join(dir, "c");
    const main = write("c/project/Main.dc.html", "<x-dc>model</x-dc>");
    await call({ action: "publish", url, root, file_path: main });
    // The person's save in the editor.
    store.publish({ taskId: "t-1", artifact: "a-1", author: "person", kind: "canvas", type: "design", entry: "project/canvas.json", changes: { "project/Main.dc.html": "<x-dc>person</x-dc>" }, createdAt: 2_000 });
    write("c/project/Main.dc.html", "<x-dc>model again</x-dc>");
    const refused = await call({ action: "publish", url, root, file_path: main });
    expect(refused["error"]).toMatch(/someone saved "project\/Main\.dc\.html"/);
    expect(filesAt(store, "t-1", "a-1")["project/Main.dc.html"]).toBe("<x-dc>person</x-dc>");
    expect(await call({ action: "read", url, path: "project/Main.dc.html" })).toMatchObject({ content: "<x-dc>person</x-dc>" });
    expect(await call({ action: "publish", url, root, file_path: main })).toHaveProperty("artifact");
  });

  it("uploads an asset as a /_blob/ url the artboards name, kept in the canvas", async () => {
    const url = await started();
    const png = join(dir, "hero.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const up = await call({ action: "publish", url, file_path: png, asset: true });
    expect(up["url"]).toMatch(/^\/_blob\/[0-9a-f]{24}$/);
    expect(filesAt(store, "t-1", "a-1")[String(up["url"]).slice(1)]).toBe("data:image/png;base64,iVBORw==");
  });

  it("reads the type's own pages it has, and says plainly which it has not", async () => {
    expect(await call({ action: "read", url: "artifact://t-1/@a-1", path: "artifact-type/reference/format.md" })).toMatchObject({ content: typeText("reference/format.md") });
    expect(await call({ action: "read", path: "SKILL.md" })).toMatchObject({ content: typeText("SKILL.md") });
    expect(await call({ action: "read", path: "artifact-type/reference/craft.md" })).toMatchObject({ error: expect.stringMatching(/does not have/) as unknown as string });
  });

  it("lists no design systems, and the task's artifacts", async () => {
    expect(String((await call({ action: "list", type: "Design System" }))["answer"])).toMatch(/^No Artifacts made from the type "Design System"/);
    await started();
    expect(String((await call({ action: "list" }))["answer"])).toContain("Video picker (mine) — canvas, version 1 — artifact://t-1/@a-1");
  });
});

describe("artifactIdOf", () => {
  it("reads this task's own urls and a bare id, and nothing of another task's", () => {
    expect(artifactIdOf("artifact://t-1/@a-xyz", "t-1")).toBe("a-xyz");
    expect(artifactIdOf("a-xyz", "t-1")).toBe("a-xyz");
    expect(artifactIdOf("artifact://t-2/@a-xyz", "t-1")).toBeUndefined();
    expect(artifactIdOf("https://claude.ai/artifact/9Beb", "t-1")).toBeUndefined();
  });
});

/** A PNG's first bytes: enough for the type to be told by name or by its magic number. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe("showing any file (2026-11-13)", () => {
  const writeBytes = (rel: string, bytes: Buffer): string => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };

  it("shows a picture as itself, kept as a data: URI under its source, and showing the same path again is its next version", async () => {
    writeBytes("shots/before.png", PNG);
    const first = await call({ artifacts: "shots/before.png", caption: "Before" });
    expect(first).toMatchObject({ caption: "Before", refused: [], shown: [{ url: "artifact://t-1/@a-1", version: 1, kind: "file", entry: "shots/before.png", title: "before.png", source: "shots/before.png" }] });
    expect(filesAt(store, "t-1", "a-1")["shots/before.png"]).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(String(first["answer"])).toMatch(/artifact:\/\/t-1\/@a-1, version 1 \(new\)/);
    // The same file named absolutely is the same source.
    expect((await call({ artifacts: [join(dir, "shots", "before.png")] }))["shown"]).toMatchObject([{ id: "a-1", version: 2 }]);
  });

  it("takes data sent in the call, typed by its name or its mimeType, and the same name again is its next version", async () => {
    expect((await call({ artifacts: { data: "a,b\n1,2", name: "timings.csv" } }))["shown"]).toMatchObject([{ kind: "file", entry: "timings.csv", version: 1 }]);
    expect(filesAt(store, "t-1", "a-1")["timings.csv"]).toBe("a,b\n1,2");
    expect((await call({ artifacts: [{ data: "a,b\n3,4", name: "timings.csv" }] }))["shown"]).toMatchObject([{ id: "a-1", version: 2 }]);
    expect((await call({ artifacts: { data: PNG.toString("base64"), encoding: "base64", mimeType: "image/png" } }))["shown"]).toMatchObject([{ kind: "file", entry: "shown.png" }]);
    expect((await call({ artifacts: `data:image/png;base64,${PNG.toString("base64")}` }))["shown"]).toMatchObject([{ kind: "file", entry: "shown.png" }]);
    // A page or a document sent this way is still a page or a document.
    expect((await call({ artifacts: { data: "# Notes", name: "notes.md" } }))["shown"]).toMatchObject([{ kind: "markdown", entry: "notes.md" }]);
    expect(await call({ artifacts: { data: "x" } })).toMatchObject({ error: expect.stringMatching(/needs a `name`/) as unknown as string });
  });

  it("fetches a web address once and keeps it as fetched, from its host; an answer that is not ok is refused", async () => {
    const fetched: string[] = [];
    tool = createShowArtifactTool({
      destination: parseDestination("virtual:"),
      store,
      vars: { worktree: dir, project: dir, jaira: join(dir, ".jaira"), artifactDir: "artifacts", taskId: "t-1" },
      now: () => 1_000,
      mintId: () => `a-${++minted}`,
      builtInDir,
      fetch: (async (url: string) => {
        fetched.push(url);
        if (url.endsWith("/missing.png")) return new Response("no", { status: 404, statusText: "Not Found" });
        return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } });
      }) as unknown as typeof fetch,
    });
    const shown = await call({ artifacts: ["https://example.com/img/raw?id=3", "https://example.com/missing.png"] });
    expect(shown["shown"]).toMatchObject([{ kind: "file", entry: "https://example.com/img/raw?id=3", title: "raw.png", from: "example.com" }]);
    expect(shown["refused"]).toMatchObject([{ source: "https://example.com/missing.png", why: expect.stringMatching(/answered 404 Not Found/) as unknown as string }]);
    expect(fetched).toEqual(["https://example.com/img/raw?id=3", "https://example.com/missing.png"]);
  });

  it("shows a file of an artifact of this task by its URI, and the artifact itself as it is now with no new version", async () => {
    await call({ content: "<title>Board</title>" });
    store.publish({ taskId: "t-1", artifact: "a-1", author: "model", kind: "page", title: "Board", entry: "page.html", changes: { "_blob/abc": `data:image/png;base64,${PNG.toString("base64")}` }, createdAt: 2 });
    const one = await call({ artifacts: "artifact://t-1/@a-1/_blob/abc" });
    expect(one["shown"]).toMatchObject([{ id: "a-2", kind: "file", entry: "artifact://t-1/@a-1/_blob/abc", from: "Board" }]);
    const again = await call({ artifacts: { artifact: "artifact://t-1/@a-1", caption: "As it is now" } });
    expect(again["shown"]).toMatchObject([{ id: "a-1", version: 2, kind: "page", caption: "As it is now" }]);
    expect(store.versions("t-1", "a-1")).toHaveLength(2);
    expect((await call({ artifacts: "artifact://t-9/@a-1" }))["error"]).toMatch(/not an artifact of this task/);
  });

  it("refuses only a type nothing draws, says what would have worked, shows the rest, and fails a call that showed nothing", async () => {
    writeBytes("docs/q.pdf", Buffer.from("%PDF-1.7\n\u0000\u00ff binary", "latin1"));
    writeBytes("blob.bin", Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81]));
    write("src/a.ts", "export const a = 1;\n");
    const mixed = await call({ artifacts: ["docs/q.pdf", "src/a.ts", "blob.bin"] });
    expect(mixed["shown"]).toMatchObject([{ kind: "file", entry: "src/a.ts" }]);
    expect(mixed["refused"]).toMatchObject([
      { source: "docs/q.pdf", why: expect.stringMatching(/no view for q\.pdf \(application\/pdf\)\. It shows pictures/) as unknown as string },
      { source: "blob.bin", why: expect.stringMatching(/no view for blob\.bin \(binary\)/) as unknown as string },
    ]);
    expect(String(mixed["answer"])).toMatch(/Not shown:/);
    expect(await call({ artifacts: "docs/q.pdf" })).toMatchObject({ error: expect.stringMatching(/no view for q\.pdf/) as unknown as string });
    expect(await call({ artifacts: [] })).toMatchObject({ error: expect.stringMatching(/names nothing/) as unknown as string });
  });

  it("keeps each item's caption, and a picture through `file_path` is shown the same way", async () => {
    writeBytes("a.png", PNG);
    writeBytes("b.png", PNG);
    const shown = await call({ artifacts: [{ artifact: "a.png", caption: "A" }, "b.png"], caption: "Both" });
    expect(shown).toMatchObject({ caption: "Both", shown: [{ entry: "a.png", caption: "A" }, { entry: "b.png" }] });
    expect((shown["shown"] as Array<Record<string, unknown>>)[1]).not.toHaveProperty("caption");
    expect((await call({ file_path: join(dir, "a.png") }))["shown"]).toMatchObject([{ entry: "a.png", version: 2 }]);
  });

  it("names, for the gate, each file it reads and each address it fetches — nothing it is sent or holds already", () => {
    const input = { artifacts: ["shots/a.png", "file:///C:/x/b.png", { artifact: "https://e.com/c.png" }, "artifact://t-1/@a-1/x", "data:image/png;base64,AA==", { data: "x", name: "n.txt" }] };
    expect(publishedReadsOf(input)).toEqual(["shots/a.png", fileURLToPath("file:///C:/x/b.png")]);
    expect(publishedFetchesOf(input)).toEqual(["https://e.com/c.png"]);
    expect(publishedFetchesOf({ action: "read", artifacts: "https://e.com/c.png" })).toEqual([]);
    expect(showItemsOf(undefined)).toBeUndefined();
    expect(showItemsOf(" ")).toEqual([]);
  });
});
