/**
 * Building an executor from its DEFINITION — the composition, instantiated.
 *
 * Two things carry the weight here, and both are about a stack that is a CHOICE without being a
 * chance to build a broken one:
 *
 *  - **The steps a definition names are the steps it gets**, and one it does not name is not in the
 *    stack at all — not a layer that does nothing.
 *  - **The ORDER is ours.** Memoize outermost so a hit skips everything; rate limiting inside retry
 *    so each attempt is admitted separately rather than one slot being held across the whole loop
 *    and its backoff. Those are correctness properties, and an authored order would let someone
 *    reverse them silently.
 */
import { describe, expect, it } from "vitest";
import type { ExecResult, Executor, MemoCache, Operation, ResolvedValue } from "@declarative-ai/exec";
import { EXECUTOR_STEP_ORDER, type JairaExecutorDefinition } from "@jaira/shared";
import { composeExecutorStack, definitionModelId, definitionModelIds, type StackedExecutor } from "../src/executorStack";
import { retargetRoute } from "../src/modelRoutes";

/**
 * A core that records the config it was handed and answers immediately.
 *
 * `memoizable` is a parameter because it is the one capability that CHANGES what the stack does: the
 * provider path declares it true, and an agent declares it FALSE — an agent mutates the workspace and
 * runs its own non-deterministic loop, so `withMemoize` declines to key it. The default here is the
 * provider's answer; the agent's is exercised on its own below.
 */
