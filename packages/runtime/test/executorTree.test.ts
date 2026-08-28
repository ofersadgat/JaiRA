/**
 * Building the executor TREE — a resolved configuration becomes the composition it describes.
 *
 * The claim worth defending most is the ORDERING one. `PromptRouterExecutor` dispatches on
 * `op.config.model`, while a leaf's `defaults` are applied inside its own lowering — after routing.
 * So a default model held at the leaf could never influence which route served the call: a state
 * naming no model fell through to the provider path and was asked for `claude-cli/default` there,
 * which `ModelRouter` cannot serve. The router node's `defaults` are applied BEFORE dispatch, and
 * that is what makes a default executor able to route at all.
 */
import { describe, expect, it } from "vitest";
import type { ExecResult, Operation, ResolvedValue } from "@declarative-ai/exec";
import { resolveExecutorTree, type JairaPromptNode } from "@jaira/shared";
import { buildExecutorTree, buildPromptTree } from "../src/executorTree";
import { withTurnStream } from "../src/wiring";
import type { StackedExecutor } from "../src/executorStack";

/** A leaf that records the config it was handed. Stands in for an agent route. */
function leaf(): { seen: Array<Record<string, unknown>>; executor: StackedExecutor } {
  const seen: Array<Record<string, unknown>> = [];
  const executor = {
    capabilities: { memoizable: true },
    metrics: { merge: (a: unknown) => a },
    start: (op: { config?: Record<string, unknown> }) => {
      seen.push(op.config ?? {});
      return {
        events: [],
        result: Promise.resolve({ value: "ok", metrics: { durationMs: 0 } } as unknown as ExecResult<ResolvedValue>),
        cancel: async () => undefined,
      };
    },
  };
  return { seen, executor: executor as unknown as StackedExecutor };
}

const promptOp = (model?: string): Operation<never> =>
  ({
    kind: "prompt",
    user: { kind: "text", binding: { text: "hi" } },
    config: model === undefined ? {} : { model },
    input: {},
    output: { answer: { kind: "json" } },
  }) as unknown as Operation<never>;

const reasonOf = (result: unknown): string => (result as { error: { reason: string } }).error.reason;

