/**
 * What the executor tree (`packages/universal/src/components/settings/ExecutorTree.tsx`) works out, as
 * pure functions — the routes a router lists, what a route's collapsed line says, who a leaf names, and
 * a node's call settings without its model.
 */
import { BUILTIN_FUNCTIONS, EXECUTOR_STEP_ORDER, isPinned, pin, type JairaAgentNode, type JairaExecutorSteps, type JairaOperationNode, type JairaPromptNode, type JairaProviderNode, type JairaRouterNode } from "@jaira/shared/browser";
import type { LayerState } from "./configWriter";
import { summariseLlmConfig, type LlmConfigDoc } from "./llmConfigModel";

/** What every level of the tree writes through: the overlay, pinned one field at a time. */
export interface TreeCtx {
  locked: boolean;
  set: (path: string, value: unknown) => void;
  pinned: (path: string) => boolean;
  split?: boolean;
}

/** The tree's writer over an overlay (`ExecutorTree`, `ExecutorRoutes`). */
export function treeCtxOf(overlay: JairaOperationNode | undefined, locked: boolean, onOverlay: (next: JairaOperationNode) => void, split?: boolean): TreeCtx {
  return { locked, set: (path, value) => onOverlay(pin(overlay, path, value)), pinned: (path) => isPinned(overlay, path), ...(split !== undefined ? { split } : {}) };
}

/**
 * A row's place over one overlay path (`Field.layer`): its ↺ while the overlay pins it, which unpins
 * it so the tree derives it again. Editing the row pins what was typed.
 */
export function treeLayerOf(ctx: TreeCtx, path: string): LayerState {
  return { stated: ctx.pinned(path), disabled: ctx.locked, onInherit: () => ctx.set(path, undefined) };
}

/** A prompt node with no kind at all is the router — the shape a fresh install gets. */
export function isRouter(node: JairaPromptNode): node is JairaRouterNode {
  return node.kind === undefined || node.kind === "router";
}

/** The top router's routes, as `[prefix, node]` — none when the prompt half is a leaf. */
export function routesOf(resolved: JairaOperationNode): Array<[string, JairaPromptNode]> {
  const router = resolved.prompt;
  return router !== undefined && isRouter(router) ? Object.entries(router.routes ?? {}) : [];
}

/**
 * Which provider or agent a leaf names — read from either field rather than branched on `kind`,
 * because a route node legitimately has NO kind of its own: the prefix it sits under supplies it.
 */
export function ownerOf(leaf: JairaProviderNode | JairaAgentNode): string | undefined {
  return (leaf as JairaProviderNode).provider ?? (leaf as JairaAgentNode).agent;
}

/** One line for a collapsed route. */
export function summarisePromptNode(node: JairaPromptNode): string {
  if (isRouter(node)) return `router over ${Object.keys(node.routes ?? {}).length} route(s)`;
  const leaf = node as JairaProviderNode | JairaAgentNode;
  const owner = ownerOf(leaf);
  const steps = EXECUTOR_STEP_ORDER.filter((s) => leaf.steps?.[s] !== undefined);
  return [
    `${leaf.kind ?? "route"} ${owner ?? "the provider path"}`,
    leaf.model ?? "its own default",
    leaf.allow ? `only ${leaf.allow.join(", ")}` : null,
    steps.length > 0 ? steps.join(" → ") : null,
    summariseLlmConfig((leaf.defaults ?? {}) as LlmConfigDoc),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The call settings minus the model, which has its own field. */
export function withoutModel(defaults: Record<string, unknown> | undefined): LlmConfigDoc {
  const { model: _model, ...rest } = defaults ?? {};
  return rest as LlmConfigDoc;
}

/** Where a node's layer `name` lives in the overlay. */
export function stepPathOf(path: string, name: string): string {
  return path.length === 0 ? `steps.${name}` : `${path}.steps.${name}`;
}

/** The layers a node has, in the order they wrap it — the disclosure's line. */
export function activeStepsOf(steps: JairaExecutorSteps | undefined): string[] {
  return EXECUTOR_STEP_ORDER.filter((name) => steps?.[name] !== undefined);
}

/** `allow`'s text box: one pattern per line. */
export function allowFromText(text: string): string[] | undefined {
  const list = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * The functions a rule can name: the built-ins JaiRA itself registers, plus every agent runtime this
 * project configures — an agent is reachable as a FUNCTION too, under the same registry name a model
 * prefix uses.
 */
export function knownFunctionsOf(agents: readonly string[]): Array<{ name: string; what: string }> {
  return [...BUILTIN_FUNCTIONS, ...agents.map((name) => ({ name, what: "agent — delegate this state to that runtime" }))];
}
