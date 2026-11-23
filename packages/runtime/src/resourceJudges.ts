/**
 * A LIST filtered to what its set allows (decision 0023 §3.1, amended 2026-11-23): what a listing tool
 * (`ToolSpec.lists`) asks of the set its call is decided under, row by row, and how it asks the person
 * about the rows that set asks about. The judge is the compiled policy's (`compilePolicy` registers it
 * against its `scopeOf`); here so a tool can reach it through its services without the policy module.
 */
import type { FunctionInputs } from "@declarative-ai/exec";
import type { AuthoredPermissions, ExecPolicy, ToolGate } from "@declarative-ai/permissions";
import type { PermissionsDecl, ResourcePlaces } from "@jaira/shared";

/**
 * The block a tool's call is decided under, as its services carry it: the host's word on the operation
 * NOW (`ExecPolicy.permissionsOf`, at the call's dispatch site), else the operation's own block.
 */
export function blockNowOf(policy: ExecPolicy | undefined, authored: unknown, scope?: { instanceId: string }): PermissionsDecl | undefined {
  const stated = authored !== null && typeof authored === "object" ? (authored as PermissionsDecl) : undefined;
  // The engine's own reading (`blockNow`). Its `sessionId` is the ledger's key, which a tool's services
  // do not carry; JaiRA's `permissionsOf` reads the instance alone.
  const now =
    policy?.permissionsOf !== undefined && scope !== undefined
      ? policy.permissionsOf({ sessionId: scope.instanceId, instanceId: scope.instanceId }, stated as AuthoredPermissions | undefined)
      : stated;
  return now !== null && typeof now === "object" ? (now as PermissionsDecl) : undefined;
}

/** What a set says about one resource a tool would show: shown, asked about, or left out. */
export interface ResourceVerdict {
  mode: "allow" | "ask" | "deny";
  /** The place that decided, `owner=user` where it was of another kind than the tool's own. */
  place?: string;
}

/** What a set says about the rows a list would show. */
export interface ResourceJudgement {
  verdicts: ResourceVerdict[];
  /**
   * True when nothing on the tool's line allows — its loosest answer asks — so the gate asked about the
   * call before it ran, and a row that asks was answered with it.
   */
  answeredByGate: boolean;
}

export const RESOURCE_JUDGES = new WeakMap<object, (block: PermissionsDecl | undefined, tool: string, resources: readonly ResourcePlaces[]) => ResourceJudgement | undefined>();

/**
 * What the set a call is decided under says about each resource a LISTING tool would show
 * (`ToolSpec.lists`): its tool's line answered for each row's places, every kind's (`resolveResource`)
 * — or `undefined` when the line decides by no place, so the gate's mode was the whole answer and
 * nothing is filtered. `ctx` is the call's services: its compiled policy, its block and its dispatch site.
 */
export function judgeResources(ctx: { policy?: ExecPolicy; authored?: unknown; scope?: { instanceId: string } } | undefined, tool: string, resources: readonly ResourcePlaces[]): ResourceJudgement | undefined {
  const judge = ctx?.policy?.scopeOf !== undefined ? RESOURCE_JUDGES.get(ctx.policy.scopeOf) : undefined;
  return judge?.(blockNowOf(ctx?.policy, ctx?.authored, ctx?.scope), tool, resources);
}

/** A list's rows the set asks about, as the gate is asked to show them. */
export const REVEALS = new WeakMap<object, { tool: string; shown: readonly string[]; noun: string }>();

/**
 * Asks the person, through the call's gate, whether a list may show the rows its set asks about —
 * once for all of them, named in the question (`the permission set asks about 3 more processes:
 * python (user), …`). `undefined` when there is no gate to ask through, and the rows are left out.
 */
export async function askToShow(gate: ToolGate | undefined, tool: string, shown: readonly string[], noun: string): Promise<boolean | undefined> {
  if (gate === undefined || shown.length === 0) return undefined;
  const input: Record<string, unknown> = { show: shown.length };
  REVEALS.set(input, { tool, shown, noun });
  return (await gate.check({ name: tool }, input as FunctionInputs)).allow;
}