describe("the ordering fix — a router's defaults are applied BEFORE dispatch", () => {
  /**
   * The bug, stated directly.
   *
   * With the default model held only at the leaf, a state naming none never reached `claude-cli` at
   * all: the router saw no prefix and fell through to the provider path, which does not own that
   * prefix and refuses it. This is the case that made "propose workflow changes" fail on a machine
   * with `claude` installed and nothing else.
   */
  it("routes a state that names no model, using the default it supplies", async () => {
    const cli = leaf();
    const tree: JairaPromptNode = {
      kind: "router",
      defaults: { model: "claude-cli/sonnet" },
      routes: { "claude-cli": { kind: "agent", agent: "claude-cli" } },
    };

    const prompt = buildPromptTree(tree, { agents: { "claude-cli": cli.executor } });
    await prompt.start(promptOp() as never, {} as never).result;

    // It reached the AGENT, which is only possible if the default was applied before the prefix was
    // read. Applied at the leaf it would have gone to the provider fallback instead.
    expect(cli.seen).toHaveLength(1);
    expect(cli.seen[0]?.["model"]).toBe("claude-cli/sonnet");
  });

  it("lets a state's own model win over the default", async () => {
    const a = leaf();
    const b = leaf();
    const tree: JairaPromptNode = {
      kind: "router",
      defaults: { model: "claude-cli/sonnet" },
      routes: { "claude-cli": { kind: "agent", agent: "claude-cli" }, codex: { kind: "agent", agent: "codex-cli" } },
    };

    const prompt = buildPromptTree(tree, { agents: { "claude-cli": a.executor, "codex-cli": b.executor } });
    await prompt.start(promptOp("codex/gpt-5") as never, {} as never).result;

    expect(a.seen).toHaveLength(0);
    expect(b.seen).toHaveLength(1);
  });

  it("supplies its other call settings too, under the state's own", async () => {
    const cli = leaf();
    const tree: JairaPromptNode = {
      kind: "router",
      defaults: { model: "claude-cli/sonnet", temperature: 0, maxOutputTokens: 500 },
      routes: { "claude-cli": { kind: "agent", agent: "claude-cli" } },
    };

    const prompt = buildPromptTree(tree, { agents: { "claude-cli": cli.executor } });
    await prompt.start(
      { ...(promptOp() as object), config: { temperature: 0.7 } } as never,
      {} as never,
    ).result;

    expect(cli.seen[0]).toMatchObject({ temperature: 0.7, maxOutputTokens: 500, model: "claude-cli/sonnet" });
  });

  it("answers capabilitiesFor for the route the default will DISPATCH to, not for the unnamed pick", async () => {
    // The two must agree or the engine plans one call and runs another: it reads `capabilitiesFor`
    // to decide whether the answering executor enforces policy through its own callback (raw tools +
    // gate) or composes (wrapped tools). `withPromptDefaults` used to forward the op UNFILLED, so a
    // state naming no model was answered for whichever route the unnamed rule picks — here the
    // provider — while `start` filled the default and sent the work to the agent.
    const provider = leaf();
    const agent = leaf();
    (agent.executor as unknown as { capabilities: Record<string, unknown> }).capabilities = {
      memoizable: false,
      policyEnforcement: "callback",
    };
    const tree: JairaPromptNode = {
      kind: "router",
      defaults: { model: "claude-cli/sonnet" },
      // `anthropic` first, so the unnamed rule would pick IT — the disagreement this test pins.
      routes: { anthropic: { kind: "agent", agent: "prov" }, "claude-cli": { kind: "agent", agent: "cli" } },
    };
    const prompt = buildPromptTree(tree, { agents: { prov: provider.executor, cli: agent.executor } });

    expect((prompt.capabilitiesFor!(promptOp() as never) as { policyEnforcement?: string }).policyEnforcement).toBe("callback");
    await prompt.start(promptOp() as never, {} as never).result;
    expect(agent.seen).toHaveLength(1);
    expect(provider.seen).toHaveLength(0);
  });
});

describe("a bare model id reaches the route that serves it", () => {
  /**
   * The failure this was written for, end to end.
   *
   * JaiRA's own feature workflow pinned `anthropic/claude-sonnet-5` on every phase parent, so 27
   * inherited leaves went to the provider path on a machine whose only credential was a `claude`
   * login. Each one failed in four milliseconds with `AI_LoadAPIKeyError`, permanently, after the
   * run had already started. Written bare, the same id names the same model and lets the machine
   * answer who serves it.
   */
  it("sends 'claude-sonnet-5' to the CLI agent, prefix written in", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, {
      providers: [],
      agents: ["claude-cli"],
      vendors: { "claude-cli": "anthropic" },
    }).prompt!;
    const built = buildPromptTree(tree, { agents: { "claude-cli": cli.executor } });

    await built.start(promptOp("claude-sonnet-5"), {} as never).result;
    // Not merely dispatched THERE — the chosen route is written into the id, because everything
    // downstream reads the model and a bare one would be a second spelling of the same call.
    expect(cli.seen).toEqual([{ model: "claude-cli/claude-sonnet-5" }]);
  });

  it("prefers the agent over a provider that could also serve the family", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, {
      providers: ["anthropic"],
      agents: ["claude-cli"],
      vendors: { "claude-cli": "anthropic" },
    }).prompt!;
    const built = buildPromptTree(tree, { agents: { "claude-cli": cli.executor } });

    await built.start(promptOp("claude-sonnet-5"), {} as never).result;
    // An agent route runs on a subscription already signed in: among transports that can serve the
    // call, the one needing no key wins. Naming `anthropic/…` is how you override that.
    expect(cli.seen).toEqual([{ model: "claude-cli/claude-sonnet-5" }]);
  });

  it("still refuses a route the author NAMED but this machine cannot reach", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, {
      providers: [],
      agents: ["claude-cli"],
      vendors: { "claude-cli": "anthropic" },
    }).prompt!;
    const built = buildPromptTree(tree, { agents: { "claude-cli": cli.executor } });

    const result = await built.start(promptOp("anthropic/claude-sonnet-5"), {} as never).result;
    // Rerouting this would be overruling the author. It goes to the provider fallback and is refused
    // there, which is where the true reason — no key — is known.
    expect(cli.seen).toEqual([]);
    expect(reasonOf(result)).toBeTruthy();
  });

  it("never hands a bare id to an agent that does not serve its family", async () => {
    const codex = leaf();
    const tree = resolveExecutorTree(undefined, {
      providers: [],
      agents: ["codex-cli"],
      vendors: { "codex-cli": "openai" },
    }).prompt!;
    const built = buildPromptTree(tree, { agents: { "codex-cli": codex.executor } });

    await built.start(promptOp("claude-sonnet-5"), {} as never).result;
    expect(codex.seen).toEqual([]);
  });
});

