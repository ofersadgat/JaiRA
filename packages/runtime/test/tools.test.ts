/**
 * The `bash` tool (DESIGN §8, §10.1) and the chain it completes: an agent's tool
 * call → `withPermission` → the compiled policy → the command parser → allow /
 * deny / ask. Registering this tool is *why* SPEC §11.2/§11.3 apply to an agent at
 * all, so the test drives the real gate rather than the policy in isolation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPermissionDenied, PermissionLedger, withPermission, type Approver } from "@declarative-ai/permissions";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { compilePolicy, type PolicyAuditEntry } from "../src/policy";
import { createBashTool, JAIRA_TOOLS, registerAllTools, registerTools } from "../src/tools";
import { registerFileTools } from "../src/fileTools";
import { newRegistry } from "../src/wiring";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-tool-"));
  writeFileSync(join(dir, "hello.txt"), "hi\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<ExecServices> = {}): ExecServices => ({ ...over }) as ExecServices;
const call = async (tool: Tool, input: unknown, c: ExecServices = ctx()) =>
  (await (tool.run as (i: unknown, x: unknown) => Promise<Record<string, unknown>>)(input, c)) ?? {};

describe("createBashTool", () => {
  it("runs a command in the workspace and returns its output", async () => {
    const tool = createBashTool();
    const result = await call(tool, { command: "echo hello-from-jaira" }, ctx({ workspace: { root: dir } }));
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain("hello-from-jaira");
  }, 60_000);

  it("reports a non-zero exit rather than throwing", async () => {
    const tool = createBashTool();
    const result = await call(tool, { command: "exit 3" }, ctx({ workspace: { root: dir } }));
    expect(result.exitCode).toBe(3);
  }, 60_000);

  it("declares readOnly: false, which is what plan/read-only profiles gate on", () => {
    expect(createBashTool().readOnly).toBe(false);
  });

  it("refuses an empty command and a cwd that escapes the workspace", async () => {
    const tool = createBashTool();
    expect(await call(tool, { command: "  " })).toMatchObject({ error: "no command given" });
    expect(await call(tool, { command: "echo x", cwd: "../elsewhere" })).toMatchObject({
      error: expect.stringMatching(/not allowed/) as unknown as string,
    });
    // `.jaira/` is engine-owned wherever it appears (§1g item 5).
    expect(await call(tool, { command: "echo x", cwd: ".jaira" })).toMatchObject({
      error: expect.stringMatching(/not allowed/) as unknown as string,
    });
  });

  it("registers under `bash` on the registry's tools facet", () => {
    const registry = newRegistry();
    registerTools(registry, { cwd: dir });
    expect(registry.tools.get("bash")).toBeDefined();
    expect(registry.tools.get("bash")!.readOnly).toBe(false);
  });
});

describe("the whole gate: tool call → policy → verdict", () => {
  /**
   * Wrap the tool exactly as a composed runtime does: the ledger holds the compiled
   * baseline, `smart` is this tool's approver from the compiled policy, and
   * `approve` is the human gate. With no approver supplied, an `ask` denies — the
   * safe unattended default.
   */
  function gated(approve?: Approver, audit: PolicyAuditEntry[] = []) {
    const policy = compilePolicy({}, { onDecision: (e) => audit.push(e) });
    const ledger = new PermissionLedger({ baseline: policy.baseline ?? {} });
    const smart = policy.smart?.["bash"];
    const tool = withPermission(createBashTool({ cwd: dir }), {
      ledger,
      sessionId: "agent-1",
      toolName: "bash",
      approve: approve ?? (() => ({ decision: "deny", scope: "once" })),
      ...(smart !== undefined ? { smart } : {}),
    });
    return { tool, audit };
  }

  it("allows a benign command through to real execution", async () => {
    const { tool, audit } = gated();
    const result = await call(tool, { command: "echo safe" }, ctx({ workspace: { root: dir } }));
    expect(String(result.stdout)).toContain("safe");
    expect(audit.at(-1)).toMatchObject({ action: "allow" });
  }, 60_000);

  it("refuses a destructive command as DATA the model can read, without running it", async () => {
    const { tool, audit } = gated();
    const result = await call(tool, { command: "git reset --hard" }, ctx({ workspace: { root: dir } }));
    // The agent's loop sees a denial result and continues — it is not an exception.
    expect(isPermissionDenied(result as never)).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ action: "deny", reason: expect.stringMatching(/hard reset/) as unknown as string });
  }, 60_000);

  it("escalates an approval class to the human, and runs it once allowed", async () => {
    const asked: string[] = [];
    const approve: Approver = (req) => {
      asked.push(String((req.input as { command?: string }).command));
      return { decision: "allow", scope: "once" };
    };
    const { tool, audit } = gated(approve);
    // `git push` is SPEC §11.3's first approval class; with no remote configured the
    // command itself fails, which is fine — what matters is that it was ASKED and
    // then actually attempted.
    const result = await call(tool, { command: "git push --dry-run" }, ctx({ workspace: { root: dir } }));
    expect(asked).toEqual(["git push --dry-run"]);
    expect(audit.at(-1)).toMatchObject({ action: "require_approval" });
    expect(isPermissionDenied(result as never)).toBe(false);
  }, 60_000);

  it("a denied approval stops the command from running", async () => {
    const approve: Approver = () => ({ decision: "deny", scope: "once" });
    const { tool } = gated(approve);
    const result = await call(tool, { command: "git push" }, ctx({ workspace: { root: dir } }));
    expect(isPermissionDenied(result as never)).toBe(true);
  }, 60_000);

  it("an approval scoped to the run is not asked twice", async () => {
    let asks = 0;
    const approve: Approver = () => {
      asks++;
      return { decision: "allow", scope: "workflow-run" };
    };
    const { tool } = gated(approve);
    await call(tool, { command: "git push --dry-run" }, ctx({ workspace: { root: dir } }));
    await call(tool, { command: "git push --dry-run" }, ctx({ workspace: { root: dir } }));
    // The scope is the whole reason a user is not asked on every call (§10.2).
    expect(asks).toBe(1);
  }, 60_000);
});

