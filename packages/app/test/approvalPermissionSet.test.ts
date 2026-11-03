/**
 * A shell approval's answer, from the renderer's request to the hub and the permission set file
 * (decision 0007 §4) — through the real `AppService`.
 *
 * Three things are pinned here that no layer below can see on its own: that `remember` on
 * `approval:submit` reaches the hub's ledger (the renderer used to send a scope and nothing else);
 * that "add to the permission set" writes BEFORE it answers, in the layer asked for and never in what
 * ships; and that a write that cannot happen leaves the question parked instead of answering it.
 *
 * The policy is the real one and the call is judged the way a run's is — through the narrowing, with
 * a lowered block in hand — because the approval finds its parts by the call's own input object.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionRequest } from "@declarative-ai/permissions";
import { initProject } from "@jaira/persistence";
import { compilePolicy, type ApprovalHub } from "@jaira/runtime";
import { lowerPermissionSet, parsePermissionSet, setBuiltInDir, type PermissionsDecl, type PushMessage } from "@jaira/shared";
import { AppService } from "@jaira/service";

const REF = "$/permission-sets/chat/ask-first";
const SHIPPED = { shell: "ask", read_file: "allow", write_file: "allow", "git commit": "ask", "git log": "allow", other: "deny" } as const;

let scratch: string;
let dir: string;
let home: string;
let builtIn: string;
let service: AppService;
let pushes: PushMessage[];

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-approval-permission-set-"));
  dir = join(scratch, "project");
  home = join(scratch, "home");
  builtIn = join(scratch, "builtin");
  mkdirSync(dir, { recursive: true });
  write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
  setBuiltInDir(builtIn);
  initProject(dir, home);
  pushes = [];
  service = new AppService({ baseDir: home, publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

/** The open project's approval hub — the one `approval:submit` is routed to. */
function hub(): ApprovalHub {
  const sessions = (service as unknown as { sessions: Map<string, { approvals: ApprovalHub }> }).sessions;
  return [...sessions.values()][0]!.approvals;
}

/** Judge a line as a run's gate does, then park it: the approval finds the parts by this very input object. */
function park(command: string, source: string | undefined = REF): Promise<PermissionDecision> {
  const input = { command };
  expect(narrowingFor(input, source)).toBe("ask");
  const request: PermissionRequest = { tool: "shell", input: input as never, sessionId: "agent-1" };
  return Promise.resolve(hub().approver({ taskId: "t-1" })(request));
}

/** What the run's gate says about a call: `ask`, `deny`, or nothing at all when every part may run. */
function narrowingFor(input: { command: string }, source: string | undefined = REF): string | undefined {
  const lowered = lowerPermissionSet(parsePermissionSet(SHIPPED).permissionSet).permissions!;
  const block: PermissionsDecl = { ...lowered, ...(source !== undefined ? { source } : {}) };
  const policy = compilePolicy({}, { execEnv: { wsl: "test" }, grants: hub().grants("t-1") });
  return policy.scopeOf!({ name: "shell" } as never, input as never, block as never);
}

const projectFile = (): string => join(dir, ".jaira", "permission-sets", "chat", "ask-first.json");
const sharedFile = (): string => join(home, "permission-sets", "chat", "ask-first.json");