describe("building each level", () => {
  const available = { providers: ["anthropic"], agents: ["claude-cli"] };

  it("builds a whole derived tree, with a route per available provider and agent", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, available);

    const { prompt } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor } });
    await prompt.start(promptOp("claude-cli/opus") as never, {} as never).result;

    expect(cli.seen).toHaveLength(1);
  });

  /**
   * The half of the ordering fix that was still missing: an unconfigured machine stated no defaults
   * at all, so a state naming no model had no prefix to route on and landed in the provider fallback.
   * Which is what "propose workflow changes" hit on a machine with `claude` installed and no API key:
   * every state in that workflow names no model, deliberately.
   *
   * The answer is not a default but the absence of a choice: a call that named no route has chosen
   * none, so the router is free to send it to any route that can answer. Prefix matching has no work
   * to do on a call that supplied no prefix.
   */
  it("forwards a state that names no model to a route that can answer it", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli"] });

    const { prompt } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor } });
    await prompt.start(promptOp() as never, {} as never).result;

    expect(cli.seen).toHaveLength(1);
    // And with the model left alone, rather than a `claude-cli/default` invented on the way past: the
    // route itself is what maps "no model" onto the transport's own placeholder.
    expect(cli.seen[0]?.["model"]).toBeUndefined();
  });

  /**
   * The other half of that rule. A state naming a prefix still DISPATCHES, so an id the sole route
   * does not own is refused rather than quietly answered by it — which is the silent substitution this
   * codebase refuses everywhere else.
   */
  it("still dispatches a state that names a prefix the sole route does not own", async () => {
    const cli = leaf();
    const tree = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli"] });

    const { prompt } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor } });
    const result = await prompt.start(promptOp("anthropic/claude-opus-4-5") as never, {} as never).result;

    expect(cli.seen).toHaveLength(0);
    // It reached the provider fallback, which owns that prefix and is the authority on it.
    expect(result).toBeDefined();
  });

  it("still answers a state that names no model when there are several routes to choose from", async () => {
    const cli = leaf();
    const codex = leaf();
    const tree = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli", "codex-cli"] });

    const { prompt } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor, "codex-cli": codex.executor } });
    await prompt.start(promptOp() as never, {} as never).result;

    // One of them answers, and the same one every time — the choice is the router's, but it is not
    // arbitrary per call, or two states of one workflow would run on different runtimes.
    expect(cli.seen).toHaveLength(1);
    expect(codex.seen).toHaveLength(0);
  });

  /** A stated default still wins: it names a prefix, so the call has chosen after all. */
  it("lets a stated default decide instead, when there is one", async () => {
    const cli = leaf();
    const codex = leaf();
    const tree = resolveExecutorTree(
      { prompt: { kind: "router", defaults: { model: "codex-cli/gpt-5" } } },
      { providers: [], agents: ["claude-cli", "codex-cli"] },
    );

    const { prompt } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor, "codex-cli": codex.executor } });
    await prompt.start(promptOp() as never, {} as never).result;

    expect(cli.seen).toHaveLength(0);
    expect(codex.seen[0]?.["model"]).toBe("codex-cli/gpt-5");
  });

  /**
   * A route naming an agent that is not registered REFUSES, by name.
   *
   * Dropping it would send its calls to the fallback — a different executor answering as if it were
   * the one that was asked for, which is the silent-substitution failure this codebase refuses
   * everywhere else.
   */
  it("refuses a route whose agent is not registered, rather than falling through", async () => {
    const prompt = buildPromptTree({ kind: "agent", agent: "not-installed" }, { agents: {} });

    const result = await prompt.start(promptOp("not-installed/x") as never, {} as never).result;

    expect(reasonOf(result)).toContain("not-installed");
    expect(reasonOf(result)).toContain("not registered");
  });

  it("applies a node's own model rules, and refuses outside them", async () => {
    const cli = leaf();
    const node: JairaPromptNode = { kind: "agent", agent: "claude-cli", allow: ["sonnet"] };
    const prompt = buildPromptTree(node, { agents: { "claude-cli": cli.executor } });

    const refused = await prompt.start(promptOp("claude-cli/opus") as never, {} as never).result;

    expect(cli.seen).toHaveLength(0);
    expect(reasonOf(refused)).toContain("restricted to 'sonnet'");
  });

  /**
   * A node with no model of its own says NOTHING about the model.
   *
   * Writing the placeholder here would be re-prefixed by the provider-level wrapper underneath —
   * `agent/default` becoming `claude-cli/agent/default`, a model nothing knows.
   */
  it("leaves the model alone when the node has none to state", async () => {
    const cli = leaf();
    const node: JairaPromptNode = { kind: "agent", agent: "claude-cli", defaults: { temperature: 0 } };
    const prompt = buildPromptTree(node, { agents: { "claude-cli": cli.executor } });

    await prompt.start(promptOp("claude-cli/default") as never, {} as never).result;

    expect(cli.seen[0]?.["model"]).toBe("claude-cli/default");
    expect(cli.seen[0]?.["temperature"]).toBe(0);
  });

  /**
   * A bare router has no routes and nothing to advertise capabilities from, and upstream refuses to
   * construct one. An absent fallback therefore means the PROVIDER path — which is both what the type
   * documents and what JaiRA did before any of this was configurable.
   */
  it("builds a bare router as the provider path rather than throwing", () => {
    expect(() => buildPromptTree({ kind: "router" }, {})).not.toThrow();
  });

  /**
   * The function half is narrowed by RULES, walked in order.
   *
   * A rule list rather than an allow list because the useful statements are subtractive: "everything
   * this workflow registers, except the one that runs commands" is one rule after a baseline, where
   * an allow list would have to name every function that exists and be edited again whenever a
   * workflow gains a state.
   */
  it("narrows the function half to what the rules allow", () => {
    const names = ["choose_option", "run_command", "read_file"];
    const registry = { functions: { has: (n: string) => names.includes(n), get: () => undefined } } as never;

    const { executor } = buildExecutorTree(
      { kind: "operation", function: { kind: "function", rules: ["everything", "-run_command"] }, prompt: { kind: "router" } },
      { registry },
    );

    // Built at all — the narrowing is a wrapper over the registry, and a state naming a function the
    // rules exclude meets the same "unregistered function" refusal a typo does.
    expect(executor).toBeDefined();
  });

  it("wraps each node in its OWN steps, so a route's limit is not the tree's", () => {
    const cli = leaf();
    const tree = resolveExecutorTree(
      { prompt: { kind: "router", routes: { "claude-cli": { kind: "agent", steps: { retry: { transient: 2 } } } } } },
      available,
    );

    const { report } = buildExecutorTree(tree, { agents: { "claude-cli": cli.executor } });

    // Recorded against the NODE's path, which is what makes "a rate limit on one route" expressible
    // at all — one steps block at the top could only ever have made the coarser statement.
    expect(Object.keys(report.stacks)).toEqual(["prompt.routes.claude-cli"]);
    expect(report.stacks["prompt.routes.claude-cli"]?.applied).toEqual(["retry"]);
  });
});

