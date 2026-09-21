/**
 * One shell line, from the agent's call to the person's answer (decision 0007 §4) — through the
 * REAL upstream gate, because the seams are the point: the state's toolset reaches the policy only
 * through `scopeOf`, the approver and the approval are handed the same input and nothing else, and
 * what is remembered must be the asking parts and never the shell tool.
 */
import { describe, expect, it } from "vitest";
import { PermissionLedger, isPermissionDenied, withPermission } from "@declarative-ai/permissions";
import type { ExecServices, FunctionInputs, Tool } from "@declarative-ai/exec";
import { lowerToolset, parseToolset } from "@jaira/shared";
import { ApprovalHub, type ApprovalRequest } from "../src/approval";
import { compilePolicy, type PolicyAuditEntry } from "../src/policy";

const TOOLSET = { bash: "ask", read_file: "allow", write_file: "ask", script: "ask", "git commit": "ask", "git log": "allow", "git rm": "deny", other: "deny" } as const;

function harness() {
  const asked: ApprovalRequest[] = [];
  const hub = new ApprovalHub({ onRequest: (request) => void asked.push(request) });
  const audit: PolicyAuditEntry[] = [];
  const policy = compilePolicy({}, { execEnv: { wsl: "test" }, grants: hub.grants("t1"), onDecision: (e) => audit.push(e) });
  // What a loaded state holds: the list and the lowered block, whichever form its author wrote.
  const block = lowerToolset(parseToolset(TOOLSET).toolset).permissions!;
  const ran: string[] = [];
  const bash: Tool = {
    description: "shell",
    inputSchema: { type: "object" },
    readOnly: false,
    run: async (input) => {
      ran.push((input as { command: string }).command);
      return { ok: true };
    },
  } as Tool;
  const gated = withPermission(bash, {
    ledger: new PermissionLedger({ baseline: policy.baseline ?? {} }),
    sessionId: "s1",
    toolName: "bash",
    approve: hub.approver({ taskId: "t1" }),
    authoredMode: block.tools!["bash"]!,
    smart: policy.smart!["bash"]!,
    scopeOf: policy.scopeOf!,
    authored: block as never,
  });
  const run = (command: string) => gated.run({ command } as FunctionInputs, {} as ExecServices);
  return { hub, asked, audit, ran, run };
}

describe("an approval for a shell line", () => {
  it("runs a line whose every part may, without asking anybody", async () => {
    const { run, asked, ran } = harness();
    await run("cd src && cat a.ts && git log --oneline");
    expect(asked).toEqual([]);
    expect(ran).toEqual(["cd src && cat a.ts && git log --oneline"]);
  });

  it("refuses a line with one denied part, without asking about the rest", async () => {
    const { run, asked, ran, audit } = harness();
    expect(isPermissionDenied(await run("git commit -m wip && git rm a.txt"))).toBe(true);
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: "bash", action: "deny", reason: "the toolset's 'git rm' is deny" });
    expect(audit[0]!.parts!.parts.map((p) => p.verdict)).toEqual(["asks", "denied"]);
  });

  it("asks ONCE, and the request carries the parts", async () => {
    const { run, hub, asked, ran } = harness();
    const line = "rm foo.txt && git commit -m wip && git log";
    const pending = run(line);
    await Promise.resolve();
    expect(asked).toHaveLength(1);
    const request = asked[0]!;
    // Every existing consumer's fields are where they were…
    expect(request).toMatchObject({ tool: "bash", command: line, taskId: "t1", reason: "the toolset's 'git commit' is ask" });
    // …and the parts are beside them.
    expect(request.parts).toMatchObject({ line, dialect: "posix", verdict: "asks" });
    expect(request.parts!.parts.map((p) => ({ text: p.text, subject: p.subject, verdict: p.verdict, entry: p.decidedBy.entry, widths: p.widths }))).toEqual([
      { text: "rm foo.txt", subject: "write_file", verdict: "asks", entry: "write_file", widths: ["rm"] },
      { text: "git commit -m wip", subject: "git commit", verdict: "asks", entry: "git commit", widths: ["git commit", "git"] },
      { text: "git log", subject: "git log", verdict: "allowed", entry: "git log", widths: ["git log", "git"] },
    ]);
    hub.decide(request.requestId, "allow");
    await pending;
    expect(ran).toEqual([line]);
  });

  it("remembers the asking PARTS for the run — and never the shell", async () => {
    const { run, hub, asked, ran } = harness();
    const first = run("rm foo.txt && git commit -m wip");
    await Promise.resolve();
    // "Every command of the program", for this run. A wider upstream scope is NOT applied with it:
    // that would remember `bash`, and the next line's parts would never be asked about.
    hub.decide(asked[0]!.requestId, "allow", "workflow-run", ["git"]);
    await first;
    expect(hub.grants("t1").list()).toEqual({ rm: "allow", git: "allow" });

    await run("git commit --amend; rm other.txt; git stash");
    expect(asked).toHaveLength(1);

    const third = run("git stash && make deploy");
    await Promise.resolve();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.parts!.parts.map((p) => `${p.subject} ${p.verdict} ${p.decidedBy.source}`)).toEqual(["git stash allowed remembered", "script asks toolset"]);
    hub.decide(asked[1]!.requestId, "deny");
    expect(isPermissionDenied(await third)).toBe(true);

    // A remembered width does not reach over a deny…
    expect(isPermissionDenied(await run("git rm a.txt"))).toBe(true);
    expect(isPermissionDenied(await run("git reset --hard"))).toBe(true);
    expect(ran).toEqual(["rm foo.txt && git commit -m wip", "git commit --amend; rm other.txt; git stash"]);
    // …and a new run starts with nothing remembered.
    hub.allow("t1");
    expect(hub.grants("t1").list()).toEqual({});
  });

  it("asks about a line it cannot read, and that answer cannot be remembered", async () => {
    const { run, hub, asked } = harness();
    const pending = run("$TOOL --do-it");
    await Promise.resolve();
    expect(asked[0]!.parts!.parts).toMatchObject([{ kind: "command", verdict: "asks", decidedBy: { source: "parser" }, widths: [] }]);
    hub.decide(asked[0]!.requestId, "allow", "once", []);
    await pending;
    expect(hub.grants("t1").list()).toEqual({});
  });
});