describe("a shell approval, answered through the service", () => {
  it("tells the renderer which permission set asked, and where a line could be written", async () => {
    void park("rm foo.txt && git commit -m wip");
    const [pending] = service.pendingApprovals();
    expect(pending!.parts!.permissionSet).toBe(REF);
    expect(pending!.permissionSet).toEqual({
      id: "chat/ask-first",
      targets: [
        { layer: "project", file: ".jaira/permission-sets/chat/ask-first.json", follows: "$SYSTEM/permission-sets/chat/ask-first" },
        { layer: "base", file: "~/.jaira/permission-sets/chat/ask-first.json", follows: "$SYSTEM/permission-sets/chat/ask-first" },
      ],
    });
    // The push carries the same thing, so a renderer that was already open draws the same menu.
    const pushed = pushes.find((m) => m.type === "approval:requested");
    expect(pushed).toMatchObject({ pending: { requestId: pending!.requestId, permissionSet: { id: "chat/ask-first" } } });
  });

  it("'for this run' reaches the hub's ledger at the width chosen, and writes nothing", async () => {
    const parked = park("git commit -m wip");
    const [pending] = service.pendingApprovals();
    service.submitApproval(pending!.requestId, "allow", "workflow-run", ["git"]);
    // The parts are remembered, never the shell: upstream is answered `once`.
    await expect(parked).resolves.toEqual({ decision: "allow", scope: "once" });
    expect(hub().grants("t-1").list()).toEqual({ git: "allow" });
    expect(existsSync(projectFile())).toBe(false);
    expect(existsSync(sharedFile())).toBe(false);
    expect(service.pendingApprovals()).toEqual([]);
  });

  it("'add to the permission set, in this project' creates an override that follows the built-in one, then answers and remembers", async () => {
    const parked = park("git commit -m wip && terraform plan");
    const [pending] = service.pendingApprovals();
    const shipped = readFileSync(join(builtIn, "permission-sets", "chat", "ask-first.json"), "utf8");

    service.submitApproval(pending!.requestId, "allow", "workflow-run", ["git commit", "terraform"], "project");

    expect(readFileSync(projectFile(), "utf8")).toBe('{\n  "$ref": "$SYSTEM/permission-sets/chat/ask-first",\n  "git commit": "allow",\n  "terraform": "allow"\n}\n');
    expect(readFileSync(join(builtIn, "permission-sets", "chat", "ask-first.json"), "utf8")).toBe(shipped);
    expect(existsSync(sharedFile())).toBe(false);
    await expect(parked).resolves.toEqual({ decision: "allow", scope: "once" });
    // A started task reads its pinned snapshot, so the same widths are remembered for the run too.
    expect(hub().grants("t-1").list()).toEqual({ "git commit": "allow", terraform: "allow" });

    // …so the same request later in this run is not a question any more.
    expect(narrowingFor({ command: "git commit -m again && terraform apply" })).toBeUndefined();
    // And the menu now describes a file that is THERE: the next line is added in place.
    void park("git log && npm publish");
    expect(service.pendingApprovals()[0]!.permissionSet!.targets[0]).toEqual({ layer: "project", file: ".jaira/permission-sets/chat/ask-first.json" });
  });

  it("'for all projects' writes the shared root, and a deny is written as deny", async () => {
    const parked = park("git commit -m wip");
    const [pending] = service.pendingApprovals();
    service.submitApproval(pending!.requestId, "deny", "workflow-run", ["git commit"], "base");
    expect(JSON.parse(readFileSync(sharedFile(), "utf8"))).toEqual({ $ref: "$SYSTEM/permission-sets/chat/ask-first", "git commit": "deny" });
    expect(existsSync(projectFile())).toBe(false);
    await expect(parked).resolves.toEqual({ decision: "deny", scope: "once" });
  });

  it("refuses a write it cannot make — the built-in layer, a map with no file — and leaves the question PARKED", async () => {
    void park("git commit -m wip");
    const [pending] = service.pendingApprovals();
    expect(() => service.submitApproval(pending!.requestId, "allow", "workflow-run", ["git commit"], "system" as never)).toThrow(/read-only/);
    expect(service.pendingApprovals().map((p) => p.requestId)).toEqual([pending!.requestId]);
    expect(hub().grants("t-1").list()).toEqual({});
    service.submitApproval(pending!.requestId, "deny");

    // A permission set written on the state: the menu is told so, and a submit that asks anyway is refused.
    const inline = park("git commit -m wip", "inline");
    const [second] = service.pendingApprovals();
    expect(second!.permissionSet).toMatchObject({ targets: [], unwritable: expect.stringMatching(/written on the state itself/) });
    expect(second!.permissionSet!.id).toBeUndefined();
    expect(() => service.submitApproval(second!.requestId, "allow", "workflow-run", ["git commit"], "project")).toThrow(/written on the state itself/);
    expect(service.pendingApprovals()).toHaveLength(1);
    expect(existsSync(projectFile())).toBe(false);
    // Once and this-run still work for it.
    service.submitApproval(second!.requestId, "allow", "workflow-run", []);
    await expect(inline).resolves.toEqual({ decision: "allow", scope: "once" });
    expect(hub().grants("t-1").list()).toEqual({ "git commit": "allow" });
  });
});

