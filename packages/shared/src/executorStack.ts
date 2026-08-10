/**
 * How an executor is INSTANTIATED — the composition, and each step's own configuration.
 *
 * An executor in declarative-ai is not one object, it is a stack: a core that makes the call, wrapped
 * in layers that each add one cross-cutting behaviour. `@declarative-ai/exec` states the shape in
 * `hydrate.ts`:
 *
 * ```ts
 * compose(leaf)
 *   .with(withRateLimit(...))   // a concurrency slot and rate headroom
 *   .with(withRetry(...))       // transient re-attempts, schema repair
 *   .with(withMemoize(...))     // a durable answer cache
 * ```
 *
 * JaiRA hardcoded that stack: two repair turns, memo on or off, and nothing else — no rate limit, no
 * deadline, and no way to say otherwise. This module is the missing half: the stack as CONFIGURATION,
 * so a project can choose which steps an executor is built from and what each one is given.
 *
 * Two decisions worth stating, because the other answer is worse in each case:
 *
 *  - **The steps are a SET, applied in a canonical ORDER.** Order is load-bearing and the upstream
 *    docs are emphatic about it — memoize outermost so a hit skips everything; rate limiting INSIDE
 *    retry so a re-attempt after a 429 waits for headroom again rather than holding one slot across
 *    the whole loop. Letting the order be authored would let someone build a stack that is silently
 *    wrong, and a settings screen has no business offering that.
 *  - **Each step carries its own JSON Schema, here.** The form is generated from it rather than
 *    hand-written, which is what keeps the parser, the UI and the documentation from drifting into
 *    three different ideas of what `retry` takes.
 */
import type { JsonValue } from "@declarative-ai/json";

/** The steps JaiRA can build an executor from, by the name they are keyed under. */
export type ExecutorStepName = "memoize" | "retry" | "rateLimit" | "deadline";

/**
 * The composition order, OUTERMOST first — the order the wrappers are applied in.
 *
 * This is the list, and it is not alphabetical or arbitrary:
 *
 *  1. `memoize` — outermost, so a cache hit costs nothing else: no slot acquired, no retry loop
 *     entered, no deadline arithmetic. Anything above it would be paid for on a hit.
 *  2. `retry` — outside the limiter, so each ATTEMPT goes through admission separately. Inside, one
 *     slot would be held for the whole loop including its backoff, which is how a rate limiter turns
 *     into a concurrency leak.
 *  3. `rateLimit` — the admission gate immediately around the call.
 *  4. `deadline` — innermost, so the window it computes bounds the call itself rather than the
 *     queueing and the backoff, which are not the call's own latency.
 */
export const EXECUTOR_STEP_ORDER: ExecutorStepName[] = ["memoize", "retry", "rateLimit", "deadline"];

/** A durable cache of model answers, keyed by the rendered operation. */
export interface JairaMemoizeStep {
  /** Keeps one executor's entries from colliding with another's. Defaults to the executor's name. */
  namespace?: string;
  /** Fail the call when the cache cannot be WRITTEN, rather than treating the write as best-effort. */
  strictCacheWrites?: boolean;
}

/** Re-attempts: transient failures, and schema-invalid output. */
export interface JairaRetryStep {
  /** How many extra attempts a transient failure (a 429, a dropped connection) gets. */
  transient?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Extra attempts for output that failed its schema. `feedback` appends the errors to the prompt. */
  validation?: { turns: number; feedback?: boolean };
}

/** Admission control: a concurrency slot plus rate headroom, with AIMD on the concurrency knob. */
export interface JairaRateLimitStep {
  initialConcurrency?: number;
  maxConcurrency?: number;
  minConcurrency?: number;
  /** Raise concurrency by one after this many consecutive successes. */
  increaseEvery?: number;
  /** Requests per minute. */
  rpm?: number;
  /** Input tokens per minute. */
  inputTpm?: number;
  /** Output tokens per minute. */
  outputTpm?: number;
}

/** A wall-clock window for one call. */
export interface JairaDeadlineStep {
  maxDurationMs: number;
  /** Held back from the window so a cut-off answer can still be salvaged. */
  safetyMarginMs?: number;
  /** Below this much remaining, do not start the call at all. */
  floorMs?: number;
}

export interface JairaExecutorSteps {
  memoize?: JairaMemoizeStep;
  retry?: JairaRetryStep;
  rateLimit?: JairaRateLimitStep;
  deadline?: JairaDeadlineStep;
}

/**
 * One executor, as a whole: who answers, with what model and settings, wrapped in which steps.
 *
 * `provider` is the piece that makes this a CHOICE rather than a description — the same prefix
 * vocabulary a model id uses, so `anthropic` names the provider route and `claude-cli` names the
 * agent. An executor definition is therefore a named, reusable answer to "who runs this, how".
 */
export interface JairaExecutorDefinition {
  /** One line, for the settings screen and for a reader of the config. */
  description?: string;
  /** Which provider answers — a model-route prefix or an agent's registry name. */
  provider?: string;
  /** The model, as the provider knows it: bare, because `provider` is already the prefix. */
  model?: string;
  /** The call settings — an `LlmConfiguration`, merged under the state's own. */
  config?: Record<string, JsonValue>;
  /** The stack. A step that is absent is not in it. */
  steps?: JairaExecutorSteps;
}

