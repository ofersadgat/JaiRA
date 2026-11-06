/**
 * The permission sets left `chat/` (2026-11-05): what names them by the old reference is rewritten once,
 * when its root is opened, and nothing reads the old names after (`permissionSetsMove.ts`).
 *
 * The old names are spelled in pieces here (`OLD`, `OLD_CONTROL`) so a sweep that renames references
 * across the tests leaves this file's fixtures as the old names they have to be.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowBundle } from "@declarative-ai/hw";
import { shippedLayer, testHome } from "@jaira/testing";
import { initProject, openProject, type Project } from "../src/project";
import { ensureSnapshot } from "../src/snapshots";
import { listPermissionSets } from "../src/permissionSets";
import { moveRecordedPermissionSets, moveTaskPermissionSets, renamedPermissionSetReferences } from "../src/permissionSetsMove";

/** The old folders, by name. */
const OLD = ["ch", "at"].join("");
const OLD_CONTROL = `${OLD}_control`;
/** `$/permission-sets/<old>/<name>` and `$/permission-sets/<old control>/<name>`. */
const old = (name: string, root = "$"): string => `${root}/permission-sets/${OLD}/${name}`;
const oldControl = (name: string, root = "$"): string => `${root}/permission-sets/${OLD_CONTROL}/${name}`;

let dir: string;
let project: Project | undefined;

const write = (file: string, body: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
};
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sets-move-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("renaming a reference", () => {
  it("renames the old folder to the top level and the old control folder to control/, from every root, and leaves everything else", () => {
    expect(renamedPermissionSetReferences(old("read-only"))).toBe("$/permission-sets/read-only");
    expect(renamedPermissionSetReferences(old("ask-first.json", "$SYSTEM"))).toBe("$SYSTEM/permission-sets/ask-first.json");
    expect(renamedPermissionSetReferences(oldControl("full", "$BASE"))).toBe("$BASE/permission-sets/control/full");
    expect(renamedPermissionSetReferences(`$/permission-sets/feature/read-only ${OLD}/session`)).toBe(`$/permission-sets/feature/read-only ${OLD}/session`);
  });
});

describe("a project opened after the move", () => {
  it("moves its own set files up out of the old folder and into control/, and renames what they follow", () => {
    shippedLayer();
    const sets = join(dir, ".jaira", "permission-sets");
    write(join(sets, OLD, "read-only.json"), { $ref: old("read-only", "$SYSTEM"), shell: "ask" });
    write(join(sets, OLD_CONTROL, "full.json"), { $ref: oldControl("full", "$SYSTEM") });
    write(join(sets, "web", "docs.json"), { layers: [old("auto")], web_fetch: "allow" });
    project = openProject(dir, { baseDir: testHome() });
    expect(existsSync(join(sets, OLD))).toBe(false);
    expect(existsSync(join(sets, OLD_CONTROL))).toBe(false);
    expect(read(join(sets, "read-only.json"))).toEqual({ $ref: "$SYSTEM/permission-sets/read-only", shell: "ask" });
    expect(read(join(sets, "control", "full.json"))).toEqual({ $ref: "$SYSTEM/permission-sets/control/full" });
    expect(read(join(sets, "web", "docs.json"))).toEqual({ layers: ["$/permission-sets/auto"], web_fetch: "allow" });
    // The project's copy is found at the top level, over the one that ships.
    const listed = listPermissionSets(project.paths.roots);
    expect(listed.find((set) => set.id === "read-only")).toMatchObject({ bucket: "", root: project.paths.jairaDir, overrides: true });
  });

  it("leaves a file whose new place is taken where it was", () => {
    const sets = join(dir, ".jaira", "permission-sets");
    write(join(sets, OLD, "read-only.json"), { shell: "ask" });
    write(join(sets, "read-only.json"), { shell: "deny" });
    project = openProject(dir, { baseDir: testHome() });
    expect(read(join(sets, "read-only.json"))).toEqual({ shell: "deny" });
    expect(read(join(sets, OLD, "read-only.json"))).toEqual({ shell: "ask" });
  });

  it("renames the references in its workflows and its settings, and the standing layers' bucket keys", () => {
    write(join(dir, ".jaira", "workflows", "plan.json"), { label: "Plan", environment: { tools: old("read-only") } });
    write(join(dir, ".jaira", "settings.json"), { permissions: { layers: { [OLD]: ["$/permission-sets/project/build-safe"], [OLD_CONTROL]: [oldControl("ask-first")], feature: [] } } });
    project = openProject(dir, { baseDir: testHome() });
    expect(read(join(dir, ".jaira", "workflows", "plan.json"))).toEqual({ label: "Plan", environment: { tools: "$/permission-sets/read-only" } });
    expect(read(join(dir, ".jaira", "settings.json"))).toEqual({ permissions: { layers: { "": ["$/permission-sets/project/build-safe"], control: ["$/permission-sets/control/ask-first"], feature: [] } } });
    expect(project.config.permissions.layers).toEqual({ "": ["$/permission-sets/project/build-safe"], control: ["$/permission-sets/control/ask-first"], feature: [] });
  });
});

