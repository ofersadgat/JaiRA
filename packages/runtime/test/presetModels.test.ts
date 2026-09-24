/**
 * Presets applied in front of the prompt tree (`withPresetModels`), and a preset's model chosen when
 * its session is created.
 *
 * The claims: a preset is expanded BEFORE routing, in the documented order (defaults, then the preset,
 * then the state's own config); a model field naming a preset means that preset's model — the Default
 * model and the judge both; `first-available` asks the host's availability predicate and takes the
 * first that can run; a session keeps what it chose, from its own memory and, on a resume, from its
 * record; nothing available fails the call naming every candidate; and the start-time check reads a
 * preset's candidates instead of refusing its name as an unknown model.
 */
import { describe, expect, it } from "vitest";
import type { ExecResult, ExecServices, JsonValue, Operation, ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowBundle } from "@declarative-ai/hw";
import { parseConfig, type ModelAvailability } from "@jaira/shared";
import { resolvePresetCall, withPresetModels, type PresetModelOptions } from "../src/presetModels";
import { defaultExecutorTree } from "../src/wiring";
import type { StackedExecutor } from "../src/executorStack";

/** An executor that records the config each call reached it with. */
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

const promptOp = (config: Record<string, unknown>): Operation<never> =>
  ({ kind: "prompt", user: { kind: "text", binding: { text: "hi" } }, config, input: {}, output: { answer: { kind: "json" } } }) as unknown as Operation<never>;

/** What `ctx.session` carries for a call at position `seq` of conversation `id`. */
const inSession = (id: string, seq: number): ExecServices => ({ session: { id, at: { id, seq } } }) as unknown as ExecServices;

const PRESETS = {
  simple: { model: { candidates: ["claude-haiku-4-5", "gpt-5.6-luna"], choose: "first-available" } },
  coder: { model: { candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "first-available" }, reasoning: { effort: "high" } },
  plain: { model: "claude-sonnet-5", temperature: 0.1 },
  nomodel: { maxOutputTokens: 100 },
} as unknown as Record<string, Record<string, JsonValue>>;

/** A machine that can run exactly these, and says "not here" of the rest. */
const machine =
  (...runs: string[]) =>
  (model: string): ModelAvailability =>
    runs.includes(model) ? { available: true, route: model.startsWith("claude") ? "claude-cli" : "codex-cli" } : { available: false, why: "not here" };

const options = (available: PresetModelOptions["available"], extra: Partial<PresetModelOptions> = {}): PresetModelOptions => ({
  presets: PRESETS,
  available,
  ...extra,
});

describe("expanding a preset before the call is routed", () => {
  it("merges the preset under the state's own config, and takes configRef out", () => {
    const resolved = resolvePresetCall({ configRef: "plain", temperature: 0.7 }, options(machine()), undefined);
    expect(resolved).toEqual({ config: { model: "claude-sonnet-5", temperature: 0.7 } });
  });

  it("lets the preset's model beat the default executor's, and the state's own beat both", () => {
    const defaults = { model: "claude-cli/default" };
    expect(resolvePresetCall({ configRef: "plain" }, options(machine()), defaults)).toMatchObject({ config: { model: "claude-sonnet-5" } });
    expect(resolvePresetCall({ configRef: "plain", model: "gpt-5" }, options(machine()), defaults)).toMatchObject({ config: { model: "gpt-5" } });
    // A preset with no model leaves the model to the defaults, which the tree fills as before.
    expect(resolvePresetCall({ configRef: "nomodel" }, options(machine()), defaults)).toEqual({ config: { maxOutputTokens: 100 } });
  });

  it("refuses a configRef naming no preset, listing the ones there are", () => {
    const resolved = resolvePresetCall({ configRef: "fast" }, options(machine()), undefined);
    expect(resolved).toEqual({ refused: "configRef 'fast' names no preset — configured presets are 'simple', 'coder', 'plain', 'nomodel'" });
  });

  it("leaves a call that names no preset exactly as it was", () => {
    expect(resolvePresetCall({ model: "claude-cli/opus", temperature: 0 }, options(machine()), undefined)).toEqual({
      config: { model: "claude-cli/opus", temperature: 0 },
    });
    expect(resolvePresetCall({}, options(machine()), undefined)).toEqual({ config: {} });
  });
});

describe("a model field naming a preset", () => {
  it("means the preset's model — for the judge's call, which states it as its own model", () => {
    // `functions.smart.model: "simple"`: the judge's op carries `{ model: "simple" }`.
    expect(resolvePresetCall({ model: "simple" }, options(machine("gpt-5.6-luna")), undefined)).toMatchObject({ config: { model: "gpt-5.6-luna" } });
  });

  it("means the preset's model — for the Default model, which fills a state that names none", () => {
    expect(resolvePresetCall({}, options(machine("claude-opus-5-5", "gpt-5.6-terra")), { model: "coder" })).toMatchObject({
      config: { model: "claude-opus-5-5" },
    });
  });

  it("takes only the model — the preset's other settings are for the states that pick it", () => {
    const resolved = resolvePresetCall({ model: "coder" }, options(machine("gpt-5.6-terra")), undefined);
    expect(resolved).toMatchObject({ config: { model: "gpt-5.6-terra" } });
    expect((resolved as { config: Record<string, unknown> }).config["reasoning"]).toBeUndefined();
  });

  it("refuses a preset that sets no model rather than sending its name to a router", () => {
    expect(resolvePresetCall({ model: "nomodel" }, options(machine()), undefined)).toEqual({
      refused: "the model 'nomodel' names the preset 'nomodel', which sets no model",
    });
  });
});

