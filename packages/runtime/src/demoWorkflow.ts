/**
 * The demo workflow: the SPEC §9 planning workflow, mirroring
 * declarative-ai/packages/hw/test/fixtures.ts (the engine golden test).
 *
 * It lives in the runtime package rather than a test folder because three
 * callers want it: the CLI tests, the app tests, and the app itself as the
 * starter workflow a fresh project can be seeded with.
 *
 * Post-ops-redesign format: slots carry JSON Schemas (an ARTIFACT is a blob-kind
 * slot derived from contentMediaType), a state s work is ONE operation
 * (prompt | function), and wiring is authored binding sugar — { input },
 * { child, output }, { expr } — that the loader lowers to base refs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FakeRule } from "./fakeExecutor";

export const PLAN_ID = "feature/plan";

/** The interactive host function the human-review gate invokes. */
export const HUMAN_REVIEW_FUNCTION = "choose_option";

const artifact = (format: string) => ({ kind: "blob", schema: { type: "string", contentMediaType: format } });
const str = () => ({ schema: { type: "string" } });
const strArray = () => ({ schema: { type: "array", items: { type: "string" } } });

export interface DemoWorkflowOptions {
  /**
   * Model id for every prompt state. Real runs need a ROUTE-PREFIXED id
   * (`anthropic/claude-sonnet-5`); the default keeps the SPEC's role names
   * (`planner`/`critic`/`fixer`), which are labels the scripted fake executor
   * dispatches on and which a real provider router correctly refuses.
   */
  model?: string;
}

