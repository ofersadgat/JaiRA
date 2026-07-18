/**
 * Test fixtures: the SPEC §9 planning workflow (mirroring
 * ai-exec/packages/hw/test/fixtures.ts, which is the golden-test workflow for
 * the engine) plus helpers to materialize it as `.jaira/workflows/` files and
 * fake-executor scripts for the happy and blocked paths.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initProject } from "@jaira/persistence";
import type { FakeRule } from "../src/fakeExecutor";

export const PLAN_ID = "feature/plan";

export function specPlanningFiles(): Record<string, unknown> {
  return {
    "feature/plan": {
      label: "Planning",
      inputs: { issue: { type: "artifact", format: "markdown" } },
      outputs: {
        outcome: {
          type: "string",
          enum: ["complete", "blocked"],
          from: "children.critique.outputs.outcome === 'clean' ? 'complete' : 'blocked'",
        },
        plan_doc: { type: "artifact", format: "markdown", from: "children.context.outputs.plan_doc" },
        critique: { type: "passthrough", from: "children.critique.outputs" },
      },
      children: {
        goals: { state: "feature/plan/goals", inputs: { issue: "inputs.issue" } },
        context: {
          state: "feature/plan/context",
          inputs: { issue: "inputs.issue", goals: "children.goals.outputs.goals" },
        },
        critique: {
          state: "feature/plan/critique",
          inputs: {
            plan_doc: "children.context.outputs.plan_doc",
            severity_threshold: { value: "significant" },
          },
        },
      },
      sequence: ["goals", "context", "critique"],
      transitions: [
        { to: "terminate.success", when: "children.critique.outputs.outcome === 'clean'" },
        {
          to: "goals",
          when: "children.critique.outputs.outcome === 'needs_changes' && run.iteration < limits.max_iterations",
        },
        { to: "terminate.success", when: "children.critique.outcome === 'success'" },
      ],
      limits: { max_iterations: 3 },
    },
    "feature/plan/goals": {
      label: "Goals",
      inputs: { issue: { type: "artifact", format: "markdown" } },
      outputs: { goals: { type: "array", items: { type: "string" } } },
      agent: { provider: "planner", prompt: { template: "Extract goals from {{inputs.issue}}." } },
    },
    "feature/plan/context": {
      label: "Context",
      inputs: {
        issue: { type: "artifact", format: "markdown" },
        goals: { type: "array", items: { type: "string" } },
      },
      outputs: { plan_doc: { type: "artifact", format: "markdown" } },
      agent: { provider: "planner", prompt: { template: "Write the plan for {{inputs.issue}}." } },
    },
    "feature/plan/critique": {
      label: "Critique Plan",
      description: "Review the current plan for significant weaknesses.",
      inputs: {
        plan_doc: { type: "artifact", format: "markdown" },
        severity_threshold: {
          type: "string",
          enum: ["minor", "significant", "critical"],
          default: "significant",
        },
      },
      outputs: {
        outcome: { type: "string", enum: ["clean", "needs_changes", "blocked"] },
        weaknesses: { type: "array", items: { type: "string" } },
        critique_report: { type: "artifact", format: "markdown" },
        human_decision: {
          type: "string",
          enum: ["approve", "request_changes", "block"],
          optional: true,
          from: "children.human_review.outputs.decision",
        },
      },
      agent: {
        provider: "critic",
        conversation: { mode: "full_history" },
        prompt: {
          template:
            "Review the plan document. Find significant weaknesses at or above the configured severity threshold. Return structured output matching this state's output schema.",
        },
      },
      children: {
        address_weaknesses: {
          state: "feature/plan/critique/address_weaknesses",
          inputs: {
            plan_doc: "inputs.plan_doc",
            weaknesses: "outputs.weaknesses",
            critique_report: "outputs.critique_report",
          },
        },
        human_review: {
          state: "feature/plan/critique/human_review",
          inputs: { plan_doc: "inputs.plan_doc", critique_report: "outputs.critique_report" },
        },
      },
      transitions: [
        { to: "terminate.success", when: "children.human_review.outcome === 'success'" },
        { to: "terminate.success", when: "children.address_weaknesses.outcome === 'success'" },
        { to: "terminate.success", when: "outputs.outcome === 'clean'" },
        { to: "human_review", when: "outputs.outcome === 'blocked'" },
        { to: "address_weaknesses", when: "outputs.outcome === 'needs_changes'" },
      ],
    },
    "feature/plan/critique/address_weaknesses": {
      label: "Address Weaknesses",
      inputs: {
        plan_doc: { type: "artifact", format: "markdown" },
        weaknesses: { type: "array", items: { type: "string" } },
        critique_report: { type: "artifact", format: "markdown" },
      },
      outputs: { resolution: { type: "string" } },
      agent: { provider: "fixer", prompt: { template: "Fix the listed weaknesses." } },
    },
    "feature/plan/critique/human_review": {
      label: "Human Review",
      inputs: {
        plan_doc: { type: "artifact", format: "markdown" },
        critique_report: { type: "artifact", format: "markdown" },
      },
      outputs: {
        decision: { type: "string", enum: ["approve", "request_changes", "block"] },
        comments: { type: "string", format: "markdown", optional: true },
      },
      ui: {
        component: "choose_option",
        prompt: "Review the critique result.",
        options: ["approve", "request_changes", "block"],
      },
    },
  };
}

/** Fake rules for the happy path (critique comes back clean). Mirrors the
 *  ai-exec executor test's `happyScript`; providers auto-bind model = name. */
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

/** A fresh temp project with `.jaira/` initialized and the planning workflow installed. */
export function makePlanningProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-test-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  return dir;
}