describe("JAIRA_TOOLS — the gateable set, and what each one may do", () => {
  /**
   * Everything JaiRA registers under its own policy — BOTH calls.
   *
   * The pairing is the point. `registerTools` supplies `bash` alone and the file tools come from
   * `registerFileTools`, so a caller doing only the first has a registry that is two-thirds of what
   * the composer offers. That was live in `sendChatMessage`, where ticking `read_file` reached
   * `gateTools` and threw `tool 'read_file' is not registered` — the loud failure that call is
   * designed to raise for a name nobody registered, raised instead for a missing line.
   */
  const registered = () => {
    const registry = newRegistry();
    // ONE call, because four was the bug — see `registerAllTools`. This assertion is the thing that
    // notices when a tool joins the vocabulary and nothing builds it.
    registerAllTools(registry, {
      execEnv: undefined,
      exec: undefined as never,
      files: { vars: { taskId: "t", worktree: dir } } as never,
    });
    return registry;
  };

  it("restates every registered tool's `readOnly` exactly", () => {
    // The table is a RESTATEMENT: it exists so a caller describing choices — a permission preset
    // assigning a mode per tool — need not construct a shell and an artifact store to ask whether a
    // tool writes. A restatement can drift, and this is the assertion that stops it. Nothing else
    // would notice: a `read_file` marked writable would simply be refused under the read-only preset,
    // quietly, in whichever project happened to pick it.
    const registry = registered();
    for (const declared of JAIRA_TOOLS) {
      const built = registry.tools.get(declared.name);
      expect(built, `JAIRA_TOOLS names '${declared.name}', which nothing registers`).toBeDefined();
      expect(built!.readOnly, `'${declared.name}' readOnly`).toBe(declared.readOnly);
    }
  });

  it("names every tool JaiRA registers — the set is the WHOLE gateable one", () => {
    // The other direction. A tool registered and left out of this table is one the composer never
    // offers and no preset ever assigns a mode to, which reads as "JaiRA cannot gate it" when the
    // truth is that somebody forgot a line.
    expect([...registered().tools.keys()].sort()).toEqual(JAIRA_TOOLS.map((t) => t.name).sort());
  });
});