export function specPlanningFiles(options: DemoWorkflowOptions = {}): Record<string, unknown> {
  const model = (role: string): string => options.model ?? role;
  return {
    "feature/plan": {
      label: "Planning",
      // The defaults every state in this subtree inherits (WORKFLOWS.md §5): these are all prompt
      // states on one model, so the leaves say only what is different.
      environment: { kind: "prompt", model: model("planner") },
      inputs: { issue: artifact("markdown") },
      outputs: {
        outcome: {
          schema: { type: "string", enum: ["complete", "blocked"] },
          binding: { expr: ".children.critique.outputs.outcome === 'clean' ? 'complete' : 'blocked'" },
        },
        // `output` defaults to the slot's own name, so this is context's `plan_doc`.
        plan_doc: { ...artifact("markdown"), binding: ".children.context.outputs.plan_doc" },
        // A "passthrough" output: the whole child result as ONE value (`*`, WORKFLOWS.md §3.4).
        critique: { binding: ".children.critique.outputs" },
      },
      children: {
        // No `state`: a child's key names the state it runs (WORKFLOWS.md §6).
        goals: { inputs: { issue: ".inputs.issue" } },
        context: { inputs: { issue: ".inputs.issue", goals: ".children.goals.outputs.goals" } },
        critique: {
          inputs: {
            plan_doc: ".children.context.outputs.plan_doc",
            severity_threshold: { text: "significant" },
          },
        },
      },
      sequence: ["goals", "context", "critique"],
      transitions: [
        { to: "terminate.success", when: ".children.critique.outputs.outcome === 'clean'" },
        {
          to: "goals",
          when: ".children.critique.outputs.outcome === 'needs_changes' && .run.iteration < .limits.max_iterations",
        },
        { to: "terminate.success", when: ".children.critique.outcome === 'success'" },
      ],
      limits: { max_iterations: 3 },
    },
    "feature/plan/goals": {
      label: "Goals",
      inputs: { issue: artifact("markdown") },
      // The call says what it returns and the state says what it publishes, with a binding between
      // them (WORKFLOWS.md §3.3). Two lines rather than one, and the reason for the second is that
      // the first is otherwise a claim nothing in the file supports: a produced output is filled by
      // NAME, silently, and a call that stops returning that name leaves a state that terminates
      // successfully having handed back nothing.
      outputs: { goals: { ...strArray(), binding: ".operation.output.goals" } },
      operation: { prompt: "Extract goals from {{.inputs.issue}}.", outputs: { goals: strArray() } },
    },
    "feature/plan/context": {
      label: "Context",
      inputs: { issue: artifact("markdown"), goals: strArray() },
      outputs: { plan_doc: { ...artifact("markdown"), binding: ".operation.output.plan_doc" } },
      operation: {
        prompt: "Write the plan for {{.inputs.issue}}.",
        outputs: { plan_doc: artifact("markdown") },
      },
    },
    "feature/plan/critique": {
      label: "Critique Plan",
      description: "Review the current plan for significant weaknesses.",
      inputs: {
        plan_doc: artifact("markdown"),
        severity_threshold: {
          schema: { type: "string", enum: ["minor", "significant", "critical"] },
          default: "significant",
        },
      },
      outputs: {
        outcome: {
          schema: { type: "string", enum: ["clean", "needs_changes", "blocked"] },
          binding: ".operation.output.outcome",
        },
        weaknesses: { ...strArray(), binding: ".operation.output.weaknesses" },
        critique_report: { ...artifact("markdown"), binding: ".operation.output.critique_report" },
        human_decision: {
          schema: { type: "string", enum: ["approve", "request_changes", "block"] },
          optional: true,
          binding: ".children.human_review.outputs.decision",
        },
      },
      environment: { conversation: { mode: "full_history" } },
      operation: {
        model: model("critic"),
        prompt:
          "Review the plan document. Find significant weaknesses at or above the configured " +
          "severity threshold. Return structured output matching this operation's declared returns.",
        outputs: {
          outcome: { schema: { type: "string", enum: ["clean", "needs_changes", "blocked"] } },
          weaknesses: strArray(),
          critique_report: artifact("markdown"),
        },
      },
      // The children read the CALL's result rather than this state's slots, and that is what binding
      // those slots costs: a produced output is filled the moment the operation returns, while a
      // bound one is computed when the state TERMINATES (WORKFLOWS.md §3.3). Anything that has to
      // see the value mid-state — a child's wiring, a guard below — must name where it came from.
      children: {
        address_weaknesses: {
          inputs: {
            plan_doc: ".inputs.plan_doc",
            weaknesses: ".operation.output.weaknesses",
            critique_report: ".operation.output.critique_report",
          },
        },
        human_review: {
          inputs: { plan_doc: ".inputs.plan_doc", critique_report: ".operation.output.critique_report" },
        },
      },
      // These two children are ALTERNATIVES, not a spine: an absent `sequence` would run both in
      // declaration order (WORKFLOWS.md §6), so the empty one says "only a transition enters these".
      sequence: [],
      transitions: [
        { to: "terminate.success", when: ".children.human_review.outcome === 'success'" },
        { to: "terminate.success", when: ".children.address_weaknesses.outcome === 'success'" },
        { to: "terminate.success", when: ".operation.output.outcome === 'clean'" },
        { to: "human_review", when: ".operation.output.outcome === 'blocked'" },
        { to: "address_weaknesses", when: ".operation.output.outcome === 'needs_changes'" },
      ],
    },
    "feature/plan/critique/address_weaknesses": {
      label: "Address Weaknesses",
      inputs: { plan_doc: artifact("markdown"), weaknesses: strArray(), critique_report: artifact("markdown") },
      outputs: { resolution: { ...str(), binding: ".operation.output.resolution" } },
      operation: { prompt: "Fix the listed weaknesses.", model: model("fixer"), outputs: { resolution: str() } },
    },
    "feature/plan/critique/human_review": {
      label: "Human Review",
      inputs: { plan_doc: artifact("markdown"), critique_report: artifact("markdown") },
      // Produced, and that is the one place JaiRA still allows it: a component's answer is delivered
      // by NAME onto these slots, and `.operation.output.decision` resolves to nothing at run time
      // however it is declared — a host function returns one value, not a map the engine can index.
      // See the rule in `workflows.ts`.
      outputs: {
        decision: { schema: { type: "string", enum: ["approve", "request_changes", "block"] } },
        comments: { schema: { type: "string", format: "markdown" }, optional: true },
      },
      // The human gate is an interactive host FUNCTION — a plain FunctionOp whose
      // authored surface rides in `config`. JaiRA's renderer backs this in phase 4;
      // headless runs script it with `--interactions`.
      operation: {
        kind: "function",
        function: HUMAN_REVIEW_FUNCTION,
        args: { prompt: "Review the critique result.", options: ["approve", "request_changes", "block"] },
      },
    },
  };
}

/** Fake rules for the happy path (critique comes back clean). Mirrors the
 *  declarative-ai executor test's `happyScript`; providers auto-bind model = name. */
export function happyRules(): FakeRule[] {
  return [
    { model: "planner", promptIncludes: "Write the plan", output: { plan_doc: "# The Plan" } },
    { model: "planner", output: { goals: ["g1"] } },
    { model: "critic", output: { outcome: "clean", weaknesses: [], critique_report: "no issues" } },
    { model: "fixer", output: { resolution: "fixed" } },
  ];
}

/** Critique reports `blocked` → the workflow routes to human_review. */
export function blockedRules(): FakeRule[] {
  return [
    { model: "planner", promptIncludes: "Write the plan", output: { plan_doc: "# The Plan" } },
    { model: "planner", output: { goals: ["g1"] } },
    { model: "critic", output: { outcome: "blocked", weaknesses: [], critique_report: "stuck" } },
  ];
}

/** Write a stateId → definition map as nested `.json` files under a dir. */
export function writeWorkflowFiles(dir: string, files: Record<string, unknown>): void {
  for (const [stateId, def] of Object.entries(files)) {
    const file = join(dir, ...stateId.split("/")) + ".json";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(def, null, 2) + "\n", "utf8");
  }
}
