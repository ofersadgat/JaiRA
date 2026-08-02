/**
 * A LIVE run against the real `codex` binary.
 *
 * Opt-in for the same reasons as its `claude` sibling — it spends the account's quota and needs a CLI
 * on PATH, so it must never run in CI or in a plain `npm test`:
 *
 *     JAIRA_LIVE_AGENT=1 npx vitest run packages/runtime/test/codex.live.test.ts
 *
 * It exists because everything else about the codex path runs against a fake process, and the two
 * halves a fake cannot check are exactly the ones a CLI gets wrong: the argv the binary accepts, and
 * the event schema it emits. Both were wrong on the first attempt, and each failure was silent in its
 * own way — an inferred `assistant_message` item type (codex says `agent_message`, so the answer read
 * as "produced no message"), and a `--sandbox` flag that `codex exec resume` does not accept (so
 * every RESUMED run died in argument parsing, exit 2, before reaching a model).
 *
 * The resume case therefore earns its own test. It is the one that a mock cannot fail on and a
 * refactor can silently break.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices } from "@declarative-ai/exec";
import { AGENT_CODEX, registerAgentRuntimes } from "../src/agents";
import { resolveInvocation } from "../src/exec";
import { newRegistry } from "../src/wiring";

function codexAvailable(): boolean {
  try {
    // Resolved the way production resolves it — no shell — which on Windows means going through the
    // npm-shim lookup. A probe that used a shell would report "available" for a binary the real spawn
    // cannot launch.
    const { file, argv } = resolveInvocation("codex", ["--version"]);
    execFileSync(file, argv, { timeout: 30_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const enabled = process.env["JAIRA_LIVE_AGENT"] === "1" && codexAvailable();
const describeLive = enabled ? describe : describe.skip;

/** The registered runtime, invoked as the engine invokes it. */
async function runAgent(prompt: string, ctx: Record<string, unknown>): Promise<Record<string, unknown>> {
  const registry = registerAgentRuntimes(newRegistry(), { adapters: ["codex"], codexSandbox: "read-only" });
  const entry = registry.functions.get(AGENT_CODEX)! as { impl: (i: unknown, c: unknown) => Promise<Record<string, unknown>> };
  return entry.impl({ prompt, config: {} }, ctx as ExecServices);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-live-codex-"));
  writeFileSync(join(dir, "note.txt"), "hello from the workspace\n", "utf8");
  // Codex refuses to run outside a git repository, and a task's worktree always is one.
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeLive("codex-cli against the real binary", () => {
  it("runs, answers, and reports the thread it ran in", async () => {
    const result = await runAgent("Reply with exactly the word READY and nothing else.", { workspace: { root: dir } });

    expect(result.error).toBeUndefined();
    expect(String(result.value)).toContain("READY");
    // Codex counts TOKENS, not money. Reporting `unknown` is the honest record; a number derived from
    // a price table would be indistinguishable from one the provider billed.
    const metrics = result.metrics as { costUsd?: number; costSource?: string; childLlmCalls?: number };
    expect(metrics.costSource).toBe("unknown");
    expect(metrics.childLlmCalls).toBe(1);
    // The handle a later call resumes. Without it every call opens a new conversation.
    expect((result.session as { providerSessionId?: string })?.providerSessionId).toMatch(/\w/);
  }, 300_000);

  it("RESUMES the conversation it was given, and stays in it", async () => {
    const first = await runAgent("My secret codeword is BANANA-42. Reply with just: stored.", { workspace: { root: dir } });
    const handle = (first.session as { providerSessionId?: string })?.providerSessionId;
    expect(handle).toBeDefined();

    const second = await runAgent("What was my secret codeword? Reply with just the codeword.", {
      workspace: { root: dir },
      // Shaped as `withSessionPosition` hands one over: an APPEND at a position, carrying the handle.
      session: { id: "s", mode: "append", at: { id: "s", seq: 1 }, providerSessionId: handle, messages: async () => [] },
    });

    expect(second.error).toBeUndefined();
    expect(String(second.value)).toContain("BANANA-42");
    // The same thread, so the append did not fork — which is what keeps divergence detection quiet.
    expect((second.session as { providerSessionId?: string })?.providerSessionId).toBe(handle);
  }, 600_000);
});