describe("a workspace's tasks", () => {
  /** A pinned `chat/session` whose root names `source` — what a conversation that never picked a stack is shown. */
  const pinned = async (source: string): Promise<string> => {
    const bundle = { rootId: "chat/session", states: { "chat/session": { label: "Chat", environment: { tools: [], permissions: { tools: {}, source } } } } } as unknown as WorkflowBundle;
    return (await ensureSnapshot(project!.paths.snapshotsDir, bundle)).hash;
  };
  const task = (id: string, meta: Record<string, unknown>, hash?: string): string => {
    const file = join(project!.paths.tasksDir, `${id}.json`);
    write(file, { id, title: id, createdAt: 1, inputs: {}, ...meta });
    project!.db.prepare(`INSERT INTO task_runtime (task_id, status, snapshot_hash, created_at, updated_at) VALUES (?, 'completed', ?, 1, 1)`).run(id, hash ?? null);
    return file;
  };

  it("renames a conversation's own stack, and gives one that picked none the renamed set its snapshot named", async () => {
    project = openProject(dir, { baseDir: testHome() });
    const picked = task("t-picked", { workflow: "chat/session", chatSettings: { model: "m", permissionSet: { layers: [old("full")] } } });
    const unpicked = task("t-unpicked", { workflow: "chat/session", chatSettings: { model: "m" } }, await pinned(old("ask-first")));
    const control = task("t-control", { workflow: "chat/control" }, await pinned(oldControl("ask-first")));
    const workflowTask = task("t-workflow", { workflow: "feature" }, await pinned(old("read-only")));
    const current = task("t-current", { workflow: "chat/session" }, await pinned("$/permission-sets/ask-first"));

    moveTaskPermissionSets(project.paths.tasksDir, project.paths.snapshotsDir, project.db);

    expect((read(picked) as { chatSettings: unknown }).chatSettings).toEqual({ model: "m", permissionSet: { layers: ["$/permission-sets/full"] } });
    expect((read(unpicked) as { chatSettings: unknown }).chatSettings).toEqual({ model: "m", permissionSet: { layers: ["$/permission-sets/ask-first"] } });
    expect((read(control) as { chatSettings: unknown }).chatSettings).toEqual({ permissionSet: { layers: ["$/permission-sets/control/ask-first"] } });
    // A workflow's task is not a conversation: its composer is not the task's.
    expect(read(workflowTask)).not.toHaveProperty("chatSettings");
    // A conversation pinned after the move already names the new set, and is left alone.
    expect(read(current)).not.toHaveProperty("chatSettings");
  });

  it("renames the settings filed beside each turn's request (migration 32)", () => {
    project = openProject(dir, { baseDir: testHome() });
    const request = { scope: { instanceId: "chat:x", sequence: 1 }, chatSettings: { permissionSet: { layers: [old("auto"), oldControl("full")] } } };
    project.db.prepare(`INSERT INTO operation_records (id, task_id, status, request_json, started_at) VALUES ('op1', 't', 'completed', ?, 1)`).run(JSON.stringify(request));
    moveRecordedPermissionSets(project.db);
    const row = project.db.prepare(`SELECT request_json AS request FROM operation_records WHERE id = 'op1'`).get() as { request: string };
    expect(JSON.parse(row.request).chatSettings).toEqual({ permissionSet: { layers: ["$/permission-sets/auto", "$/permission-sets/control/full"] } });
  });
});
