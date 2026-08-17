/**
 * `artifact:serve` — handing ONE artifact to a frame so it can run.
 *
 * This is the only path in the app that ends with a model's code executing, so the tests that matter
 * are the ones about what is refused and what is not decided here:
 *
 *  - a grant covers one artifact, named by the caller — the handler resolves nothing on its own, so
 *    there is no URL a page can contrive that reaches anything else;
 *  - the RECORD says whether scripts may run, not the request and not the media type, so an artifact
 *    written before the question existed can never acquire them;
 *  - a token that was never minted serves nothing.
 *
 * The renderer half (`sandbox="allow-scripts"` without `allow-same-origin`, and the CSP header that
 * makes inline script possible at all) is not testable here — it lives in the Electron layer and was
 * verified against a real Chromium instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-artifact-serve-"));
  initProject(dir);
  service = new AppService({ watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a record in the map directly — the producing tool is tested in `runtime`.
 *
 * Its own handle, CLOSED again: the service holds the project open for the duration of the test, and
 * a second handle left dangling keeps the database file locked past the cleanup that deletes it.
 */
function record(path: string, content: string, extra: { format?: string; interactive?: boolean } = {}): void {
  const project = openProject(dir);
  try {
    project.artifacts.put({
      taskId: "t-1",
      logicalPath: path,
      content,
      hash: "x",
      bytes: Buffer.byteLength(content, "utf8"),
      createdAt: 1,
      ...extra,
    });
  } finally {
    project.close();
  }
}

describe("artifact:serve", () => {
  it("grants an address for an artifact the caller named", async () => {
    record("mockups/dash.html", "<h1>hi</h1>", { format: "text/html", interactive: true });
    const granted = await service.serveArtifact({ taskId: "t-1", path: "mockups/dash.html" });

    expect(granted.url).toMatch(/^jaira-artifact:\/\/frame\//);
    expect(granted.mediaType).toBe("text/html");
    expect(granted.bytes).toBe(11);
    expect(granted.interactive).toBe(true);

    const token = granted.url.split("/").pop()!;
    expect(service.servedArtifact(token)).toMatchObject({ body: "<h1>hi</h1>", mediaType: "text/html", interactive: true });
  });

  it("lets the RECORD decide whether anything may run, not the request or the type", async () => {
    // An ordinary HTML artifact — written by `write_file`, or by a producer that never asked for
    // scripts. Serving it must not turn it into a program, or every artifact ever written becomes
    // scriptable the day this path ships.
    record("notes/page.html", "<h1>static</h1>", { format: "text/html" });
    const granted = await service.serveArtifact({ taskId: "t-1", path: "notes/page.html" });
    expect(granted.interactive).toBe(false);
    expect(service.servedArtifact(granted.url.split("/").pop()!)?.interactive).toBe(false);
  });

  it("serves nothing for a token nobody was granted", () => {
    // The handler's whole authority is this map: no token, no bytes, and no path to parse.
    expect(service.servedArtifact("not-a-token")).toBeUndefined();
    expect(service.servedArtifact("")).toBeUndefined();
  });

  it("mints a distinct grant each time, so one address is not a handle on the map", async () => {
    record("a.html", "<p>a</p>", { format: "text/html", interactive: true });
    const first = await service.serveArtifact({ taskId: "t-1", path: "a.html" });
    const second = await service.serveArtifact({ taskId: "t-1", path: "a.html" });
    expect(first.url).not.toBe(second.url);
  });

  it("refuses an artifact that is not in the map at all", async () => {
    await expect(service.serveArtifact({ taskId: "t-1", path: "nope.html" })).rejects.toThrow(/no artifact/);
    // Including one belonging to another task — the map is keyed by both, and so is the grant.
    record("mine.html", "<p>x</p>", { format: "text/html" });
    await expect(service.serveArtifact({ taskId: "t-2", path: "mine.html" })).rejects.toThrow(/no artifact/);
  });

  it("falls back to the path's type when the record kept none", async () => {
    record("chart.svg", "<svg/>");
    expect((await service.serveArtifact({ taskId: "t-1", path: "chart.svg" })).mediaType).toBe("image/svg+xml");
  });
});

describe("artifact:list", () => {
  it("collects what a task produced, oldest first", () => {
    record("a.html", "<p>a</p>", { format: "text/html", interactive: true });
    record("b.md", "# b");
    const list = service.listArtifacts({ taskId: "t-1" });
    expect(list.map((row) => row.path)).toEqual(["a.html", "b.md"]);
    expect(list[0]).toMatchObject({ mediaType: "text/html", bytes: 8, interactive: true });
    // The type falls back to what the name implies, in the same order `serveArtifact` resolves it —
    // so a row in the list and the thing that opens from it cannot disagree about what it is.
    expect(list[1]).toMatchObject({ mediaType: "text/markdown", interactive: false });
  });

  it("carries no content, however small — the list is a list", () => {
    record("a.html", "<p>a</p>", { format: "text/html" });
    expect(service.listArtifacts({ taskId: "t-1" })[0]).not.toHaveProperty("content");
  });

  it("is empty for a task that produced nothing, rather than an error", () => {
    expect(service.listArtifacts({ taskId: "t-nothing" })).toEqual([]);
  });
});

describe("uri:read of an artifact", () => {
  it("resolves through the MAP, so a virtual artifact reads back at all", async () => {
    // The whole reason this is a scheme rather than a `file:` path: nothing was written to disk, so
    // there is no path under an anchor that could name it.
    record("mockups/dash.html", "<h1>hi</h1>", { format: "text/html" });
    const content = await service.readUri({ uri: "artifact://t-1/mockups/dash.html" });
    expect(content).toMatchObject({ mime: "text/html", text: "<h1>hi</h1>" });
  });

  it("reads the address a produced artifact actually carries", async () => {
    // `show_artifact` returns `uri: artifact://<taskId>/<logicalPath>`, and this is that value handed
    // straight back — the point of matching the form rather than inventing a second one.
    record("notes.md", "# hi");
    expect((await service.readUri({ uri: "artifact://t-1/notes.md" })).text).toBe("# hi");
  });

  it("refuses one that names no record, including another task's", async () => {
    record("mine.html", "<p>x</p>", { format: "text/html" });
    await expect(service.readUri({ uri: "artifact://t-1/nope.html" })).rejects.toThrow(/names no artifact/);
    await expect(service.readUri({ uri: "artifact://t-2/mine.html" })).rejects.toThrow(/names no artifact/);
  });
});
