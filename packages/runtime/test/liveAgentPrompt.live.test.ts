/**
 * A PROMPT op answered by the real `claude` binary — the path the whole change exists for.
 *
 * Opt-in (`JAIRA_LIVE_AGENT=1`) and named `.live.` like the other tests that need a real binary: it
 * spends a token budget and depends on a working subscription, so it must never run in a plain
 * `npm test`.
 */
import { describe, expect, it } from "vitest";
import { isOk, promptOp } from "@declarative-ai/exec";
import { AgentCliExecutor } from "@declarative-ai/agents-cli";
import { agentSpawn } from "../src/agents";
import { buildPromptExecutor, modelDefaults } from "../src/wiring";
import { agentPromptRoutes, defaultModelId } from "../src/modelRoutes";
import { defaultConfig } from "@jaira/shared";

const live = process.env["JAIRA_LIVE_AGENT"] === "1";

describe.skipIf(!live)("a prompt op answered by the real claude CLI", () => {
  it("answers through AgentCliExecutor with no API key configured", async () => {
    const executor = new AgentCliExecutor({ spawn: agentSpawn({}) });
    const op = promptOp({ user: "Reply with exactly the word: pong", output: { name: "answer", schema: { type: "string" } } });
    const result = await executor.start(op, {}).result;
    if (!isOk(result)) throw new Error(`the agent failed: ${result.error.reason}`);
    expect(String(result.value).toLowerCase()).toContain("pong");
  }, 120_000);

  it("routes by PREFIX through the same executor the app builds", async () => {
    // The end-to-end claim: config names nothing, `defaultModelId` picks the agent, and the router
    // sends the op there — which is exactly what the sync panel now does.
    const config = defaultConfig();
    expect(defaultModelId(config.models, { agents: config.agents })).toBe("claude-cli/default");

    const prompt = buildPromptExecutor({
      routes: agentPromptRoutes(config.agents, {}),
      defaults: modelDefaults(config, { states: { s: { operation: { kind: "prompt" } } } } as never),
    });
    const op = promptOp({
      user: "Reply with exactly the word: routed",
      config: { model: "claude-cli/default" },
      output: { name: "answer", schema: { type: "string" } },
    });
    const result = await prompt.start(op, {}).result;
    if (!isOk(result)) throw new Error(`the routed call failed: ${result.error.reason}`);
    expect(String(result.value).toLowerCase()).toContain("routed");
  }, 120_000);
});
