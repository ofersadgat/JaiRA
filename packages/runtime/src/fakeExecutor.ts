/**
 * JSON-scriptable fake prompt `Executor` for headless runs — the CLI-facing
 * cousin of declarative-ai's `packages/hw/test/fakes.ts` FakePromptExecutor.
 *
 * The engine dispatches every `PromptOp` to the injected prompt executor, so
 * substituting this one is all it takes to run a whole workflow with no LLM in
 * the graph. Rules are matched first-to-last against the op's configured model
 * and the rendered prompt tail (conversation-history preamble stripped, so
 * `full_history` re-invocations don't accidentally match on echoed history).
 */
import type {
  Capabilities,
  ExecHandle,
  ExecResult,
  ExecServices,
  Executor,
  InlineFamily,
  JsonValue,
  Operation,
  PromptOp,
  ResolvedValue,
} from "@declarative-ai/exec";
import { mergeWorkflowMetrics, type WorkflowMetrics } from "@declarative-ai/hw";

const CAPS: Capabilities = {
  structuredOutput: true,
  sessionResume: false,
  streaming: false,
  interactive: false,
  readOnly: true,
  mutatesWorkspace: false,
  policyEnforcement: "none",
  memoizable: true,
  runtime: "edge-safe",
};

async function* empty(): AsyncGenerator<never> {}

export interface FakeRule {
  /** Match on the op's configured `model` (a state's `operation.config.model`). */
  model?: string;
  /** Match when the rendered prompt tail contains this substring. */
  promptIncludes?: string;
  /** The structured output value to return (exclusive with `error`). */
  output?: JsonValue;
  /** Fail the operation with this reason instead of returning output. */
  error?: string;
  /** USD cost to report, so cost roll-up is exercised headlessly. */
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

function modelOf(op: PromptOp<InlineFamily>): string {
  const config = op.config !== null && typeof op.config === "object" && !Array.isArray(op.config) ? op.config : {};
  return typeof config.model === "string" ? config.model : "";
}

function promptTail(op: PromptOp<InlineFamily>): string {
  const prompt = op.user ?? "";
  const marker = "</conversation-history>";
  const at = prompt.lastIndexOf(marker);
  return at < 0 ? prompt.trim() : prompt.slice(at + marker.length).trim();
}

const failed = (reason: string, classification: "permanent" | "canceled" = "permanent"): ExecResult<ResolvedValue, WorkflowMetrics> => ({
  error: { classification, reason },
  metrics: { durationMs: 0, costUsd: 0, costSource: "unknown" },
});

export class ScriptedFakeExecutor implements Executor<ExecServices, WorkflowMetrics> {
  readonly metrics = { merge: mergeWorkflowMetrics };
  readonly capabilities = CAPS;
  readonly calls: PromptOp<InlineFamily>[] = [];

  constructor(private readonly rules: FakeRule[]) {}

  start(operation: Operation<InlineFamily>, ctx: ExecServices): ExecHandle<ResolvedValue, WorkflowMetrics> {
    const op = operation as PromptOp<InlineFamily>;
    this.calls.push(op);
    return { events: empty(), result: Promise.resolve(this.execute(op, ctx)), cancel: async () => {} };
  }

  private execute(op: PromptOp<InlineFamily>, ctx: ExecServices): ExecResult<ResolvedValue, WorkflowMetrics> {
    if (ctx.abortSignal?.aborted) return failed("aborted", "canceled");
    const model = modelOf(op);
    const tail = promptTail(op);
    const rule = this.rules.find(
      (r) =>
        (r.model === undefined || r.model === model) &&
        (r.promptIncludes === undefined || tail.includes(r.promptIncludes)),
    );
    if (!rule) {
      return failed(`no fake rule matched model '${model}', prompt '${tail.slice(0, 80)}'`);
    }
    if (rule.error !== undefined) return failed(rule.error);
    // Token counts belong to the model payload (`LlmOutput`), which stops at the
    // prompt executor — a workflow measurement is duration plus spend.
    return {
      value: rule.output ?? null,
      metrics: { durationMs: 1, costUsd: rule.cost ?? 0.01, costSource: "table" },
      // The conversation this call added, on the DECLARED session channel.
      //
      // A real prompt executor's payload is an `LlmOutput` that already carries the
      // messages; this fake's projected value is the structured output and is not, so
      // it reports the delta explicitly. Without it a scripted run records positions
      // holding no messages — every transcript empty, and every conversation-dependent
      // behaviour (the preamble, `{ conversation }` bindings, summary mode) silently
      // inert in exactly the runs that are supposed to exercise them.
      session: {
        messages: [
          { role: "user", content: op.user ?? "" },
          { role: "assistant", content: typeof rule.output === "string" ? rule.output : JSON.stringify(rule.output ?? null) },
        ],
      },
    } as ExecResult<ResolvedValue, WorkflowMetrics>;
  }
}
