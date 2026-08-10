/**
 * Building an executor from its DEFINITION — the composition, instantiated.
 *
 * `@declarative-ai/exec` states the shape in `hydrate.ts`:
 *
 * ```ts
 * compose(leaf)
 *   .with(withRateLimit(...))
 *   .with(withRetry(...))
 *   .with(withMemoize(...))
 * ```
 *
 * JaiRA hardcoded exactly one instance of it — two repair turns and an on/off memo — so the stack was
 * a fact about the program rather than a choice a project could make. This module makes it a choice:
 * `config.executors.<name>` names the steps and their settings, and {@link composeExecutorStack}
 * applies them.
 *
 * **The order is ours, not the author's**, and that is deliberate (see `EXECUTOR_STEP_ORDER`). Order
 * is load-bearing here: memoize outermost so a hit skips everything, rate limiting INSIDE retry so a
 * re-attempt after a 429 waits for headroom again rather than holding one slot across the whole loop
 * and its backoff. Those are correctness properties, not preferences, and offering them as a
 * drag-to-reorder list would be offering someone the chance to build a stack that is quietly wrong.
 */
import {
  AdaptiveRateController,
  withDeadline,
  withMemoize,
  withRetry,
  type ExecServices,
  type Executor,
  type InlineFamily,
  type MemoCache,
  type ModelRateLimits,
  type Operation,
  type ResolvedValue,
} from "@declarative-ai/exec";
import { withRateLimit } from "@declarative-ai/promptop";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  EXECUTOR_STEP_ORDER,
  type JairaExecutorDefinition,
  type JairaExecutorSteps,
} from "@jaira/shared";

/** What an executor here is, in JaiRA's metric algebra. */
export type StackedExecutor = Executor<ExecServices, WorkflowMetrics>;

export interface StackDeps {
  /**
   * Where memoized answers live. Absent ⇒ the `memoize` step is SKIPPED rather than faked.
   *
   * Skipped and reported, not silently dropped: a definition that asks to memoize and a run that
   * quietly does not is the kind of difference nobody notices until the bill arrives.
   */
  memoCache?: MemoCache;
  /** The name the memo namespace defaults to — the executor's own. */
  name: string;
  /** Injected so a test can drive the deadline arithmetic without real time. */
  now?: () => number;
}

/** What was actually applied, and what was asked for but could not be. */
export interface StackReport {
  applied: string[];
  skipped: Array<{ step: string; reason: string }>;
}

/**
 * Wrap `core` in the steps a definition names, outermost last.
 *
 * Applied in `EXECUTOR_STEP_ORDER`, which lists them OUTERMOST first — so the list is walked in
 * reverse, each step wrapping what has been built so far. The innermost wrapper is therefore the last
 * entry of the order and sits closest to the call, which is what "innermost" has to mean.
 */
export function composeExecutorStack(
  core: StackedExecutor,
  definition: JairaExecutorDefinition,
  deps: StackDeps,
): { executor: StackedExecutor; report: StackReport } {
  const steps: JairaExecutorSteps = definition.steps ?? {};
  const report: StackReport = { applied: [], skipped: [] };
  let executor = core;

  for (const name of [...EXECUTOR_STEP_ORDER].reverse()) {
    const step = steps[name];
    if (step === undefined) continue;

    if (name === "deadline") {
      const spec = step as JairaExecutorSteps["deadline"];
      if (spec === undefined) continue;
      const now = deps.now ?? Date.now;
      executor = withDeadline(
        {
          deadline: {
            maxDurationMs: spec.maxDurationMs,
            ...(spec.safetyMarginMs !== undefined ? { safetyMarginMs: spec.safetyMarginMs } : {}),
            ...(spec.floorMs !== undefined ? { floorMs: spec.floorMs } : {}),
          },
          // The window is measured from when this step began, and a stack is built per run — so the
          // clock is read at COMPOSITION rather than per call, which is what makes a long run's later
          // calls see the window shrinking instead of each one getting a fresh full window.
          stepStartMs: now(),
        },
        executor,
      );
      report.applied.push(name);
      continue;
    }

    if (name === "rateLimit") {
      const spec = step as NonNullable<JairaExecutorSteps["rateLimit"]>;
      const limits: ModelRateLimits = {
        ...(spec.rpm !== undefined ? { rpm: spec.rpm } : {}),
        ...(spec.inputTpm !== undefined ? { inputTpm: spec.inputTpm } : {}),
        ...(spec.outputTpm !== undefined ? { outputTpm: spec.outputTpm } : {}),
      };
      const limiter = new AdaptiveRateController({
        ...(spec.initialConcurrency !== undefined ? { initialConcurrency: spec.initialConcurrency } : {}),
        ...(spec.maxConcurrency !== undefined ? { maxConcurrency: spec.maxConcurrency } : {}),
        ...(spec.minConcurrency !== undefined ? { minConcurrency: spec.minConcurrency } : {}),
        ...(spec.increaseEvery !== undefined ? { increaseEvery: spec.increaseEvery } : {}),
        // One published limit for every model this executor serves: a definition names ONE provider,
        // so a per-model resolver would be a table with one row. The `key` is what the controller
        // buckets by, and one key means one shared set of buckets — which is the intent.
        ...(Object.keys(limits).length > 0 ? { modelLimits: () => ({ key: deps.name, limits }) } : {}),
      });
      executor = withRateLimit({ limiter }, executor);
      report.applied.push(name);
      continue;
    }

    if (name === "retry") {
      const spec = step as NonNullable<JairaExecutorSteps["retry"]>;
      const transient =
        spec.transient === undefined
          ? undefined
          : {
              cap: spec.transient,
              ...(spec.baseBackoffMs !== undefined ? { baseBackoffMs: spec.baseBackoffMs } : {}),
              ...(spec.maxBackoffMs !== undefined ? { maxBackoffMs: spec.maxBackoffMs } : {}),
            };
      executor = withRetry(
        {
          ...(transient !== undefined ? { transient } : {}),
          ...(spec.validation !== undefined ? { validation: spec.validation } : {}),
        },
        executor,
      );
      report.applied.push(name);
      continue;
    }

    if (name === "memoize") {
      const spec = step as NonNullable<JairaExecutorSteps["memoize"]>;
      if (deps.memoCache === undefined) {
        report.skipped.push({
          step: name,
          reason: "no memo store is open — memoization needs a project, and this run has none",
        });
        continue;
      }
      executor = withMemoize(
        {
          cache: deps.memoCache,
          namespace: spec.namespace ?? deps.name,
          ...(spec.strictCacheWrites !== undefined ? { strictCacheWrites: spec.strictCacheWrites } : {}),
        },
        executor,
      );
      report.applied.push(name);
      continue;
    }
  }

  return { executor, report };
}

/**
 * The model id a definition dispatches on — `<provider>/<model>`.
 *
 * A definition is selected the same way everything else is: by prefix. Its `provider` supplies the
 * prefix and its `model` the rest, so a named executor is a model id like any other and an automatic
 * choice and an explicit one stay the same kind of thing (DESIGN §8.3).
 */
export function definitionModelId(definition: JairaExecutorDefinition): string | undefined {
  if (definition.provider === undefined) return undefined;
  return definition.model === undefined ? `${definition.provider}/default` : `${definition.provider}/${definition.model}`;
}

/** Every definition that names a provider, as `name → the model id it dispatches on`. */
export function definitionModelIds(
  definitions: Record<string, JairaExecutorDefinition> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const id = definitionModelId(definition);
    if (id !== undefined) out[name] = id;
  }
  return out;
}
