import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import {
  EXECUTOR_STEPS,
  EXECUTOR_STEP_ORDER,
  executorNode,
  type JairaAgentNode,
  type JairaExecutorSteps,
  type JairaOperationNode,
  type JairaPromptNode,
  type JairaProviderNode,
  type JairaRouterNode,
} from "@jaira/shared/browser";
import { activeStepsOf, allowFromText, isRouter, knownFunctionsOf, ownerOf, routesOf, stepPathOf, summarisePromptNode, treeCtxOf, treeLayerOf, withoutModel, type TreeCtx } from "@jaira/ui/executorTreeModel";
import type { LlmConfigDoc } from "@jaira/ui/llmConfigModel";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Disclosure, Field, FieldGrid, Level } from "../form/Field";
import { FormInput, TextArea } from "../form/inputs";
import { LlmConfigForm } from "../form/LlmConfigForm";
import { SchemaForm } from "../form/SchemaForm";
import { Hint, Stack, Status } from "./bits";
import { Button } from "./Button";
import { RuleList } from "./FunctionsSections";

/**
 * `executorTreePane.tsx`, universal (decision 0015): the executor tree, every level expanded, with only
 * what changed written down — the Routes section's cards and Advanced's whole tree. Which routes there
 * are, what a card says and what a write pins are `executorTreeModel.ts`'s. The rules it adds:
 *
 *   .cfg-node-banner     row, baseline, gap 8, wraps, padding 6 9, radius --control-radius,
 *                        --tint-accent; its kind app 700 at 11/12.5, 0.06em, upper, --accent; the class
 *                        it builds a `.cfg-param`; its hint grows from 260
 *   .cfg-route           1px --line (dashed while derived), radius 8, --panel, padding 8 10, column,
 *                        gap 4; its head a row, centred, gap 8, wraps: the prefix data 600 at 12/12, a
 *                        hint (grows from 200, one line), its status, Configure; its body 6 below, 9
 *                        in, a --line above
 *   .cfg-step            1px --line, radius 8, --panel-2, padding 9 11, column, gap 4, at 72%; on:
 *                        --panel, --accent 40% into --line, whole. Its head a row, centred, gap 8: the
 *                        index an 18 circle ringed --line (--accent on), app 10/12.5 --dim (--accent);
 *                        the title app 600 at 12.5/12.5, growing; its body 6 below, 9 in, a --line above
 */

export interface ExecutorTreeProps {
  resolved: JairaOperationNode;
  overlay: JairaOperationNode | undefined;
  locked: boolean;
  agents: string[];
  onOverlay: (next: JairaOperationNode) => void;
  split?: boolean;
}

export function ExecutorTree({ resolved, overlay, locked, agents, onOverlay, split = false }: ExecutorTreeProps): JSX.Element {
  // The built-ins and every agent runtime this project configures (`executorTreeModel.ts`).
  const known = knownFunctionsOf(agents);
  const ctx = treeCtxOf(overlay, locked, onOverlay, split);
  return (
    <Stack>
      <NodeBanner kind="operation" />
      <Level title="Functions" hint={executorNode("function")!.hint} depth={1}>
        <FunctionNode node={resolved.function ?? {}} ctx={ctx} known={known} />
      </Level>
      <Level title="Prompts" hint="How a prompt state is answered." depth={1}>
        <PromptNode node={resolved.prompt ?? { kind: "router" }} path="prompt" ctx={ctx} />
      </Level>
      <StepStack path="" steps={resolved.steps} label="Around the whole executor" ctx={ctx} />
    </Stack>
  );
}

/** The top router's routes as a list of their own — Settings → Models → Routes. */
export function ExecutorRoutes({ resolved, overlay, locked, onOverlay }: Omit<ExecutorTreeProps, "agents" | "split">): JSX.Element {
  const ctx = treeCtxOf(overlay, locked, onOverlay);
  const routes = routesOf(resolved);
  return (
    <Stack card>
      {routes.length === 0 ? (
        <Hint color="warn">Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Connections and a route appears.</Hint>
      ) : null}
      {routes.map(([prefix, child]) => (
        <RouteCard key={prefix} prefix={prefix} node={child} path={`prompt.routes.${prefix}`} ctx={ctx} />
      ))}
    </Stack>
  );
}

/** What this level IS, and which upstream class it builds. */
function NodeBanner({ kind }: { kind: string }): JSX.Element {
  const t = useTokens();
  const spec = executorNode(kind)!;
  return (
    <View flexDirection="row" alignItems="baseline" gap={8} flexWrap="wrap" paddingVertical={6} paddingHorizontal={9} borderRadius={7} backgroundColor={t.v("tint-accent") as never}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.06, upper: true, color: "accent" }}>{spec.title}</Txt>
      <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }} numberOfLines={1}>
        {spec.builds}
      </Txt>
      <Hint flexGrow={1} flexShrink={1} flexBasis={260} minWidth={0}>
        {spec.hint}
      </Hint>
    </View>
  );
}

