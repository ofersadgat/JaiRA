/**
 * Engine wiring: project config → provider bindings, executor registry, and
 * one workflow execution through `@ai-exec/hw`'s hierarchical-workflow
 * executor. Used by both `jaira run` (ad-hoc) and `jaira task start`.
 */
import { MapExecutorRegistry, type ExecutorRegistry, type ExecutionSpec, type InteractionPort, type Outcome } from "@ai-exec/core";
import {
  createHierarchicalWorkflowExecutor,
  llmCallBinding,
  snapshotHash,
  type Persistence,
  type ProviderBinding,
  type WorkflowBundle,
} from "@ai-exec/hw";
import { createLlmCallExecutor } from "@ai-exec/llm";
import { SchemaValidator } from "@ai-exec/services";
import type { JairaConfig } from "@jaira/shared";
import { ScriptedFakeExecutor, type FakeRule } from "./fakeExecutor";

/** Provider names referenced by `agent.provider` across a bundle's states. */
export function providerNamesOf(bundle: WorkflowBundle): string[] {
  const names = new Set<string>();
  for (const def of Object.values(bundle.states)) {
    const provider = (def.agent as { provider?: unknown } | undefined)?.provider;
    if (typeof provider === "string") names.add(provider);
  }
  return [...names].sort();
}

/**
 * Bind provider names to llm-call configs from project config. In fake mode,
 * names missing from config are auto-bound with `model = <provider name>` so
 * scripted runs work in a bare project (mirrors the ai-exec test fixtures'
 * `llmCallBinding({ model: "planner" })` convention).
 */
export function providerBindings(
  config: JairaConfig,
  bundle: WorkflowBundle,
  opts?: { fake?: boolean },
): Record<string, ProviderBinding> {
  const bindings: Record<string, ProviderBinding> = {};
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    bindings[name] = llmCallBinding(providerConfig);
  }
  for (const name of providerNamesOf(bundle)) {
    if (bindings[name] === undefined) {
      if (!opts?.fake) {
        throw new Error(`provider '${name}' is not configured in .jaira/config.json (providers.${name})`);
      }
      bindings[name] = llmCallBinding({ model: name });
    }
  }
  return bindings;
}

export function buildRegistry(fakeRules?: FakeRule[]): { registry: ExecutorRegistry; fake?: ScriptedFakeExecutor } {
  if (fakeRules) {
    const fake = new ScriptedFakeExecutor(fakeRules);
    return { registry: new MapExecutorRegistry().register(fake), fake };
  }
  return { registry: new MapExecutorRegistry().register(createLlmCallExecutor()) };
}

export interface WorkflowRunConfig {
  bundle: WorkflowBundle;
  inputs: Record<string, unknown>;
  providers: Record<string, ProviderBinding>;
  registry: ExecutorRegistry;
  interaction?: InteractionPort;
  persistence?: Persistence;
  repairTurns?: number;
  abortSignal?: AbortSignal;
}

/** Bounded output-repair default for interactive use (DESIGN §7.5). */
export const DEFAULT_REPAIR_TURNS = 2;

export async function executeWorkflow(cfg: WorkflowRunConfig): Promise<Outcome> {
  const executor = createHierarchicalWorkflowExecutor({
    providers: cfg.providers,
    persistence: cfg.persistence,
    repairTurns: cfg.repairTurns ?? DEFAULT_REPAIR_TURNS,
  });
  const spec: ExecutionSpec = {
    kind: "hierarchical-workflow",
    definition: { rootId: cfg.bundle.rootId, states: cfg.bundle.states },
    definitionHash: snapshotHash(cfg.bundle),
    inputs: cfg.inputs,
    ...(cfg.interaction !== undefined ? { interaction: cfg.interaction } : {}),
    ...(cfg.abortSignal !== undefined ? { abortSignal: cfg.abortSignal } : {}),
  };
  return executor.start(spec, { registry: cfg.registry, validator: new SchemaValidator() }).outcome;
}

/** Collapse an Outcome into the task-status vocabulary. */
export function statusOfOutcome(outcome: Outcome): "completed" | "failed" | "canceled" {
  if (!outcome.error) return "completed";
  return outcome.error.classification === "canceled" ? "canceled" : "failed";
}