// --- the schemas the form is generated from ----------------------------------

/** A JSON Schema node. The same `Schema` shape findmyprompt's signature-driven form consumes. */
export type StepSchema = Record<string, JsonValue>;

export interface ExecutorStepSpec {
  name: ExecutorStepName;
  title: string;
  /** One line: what this step DOES, addressed to someone deciding whether they want it. */
  hint: string;
  /** Why it sits where it does in the stack — the thing a settings screen usually leaves out. */
  placement: string;
  schema: StepSchema;
}

/**
 * Every step's schema, in composition order.
 *
 * Authored here rather than fetched, which is the one honest difference from findmyprompt: there the
 * server publishes a signature for a search method it also implements, so the form follows the engine
 * automatically. JaiRA's stack is a fixed set of upstream wrappers, so the schema is static — but it
 * is still ONE declaration that the parser, the form and the composition all read.
 */
export const EXECUTOR_STEPS: ExecutorStepSpec[] = [
  {
    name: "memoize",
    title: "Memoize",
    hint: "Remember what a model answered, and reuse it when the identical call is made again. It saves real money and is not a pure optimization: a re-run returns the first run's answer rather than asking again.",
    placement: "Outermost, so a hit costs nothing else — no slot acquired, no retry loop entered.",
    schema: {
      $type: "memoize",
      type: "object",
      properties: {
        namespace: {
          type: "string",
          title: "namespace",
          description: "Keeps this executor's entries from colliding with another's. Empty uses the executor's name.",
        },
        strictCacheWrites: {
          type: "boolean",
          title: "strict cache writes",
          description: "Fail the call when the cache cannot be written, rather than treating the write as best-effort.",
        },
      },
    },
  },
  {
    name: "retry",
    title: "Retry",
    hint: "Re-attempt a call that failed for a reason worth trying again — a 429, a dropped connection, or output that did not satisfy its schema.",
    placement: "Outside the rate limiter, so each attempt goes through admission separately rather than holding one slot across the whole loop and its backoff.",
    schema: {
      $type: "retry",
      type: "object",
      properties: {
        transient: {
          type: "number",
          title: "transient attempts",
          description: "Extra attempts for a retriable failure. Empty means none — the first failure is the answer.",
        },
        baseBackoffMs: {
          type: "number",
          title: "base backoff (ms)",
          description: "The first wait between attempts. It grows from here.",
        },
        maxBackoffMs: {
          type: "number",
          title: "max backoff (ms)",
          description: "A ceiling on that growth, so a long outage does not turn into a very long sleep.",
        },
        validation: {
          $type: "retry-validation",
          type: "object",
          title: "schema repair",
          properties: {
            turns: {
              type: "number",
              title: "repair turns",
              description: "Extra attempts for output that failed its schema.",
            },
            feedback: {
              type: "boolean",
              title: "send the errors back",
              description:
                "Append the concrete validation errors to the prompt before retrying — a targeted fix. Off is a blind re-roll, which biases stochastic output until it happens to pass.",
            },
          },
        },
      },
    },
  },
  {
    name: "rateLimit",
    title: "Rate limit",
    hint: "Hold each call until there is a concurrency slot and enough rate headroom, and back off automatically when the provider says no.",
    placement: "Immediately around the call, inside retry.",
    schema: {
      $type: "rateLimit",
      type: "object",
      properties: {
        maxConcurrency: {
          type: "number",
          title: "max concurrency",
          description: "The most calls in flight at once. The knob halves on a 429 and climbs back with success.",
        },
        initialConcurrency: { type: "number", title: "initial concurrency", description: "Where that knob starts." },
        minConcurrency: { type: "number", title: "min concurrency", description: "How far it may be halved." },
        increaseEvery: {
          type: "number",
          title: "raise after N successes",
          description: "Consecutive successes before concurrency climbs by one. Default 8.",
        },
        rpm: { type: "number", title: "requests / minute", description: "The provider's published request limit." },
        inputTpm: { type: "number", title: "input tokens / minute", description: "The published input-token limit." },
        outputTpm: { type: "number", title: "output tokens / minute", description: "The published output-token limit." },
      },
    },
  },
  {
    name: "deadline",
    title: "Deadline",
    hint: "Give a call a wall-clock window, and refuse to start one that cannot finish inside it.",
    placement: "Innermost, so the window bounds the call itself rather than the queueing and the backoff — neither of which is the call's own latency.",
    schema: {
      $type: "deadline",
      type: "object",
      required: ["maxDurationMs"],
      properties: {
        maxDurationMs: {
          type: "number",
          title: "window (ms)",
          description: "How long the call may take, measured from when the step began.",
        },
        safetyMarginMs: {
          type: "number",
          title: "safety margin (ms)",
          description: "Held back from the window so a cut-off answer can still be salvaged. Default 10000.",
        },
        floorMs: {
          type: "number",
          title: "floor (ms)",
          description: "With less than this remaining, do not start the call at all. Default 5000.",
        },
      },
    },
  },
];

/** One step's spec, by name. */
export function executorStep(name: string): ExecutorStepSpec | undefined {
  return EXECUTOR_STEPS.find((s) => s.name === name);
}
