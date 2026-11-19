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
import { initProject, permissionSetReader, workflowLoadOptions } from "@jaira/persistence";
import {
  copyDifferences,
  jairaBuiltInPaths,
  jairaPaths,
  rebasePermissionSetChange,
  resolvePermissionSetDecl,
  permissionSetsAt,
  permissionSetStanding,
  SHARED_SESSION,
  type PushMessage,
  type PermissionSetDecl,
} from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];
const others: string[] = [];

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
  for (const one of [dir, ...others.splice(0)]) rmSync(one, { recursive: true, force: true });
});

describe("permissionSets:read", () => {
  it("answers the six shipped permission sets, the layers this window has, and the tools a line can name", () => {
    const view = service.readPermissionSetSettings({ project: dir });
    expect(view.records.map((r) => r.id)).toEqual([
      "ask-first",
      "auto",
      "full",
      "improve/simulation",
      "read-only",
      "read-only-scratch",
    ]);
    expect(view.records.every((r) => r.files.every((f) => f.layer === "system" && f.decl !== undefined))).toBe(true);
    // Every layer a set can be in, nearest first: the settings' six, then what ships (decision 0023, amended 2026-11-18).
    expect(view.layers).toEqual(["projectYou", "you", "projectMachine", "machine", "project", "base", "system"]);
    expect(view.tools.map((t) => t.name)).toContain("read_file");
    // A tool named and not served yet still gets a line — a permission set may hold one (0007 step 4).
    expect(view.tools.map((t) => t.name)).toContain("start_task");
  });

  it("skips the used-by scan when it is not asked for", () => {
    write(join(dir, ".jaira"), "workflows/plan.json", { environment: { tools: "$/permission-sets/read-only" } });
    expect(service.readPermissionSetSettings({ project: dir }).usedBy["read-only"]).toEqual(["plan"]);
    expect(service.readPermissionSetSettings({ project: dir, usedBy: false }).usedBy).toEqual({});
  });

  it("reads the shared root when the window names it, with several projects open", async () => {
    const other = mkdtempSync(join(tmpdir(), "jaira-permission-sets-service-"));
    others.push(other);
    initProject(other, testHome());
    await service.open(other);
    // Nothing named with two open is the caller's fault, and stays a refusal…
    expect(() => service.readPermissionSetSettings({ usedBy: false })).toThrow(/several projects are open/);
    // …while `shared` — a window standing at the root — reads the root, which has no project's layers.
    expect(service.readPermissionSetSettings({ project: SHARED_SESSION, usedBy: false }).layers).toEqual(["you", "machine", "base", "system"]);
  });
});