/**
 * Partial answers, forwarded as they are written.
 *
 * A record persists once, when the operation closes — correct, because a half-written answer is not a
 * turn, and the reason a long agent run used to show nothing at all while it worked. The transports
 * already streamed and nothing consumed it: hw does not drain the prompt handle's `events`, so taking
 * them steals nothing from anybody.
 */
describe("withTurnStream", () => {
  /** A leaf that emits deltas before it answers, the way a streaming transport does. */
  function streaming(deltas: string[]): StackedExecutor {
    return {
      capabilities: {},
      metrics: { merge: (a: unknown) => a },
      start: () => ({
        events: (async function* () {
          for (const text of deltas) yield { type: "output_partial", text };
        })(),
        result: Promise.resolve({ value: "done", metrics: { durationMs: 0 } }),
        cancel: async () => undefined,
      }),
    } as unknown as StackedExecutor;
  }

  it("forwards each delta with the position it belongs to", async () => {
    const seen: Array<{ text?: string; session?: { id: string; seq: number }; stateId?: string }> = [];
    const wrapped = withTurnStream((d) => seen.push(d), streaming(["Hel", "lo"]) as never);

    const ctx = { session: { at: { id: "chat", seq: 3 }, seed: "wf/write:chat" } };
    const handle = wrapped.start(promptOp() as never, ctx as never);
    await handle.result;
    // The drain is a floating promise, so give it a turn to finish — awaiting it inside `start` would
    // hold `result` open until the stream closed.
    await new Promise((r) => setTimeout(r, 5));

    expect(seen.map((d) => d.text)).toEqual(["Hel", "lo"]);
    expect(seen[0]?.session).toEqual({ id: "chat", seq: 3 });
    // Recovered from the seed, split on the LAST colon because a session id may contain one.
    expect(seen[0]?.stateId).toBe("wf/write");
  });

  it("says nothing when the call runs in no conversation", async () => {
    const seen: unknown[] = [];
    const wrapped = withTurnStream((d) => seen.push(d), streaming(["x"]) as never);
    await wrapped.start(promptOp() as never, {} as never).result;
    await new Promise((r) => setTimeout(r, 5));
    // Still forwarded — a delta is a delta — but with no position to attribute it to.
    expect(seen).toHaveLength(1);
    expect((seen[0] as { session?: unknown }).session).toBeUndefined();
  });

  it("forwards whole turns and unknown events, not only text", async () => {
    // The viewer's contract: EVERYTHING on the stream reaches it in order, understood or not. Tool
    // calls ride on `message` events; anything else goes through opaquely rather than vanishing.
    const chatty = {
      capabilities: {},
      metrics: { merge: (a: unknown) => a },
      start: () => ({
        events: (async function* () {
          yield { type: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } };
          yield { type: "provider_event", payload: { type: "system", subtype: "init" } };
          yield { type: "thinking_partial", text: "hmm, " };
          yield { type: "output_partial", text: "hi" };
        })(),
        result: Promise.resolve({ value: "done", metrics: { durationMs: 0 } }),
        cancel: async () => undefined,
      }),
    } as unknown as StackedExecutor;

    const seen: Array<{ text?: string; thinking?: string; entry?: unknown }> = [];
    const wrapped = withTurnStream((d) => seen.push(d), chatty as never);
    await wrapped.start(promptOp() as never, {} as never).result;
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toHaveLength(4);
    expect(seen[0]?.entry).toMatchObject({ kind: "message", role: "assistant" });
    expect(seen[1]?.entry).toMatchObject({ kind: "event", event: { type: "provider_event" } });
    // Reasoning travels on its own field, never as answer text.
    expect(seen[2]).toMatchObject({ thinking: "hmm, " });
    expect(seen[2]?.text).toBeUndefined();
    expect(seen[3]).toMatchObject({ text: "hi" });
  });

  it("does not fail the call when the stream ends badly", async () => {
    const broken = {
      capabilities: {},
      metrics: { merge: (a: unknown) => a },
      start: () => ({
        events: (async function* () {
          throw new Error("stream exploded");
        })(),
        result: Promise.resolve({ value: "answered anyway", metrics: { durationMs: 0 } }),
        cancel: async () => undefined,
      }),
    } as unknown as StackedExecutor;

    const wrapped = withTurnStream(() => undefined, broken as never);
    const result = await wrapped.start(promptOp() as never, {} as never).result;
    // Narrating a call must never be able to fail it.
    expect((result as { value?: unknown }).value).toBe("answered anyway");
  });
});