function FunctionNode({ node, ctx, known }: { node: NonNullable<JairaOperationNode["function"]>; ctx: TreeCtx; known: Array<{ name: string; what: string }> }): JSX.Element {
  const rules = node.rules ?? [];
  const setRules = (next: string[]): void => ctx.set("function.rules", next.length > 0 ? next : undefined);
  return (
    <Stack>
      {ctx.split === true ? (
        <Hint>Which functions this executor may reach is Settings → Tools → Functions, the available column.</Hint>
      ) : (
        <Field
          label="Rules"
          param="function.rules"
          hint="Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract. Empty means everything the workflow registers."
          wide
          layer={treeLayerOf(ctx, "function.rules")}
        >
          <RuleList rules={rules} known={known} disabled={ctx.locked} onChange={setRules} />
        </Field>
      )}
      <StepStack path="function" steps={node.steps} label="Around every function call" ctx={ctx} />
    </Stack>
  );
}

function PromptNode({ node, path, ctx }: { node: JairaPromptNode; path: string; ctx: TreeCtx }): JSX.Element {
  if (isRouter(node)) return <RouterNode node={node as JairaRouterNode} path={path} ctx={ctx} />;
  return <LeafNode node={node as JairaProviderNode | JairaAgentNode} path={path} ctx={ctx} />;
}

function RouterNode({ node, path, ctx }: { node: JairaRouterNode; path: string; ctx: TreeCtx }): JSX.Element {
  const routes = Object.entries(node.routes ?? {});
  const top = ctx.split === true && path === "prompt";
  return (
    <Stack>
      <NodeBanner kind="router" />
      {top ? <Hint>Its defaults and its routes are the Defaults and Routes sections above.</Hint> : null}
      {top ? null : (
        <Level title="Default call settings" depth={2} hint="What a state that names nothing is filled in with — applied BEFORE the prefix is read, which is what lets a default reach an agent at all.">
          <FieldGrid>
            <Field
              label="Default model"
              param={`${path}.defaults.model`}
              hint="A bare id routes to whatever serves that family below; prefix it to insist on one route. Empty leaves the choice to the state. The same block as Settings → Models → Defaults."
              layer={treeLayerOf(ctx, `${path}.defaults.model`)}
            >
              <FormInput
                value={typeof node.defaults?.["model"] === "string" ? (node.defaults["model"] as string) : ""}
                mono
                placeholder="left to the state"
                disabled={ctx.locked}
                onChange={(v) => ctx.set(`${path}.defaults.model`, v === "" ? undefined : v)}
              />
            </Field>
          </FieldGrid>
          <LlmConfigForm
            value={withoutModel(node.defaults)}
            disabled={ctx.locked}
            onChange={(next) => {
              const model = node.defaults?.["model"];
              const merged = { ...next, ...(model === undefined ? {} : { model }) };
              ctx.set(`${path}.defaults`, Object.keys(merged).length === 0 ? undefined : merged);
            }}
          />
        </Level>
      )}
      {top ? null : (
        <Level title={`Routes (${routes.length})`} depth={2} hint="Derived from everything available, so a provider or agent you set up appears here by itself. Configuring one pins only what you changed.">
          <Stack>
            {routes.length === 0 ? <Hint color="warn">Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Connections and a route appears.</Hint> : null}
            {routes.map(([prefix, child]) => (
              <RouteCard key={prefix} prefix={prefix} node={child} path={`${path}.routes.${prefix}`} ctx={ctx} />
            ))}
          </Stack>
        </Level>
      )}
      <StepStack path={path} steps={node.steps} label="Around every routed call" ctx={ctx} />
    </Stack>
  );
}

/** One route, collapsed to a line until it is opened. */
function RouteCard({ prefix, node, path, ctx }: { prefix: string; node: JairaPromptNode; path: string; ctx: TreeCtx }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const derived = !ctx.pinned(path);
  return (
    <View
      flexDirection="column"
      gap={4}
      paddingVertical={8}
      paddingHorizontal={10}
      borderRadius={8}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", derived ? "dashed" : "solid") as object)}
    >
      <View flexDirection="row" alignItems="center" gap={8} flexWrap="wrap">
        <Txt spec={{ voice: "data", scale: 1, weight: 600 }}>{`${prefix}/…`}</Txt>
        <Hint flexGrow={1} flexShrink={1} flexBasis={200} minWidth={0} numberOfLines={1}>
          {summarisePromptNode(node)}
        </Hint>
        <Status kind={derived ? "unchecked" : "available"}>{derived ? "derived" : "pinned"}</Status>
        <Button kind="ghost" onPress={() => setOpen((v) => !v)}>
          {open ? "Done" : "Configure"}
        </Button>
      </View>
      {open ? (
        <View marginTop={6} paddingTop={9} {...(edge(t, { top: 1 }) as object)}>
          <PromptNode node={node} path={path} ctx={ctx} />
        </View>
      ) : null}
    </View>
  );
}