describe("permissionSets:write", () => {
  it("writes an override of what ships, following it, holding only what differs — and says so", () => {
    const decl: PermissionSetDecl = { ...shipped("read-only"), shell: "ask" };
    const written = service.writePermissionSetSettings({ id: "read-only", layer: "project", project: dir, permissionSet: decl });
    expect(written.kind).toBe("override");
    expect(readFileSync(written.file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/permission-sets/read-only",\n  "shell": "ask"\n}\n`);
    // The pane re-reads on this scope, so a permission set written here shows up everywhere a state is read.
    expect(pushes.some((p) => p.type === "store:invalidate" && p.scope === "workflows")).toBe(true);

    const after = permissionSetsAt(service.readPermissionSetSettings({ project: dir }).records, "project");
    const readOnly = after.find((at) => at.id === "read-only")!;
    expect(permissionSetStanding(readOnly)).toEqual({ here: true, label: "this project · copied from built in" });
    expect(readOnly.source.decl).toMatchObject({ shell: "ask", read_file: { $PROJECT: "allow" } });
  });

  it("stops following when a line what ships holds is taken out, because an override cannot say that", () => {
    const { glob: _gone, ...rest } = shipped("read-only");
    const written = service.writePermissionSetSettings({ id: "read-only", layer: "project", project: dir, permissionSet: rest });
    expect(written.kind).toBe("detach");
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual(rest);
  });

  it("refuses what ships, and writes nothing", () => {
    const before = readFileSync(join(jairaBuiltInPaths().dir, "permission-sets", "read-only.json"), "utf8");
    expect(() => service.writePermissionSetSettings({ id: "read-only", layer: "system", project: dir, permissionSet: { other: "allow" } })).toThrow(/read-only/);
    expect(readFileSync(join(jairaBuiltInPaths().dir, "permission-sets", "read-only.json"), "utf8")).toBe(before);
  });

  it("refuses an id that climbs out of the layer, and a map that is not a permission set", () => {
    expect(() => service.writePermissionSetSettings({ id: "../../escape", layer: "project", project: dir, permissionSet: { other: "allow" } })).toThrow();
    expect(() => service.writePermissionSetSettings({ id: "x", layer: "project", project: dir, permissionSet: { read_file: 7 } as never })).toThrow(/not a permission set/);
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
    const written = service.writePermissionSetSettings({ id: "read-only", layer: "project", project: dir, permissionSet: { ...shipped("read-only"), shell: "ask" } });
    expect(service.resetPermissionSetSettings({ id: "read-only", layer: "project", project: dir }).file).toBe(written.file);
    expect(existsSync(written.file)).toBe(false);
    const at = permissionSetsAt(service.readPermissionSetSettings({ project: dir, usedBy: false }).records, "project").find((one) => one.id === "read-only")!;
    expect(at.here).toBe(false);
    expect(at.source.decl).toEqual(shipped("read-only"));
  });

  it("refuses to delete a permission set that overrides nothing, and refuses what ships", () => {
    service.writePermissionSetSettings({ id: "feature/quiet", layer: "project", project: dir, permissionSet: { other: "ask" } });
    expect(() => service.resetPermissionSetSettings({ id: "feature/quiet", layer: "project", project: dir })).toThrow(/overrides nothing/);
    expect(() => service.resetPermissionSetSettings({ id: "read-only", layer: "system", project: dir })).toThrow(/read-only/);
  });
});

/**
 * Round 5 (2026-09-23): a built-in set is live on every layer, and its FIRST change is the copy. There
 * is no channel of its own for that — the pane sends the map as shown with the change applied through
 * `permissionSets:write`, and what this proves is that the one write is the copy AND the change, in the
 * layer the page is on, and that "Put back the built-in" is the reset that deletes it.
 */
describe("copy on first edit", () => {
  const readAt = (layer: "project" | "base", id: string) =>
    permissionSetsAt(service.readPermissionSetSettings({ project: dir, usedBy: false }).records, layer).find((at) => at.id === id)!;

  it("on Shared: one write makes ~/.jaira's copy with the change in it, following what ships", () => {
    const before = readAt("base", "ask-first");
    expect(before.here).toBe(false);
    const written = service.writePermissionSetSettings({ id: "ask-first", layer: "base", project: dir, permissionSet: { ...before.source.decl!, shell: "allow" } });
    expect(written.file).toBe(join(testHome(), "permission-sets", "ask-first.json"));
    expect(written.kind).toBe("override");
    expect(readFileSync(written.file, "utf8")).toBe(`{\n  "$ref": "$SYSTEM/permission-sets/ask-first",\n  "shell": "allow"\n}\n`);
    // What ships is untouched.
    expect(shipped("ask-first").shell).not.toBe("allow");

    const after = readAt("base", "ask-first");
    expect(permissionSetStanding(after)).toEqual({ here: true, label: "shared · copied from built in" });
    expect(copyDifferences(after)).toBe(1);
    expect(after.source.file).toBe("~/.jaira/permission-sets/ask-first.json");
    // The project, which states nothing of it, now reads the shared copy.
    expect(readAt("project", "ask-first").source.layer).toBe("base");
  });

  it("on this project, over a shared copy: copies the set as it is IN EFFECT — the shared one — and says so", () => {
    service.writePermissionSetSettings({ id: "ask-first", layer: "base", project: dir, permissionSet: { ...shipped("ask-first"), shell: "allow" } });
    const seen = readAt("project", "ask-first");
    const written = service.writePermissionSetSettings({ id: "ask-first", layer: "project", project: dir, permissionSet: { ...seen.source.decl!, web_fetch: "deny" } });
    expect(written.file).toBe(join(dir, ".jaira", "permission-sets", "ask-first.json"));
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual({ $ref: "$BASE/permission-sets/ask-first", web_fetch: "deny" });
    const after = readAt("project", "ask-first");
    expect(permissionSetStanding(after).label).toBe("this project · copied from Shared");
    // Shared's line is carried by the `$ref`, and the project's own sits over it.
    expect(after.source.decl).toMatchObject({ shell: "allow", web_fetch: "deny" });
    expect(copyDifferences(after)).toBe(1);
  });

  it("Put back the built-in deletes the layer's copy, and what ships answers again", () => {
    const written = service.writePermissionSetSettings({ id: "ask-first", layer: "base", project: dir, permissionSet: { ...shipped("ask-first"), shell: "allow" } });
    expect(service.resetPermissionSetSettings({ id: "ask-first", layer: "base", project: dir }).file).toBe(written.file);
    expect(existsSync(written.file)).toBe(false);
    const after = readAt("base", "ask-first");
    expect(after.here).toBe(false);
    expect(after.source.layer).toBe("system");
    expect(permissionSetStanding(after).label).toBe("built in");
  });

  it("from a layer an older engine keeps no sets for: the change, replayed over the chosen layer's own view, carries none of the nearer layer's lines", () => {
    // The project has its own copy; the page's layer reads it, and its change goes to Shared.
    service.writePermissionSetSettings({ id: "ask-first", layer: "project", project: dir, permissionSet: { ...shipped("ask-first"), web_fetch: "deny" } });
    const shown = readAt("project", "ask-first").source.decl!;
    const onto = readAt("base", "ask-first").source.decl!;
    const written = service.writePermissionSetSettings({
      id: "ask-first",
      layer: "base",
      project: dir,
      permissionSet: rebasePermissionSetChange(shown, { ...shown, shell: "allow" }, onto),
    });
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual({ $ref: "$SYSTEM/permission-sets/ask-first", shell: "allow" });
    // The project's copy still says what it said, and follows nothing new.
    expect(readAt("project", "ask-first").source.decl).toMatchObject({ web_fetch: "deny" });
  });
});

/**
 * The settings' six layers each keep permission sets (decision 0023, amended 2026-11-18): this machine's in
 * `~/.jaira/machine`, the project on this machine in `.jaira/local` (which git ignores), Just you in
 * `~/.jaira/personal`, you in the project beside your settings for it — read in the settings' order, the
 * most specific first, by the Settings pane and by a run's `$/permission-sets/…` alike.
 */
describe("a permission set in each of the settings' layers", () => {
  const view = () => service.readPermissionSetSettings({ project: dir, usedBy: false });
  const readAt = (layer: Parameters<typeof permissionSetsAt>[1], id: string) => permissionSetsAt(view().records, layer).find((at) => at.id === id)!;
  /** What a run's `tools: "$/permission-sets/<id>"` reads: the nearest copy, followed. */
  const inEffect = (id: string): PermissionSetDecl =>
    resolvePermissionSetDecl(`$/permission-sets/${id}`, permissionSetReader(workflowLoadOptions(jairaPaths(dir, testHome()), { tolerant: true })), "", []) as PermissionSetDecl;

  it("keeps each layer's copy where its settings are kept, and the project on this machine out of git", () => {
    const base = shipped("ask-first");
    const machine = service.writePermissionSetSettings({ id: "ask-first", layer: "machine", project: dir, permissionSet: { ...base, web_fetch: "deny" } });
    expect(machine.file).toBe(join(testHome(), "machine", "permission-sets", "ask-first.json"));
    const local = service.writePermissionSetSettings({ id: "ask-first", layer: "projectMachine", project: dir, permissionSet: { ...base, shell: "allow" } });
    expect(local.file).toBe(join(dir, ".jaira", "local", "permission-sets", "ask-first.json"));
    expect(readFileSync(join(dir, ".jaira", ".gitignore"), "utf8").split("\n")).toContain("local/");
    const you = service.writePermissionSetSettings({ id: "ask-first", layer: "you", project: dir, permissionSet: { ...base, read_file: "allow" } });
    expect(you.file).toBe(join(testHome(), "personal", "permission-sets", "ask-first.json"));
    const mine = service.writePermissionSetSettings({ id: "ask-first", layer: "projectYou", project: dir, permissionSet: { ...readAt("projectYou", "ask-first").source.decl!, write_file: "deny" } });
    expect(dirname(dirname(mine.file))).toBe(dirname(service.readConfig(dir).projectYouFile!));
    // Each is listed in its own layer, the nearer ones shadowing it.
    expect(readAt("machine", "ask-first")).toMatchObject({ here: true, shadowedBy: "projectYou", source: { file: "~/.jaira/machine/permission-sets/ask-first.json" } });
    expect(permissionSetStanding(readAt("projectMachine", "ask-first")).label).toBe("this project on this machine · copied from this machine");
  });

  it("is read by a run as the settings are: you in the project, Just you, the project on this machine, this machine, the project", () => {
    const base = shipped("ask-first");
    service.writePermissionSetSettings({ id: "ask-first", layer: "project", project: dir, permissionSet: { ...base, web_fetch: "allow" } });
    expect(inEffect("ask-first").web_fetch).toBe("allow");
    service.writePermissionSetSettings({ id: "ask-first", layer: "machine", project: dir, permissionSet: { ...base, web_fetch: "deny" } });
    expect(inEffect("ask-first").web_fetch).toBe("deny");
    service.writePermissionSetSettings({ id: "ask-first", layer: "projectMachine", project: dir, permissionSet: { ...readAt("projectMachine", "ask-first").source.decl!, web_fetch: "ask" } });
    expect(inEffect("ask-first").web_fetch).toBe("ask");
    service.writePermissionSetSettings({ id: "ask-first", layer: "you", project: dir, permissionSet: { ...base, shell: "allow" } });
    expect(inEffect("ask-first")).toMatchObject({ shell: "allow" });
    service.writePermissionSetSettings({ id: "ask-first", layer: "projectYou", project: dir, permissionSet: { ...readAt("projectYou", "ask-first").source.decl!, shell: "deny" } });
    expect(inEffect("ask-first")).toMatchObject({ shell: "deny" });
    // The composer offers the nearest copy, and says whose it is.
    expect(view().records.find((r) => r.id === "ask-first")!.files.map((f) => f.layer)).toEqual(["projectYou", "you", "projectMachine", "machine", "project", "system"]);
  });

  it("follows no project's copy from a layer that is no project's, which every project reads", () => {
    service.writePermissionSetSettings({ id: "ask-first", layer: "project", project: dir, permissionSet: { ...shipped("ask-first"), web_fetch: "allow" } });
    // This machine's pane sees what ships under it, not this project's copy…
    expect(readAt("machine", "ask-first").source.layer).toBe("system");
    const written = service.writePermissionSetSettings({ id: "ask-first", layer: "machine", project: dir, permissionSet: { ...shipped("ask-first"), shell: "allow" } });
    // …so its copy follows what ships, and means the same in every project on this machine.
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toEqual({ $ref: "$SYSTEM/permission-sets/ask-first", shell: "allow" });
    // The project on this machine is the project's, and follows the nearest copy under it, this machine's.
    const local = service.writePermissionSetSettings({ id: "ask-first", layer: "projectMachine", project: dir, permissionSet: { ...readAt("projectMachine", "ask-first").source.decl!, read_file: "ask" } });
    expect(JSON.parse(readFileSync(local.file, "utf8"))).toMatchObject({ $ref: "$MACHINE/permission-sets/ask-first" });
    // Reset takes this machine's copy away, and what ships answers there again.
    service.resetPermissionSetSettings({ id: "ask-first", layer: "machine", project: dir });
    expect(readAt("machine", "ask-first").source.layer).toBe("system");
  });

  it("reads the shared root's own three — this machine's, Just you and Shared — with no project named", () => {
    service.writePermissionSetSettings({ id: "ask-first", layer: "machine", project: SHARED_SESSION, permissionSet: { ...shipped("ask-first"), web_fetch: "deny" } });
    const shared = service.readPermissionSetSettings({ project: SHARED_SESSION, usedBy: false });
    expect(shared.records.find((r) => r.id === "ask-first")!.files.map((f) => f.layer)).toEqual(["machine", "system"]);
    expect(() => service.writePermissionSetSettings({ id: "ask-first", layer: "projectMachine", project: SHARED_SESSION, permissionSet: shipped("ask-first") })).toThrow(/no projectMachine layer/);
  });
});

/**
 * The set browser's channels (decision 0023 §4.1, §7.4): the tree of set files, one set's own lines,
 * the whole stack composed, and a stack saved as a set — over the REAL shipped sets.
 */
describe("permissionSets:tree, :own, :stack and :saveStack", () => {
  const STACK = { layers: ["$/permission-sets/ask-first", "$/permission-sets/web/docs"], web_search: "unavailable", write_file: "allow" };
  beforeEach(() => {
    write(join(dir, ".jaira"), "permission-sets/web/docs.json", { icon: "globe", web_fetch: { "docs.example.com": "allow" } });
  });

  it("lists every scope's set files, marking the ones the composer's stack is built of", () => {
    const tree = service.permissionSetTree({ project: dir, permissionSet: STACK });
    expect(tree.scopes.map((scope) => scope.scope)).toEqual(["built in", "global", "project"]);
    // The shipped conversation sets are at the top level: the scope's own sets, in no bucket.
    expect(tree.scopes[0]!.buckets.map((bucket) => bucket.name)).toEqual(["improve"]);
    expect(tree.scopes[0]!.sets.map((set) => [set.name, set.icon, set.inStack])).toEqual([
      ["ask-first", "ask", true],
      ["auto", "smart", false],
      ["full", "allow", false],
      ["read-only", "deny", false],
      ["read-only-scratch", "deny", false],
    ]);
    expect(tree.scopes[2]!.buckets.find((bucket) => bucket.name === "web")!.sets[0]).toMatchObject({ id: "web/docs", icon: "globe", inStack: true, lines: 1 });
  });

  it("reads one set's OWN lines", () => {
    expect(service.ownPermissionSet({ project: dir, reference: "$/permission-sets/web/docs" }).lines).toEqual({ web_fetch: { "docs.example.com": "allow" } });
    expect(() => service.ownPermissionSet({ project: dir, reference: "$/permission-sets/web/nope" })).toThrow(/no scope holds/);
  });

  it("composes the whole stack, every line tagged with the layer that decided it", () => {
    const view = service.permissionStack({ project: dir, permissionSet: STACK });
    expect(view.layers.map((layer) => [layer.id, layer.scope, layer.role])).toEqual([
      ["ask-first", "built in", "bottom"],
      ["web/docs", "project", "named"],
      ["runtime", "runtime", "runtime"],
      ["tools", "this conversation", "own"],
    ]);
    const line = (subject: string) => view.lines.find((each) => each.subject === subject)!;
    expect(line("write_file")).toMatchObject({ layer: "tools", value: "allow" });
    expect(line("web_fetch")).toMatchObject({ layer: "ask-first", places: { "docs.example.com": { decision: "allow", layer: "web/docs" } } });
    expect(line("web_search")).toMatchObject({ unavailable: "tools" });
    expect(line("read_file").places["$PROJECT"]).toEqual({ decision: "ask", layer: "ask-first" });
  });

  it("saves the stack as a set: its layers and the tools layer's own lines — and refuses what ships and a stack it cannot read", () => {
    const saved = service.savePermissionStack({ project: dir, layer: "project", bucket: "mine", name: "docs-writer", permissionSet: STACK });
    expect(saved).toMatchObject({ id: "mine/docs-writer", scope: "project", layers: ["$/permission-sets/ask-first", "$/permission-sets/web/docs"], lines: 2 });
    expect(JSON.parse(readFileSync(join(dir, ".jaira", "permission-sets", "mine", "docs-writer.json"), "utf8"))).toEqual(STACK);
    // It reads back as the stack it was: the preset, then the docs layer, then its own lines.
    expect(service.permissionStack({ project: dir, permissionSet: { layers: ["$/permission-sets/mine/docs-writer"] } }).layers.map((layer) => layer.id)).toEqual([
      "ask-first",
      "web/docs",
      "mine/docs-writer",
      "runtime",
    ]);
    expect(() => service.savePermissionStack({ project: dir, layer: "system" as never, bucket: "mine", name: "x", permissionSet: STACK })).toThrow(/read-only/);
    expect(() => service.savePermissionStack({ project: dir, layer: "project", bucket: "mine", name: "x", permissionSet: { layers: ["$/permission-sets/web/nope"] } })).toThrow(/cannot be read/);
    expect(() => service.savePermissionStack({ project: dir, layer: "project", bucket: "mine", name: "docs-writer", permissionSet: STACK })).toThrow(/already exists/);
  });

  it("names each layer by the reference the stack named it through, so a file built of layers is one segment", () => {
    service.savePermissionStack({ project: dir, layer: "project", bucket: "mine", name: "built", permissionSet: STACK });
    const view = service.permissionStack({ project: dir, permissionSet: { layers: ["$/permission-sets/read-only", "$/permission-sets/mine/built"] } });
    expect(view.layers.map((layer) => [layer.id, layer.role, layer.via])).toEqual([
      ["read-only", "bottom", "$/permission-sets/read-only"],
      ["ask-first", "named", "$/permission-sets/mine/built"],
      ["web/docs", "named", "$/permission-sets/mine/built"],
      ["mine/built", "named", "$/permission-sets/mine/built"],
      ["runtime", "runtime", undefined],
    ]);
  });

  it("lets go of the run's answers one by one, or all of them — a run mark's × and `let go of all`", () => {
    const open = (service as unknown as { session: (project?: string) => { approvals: { grants: (taskId: string) => { remember: (width: string, decision: "allow" | "deny", place?: string) => void; list: () => Record<string, string> } } } }).session(dir);
    const grants = open.approvals.grants("t-stack");
    grants.remember("npm run build", "allow", "packages");
    grants.remember("git push", "deny");
    expect(service.permissionStack({ project: dir, taskId: "t-stack", permissionSet: STACK }).runtime).toEqual({ "npm run build @ packages": "allow", "git push": "deny" });
    expect(service.forgetRuntimeAnswers({ project: dir, taskId: "t-stack", keys: ["npm run build @ packages"] })).toEqual({ "git push": "deny" });
    expect(service.forgetRuntimeAnswers({ project: dir, taskId: "t-stack" })).toEqual({});
  });

  it("words a composer's stack by the set it comes to, and hands its settings back as the composer wrote them", () => {
    const plan = service.chatStartPlan({ project: dir, overrides: { permissionSet: { layers: ["$/permission-sets/read-only"] } as never } });
    expect(plan.effective.permissions).toBe("read-only");
    expect(plan.settings.permissionSet).toEqual({ layers: ["$/permission-sets/read-only"] });
  });
});
