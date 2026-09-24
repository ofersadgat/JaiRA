/**
 * The three channels Settings → Permission sets talks through (decision 0007 §6), against a real tree.
 *
 * `permissionSets:read` / `permissionSets:write` / `permissionSets:reset`, over the REAL `packages/shared/builtin/`
 * permission sets — what this asserts is about the files that ship. The shared root is a temp directory
 * (`testHome`), never the machine's `~/.jaira`.
 *
 * What is worth proving HERE rather than in `@jaira/persistence`, which owns the writes themselves:
 * that the layer picker's three segments are the layers the service reports, that nothing is ever
 * written into what ships however the request is spelled, and that a write says which scope to
 * re-read.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { jairaBuiltInPaths, permissionSetsAt, permissionSetStanding, type PushMessage, type PermissionSetDecl } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

const shipped = (id: string): PermissionSetDecl => JSON.parse(readFileSync(join(jairaBuiltInPaths().dir, "permission-sets", `${id}.json`), "utf8")) as PermissionSetDecl;

const write = (root: string, rel: string, body: unknown): string => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return file;
};

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-permission-sets-service-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("permissionSets:read", () => {
  it("answers the eight shipped permission sets, the layers this window has, and the tools a line can name", () => {
    const view = service.readPermissionSetSettings({ project: dir });
    expect(view.records.map((r) => r.id)).toEqual([
      "chat/ask-first",
      "chat/auto",
      "chat/full",
      "chat/read-only",
      "chat_control/ask-first",
      "chat_control/auto",
      "chat_control/full",
      "chat_control/read-only",
    ]);
    expect(view.records.every((r) => r.files.every((f) => f.layer === "system" && f.decl !== undefined))).toBe(true);
    // The three segments of the layer picker, nearest first (decision 0006).
    expect(view.layers).toEqual(["project", "base", "system"]);
    expect(view.tools.map((t) => t.name)).toContain("read_file");
    // A tool named and not served yet still gets a line — a permission set may hold one (0007 step 4).
    expect(view.tools.map((t) => t.name)).toContain("start_task");
  });

  it("skips the used-by scan when it is not asked for", () => {
    write(join(dir, ".jaira"), "workflows/plan.json", { environment: { tools: "$/permission-sets/chat/read-only" } });
    expect(service.readPermissionSetSettings({ project: dir }).usedBy["chat/read-only"]).toEqual(["plan"]);
    expect(service.readPermissionSetSettings({ project: dir, usedBy: false }).usedBy).toEqual({});
  });
});

describe("permissionSets:write", () => {
  it("writes an override of what ships, following it, holding only what differs — and says so", () => {
    const decl: PermissionSetDecl = { ...shipped("chat/read-only"), bash: "ask" };
    const written = service.writePermissionSetSettings({ id: "chat/read-only", layer: "project", project: dir, permissionSet: decl });
    expect(written.kind).toBe("override");
    expect(readFileSync(written.file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/permission-sets/chat/read-only",\n  "bash": "ask"\n}\n`);
    // The pane re-reads on this scope, so a permission set written here shows up everywhere a state is read.
    expect(pushes.some((p) => p.type === "store:invalidate" && p.scope === "workflows")).toBe(true);

    const after = permissionSetsAt(service.readPermissionSetSettings({ project: dir }).records, "project");
    const readOnly = after.find((at) => at.id === "chat/read-only")!;
    expect(permissionSetStanding(readOnly)).toEqual({ here: true, label: "overrides built in" });
    expect(readOnly.source.decl).toMatchObject({ bash: "ask", read_file: "allow" });
  });

  it("stops following when a line what ships holds is taken out, because an override cannot say that", () => {
    const { glob: _gone, ...rest } = shipped("chat/read-only");
    const written = service.writePermissionSetSettings({ id: "chat/read-only", layer: "project", project: dir, permissionSet: rest });
    expect(written.kind).toBe("detach");
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual(rest);
  });

  it("refuses what ships, and writes nothing", () => {
    const before = readFileSync(join(jairaBuiltInPaths().dir, "permission-sets", "chat", "read-only.json"), "utf8");
    expect(() => service.writePermissionSetSettings({ id: "chat/read-only", layer: "system", project: dir, permissionSet: { other: "allow" } })).toThrow(/read-only/);
    expect(readFileSync(join(jairaBuiltInPaths().dir, "permission-sets", "chat", "read-only.json"), "utf8")).toBe(before);
  });

  it("refuses an id that climbs out of the layer, and a map that is not a permission set", () => {
    expect(() => service.writePermissionSetSettings({ id: "../../escape", layer: "project", project: dir, permissionSet: { other: "allow" } })).toThrow();
    expect(() => service.writePermissionSetSettings({ id: "chat/x", layer: "project", project: dir, permissionSet: { read_file: "whenever" } as never })).toThrow(/not a permission set/);
    expect(existsSync(join(dir, "..", "escape.json"))).toBe(false);
  });

  it("creates a permission set in a bucket nobody holds — what `+ permission set` and `+ bucket` do", () => {
    const written = service.writePermissionSetSettings({ id: "feature/quiet", layer: "project", project: dir, permissionSet: { other: "ask" } });
    expect(written.kind).toBe("create");
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual({ other: "ask" });
    expect(service.readPermissionSetSettings({ project: dir, usedBy: false }).records.map((r) => r.id)).toContain("feature/quiet");
  });
});

describe("permissionSets:reset", () => {
  it("deletes the override, so what ships answers again", () => {
    const written = service.writePermissionSetSettings({ id: "chat/read-only", layer: "project", project: dir, permissionSet: { ...shipped("chat/read-only"), bash: "ask" } });
    expect(service.resetPermissionSetSettings({ id: "chat/read-only", layer: "project", project: dir }).file).toBe(written.file);
    expect(existsSync(written.file)).toBe(false);
    const at = permissionSetsAt(service.readPermissionSetSettings({ project: dir, usedBy: false }).records, "project").find((one) => one.id === "chat/read-only")!;
    expect(at.here).toBe(false);
    expect(at.source.decl).toEqual(shipped("chat/read-only"));
  });

  it("refuses to delete a permission set that overrides nothing, and refuses what ships", () => {
    service.writePermissionSetSettings({ id: "feature/quiet", layer: "project", project: dir, permissionSet: { other: "ask" } });
    expect(() => service.resetPermissionSetSettings({ id: "feature/quiet", layer: "project", project: dir })).toThrow(/overrides nothing/);
    expect(() => service.resetPermissionSetSettings({ id: "chat/read-only", layer: "system", project: dir })).toThrow(/read-only/);
  });
});