function LeafNode({ node, path, ctx }: { node: JairaProviderNode | JairaAgentNode; path: string; ctx: TreeCtx }): JSX.Element {
  const owner = ownerOf(node);
  const isProvider = node.kind !== "agent";
  return (
    <Stack>
      <NodeBanner kind={isProvider ? "provider" : "agent"} />
      <FieldGrid>
        <Field
          label={isProvider ? "Provider" : "Agent"}
          param={`${path}.${isProvider ? "provider" : "agent"}`}
          hint="What actually serves the call. Derived from the route this sits under."
          set={ctx.pinned(`${path}.${isProvider ? "provider" : "agent"}`)}
        >
          <FormInput value={owner ?? ""} mono disabled placeholder="the provider path" onChange={() => undefined} />
        </Field>
        <Field label="Model" param={`${path}.model`} hint="As it knows it — bare, because the route's own name is already the prefix. Empty means the runtime's own default." layer={treeLayerOf(ctx, `${path}.model`)}>
          <FormInput value={node.model ?? ""} mono placeholder="the runtime's own default" disabled={ctx.locked} onChange={(v) => ctx.set(`${path}.model`, v === "" ? undefined : v)} />
        </Field>
        <Field
          label="May only run"
          param={`${path}.allow`}
          hint="One pattern per line. 'opus' restricts a model; 'openrouter/*' restricts a provider. A state asking for anything else is refused before it runs."
          layer={treeLayerOf(ctx, `${path}.allow`)}
        >
          <TextArea value={(node.allow ?? []).join("\n")} rows={2} placeholder="anything" disabled={ctx.locked} onChange={(v) => ctx.set(`${path}.allow`, allowFromText(v))} />
        </Field>
      </FieldGrid>
      <Level title="Call settings" depth={3} hint="Merged under a state's own config.">
        <LlmConfigForm value={(node.defaults ?? {}) as LlmConfigDoc} disabled={ctx.locked} onChange={(next) => ctx.set(`${path}.defaults`, Object.keys(next).length === 0 ? undefined : next)} />
      </Level>
      <StepStack path={path} steps={node.steps} label="Around this route's calls" ctx={ctx} />
    </Stack>
  );
}

/** The cross-cutting layers around ONE node, in their fixed order. */
function StepStack({ path, steps, label, ctx }: { path: string; steps: JairaExecutorSteps | undefined; label: string; ctx: TreeCtx }): JSX.Element {
  const t = useTokens();
  const active = activeStepsOf(steps);
  return (
    <Disclosure summary={label} desc={active.length === 0 ? "no layers" : active.join(" → ")} defaultOpen={active.length > 0}>
      <Stack>
        {EXECUTOR_STEP_ORDER.map((name, index) => {
          const spec = EXECUTOR_STEPS.find((s) => s.name === name)!;
          const on = steps?.[name] !== undefined;
          const at = stepPathOf(path, name);
          return (
            <View
              key={name}
              flexDirection="column"
              gap={4}
              paddingVertical={9}
              paddingHorizontal={11}
              borderRadius={8}
              backgroundColor={t.v(on ? "panel" : "panel-2") as never}
              opacity={on ? 1 : 0.72}
              {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? t.mix(t.v("accent"), 40, t.v("line")) : "line") as object)}
            >
              <View flexDirection="row" alignItems="center" gap={8}>
                <View width={18} height={18} borderRadius={999} alignItems="center" justifyContent="center" flexShrink={0} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : "line") as object)}>
                  <Txt spec={{ voice: "app", scale: 10 / 12.5, color: on ? "accent" : "dim" }} textAlign="center">
                    {String(index + 1)}
                  </Txt>
                </View>
                <Txt spec={{ voice: "app", scale: 1, weight: 600 }} flexGrow={1} flexShrink={1}>
                  {spec.title}
                </Txt>
                <Button kind="ghost" disabled={ctx.locked} onPress={() => ctx.set(at, on ? undefined : {})}>
                  {on ? "Remove" : "Add"}
                </Button>
              </View>
              <Hint>{spec.hint}</Hint>
              <Hint>{spec.placement}</Hint>
              {on ? (
                <View marginTop={6} paddingTop={9} {...(edge(t, { top: 1 }) as object)}>
                  <SchemaForm
                    schema={spec.schema}
                    value={steps?.[name]}
                    onChange={(next) => ctx.set(at, next ?? {})}
                    ctx={{ path: at, disabled: ctx.locked, isSet: (p) => ctx.pinned(p), setAt: (p, v) => ctx.set(p, v) }}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </Stack>
    </Disclosure>
  );
}
