/**
 * What the agent reads for a refused call, and who refused it (decision 0007, amended 2026-10-24) —
 * through the REAL upstream gate, because the seam is the point: upstream says which step refused, the
 * deciders write down who stands behind it, and the policy's `refusal` says it.
 */
import { describe, expect, it } from "vitest";
import { PermissionLedger, withPermission, type PermissionDenied } from "@declarative-ai/permissions";
import type { ExecServices, FunctionInputs, Tool } from "@declarative-ai/exec";
import { lowerPermissionSet, parsePermissionSet } from "@jaira/shared";
import { ApprovalHub, type ApprovalRequest } from "../src/approval";
import { compilePolicy, type RuleRefusal } from "../src/policy";
import { noteRefusal, refusalWords, takeRefusal } from "../src/refusals";

const PERMISSION_SET = { shell: "ask", write_file: "ask", "git commit": "ask", "git rm": "deny", other: "deny" } as const;

function harness(toolName: "shell" | "write_file" = "shell") {
  const asked: ApprovalRequest[] = [];
  const hub = new ApprovalHub({ onRequest: (request) => void asked.push(request) });
  const refusedByRule: RuleRefusal[] = [];
  const policy = compilePolicy({}, { execEnv: { wsl: "test" }, grants: hub.grants("t1"), onRefused: (r) => void refusedByRule.push(r) });
  const block = lowerPermissionSet(parsePermissionSet(PERMISSION_SET).permissionSet).permissions!;
  const ran: unknown[] = [];
  const tool: Tool = { description: toolName, inputSchema: { type: "object" }, readOnly: false, run: async (input) => (ran.push(input), { ok: true }) } as Tool;
  const ledger = new PermissionLedger({ baseline: policy.baseline ?? {} });
  const gated = withPermission(tool, {
    ledger,
    sessionId: "s1",
    toolName,
    approve: hub.approver({ taskId: "t1" }),
    authoredMode: block.tools![toolName]!,
    ...(policy.smart![toolName] !== undefined ? { smart: policy.smart![toolName]! } : {}),
    scopeOf: policy.scopeOf!,
    refusal: policy.refusal!,
    authored: block as never,
  });
  const run = (input: Record<string, unknown>) => gated.run(input as FunctionInputs, {} as ExecServices) as Promise<PermissionDenied | { ok: true }>;
  return { hub, asked, ran, run, refusedByRule };
}

/** Let a parked request reach the hub. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the words the agent reads for a refused call", () => {
  it("names the permission set and the part it denied — and tells the host, which draws it as a step", async () => {
    const { run, ran, refusedByRule } = harness();
    const result = await run({ command: "git commit -m wip && git rm a.txt" });
    expect(result).toEqual({
      denied: true,
      tool: "shell",
      reason: "Not run: this conversation's permission set denies shell (git rm a.txt). Nothing was run. Do not retry it; do the work another way, or ask the person to change the permission set.",
    });
    expect(ran).toEqual([]);
    expect(refusedByRule.map((r) => r.by)).toEqual([{ kind: "rule", rule: "permission set", reason: "git rm a.txt" }]);
  });

  it("says the person denied it, and tells the host nothing: the person's answer is a step already", async () => {
    const { run, hub, asked, refusedByRule } = harness();
    const pending = run({ command: "git commit -m wip" });
    await tick();
    hub.decide(asked[0]!.requestId, "deny");
    expect(await pending).toMatchObject({
      denied: true,
      reason: "Not run: the person denied this call. Nothing was run. Do not make it again; carry on without it, or ask them what they want instead.",
    });
    expect(refusedByRule).toEqual([]);
  });

  it("says the run was stopped while the call waited — not that anybody said no", async () => {
    const { run, hub, asked } = harness();
    const pending = run({ command: "git commit -m wip" });
    await tick();
    hub.stop("t1");
    expect(asked).toHaveLength(1);
    expect(await pending).toMatchObject({ reason: "Not run: the run was stopped while this call waited for approval. Nothing was run." });
  });

  it("says a tool the person denied for longer than one call was denied by that answer, not by the permission set", async () => {
    const { run, hub, asked, refusedByRule } = harness("write_file");
    const first = run({ path: "a.md", content: "x" });
    await tick();
    hub.decide(asked[0]!.requestId, "deny", "workflow-run");
    await first;
    expect(await run({ path: "b.md", content: "y" })).toMatchObject({
      reason: "Not run: the person denied write_file earlier in this conversation. Nothing was changed. Do not retry it; carry on without it, or ask them.",
    });
    expect(asked).toHaveLength(1);
    expect(refusedByRule.map((r) => r.by.rule)).toEqual(["earlier answer"]);
  });
});

describe("who refused, as the deciders write it down", () => {
  it("keeps the person's answer when a function that asked them hands their no on", () => {
    const input = { command: "curl https://example.com" };
    noteRefusal(input, { kind: "person" });
    noteRefusal({ ...input }, { kind: "function", function: "smart" }, true);
    expect(takeRefusal(input)).toEqual({ kind: "person" });
    // Read once.
    expect(takeRefusal(input)).toBeUndefined();
  });

  it("words every kind of refusal: Not run, who, why when known, that nothing happened", () => {
    expect(refusalWords({ kind: "function", function: "smart", reason: "a subagent the task did not ask for" }, "agent")).toBe(
      "Not run: auto denied it (a subagent the task did not ask for). Nothing was done. Do not retry the same call; carry on without it, or tell the person why you need it.",
    );
    expect(refusalWords({ kind: "function", function: "./judge.ts#judge" }, "web_fetch")).toMatch(/^Not run: the function '\.\/judge\.ts#judge' denied it\. Nothing was fetched\./);
    expect(refusalWords({ kind: "rule", rule: "built-in rules", reason: "deletes recursively" }, "shell")).toBe(
      "Not run: JaiRA's built-in rules refuse this shell call (deletes recursively). Nothing was run. Do not retry it; do the work another way.",
    );
    expect(refusalWords({ kind: "rule", rule: "scopes" }, "edit")).toBe("Not run: edit would act outside where this conversation may act. Nothing was changed. Do not retry it there.");
    expect(refusalWords({ kind: "rule", rule: "profile", profile: "plan" }, "write_file")).toMatch(/^Not run: this conversation is in plan mode, which does not allow write_file\./);
    expect(refusalWords({ kind: "nobody", why: "closed" }, "read_file")).toBe("Not run: the app closed while this call waited for approval. Nothing was read.");
    expect(refusalWords({ kind: "nobody", why: "unattended", reason: "run it in the app to be asked" }, "shell")).toBe(
      "Not run: this call needs approval and nobody is here to give it (run it in the app to be asked). Nothing was run.",
    );
    expect(refusalWords({ kind: "approver" }, "edit")).toBe("Not run: this call was not approved. Nothing was changed. Do not make it again; carry on without it.");
  });
});
