/**
 * Putting a workflow's own TypeScript functions into the registry the run dispatches against
 * (SPEC §7.5).
 *
 * There is almost nothing here, and that is the point the feature is built around: a resolved `.ts`
 * symbol is an ORDINARY registry entry — it carries its own capabilities, its own signature, and the
 * errors-as-data contract — so a host merges it rather than wrapping it. An earlier shape handed
 * back bare callables and left every host to invent `memoizable` for itself, correctly, from memory.
 *
 * The one thing a caller must not get wrong is ORDER: `prepare()` compiles what has been resolved,
 * and compiling is the step an approval gate happens *before*. {@link registerUserFunctions} merges
 * entries that cannot run yet; {@link prepareUserFunctions} is what makes them runnable, and its
 * caller is expected to have frozen first.
 */
import type { CapabilityRegistry, ExecServices, RegisteredFunction } from "@declarative-ai/exec";
import type { UserFunctions } from "@declarative-ai/hw";
import type { WorkflowMetrics } from "@declarative-ai/hw";

/**
 * Merge every function resolved so far into `registry`.
 *
 * Call AFTER the bundle has loaded: `UserFunctions.entries` holds what resolution actually reached,
 * so merging earlier would merge an empty map. A workflow that names no module contributes nothing
 * and this is a no-op.
 */
export function registerUserFunctions(registry: CapabilityRegistry<WorkflowMetrics>, functions: UserFunctions): number {
  let merged = 0;
  for (const [ref, entry] of functions.entries) {
    // `unknown` as the entry's ctx type is honest rather than a widening — nothing reaches a user
    // function but its parameters (§7.5.6) — so it is assignable from whatever `Ctx` this registry
    // has. The metrics parameter is the one that needs saying: an entry declares `never` because it
    // reports none, and a map of `M = WorkflowMetrics` is contravariant in exactly the wrong
    // direction for TypeScript to see that a function reporting nothing satisfies one that may.
    registry.functions.set(ref, entry as unknown as RegisteredFunction<ExecServices, WorkflowMetrics>);
    merged += 1;
  }
  return merged;
}

/**
 * Compile the resolved functions so they can actually run.
 *
 * Separate from the merge because the boundary is SPEC §7.5.5's: resolving and type-checking read
 * files, running them is a decision somebody has to have made. A caller reaches this only on the far
 * side of its approval gate.
 */
export async function prepareUserFunctions(functions: UserFunctions): Promise<void> {
  await functions.prepare();
}
