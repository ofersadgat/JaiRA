/**
 * JSON-scriptable fake `llm-call` executor for headless runs — the CLI-facing
 * cousin of ai-exec's `packages/hw/test/fakes.ts` FakeExecutor. Rules are
 * matched first-to-last against the built definition's model and the rendered
 * prompt tail (conversation-history preamble stripped, so `full_history`
 * re-invocations don't accidentally match on echoed history).
 */
import type {
  ExecHandle,
  ExecutionSpec,
  Executor,
  ExecutorCapabilities,
  ExecServices,
  Outcome,
  UnitKind,
} from "@ai-exec/core";

const CAPS: ExecutorCapabilities = {
  structuredOutput: true,
  sessionResume: false,
  streaming: false,
  interactive: false,
  mutatesWorkspace: false,
  policyEnforcement: "none",
  memoizable: true,
  runtime: "edge-safe",
};

async function* empty(): AsyncGenerator<never> {}

export interface FakeRule {
  /** Match on the definition's `model` (what `llmCallBinding` puts there). */
  model?: string;
  /** Match when the rendered prompt tail contains this substring. */
  promptIncludes?: string;
  /** The structured output value to return (exclusive with `error`). */
  output?: unknown;
  /** Fail the operation with this reason instead of returning output. */
  error?: string;
  cost?: number;
}

export function parseFakeRules(raw: unknown): FakeRule[] {
  if (!Array.isArray(raw)) throw new Error("fake script must be a JSON array of rules");
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`fake rule ${i} must be an object`);
    }
    const rule = entry as FakeRule;
    if ((rule.output === undefined) === (rule.error === undefined)) {
      throw new Error(`fake rule ${i} must have exactly one of 'output' or 'error'`);
    }
    return rule;
  });
}

function modelOf(spec: ExecutionSpec): string {
  return String((spec.definition as { model?: unknown }).model ?? "");
}

function promptTail(spec: ExecutionSpec): string {
  const prompt = String((spec.definition as { prompt?: unknown }).prompt ?? "");
  const marker = "</conversation-history>";
  const at = prompt.lastIndexOf(marker);
  return at < 0 ? prompt.trim() : prompt.slice(at + marker.length).trim();
}

export class ScriptedFakeExecutor implements Executor {
  readonly kind: UnitKind = "llm-call";
  readonly capabilities = CAPS;
  readonly calls: ExecutionSpec[] = [];

  constructor(private readonly rules: FakeRule[]) {}

  start(spec: ExecutionSpec, _ctx: ExecServices): ExecHandle {
    this.calls.push(spec);
    const outcome = Promise.resolve(this.execute(spec));
    return { events: empty(), outcome, cancel: async () => {} };
  }

  private execute(spec: ExecutionSpec): Outcome {
    if (spec.abortSignal?.aborted) {
      return { metrics: { durationMs: 0 }, error: { classification: "canceled", reason: "aborted" } };
    }
    const model = modelOf(spec);
    const tail = promptTail(spec);
    const rule = this.rules.find(
      (r) =>
        (r.model === undefined || r.model === model) &&
        (r.promptIncludes === undefined || tail.includes(r.promptIncludes)),
    );
    if (!rule) {
      return {
        metrics: { durationMs: 0 },
        error: { classification: "permanent", reason: `no fake rule matched model '${model}', prompt '${tail.slice(0, 80)}'` },
      };
    }
    if (rule.error !== undefined) {
      return { metrics: { durationMs: 0 }, error: { classification: "permanent", reason: rule.error } };
    }
    return {
      value: rule.output,
      rawText: JSON.stringify(rule.output),
      metrics: { durationMs: 1, cost: rule.cost ?? 0.01, inputTokens: 10, outputTokens: 20 },
    };
  }
}