/**
 * The approval over a STACK (decision 0023 §4.4, §2.8): it lists the stack's layers newest first, with
 * where a line for each could be written, and "Add to" writes into the layer chosen — a deny as well as
 * an allow, and at a place, merged into the line.
 */
describe("an approval over a stack of sets", () => {
  const BUILD = "$/permission-sets/project/build-safe";
  const buildFile = (): string => join(dir, ".jaira", "permission-sets", "project", "build-safe.json");

  /** Judge a line under [chat/ask-first, project/build-safe], as a state naming that stack is lowered, and park it. */
  function parkStacked(command: string): Promise<PermissionDecision> {
    write(join(dir, ".jaira"), "permission-sets/project/build-safe.json", { git: "allow", terraform: "ask" });
    const set = parsePermissionSet({ ...SHIPPED, git: "allow", terraform: "ask" }).permissionSet;
    const stack = {
      layers: [{ id: "chat/ask-first", reference: REF }, { id: "project/build-safe", reference: BUILD }],
      lines: { terraform: { everywhere: "project/build-safe", places: {} }, git: { everywhere: "project/build-safe", places: {} }, shell: { everywhere: "chat/ask-first", places: {} } },
    };
    const block = lowerPermissionSet(set, REF, stack).permissions!;
    const policy = compilePolicy({}, { execEnv: { wsl: "test" }, grants: hub().grants("t-1") });
    const input = { command };
    expect(policy.scopeOf!({ name: "shell" } as never, input as never, block as never)).toBe("ask");
    return Promise.resolve(hub().approver({ taskId: "t-1" })({ tool: "shell", input: input as never, sessionId: "agent-1" }));
  }

  it("lists the stack newest first — runtime, this project's set, the shipped preset that changes for everyone — and names who asked", async () => {
    void parkStacked("terraform plan");
    const [pending] = service.pendingApprovals();
    expect(pending!.parts!.parts[0]!.decidedBy).toMatchObject({ entry: "terraform", layer: "project/build-safe" });
    expect(pending!.layers!.map((layer) => [layer.id, layer.scope, layer.targets.map((target) => target.layer), layer.everyone ?? false])).toEqual([
      ["runtime", "runtime", [], false],
      ["project/build-safe", "project", ["project"], false],
      ["chat/ask-first", "built in", ["project", "base"], true],
    ]);
    // The set that asked is where "Add to" starts, there being no standing layer for `chat` here.
    expect(pending!.defaultLayer).toBe("chat/ask-first");
  });

  it("'Add to' writes a DENY at a PLACE into the layer chosen, merged into its line, and keeps it for the run there", async () => {
    const parked = parkStacked("terraform plan");
    const [pending] = service.pendingApprovals();
    service.submitApproval(pending!.requestId, "deny", "workflow-run", ["terraform"], "project", "infra", "project/build-safe");
    // `terraform: "ask"` becomes its `**`, the place joins it; nothing else in the file moves.
    expect(JSON.parse(readFileSync(buildFile(), "utf8"))).toEqual({ git: "allow", terraform: { "**": "ask", infra: "deny" } });
    expect(existsSync(projectFile())).toBe(false);
    await expect(parked).resolves.toEqual({ decision: "deny", scope: "once" });
    expect(hub().grants("t-1").list()).toEqual({ "terraform @ infra": "deny" });
  });

  it("takes the ROWS one by one: a deny written into one layer, an allow for this run, a once — and refuses the call, keeping the rest", async () => {
    const parked = parkStacked("terraform plan && git commit -m wip && git log");
    const [pending] = service.pendingApprovals();
    const asking = pending!.parts!.parts.map((p, i) => [i, p.widths, p.verdict] as const).filter(([, , v]) => v === "asks");
    expect(asking.map(([, w]) => w)).toEqual([["terraform plan", "terraform"], ["git commit", "git"]]);
    const [terraform, push] = asking.map(([i]) => i);
    service.submitApproval(pending!.requestId, "deny", "workflow-run", undefined, undefined, undefined, undefined, [
      { part: terraform!, decision: "deny", reach: "add", width: "terraform", layer: "project/build-safe", addTo: "project" },
      { part: push!, decision: "allow", reach: "run" },
    ]);
    // Each row its own line, in its own layer; nothing in the preset's file.
    expect(JSON.parse(readFileSync(buildFile(), "utf8"))).toEqual({ git: "allow", terraform: "deny" });
    expect(existsSync(projectFile())).toBe(false);
    await expect(parked).resolves.toEqual({ decision: "deny", scope: "once" });
    expect(hub().grants("t-1").list()).toEqual({ terraform: "deny", "git commit": "allow" });
  });

  it("refuses rows that would allow a call one of whose parts is not allowed, or that name a part that does not ask — and leaves it parked", async () => {
    void parkStacked("terraform plan && git commit -m wip");
    const [pending] = service.pendingApprovals();
    const [terraform, push] = pending!.parts!.parts.map((p, i) => (p.verdict === "asks" ? i : -1)).filter((i) => i >= 0);
    const submit = (decision: "allow" | "deny", answers: never[]): unknown => service.submitApproval(pending!.requestId, decision, "once", undefined, undefined, undefined, undefined, answers);
    expect(() => submit("allow", [{ part: terraform!, decision: "allow", reach: "once" }] as never[])).toThrow(/not every part that asks was allowed/);
    expect(() => submit("allow", [{ part: terraform!, decision: "allow", reach: "once" }, { part: push!, decision: "deny", reach: "once" }] as never[])).toThrow(/not every part/);
    expect(() => submit("deny", [{ part: 99, decision: "deny", reach: "once" }] as never[])).toThrow(/not a part of this line that asks/);
    expect(() => submit("deny", [{ part: terraform!, decision: "deny", reach: "run", width: "rm" }] as never[])).toThrow(/not a width/);
    expect(() => submit("deny", [{ part: terraform!, decision: "deny", reach: "add", width: "terraform" }] as never[])).toThrow(/which file/);
    expect(service.pendingApprovals().map((p) => p.requestId)).toEqual([pending!.requestId]);
    expect(hub().grants("t-1").list()).toEqual({});
    // Every row allowed: the call runs.
    submit("allow", [{ part: terraform!, decision: "allow", reach: "once" }, { part: push!, decision: "allow", reach: "once" }] as never[]);
    expect(service.pendingApprovals()).toEqual([]);
  });

  it("refuses a layer the call was not judged under, the runtime layer and the tools layer — and leaves the question parked", async () => {
    void parkStacked("terraform plan");
    const [pending] = service.pendingApprovals();
    expect(() => service.submitApproval(pending!.requestId, "allow", "workflow-run", ["terraform"], "project", undefined, "web/docs")).toThrow(/not a layer of the stack/);
    expect(() => service.submitApproval(pending!.requestId, "allow", "workflow-run", ["terraform"], "project", undefined, "runtime")).toThrow(/For this run/);
    expect(service.pendingApprovals().map((p) => p.requestId)).toEqual([pending!.requestId]);
  });
});
