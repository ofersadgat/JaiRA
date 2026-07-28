/**
 * Per-command approvals (DESIGN §10.2) through the app surface: policy escalates
 * a tool call, the approval reaches the inbox, the human's answer (with its scope)
 * releases it, and every decision lands in the audit trail.
 *
 * The hub is driven directly rather than through a real agent: what is under test
 * is JaiRA's approval + audit path, and an agent would only add a dependency on a
 * provider to reach it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@declarative-ai/permissions";
import { initProject, openProject, type Project } from "@jaira/persistence";
import { ApprovalHub, compilePolicy, type ApprovalRequest, type PolicyAuditEntry } from "@jaira/runtime";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-approve-"));
  initProject(dir);
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const request = (command: string): PermissionRequest =>
  ({ tool: "bash", input: { command } as never, sessionId: "agent-1" });

describe("ApprovalHub", () => {
  it("parks an ask, reports it, and resolves on the human's answer", async () => {
    const seen: ApprovalRequest[] = [];
    const hub = new ApprovalHub({ onRequest: (r) => seen.push(r), nextId: () => "a1" });
    const pending = hub.approver({ taskId: "t-1" })(request("git push origin main"));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestId: "a1", tool: "bash", command: "git push origin main", taskId: "t-1" });
    expect(hub.list()).toHaveLength(1);

    expect(hub.decide("a1", "allow", "workflow-run")).toBe(true);
    await expect(pending).resolves.toEqual({ decision: "allow", scope: "workflow-run" });
    expect(hub.list()).toEqual([]);
    // Answering twice is not an error the caller must guard against.
    expect(hub.decide("a1", "allow")).toBe(false);
  });

  it("explains why it is asking, using the policy's reason", async () => {
    const hub = new ApprovalHub({ onRequest: () => undefined, nextId: () => "a1" });
    const policy = compilePolicy({}, { onDecision: hub.noteDecision });
    // Run the policy first, exactly as a real call does: its audit entry carries
    // the reason the approval prompt should show.
    await policy.smart!["bash"]!(request("npm publish"));

    const seen: ApprovalRequest[] = [];
    const explaining = new ApprovalHub({ onRequest: (r) => seen.push(r), nextId: () => "a2" });
    explaining.noteDecision({
      tool: "bash",
      command: "npm publish",
      action: "require_approval",
      reason: "publishing a package is public and irreversible",
      sessionId: "agent-1",
    });
    void explaining.approver()(request("npm publish"));
    expect(seen[0]!.reason).toMatch(/publishing a package/);
  });

  it("denies rather than hanging when nothing can answer", async () => {
    // A run with no UI attached must not block an agent's tool loop forever.
    const unattended = new ApprovalHub();
    await expect(unattended.approver()(request("git push"))).resolves.toEqual({ decision: "deny", scope: "once" });
  });

  it("denies every parked approval on denyAll", async () => {
    const hub = new ApprovalHub({ onRequest: () => undefined, nextId: () => "a1" });
    const pending = hub.approver()(request("git push"));
    hub.denyAll();
    await expect(pending).resolves.toMatchObject({ decision: "deny" });
  });
});

describe("policy → approval → audit", () => {
  it("records what policy decided and what the human then chose", async () => {
    // A run row references a task row (the FK the schema declares), so both exist.
    project.runtime.insert("t-1", Date.now());
    const run = project.runtime.beginRun("t-1", "hash", Date.now());

    const audit: PolicyAuditEntry[] = [];
    const hub = new ApprovalHub({ onRequest: () => undefined, nextId: () => "a1" });
    const policy = compilePolicy(
      {},
      {
        onDecision: (entry) => {
          audit.push(entry);
          hub.noteDecision(entry);
          project.commands.record({
            taskId: "t-1",
            runId: run,
            tool: entry.tool,
            ...(entry.command !== undefined ? { command: entry.command } : {}),
            decision: entry.action === "deny" ? "blocked" : "allowed",
            decidedBy: "policy",
            reason: entry.reason,
            sessionId: entry.sessionId,
          });
        },
      },
    );

    // 1. Allowed outright.
    expect(await policy.smart!["bash"]!(request("git status"))).toBe("allow");
    // 2. Blocked by the §11.2 list.
    expect(await policy.smart!["bash"]!(request("git reset --hard"))).toBe("deny");
    // 3. Escalated, then approved by a human for the whole run.
    expect(await policy.smart!["bash"]!(request("git push origin main"))).toBe("ask");
    void hub.approver({ taskId: "t-1" })(request("git push origin main"));
    hub.decide("a1", "allow", "workflow-run");
    project.commands.record({
      taskId: "t-1",
      runId: run,
      tool: "bash",
      command: "git push origin main",
      decision: "approved",
      decidedBy: "user",
      scope: "workflow-run",
    });

    const log = project.commands.list("t-1");
    expect(log.map((e) => e.decision)).toEqual(["allowed", "blocked", "allowed", "approved"]);
    expect(log.find((e) => e.decision === "blocked")).toMatchObject({
      command: "git reset --hard",
      decidedBy: "policy",
    });
    expect(log.find((e) => e.decision === "approved")).toMatchObject({
      decidedBy: "user",
      scope: "workflow-run",
    });
    // The summary is what a run's safety story looks like at a glance.
    expect(project.commands.summary("t-1")).toEqual({ allowed: 2, blocked: 1, approved: 1, denied: 0 });
  });

  it("keeps the parsed intent in the log, so the audit shows what was matched", () => {
    project.runtime.insert("t-2", Date.now());
    const run = project.runtime.beginRun("t-2", "hash", Date.now());
    project.commands.record({
      taskId: "t-2",
      runId: run,
      tool: "bash",
      command: "git -C /x reset --hard",
      parsed: { program: "git", subcommand: "reset", flags: ["--hard"] },
      decision: "blocked",
      decidedBy: "policy",
      reason: "hard reset discards work",
    });
    const [entry] = project.commands.list("t-2");
    expect(entry!.parsed).toMatchObject({ program: "git", subcommand: "reset" });
    expect(entry!.reason).toBe("hard reset discards work");
  });
});