describe("first-available, at the call", () => {
  it("runs the first candidate this machine can, and the record then shows that model", async () => {
    const inner = leaf();
    const executor = withPresetModels(options(machine("gpt-5.6-terra")), undefined, inner.executor);
    await executor.start(promptOp({ configRef: "coder" }), {} as ExecServices).result;
    expect(inner.seen).toEqual([{ model: "gpt-5.6-terra", reasoning: { effort: "high" } }]);
  });

  it("fails the call naming every candidate and why, when none can run", async () => {
    const inner = leaf();
    const executor = withPresetModels(options(machine()), undefined, inner.executor);
    const result = await executor.start(promptOp({ configRef: "coder" }), {} as ExecServices).result;
    expect((result as { error: { reason: string } }).error.reason).toBe(
      "none of the candidates of preset 'coder' is available here — claude-opus-5-5: not here; gpt-5.6-terra: not here",
    );
    expect(inner.seen).toHaveLength(0);
  });

  it("leaves a function op alone", async () => {
    const inner = leaf();
    const executor = withPresetModels(options(machine()), undefined, inner.executor);
    const op = { kind: "function", functionRef: "x", config: { configRef: "nowhere" } } as unknown as Operation<never>;
    await executor.start(op, {} as ExecServices).result;
    expect(inner.seen).toEqual([{ configRef: "nowhere" }]);
  });
});

describe("a session keeps the model it chose", () => {
  it("keeps it for every later call in the session, though the machine changed underneath", async () => {
    const inner = leaf();
    let runs = ["claude-opus-5-5", "gpt-5.6-terra"];
    const executor = withPresetModels(options((model) => machine(...runs)(model)), undefined, inner.executor);
    await executor.start(promptOp({ configRef: "coder" }), inSession("s1", 0)).result;
    // The CLI signed out halfway through the conversation.
    runs = ["gpt-5.6-terra"];
    await executor.start(promptOp({ configRef: "coder" }), inSession("s1", 1)).result;
    // A NEW session chooses again.
    await executor.start(promptOp({ configRef: "coder" }), inSession("s2", 0)).result;
    expect(inner.seen.map((c) => c["model"])).toEqual(["claude-opus-5-5", "claude-opus-5-5", "gpt-5.6-terra"]);
  });

  it("reads the choice off the record when resumed — a fresh executor, the session's last call recorded under its route", async () => {
    const inner = leaf();
    const asked: Array<{ id: string; seq: number }> = [];
    const executor = withPresetModels(
      options(machine("claude-opus-5-5", "gpt-5.6-terra"), {
        recorded: (at) => {
          asked.push(at);
          return "codex-cli/gpt-5.6-terra";
        },
      }),
      undefined,
      inner.executor,
    );
    await executor.start(promptOp({ configRef: "coder" }), inSession("s1", 3)).result;
    expect(inner.seen[0]!["model"]).toBe("gpt-5.6-terra");
    expect(asked).toEqual([{ id: "s1", seq: 3 }]);
  });

  it("chooses again when the record names none of the candidates, and never asks the record for a session's first call", async () => {
    const inner = leaf();
    let asked = 0;
    const recorded = (): string => {
      asked += 1;
      return "claude-cli/claude-sonnet-5";
    };
    const executor = withPresetModels(options(machine("claude-opus-5-5"), { recorded }), undefined, inner.executor);
    await executor.start(promptOp({ configRef: "coder" }), inSession("s1", 2)).result;
    await executor.start(promptOp({ configRef: "coder" }), inSession("s9", 0)).result;
    expect(inner.seen.map((c) => c["model"])).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(asked).toBe(1);
  });

  it("chooses every time for a call with no session — the judge", async () => {
    const inner = leaf();
    let runs = ["claude-haiku-4-5"];
    const executor = withPresetModels(options((model) => machine(...runs)(model)), undefined, inner.executor);
    await executor.start(promptOp({ model: "simple" }), {} as ExecServices).result;
    runs = ["gpt-5.6-luna"];
    await executor.start(promptOp({ model: "simple" }), {} as ExecServices).result;
    expect(inner.seen.map((c) => c["model"])).toEqual(["claude-haiku-4-5", "gpt-5.6-luna"]);
  });
});

describe("the start-time check reads a preset's candidates", () => {
  const bundle = (config: Record<string, unknown>): WorkflowBundle =>
    ({ rootId: "s", states: { s: { operation: { kind: "prompt", config } } } }) as unknown as WorkflowBundle;
  const config = parseConfig({
    agents: { cli: { enabled: true }, codex: { enabled: false } },
    models: { presets: PRESETS },
  });

  it("starts a state that picks a preset one of whose candidates is served here", () => {
    expect(() => defaultExecutorTree(config, bundle({ configRef: "coder" }))).not.toThrow();
    expect(() => defaultExecutorTree(config, bundle({ model: "coder" }))).not.toThrow();
  });

  it("refuses one none of whose candidates is, naming the preset and each reason", () => {
    const onlyOpenAi = parseConfig({
      agents: { cli: { enabled: true }, codex: { enabled: false } },
      models: { presets: { openaionly: { model: { candidates: ["gpt-5", "gpt-5-mini"], choose: "first-available" } } } },
    });
    expect(() => defaultExecutorTree(onlyOpenAi, bundle({ model: "openaionly" }))).toThrow(/preset 'openaionly' names no model this machine serves — 'gpt-5' is a openai model/);
  });
});
