/**
 * A RUN's policy, built one way for every host that starts one (DESIGN §10.1, decision 0007).
 *
 * The app's `startRun` and the `jaira` CLI both start workflow runs, and what governs a run — the
 * project's command policy, the executor's scope floor, the size above which a produced payload asks,
 * the per-run memory of answered parts, the audit — must not depend on which of them started it. It
 * did: the CLI handed `executeWorkflow` no policy at all, so a CLI run judged no line, bounded no
 * place and audited nothing. So the one recipe lives here and both hosts call it; what differs
 * between them is only who answers an `ask` (the approval hub the host builds) and where the audit
 * lands (the host's `onDecision`).
 */
import type { JsonValue } from "@declarative-ai/exec";
import type { ExecPolicy } from "@declarative-ai/permissions";
import type { JairaConfig, Scope } from "@jaira/shared";
import { compilePolicy, type CommandGrants, type JairaPolicy, type PolicyAuditEntry } from "./policy";
import { claudePermissionSettings, compileClaudeScopeRules } from "./tools";

/** The parts of a project's configuration a run's policy is compiled from. */
export type RunPolicyConfig = Pick<JairaConfig, "policy" | "execEnvironment" | "executors" | "artifacts">;

/**
 * The scope floor an executor declares — §7's "the screen that configures an executor bounds it".
 *
 * Read off the executor TREE rather than a key of its own, because what an executor may touch is a
 * property of that executor and inherits down its nodes like every other node setting. The topmost
 * declaration wins here; a per-route narrowing is the tree's own business.
 *
 * `undefined` when nobody declared one, which is what keeps a project that has never heard of scopes
 * paying nothing at all.
 */
export function scopeFloorOf(config: Pick<JairaConfig, "executors">): readonly Scope[] | undefined {
  for (const node of Object.values(config.executors ?? {})) {
    const scopes = (node as { scopes?: Scope[] }).scopes;
    if (Array.isArray(scopes) && scopes.length > 0) return scopes;
  }
  return undefined;
}

/**
 * The scope floor compiled into a delegated agent's OWN permission rules, as the `securityFloor`
 * `buildPromptExecutor` folds over every prompt call — or `undefined` when there is no floor.
 *
 * Without it a workflow's states bounded nothing but JaiRA's own callbacks: the agent's built-ins ran
 * under its default posture.
 */
export function securityFloorOf(config: Pick<JairaConfig, "executors">, root: string | undefined): Record<string, JsonValue> | undefined {
  const floor = scopeFloorOf(config);
  if (floor === undefined) return undefined;
  // `claudePermissionSettings` returns the providerOptions VALUE — the key is this caller's.
  const rules = claudePermissionSettings(compileClaudeScopeRules(floor, { root }));
  return Object.keys(rules).length > 0 ? { providerOptions: rules as JsonValue } : undefined;
}

export interface RunPolicyOptions {
  /** What a relative scope glob and a relative call path resolve against: the run's workspace. */
  workspaceRoot?: string | undefined;
  /** Every decision, for the audit trail — the host's `command_log` writer. Absent ⇒ unaudited. */
  onDecision?: ((entry: PolicyAuditEntry) => void) | undefined;
  /** The run's remembered part answers — `ApprovalHub.grants(taskId)`. */
  grants?: CommandGrants | undefined;
}

/**
 * The project's policy for one run: authored rules, the built-ins, the executor's scope floor on
 * `scopeOf`, the artifact size above which a payload asks, and the run's remembered answers.
 *
 * No toolset is passed: the engine hands each state's own lowered block to the gate and the narrowing
 * at the moment of decision, so a run's policy stays the project's (see `CompilePolicyOptions.toolset`).
 */
export function compileRunPolicy(config: RunPolicyConfig, options: RunPolicyOptions = {}): ExecPolicy {
  const floor = scopeFloorOf(config);
  return compilePolicy(config.policy as JairaPolicy, {
    execEnv: config.execEnvironment,
    ...(options.onDecision !== undefined ? { onDecision: options.onDecision } : {}),
    // Absent ⇒ no narrowing, and nothing pays for the feature.
    ...(floor !== undefined ? { scopes: floor } : {}),
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    // The number is artifact configuration; turning it into an escalation is the policy's job.
    askAboveBytes: config.artifacts.askAboveBytes,
    ...(options.grants !== undefined ? { grants: options.grants } : {}),
  });
}
