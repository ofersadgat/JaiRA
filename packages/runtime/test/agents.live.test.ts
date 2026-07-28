/**
 * A LIVE delegated-agent run against the real `claude` binary.
 *
 * Opt-in, and deliberately so: it spends money and needs a CLI on PATH, so it must
 * never run in CI or as part of `npm test` by default. Enable with
 * `JAIRA_LIVE_AGENT=1` (plus `ANTHROPIC_API_KEY` in the environment):
 *
 *     JAIRA_LIVE_AGENT=1 npx vitest run packages/runtime/test/agents.live.test.ts
 *
 * It exists because everything else about the agent path is exercised with a fake
 * `AgentQuery` — and upstream's `cliQuery` still carries an "UNVERIFIED against a
 * live CLI" note about its flags and stream-json shape. This is the test that
 * actually checks that assumption.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices } from "@declarative-ai/exec";
import { AGENT_CLI, registerAgentRuntimes } from "../src/agents";
import { newRegistry } from "../src/wiring";

function claudeAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { timeout: 30_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const enabled = process.env["JAIRA_LIVE_AGENT"] === "1" && claudeAvailable();
const describeLive = enabled ? describe : describe.skip;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-live-agent-"));
  writeFileSync(join(dir, "note.txt"), "hello from the workspace\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeLive("claude-cli against the real binary", () => {
  it("runs a delegated agent and reports what it billed", async () => {
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["cli"] });
    const entry = registry.functions.get(AGENT_CLI)!;

    const result = await (entry as { impl: (i: unknown, c: unknown) => Promise<Record<string, unknown>> }).impl(
      { prompt: "Reply with exactly the word READY and nothing else.", config: {} },
      { workspace: { root: dir } } as ExecServices,
    );

    expect(result.error).toBeUndefined();
    expect(String(result.value)).toContain("READY");
    // A delegated agent bills inside its own loop, so the charge is authoritative
    // rather than a price-table estimate.
    const metrics = result.metrics as { costUsd?: number; costSource?: string; childLlmCalls?: number };
    expect(metrics.costUsd).toBeGreaterThan(0);
    expect(metrics.costSource).toBe("provider");
    expect(metrics.childLlmCalls).toBe(1);
  }, 240_000);
});
