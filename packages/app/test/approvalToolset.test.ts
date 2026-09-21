/**
 * A shell approval's answer, from the renderer's request to the hub and the toolset file
 * (decision 0007 §4) — through the real `AppService`.
 *
 * Three things are pinned here that no layer below can see on its own: that `remember` on
 * `approval:submit` reaches the hub's ledger (the renderer used to send a scope and nothing else);
 * that "add to the toolset" writes BEFORE it answers, in the layer asked for and never in what
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
import { lowerToolset, parseToolset, setBuiltInDir, type PermissionsDecl, type PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

const REF = "$/toolsets/chat/ask-first";
const SHIPPED = { bash: "ask", read_file: "allow", write_file: "allow", "git commit": "ask", "git log": "allow", other: "deny" } as const;

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
  scratch = mkdtempSync(join(tmpdir(), "jaira-approval-toolset-"));
  dir = join(scratch, "project");
  home = join(scratch, "home");
  builtIn = join(scratch, "builtin");
  mkdirSync(dir, { recursive: true });
  write(builtIn, "toolsets/chat/ask-first.json", SHIPPED);
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
  const request: PermissionRequest = { tool: "bash", input: input as never, sessionId: "agent-1" };
  return Promise.resolve(hub().approver({ taskId: "t-1" })(request));
}

/** What the run's gate says about a call: `ask`, `deny`, or nothing at all when every part may run. */
function narrowingFor(input: { command: string }, source: string | undefined = REF): string | undefined {
  const lowered = lowerToolset(parseToolset(SHIPPED).toolset).permissions!;
  const block: PermissionsDecl = { ...lowered, ...(source !== undefined ? { source } : {}) };
  const policy = compilePolicy({}, { execEnv: { wsl: "test" }, grants: hub().grants("t-1") });
  return policy.scopeOf!({ name: "bash" } as never, input as never, block as never);
}

const projectFile = (): string => join(dir, ".jaira", "toolsets", "chat", "ask-first.json");
const sharedFile = (): string => join(home, "toolsets", "chat", "ask-first.json");

describe("a shell approval, answered through the service", () => {
  it("tells the renderer which toolset asked, and where a line could be written", async () => {
    void park("rm foo.txt && git commit -m wip");
    const [pending] = service.pendingApprovals();
    expect(pending!.parts!.toolset).toBe(REF);
    expect(pending!.toolset).toEqual({
      id: "chat/ask-first",
      targets: [
        { layer: "project", file: ".jaira/toolsets/chat/ask-first.json", follows: "$SYSTEM/toolsets/chat/ask-first" },
        { layer: "base", file: "~/.jaira/toolsets/chat/ask-first.json", follows: "$SYSTEM/toolsets/chat/ask-first" },
      ],
    });
    // The push carries the same thing, so a renderer that was already open draws the same menu.
    const pushed = pushes.find((m) => m.type === "approval:requested");
    expect(pushed).toMatchObject({ pending: { requestId: pending!.requestId, toolset: { id: "chat/ask-first" } } });
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

  it("'add to the toolset, in this project' creates an override that follows the built-in one, then answers and remembers", async () => {
    const parked = park("git commit -m wip && terraform plan");
    const [pending] = service.pendingApprovals();
    const shipped = readFileSync(join(builtIn, "toolsets", "chat", "ask-first.json"), "utf8");

    service.submitApproval(pending!.requestId, "allow", "workflow-run", ["git commit", "terraform"], "project");

    expect(readFileSync(projectFile(), "utf8")).toBe('{\n  "$ref": "$SYSTEM/toolsets/chat/ask-first",\n  "git commit": "allow",\n  "terraform": "allow"\n}\n');
    expect(readFileSync(join(builtIn, "toolsets", "chat", "ask-first.json"), "utf8")).toBe(shipped);
    expect(existsSync(sharedFile())).toBe(false);
    await expect(parked).resolves.toEqual({ decision: "allow", scope: "once" });
    // A started task reads its pinned snapshot, so the same widths are remembered for the run too.
    expect(hub().grants("t-1").list()).toEqual({ "git commit": "allow", terraform: "allow" });

    // …so the same request later in this run is not a question any more.
    expect(narrowingFor({ command: "git commit -m again && terraform apply" })).toBeUndefined();
    // And the menu now describes a file that is THERE: the next line is added in place.
    void park("git log && npm publish");
    expect(service.pendingApprovals()[0]!.toolset!.targets[0]).toEqual({ layer: "project", file: ".jaira/toolsets/chat/ask-first.json" });
  });

  it("'for all projects' writes the shared root, and a deny is written as deny", async () => {
    const parked = park("git commit -m wip");
    const [pending] = service.pendingApprovals();
    service.submitApproval(pending!.requestId, "deny", "workflow-run", ["git commit"], "base");
    expect(JSON.parse(readFileSync(sharedFile(), "utf8"))).toEqual({ $ref: "$SYSTEM/toolsets/chat/ask-first", "git commit": "deny" });
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

    // A toolset written on the state: the menu is told so, and a submit that asks anyway is refused.
    const inline = park("git commit -m wip", "inline");
    const [second] = service.pendingApprovals();
    expect(second!.toolset).toMatchObject({ targets: [], unwritable: expect.stringMatching(/written on the state itself/) });
    expect(second!.toolset!.id).toBeUndefined();
    expect(() => service.submitApproval(second!.requestId, "allow", "workflow-run", ["git commit"], "project")).toThrow(/written on the state itself/);
    expect(service.pendingApprovals()).toHaveLength(1);
    expect(existsSync(projectFile())).toBe(false);
    // Once and this-run still work for it.
    service.submitApproval(second!.requestId, "allow", "workflow-run", []);
    await expect(inline).resolves.toEqual({ decision: "allow", scope: "once" });
    expect(hub().grants("t-1").list()).toEqual({ "git commit": "allow" });
  });
});
