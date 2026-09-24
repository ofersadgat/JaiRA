/**
 * The app never writes to the built-in layer (decision 0006, step 1).
 *
 * `$SYSTEM` is a third value of `layer` now, and every surface that takes one used to branch
 * `layer === "base" ? shared : project` — so the question worth a test is not only "does a write
 * into the app get refused" but "does it get refused rather than QUIETLY LANDING IN THE PROJECT",
 * which is what that branch would have done with a value it had never heard of.
 *
 * The layer itself is a fixture directory, registered for the process the way a host would: nothing
 * here depends on what `packages/shared/builtin/` holds.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { setBuiltInDir } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let builtIn: string;
let service: AppService;

const SHIPPED = JSON.stringify({ label: "Shipped" });

/** Every file under a directory, relative — what "nothing was written" is asserted against. */
function filesUnder(root: string, rel = ""): string[] {
  if (!existsSync(join(root, rel))) return [];
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(root, join(rel, entry.name)) : [join(rel, entry.name).replace(/\\/g, "/")],
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-builtin-app-"));
  builtIn = mkdtempSync(join(tmpdir(), "jaira-shipped-app-"));
  for (const [path, text] of [
    ["workflows/chat/hello.json", SHIPPED],
    ["prompts/hello.md", "shipped prompt"],
  ] as const) {
    mkdirSync(dirname(join(builtIn, path)), { recursive: true });
    writeFileSync(join(builtIn, path), text, "utf8");
  }
  setBuiltInDir(builtIn);
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  setBuiltInDir(undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(builtIn, { recursive: true, force: true });
});

describe("reading what ships", () => {
  it("reads a shipped state and a shipped prompt by the `system` layer", () => {
    const state = service.readWorkflow({ stateId: "chat/hello", layer: "system" });
    expect(state.exists).toBe(true);
    expect(state.text).toBe(SHIPPED);
    expect(state.file).toBe(join(builtIn, "workflows", "chat", "hello.json"));
    expect(service.readFile({ layer: "system", path: "prompts/hello.md" }).text).toBe("shipped prompt");
  });

  it("lists the shipped state among the workflows, marked `system`", () => {
    const entry = service.browseWorkflows().files.find((f) => f.stateId === "chat/hello");
    expect(entry?.layer).toBe("system");
  });

  it("still refuses a path that climbs out of the layer", () => {
    expect(() => service.readFile({ layer: "system", path: "../outside.md" })).toThrow(/not inside/);
    expect(() => service.readWorkflow({ stateId: "../../escape", layer: "system" })).toThrow(/does not name a state/);
  });
});

describe("writing to what ships", () => {
  const READ_ONLY = /read-only/;

  it("refuses every write surface that takes a layer", async () => {
    expect(() => service.writeWorkflow({ stateId: "chat/hello", layer: "system", text: "{}" })).toThrow(READ_ONLY);
    expect(() => service.writeWorkflow({ stateId: "chat/new", layer: "system", text: "{}" })).toThrow(READ_ONLY);
    expect(() => service.deleteWorkflow({ stateId: "chat/hello", layer: "system", force: true })).toThrow(READ_ONLY);
    expect(() => service.writeFile({ layer: "system", path: "prompts/hello.md", text: "mine" })).toThrow(READ_ONLY);
    expect(() => service.createFile({ layer: "system", path: "prompts/new.md", kind: "file", text: "x" })).toThrow(READ_ONLY);
    expect(() => service.createFile({ layer: "system", path: "permission-sets/mine", kind: "directory" })).toThrow(READ_ONLY);
    expect(() => service.renameFile({ layer: "system", path: "prompts/hello.md", to: "prompts/bye.md" })).toThrow(READ_ONLY);
    expect(() => service.deleteFile({ layer: "system", path: "prompts", force: true })).toThrow(READ_ONLY);
    await expect(service.runSync({ layer: "system", path: "workflows/workflow.md", direction: "states" })).rejects.toThrow(
      READ_ONLY,
    );
    expect(service.syncStatus({ layer: "system", path: "workflows/workflow.md" }).blocked).toMatch(READ_ONLY);
  });

  it("leaves the layer byte-for-byte as it was, and writes nothing into the project instead", () => {
    const before = filesUnder(dir);
    for (const attempt of [
      () => service.writeWorkflow({ stateId: "chat/hello", layer: "system", text: '{"label":"Mine"}' }),
      () => service.writeFile({ layer: "system", path: "prompts/hello.md", text: "mine" }),
      () => service.createFile({ layer: "system", path: "prompts/new.md", kind: "file", text: "x" }),
      () => service.deleteFile({ layer: "system", path: "prompts/hello.md", force: true }),
    ]) {
      expect(attempt).toThrow(READ_ONLY);
    }
    expect(filesUnder(builtIn).sort()).toEqual(["prompts/hello.md", "workflows/chat/hello.json"]);
    expect(readFileSync(join(builtIn, "workflows/chat/hello.json"), "utf8")).toBe(SHIPPED);
    expect(readFileSync(join(builtIn, "prompts/hello.md"), "utf8")).toBe("shipped prompt");
    // The fall-through this guards against: `system` read as "not base, so project".
    expect(filesUnder(dir)).toEqual(before);
  });

  it("refuses to move a state INTO the layer, or OUT of it by renaming", () => {
    service.writeWorkflow({ stateId: "mine", layer: "project", text: '{"label":"Mine"}' });
    expect(() => service.moveWorkflow({ stateId: "mine", layer: "project", to: "mine", toLayer: "system" })).toThrow(READ_ONLY);
    expect(() =>
      service.moveWorkflow({ stateId: "mine", layer: "project", to: "mine", toLayer: "system", copy: true }),
    ).toThrow(READ_ONLY);
    // A move without `copy` would REMOVE the shipped file, which is a write to the layer.
    expect(() => service.moveWorkflow({ stateId: "chat/hello", layer: "system", to: "chat/hello", toLayer: "project" })).toThrow(
      READ_ONLY,
    );
    expect(existsSync(join(builtIn, "workflows/chat/hello.json"))).toBe(true);
  });

  it("allows the override: a COPY out of the layer, into the project or the shared root", () => {
    const here = service.moveWorkflow({ stateId: "chat/hello", layer: "system", to: "chat/hello", toLayer: "project", copy: true });
    expect(here).toMatchObject({ applied: true, layer: "project" });
    expect(readFileSync(join(dir, ".jaira", "workflows", "chat", "hello.json"), "utf8")).toBe(SHIPPED);

    const everywhere = service.moveWorkflow({ stateId: "chat/hello", layer: "system", to: "chat/hello", toLayer: "base", copy: true });
    expect(everywhere).toMatchObject({ applied: true, layer: "base" });
    expect(readFileSync(join(testHome(), "workflows", "chat", "hello.json"), "utf8")).toBe(SHIPPED);

    // The shipped copy is untouched, and is now the shadowed one.
    expect(readFileSync(join(builtIn, "workflows/chat/hello.json"), "utf8")).toBe(SHIPPED);
    const copies = service.browseWorkflows().files.filter((f) => f.stateId === "chat/hello");
    expect(copies.map((f) => [f.layer, f.shadowed === true]).sort()).toEqual([
      ["base", true],
      ["project", false],
      ["system", true],
    ]);
  });
});