function spyCore(memoizable = true): { seen: Array<Record<string, unknown>>; core: StackedExecutor; calls: () => number } {
  const seen: Array<Record<string, unknown>> = [];
  const core = {
    capabilities: { memoizable },
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
  return { seen, core: core as unknown as StackedExecutor, calls: () => seen.length };
}

const promptOp = (model?: string): Operation<never> =>
  ({
    kind: "prompt",
    user: { kind: "text", binding: { text: "hi" } },
    config: model === undefined ? {} : { model },
    input: {},
    output: { name: "answer", kind: "json" },
  }) as unknown as Operation<never>;

/** An in-memory memo store, so the memoize step has somewhere real to write. */
function memory(): MemoCache & { size: () => number } {
  const map = new Map<string, ExecResult<ResolvedValue>>();
  return {
    get: (key) => map.get(key),
    set: (key, outcome) => {
      map.set(key, outcome);
    },
    size: () => map.size,
  } as MemoCache & { size: () => number };
}

describe("composeExecutorStack", () => {
  it("leaves a definition with no steps exactly as it came", () => {
    const { core } = spyCore();
    const { executor, report } = composeExecutorStack(core, {}, { name: "plain" });

    // Not "wrapped in nothing" — the SAME object. A stack of no-op layers would still cost a frame
    // per call and still show up in a stack trace.
    expect(executor).toBe(core);
    expect(report.applied).toEqual([]);
  });

  it("applies every step a definition names, and only those", () => {
    const { core } = spyCore();
    const definition: JairaExecutorDefinition = {
      steps: { retry: { transient: 2 }, deadline: { maxDurationMs: 60_000 } },
    };

    const { report } = composeExecutorStack(core, definition, { name: "x" });

    expect(new Set(report.applied)).toEqual(new Set(["retry", "deadline"]));
    expect(report.applied).not.toContain("rateLimit");
    expect(report.applied).not.toContain("memoize");
  });

  /**
   * The order is documented OUTERMOST first, and applied inside out.
   *
   * This is the assertion that the list in `EXECUTOR_STEP_ORDER` is the one being honoured, rather
   * than whatever order the config object's keys happened to be written in.
   */
  it("applies them in the canonical order, whatever order they were authored in", () => {
    expect(EXECUTOR_STEP_ORDER).toEqual(["memoize", "retry", "rateLimit", "deadline"]);
    const { core } = spyCore();

    // Authored backwards on purpose.
    const { report } = composeExecutorStack(
      core,
      { steps: { deadline: { maxDurationMs: 60_000 }, rateLimit: {}, retry: {}, memoize: {} } },
      { name: "x", memoCache: memory() },
    );

    // Applied inside out, so the report reads innermost first — the reverse of the composition order.
    expect(report.applied).toEqual(["deadline", "rateLimit", "retry", "memoize"]);
  });

  it("actually memoizes: the second identical call does not reach the core", async () => {
    const { core, calls } = spyCore();
    const cache = memory();
    const { executor } = composeExecutorStack(core, { steps: { memoize: {} } }, { name: "review", memoCache: cache });

    await executor.start(promptOp("claude-cli/opus") as never, {} as never).result;
    await executor.start(promptOp("claude-cli/opus") as never, {} as never).result;

    expect(calls()).toBe(1);
    expect(cache.size()).toBe(1);
  });

  /**
   * A definition that asks to memoize where nothing can store an answer is REPORTED, not silently
   * dropped. A run that quietly does not memoize is the kind of difference nobody notices until the
   * bill arrives.
   */
  it("skips memoization with no store, and says so rather than pretending", () => {
    const { core } = spyCore();
    const { executor, report } = composeExecutorStack(core, { steps: { memoize: {} } }, { name: "x" });

    expect(executor).toBe(core);
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([{ step: "memoize", reason: expect.stringContaining("no memo store") }]);
  });

  /**
   * An AGENT-backed definition asking to memoize does not memoize, and that is upstream's rule rather
   * than a gap here: `AgentApiExecutor` declares `memoizable: false` because it mutates the workspace
   * and runs its own non-deterministic loop, so `withMemoize` declines to key it.
   *
   * Pinned because it is exactly the plausible-but-wrong stack a settings screen invites — and the
   * screen says so beside the step for the same reason.
   */
  it("does not memoize an executor that declares itself unmemoizable", async () => {
    const { core, calls } = spyCore(false);
    const cache = memory();
    const { executor, report } = composeExecutorStack(core, { steps: { memoize: {} } }, { name: "agent", memoCache: cache });

    await executor.start(promptOp("claude-cli/opus") as never, {} as never).result;
    await executor.start(promptOp("claude-cli/opus") as never, {} as never).result;

    // The layer IS applied — it is the OP that declines to be keyed, per call.
    expect(report.applied).toEqual(["memoize"]);
    expect(calls()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("defaults the memo namespace to the executor's own name", async () => {
    // A durable cache needs an explicit namespace — the upstream default is a process-local token, so
    // a persisted entry could never be hit. Two executors must not share one either.
    const a = spyCore();
    const b = spyCore();
    const cache = memory();
    const first = composeExecutorStack(a.core, { steps: { memoize: {} } }, { name: "cheap", memoCache: cache });
    const second = composeExecutorStack(b.core, { steps: { memoize: {} } }, { name: "careful", memoCache: cache });

    await first.executor.start(promptOp("x/y") as never, {} as never).result;
    await second.executor.start(promptOp("x/y") as never, {} as never).result;

    // The same op under two executors is two entries, and both cores ran.
    expect(cache.size()).toBe(2);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });
});

/**
 * A definition is reached by PREFIX, like everything else — and what the transport underneath sees is
 * the provider it names, not the definition's name.
 */
describe("retargetRoute — a definition's name becomes its provider's id", () => {
  it("rewrites the definition's prefix to the provider and model it names", () => {
    const { seen, core } = spyCore();
    const route = retargetRoute("review", { provider: "claude-cli", model: "opus" }, core);

    // The placeholder — a state that reached this definition without naming a model of its own.
    route.start(promptOp("review/default") as never, {} as never);

    expect(seen[0]?.["model"]).toBe("claude-cli/opus");
  });

  it("lets a state's own model win over the definition's", () => {
    const { seen, core } = spyCore();
    const route = retargetRoute("review", { provider: "claude-cli", model: "opus" }, core);

    route.start(promptOp("review/sonnet") as never, {} as never);

    expect(seen[0]?.["model"]).toBe("claude-cli/sonnet");
  });

  it("merges the definition's call settings UNDER the state's own", () => {
    const { seen, core } = spyCore();
    const route = retargetRoute(
      "review",
      { provider: "claude-cli", config: { temperature: 0, maxOutputTokens: 500 } },
      core,
    );

    route.start(
      { ...(promptOp("review/x") as object), config: { model: "review/x", temperature: 0.7 } } as never,
      {} as never,
    );

    expect(seen[0]).toMatchObject({ temperature: 0.7, maxOutputTokens: 500 });
  });

  it("falls back to the transport's own placeholder when neither names a model", () => {
    const { seen, core } = spyCore();
    const route = retargetRoute("review", { provider: "claude-cli" }, core);

    route.start(promptOp("review/default") as never, {} as never);

    // Not `claude-cli/default`, which would reach the binary as a model literally called `default`.
    expect(seen[0]?.["model"]).toBe("agent/default");
  });

  it("is a no-op for a definition that names no provider yet", () => {
    const { core } = spyCore();
    expect(retargetRoute("half-built", {}, core)).toBe(core);
  });
});

describe("the model id a definition dispatches on", () => {
  it("is provider/model, and provider/default when it names no model", () => {
    expect(definitionModelId({ provider: "claude-cli", model: "opus" })).toBe("claude-cli/opus");
    expect(definitionModelId({ provider: "anthropic" })).toBe("anthropic/default");
    expect(definitionModelId({})).toBeUndefined();
  });

  it("lists only the definitions complete enough to run", () => {
    expect(
      definitionModelIds({ review: { provider: "claude-cli", model: "opus" }, draft: {} }),
    ).toEqual({ review: "claude-cli/opus" });
  });
});
