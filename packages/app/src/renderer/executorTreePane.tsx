/**
 * The executor TREE, rendered — every level expanded, with only what changed written down.
 *
 * The two halves of that sentence are the design:
 *
 *  - **Expanded.** The whole resolved tree is on screen — the operation node, its function half, the
 *    router, and a card per route — because the point of configuring a composition is being able to
 *    SEE it. A screen that showed only what the file happens to state would show almost nothing, and
 *    the tree that actually runs would stay invisible.
 *  - **Minimal.** Every write goes through `pin`, which stores exactly the field that changed. So the
 *    file stays a few lines while the screen stays complete, and a route derived today is still
 *    derived tomorrow — which is what lets a newly-installed agent appear by itself.
 *
 * Every value is therefore one of two things, and the screen says which: DERIVED (adaptive, follows
 * what is available) or PINNED (stated here, and it will not move again). That distinction is the
 * one a settings screen over an adaptive default has to make, and it is what `Field`'s "set here"
 * marker means throughout.
 */
import { useState, type JSX } from "react";
import {
  EXECUTOR_STEPS,
  EXECUTOR_STEP_ORDER,
  BUILTIN_FUNCTIONS,
  executorNode,
  isPinned,
  parseFunctionRule,
  pin,
  type ExecutorStepName,
  type JairaExecutorSteps,
  type JairaAgentNode,
  type JairaOperationNode,
  type JairaPromptNode,
  type JairaProviderNode,
  type JairaRouterNode,
} from "@jaira/shared/browser";
import { Disclosure, Field, FieldGrid, Level, SelectInput, TextArea, TextInput } from "./controls";
import { LlmConfigForm, summariseLlmConfig, type LlmConfigDoc } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";

export interface ExecutorTreeProps {
  /** The resolved tree — every level present, derived from what is available. */
  resolved: JairaOperationNode;
  /** What the layer being edited actually STATES. Everything else is derived. */
  overlay: JairaOperationNode | undefined;
  locked: boolean;
  /** Agent runtimes this project configures — reachable as functions, so they belong in the dropdown. */
  agents: string[];
  /** Write a new overlay. The caller persists it; this only ever produces one via `pin`. */
  onOverlay: (next: JairaOperationNode) => void;
}

export function ExecutorTree({ resolved, overlay, locked, agents, onOverlay }: ExecutorTreeProps): JSX.Element {
  // The built-ins JaiRA itself registers, plus every agent runtime this project configures — an agent
  // is reachable as a FUNCTION too, under the same registry name a model prefix uses.
  const knownFunctions = [
    ...BUILTIN_FUNCTIONS,
    ...agents.map((name) => ({ name, what: "agent — delegate this state to that runtime" })),
  ];
  const set = (path: string, value: unknown): void => onOverlay(pin(overlay, path, value));
  const pinned = (path: string): boolean => isPinned(overlay, path);
  const ctx = { locked, set, pinned };

  return (
    <div className="cfg-stack">
      <NodeBanner kind="operation" />
      <Level
        title="Functions"
        hint={executorNode("function")!.hint}
        depth={1}
      >
        <FunctionNode node={resolved.function ?? {}} ctx={ctx} known={knownFunctions} />
      </Level>
      <Level title="Prompts" hint="How a prompt state is answered." depth={1}>
        <PromptNode node={resolved.prompt ?? { kind: "router" }} path="prompt" ctx={ctx} />
      </Level>
      <StepStack path="" steps={resolved.steps} label="Around the whole executor" ctx={ctx} />
    </div>
  );
}

interface Ctx {
  locked: boolean;
  set: (path: string, value: unknown) => void;
  pinned: (path: string) => boolean;
}

/** What this level IS, and which upstream class it builds. */
function NodeBanner({ kind }: { kind: string }): JSX.Element {
  const spec = executorNode(kind)!;
  return (
    <div className="cfg-node-banner">
      <span className="cfg-node-kind">{spec.title}</span>
      <code className="cfg-param">{spec.builds}</code>
      <span className="cfg-hint">{spec.hint}</span>
    </div>
  );
}

/**
 * The function half.
 *
 * Which functions EXIST is not settable here and the screen says so: a workflow's states decide what
 * has to be registered, and the registry is assembled per run from what they name. What IS settable
 * is which of them this executor may reach.
 */
function FunctionNode({
  node,
  ctx,
  known,
}: {
  node: NonNullable<JairaOperationNode["function"]>;
  ctx: Ctx;
  known: Array<{ name: string; what: string }>;
}): JSX.Element {
  const rules = node.rules ?? [];
  const setRules = (next: string[]): void => ctx.set("function.rules", next.length > 0 ? next : undefined);

  return (
    <div className="cfg-stack">
      <Field
        label="Rules"
        param="function.rules"
        hint="Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract. Empty means everything the workflow registers."
        set={ctx.pinned("function.rules")}
      >
        <RuleList rules={rules} known={known} disabled={ctx.locked} onChange={setRules} />
      </Field>
      <StepStack path="function" steps={node.steps} label="Around every function call" ctx={ctx} />
    </div>
  );
}

/**
 * An ordered list of `everything` / `nothing` / `+name` / `-name`.
 *
 * A list rather than a set of checkboxes, because the ORDER is the meaning: "everything, then not
 * run_command" and "nothing, then read_file" are both two rules, and a checkbox grid could express
 * neither without silently picking one of them.
 *
 * The name comes from a dropdown of what JaiRA itself registers, beside a free-text box — because
 * the list cannot be exhaustive: a workflow registers a sub-workflow under its own state id, and an
 * agent under whatever name its config gives it. Offering only the known ones would make the
 * common case easy and the real case impossible.
 */
function RuleList({
  rules,
  known,
  disabled,
  onChange,
}: {
  rules: string[];
  known: Array<{ name: string; what: string }>;
  disabled: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [sign, setSign] = useState<"+" | "-">("-");
  const [name, setName] = useState("");

  const replace = (index: number, rule: string): void => onChange(rules.map((r, i) => (i === index ? rule : r)));
  const move = (index: number, by: number): void => {
    const next = [...rules];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="cfg-rules">
      {rules.length === 0 ? <p className="cfg-hint">No rules — everything the workflow registers.</p> : null}
      <ol className="cfg-rule-list">
        {rules.map((rule, index) => {
          const parsed = parseFunctionRule(rule);
          const base = parsed?.kind === "everything" || parsed?.kind === "nothing";
          return (
            <li key={`${index}:${rule}`} className={`cfg-rule ${parsed?.kind ?? "bad"}`}>
              <span className="cfg-rule-index" aria-hidden="true">
                {index + 1}
              </span>
              {base ? (
                <span className="cfg-rule-text">{parsed?.kind === "everything" ? "everything" : "nothing"}</span>
              ) : (
                <>
                  <SelectInput
                    value={parsed?.kind === "deny" ? "-" : "+"}
                    options={[
                      ["allow", "+"],
                      ["deny", "-"],
                    ]}
                    disabled={disabled}
                    onChange={(v) => replace(index, `${v}${parsed?.pattern ?? ""}`)}
                  />
                  <TextInput
                    value={parsed?.pattern ?? ""}
                    mono
                    placeholder="name or pattern"
                    disabled={disabled}
                    onChange={(v) => replace(index, `${parsed?.kind === "deny" ? "-" : "+"}${v}`)}
                  />
                </>
              )}
              <button className="ghost" disabled={disabled || index === 0} onClick={() => move(index, -1)} title="earlier">
                ↑
              </button>
              <button
                className="ghost"
                disabled={disabled || index === rules.length - 1}
                onClick={() => move(index, 1)}
                title="later"
              >
                ↓
              </button>
              <button className="ghost danger" disabled={disabled} onClick={() => onChange(rules.filter((_, i) => i !== index))}>
                Remove
              </button>
            </li>
          );
        })}
      </ol>

      <div className="cfg-rule-add">
        <button className="ghost" disabled={disabled} onClick={() => onChange([...rules, "everything"])}>
          + everything
        </button>
        <button className="ghost" disabled={disabled} onClick={() => onChange([...rules, "nothing"])}>
          + nothing
        </button>
        <SelectInput
          value={sign}
          options={[
            ["allow", "+"],
            ["deny", "-"],
          ]}
          disabled={disabled}
          onChange={(v) => setSign(v as "+" | "-")}
        />
        <SelectInput
          value=""
          options={[["— pick a function", ""], ...known.map((k): [string, string] => [`${k.name} — ${k.what}`, k.name])]}
          disabled={disabled}
          onChange={(v) => {
            if (v === "") return;
            onChange([...rules, `${sign}${v}`]);
          }}
        />
        <TextInput
          value={name}
          mono
          placeholder="…or type a name / pattern"
          disabled={disabled}
          onChange={setName}
        />
        <button
          disabled={disabled || name.trim().length === 0}
          onClick={() => {
            onChange([...rules, `${sign}${name.trim()}`]);
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** A prompt node, whichever level it is. */
function PromptNode({ node, path, ctx }: { node: JairaPromptNode; path: string; ctx: Ctx }): JSX.Element {
  // A node with no kind at all is the router — the shape a fresh install gets, and the one nobody
  // should have to write down.
  if (node.kind === undefined || node.kind === "router") {
    return <RouterNode node={node as JairaRouterNode} path={path} ctx={ctx} />;
  }
  return <LeafNode node={node as JairaProviderNode | JairaAgentNode} path={path} ctx={ctx} />;
}

/** Dispatch on the model id's prefix — the routes, and what fills a state's config before that. */
function RouterNode({ node, path, ctx }: { node: JairaRouterNode; path: string; ctx: Ctx }): JSX.Element {
  const routes = Object.entries(node.routes ?? {});
  return (
    <div className="cfg-stack">
      <NodeBanner kind="router" />

      <Level
        title="Default call settings"
        depth={2}
        hint="What a state that names nothing is filled in with — applied BEFORE the prefix is read, which is what lets a default reach an agent at all."
      >
        <FieldGrid>
          <Field
            label="Default model"
            param={`${path}.defaults.model`}
            hint="A bare id routes to whatever serves that family below; prefix it to insist on one route. Empty leaves the choice to the state. The same block as Settings → Default environment."
            set={ctx.pinned(`${path}.defaults.model`)}
          >
            <TextInput
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

      <Level
        title={`Routes (${routes.length})`}
        depth={2}
        hint="Derived from everything available, so a provider or agent you set up appears here by itself. Configuring one pins only what you changed."
      >
        <div className="cfg-stack">
          {routes.length === 0 ? (
            <p className="cfg-hint warn-text">
              Nothing can answer a prompt here yet — no provider key, no local server, and no agent that
              runs. Set one up under Providers and a route appears.
            </p>
          ) : null}
          {routes.map(([prefix, child]) => (
            <RouteCard key={prefix} prefix={prefix} node={child} path={`${path}.routes.${prefix}`} ctx={ctx} />
          ))}
        </div>
      </Level>

      <StepStack path={path} steps={node.steps} label="Around every routed call" ctx={ctx} />
    </div>
  );
}

/** One route, collapsed to a line until it is opened. */
function RouteCard({
  prefix,
  node,
  path,
  ctx,
}: {
  prefix: string;
  node: JairaPromptNode;
  path: string;
  ctx: Ctx;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const derived = !ctx.pinned(path);
  return (
    <div className={`cfg-route${derived ? " derived" : ""}`}>
      <div className="cfg-route-head">
        <code className="cfg-route-prefix">{prefix}/…</code>
        <span className="cfg-hint">{summarisePromptNode(node)}</span>
        <span className={`cfg-status ${derived ? "unchecked" : "available"}`}>
          <span className="cfg-dot" aria-hidden="true" />
          {derived ? "derived" : "pinned"}
        </span>
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Configure"}
        </button>
      </div>
      {open ? (
        <div className="cfg-route-body">
          <PromptNode node={node} path={path} ctx={ctx} />
        </div>
      ) : null}
    </div>
  );
}

/** A leaf: one provider route or one agent runtime. */
function LeafNode({ node, path, ctx }: { node: JairaProviderNode | JairaAgentNode; path: string; ctx: Ctx }): JSX.Element {
  const owner = ownerOf(node);
  const isProvider = node.kind !== "agent";
  return (
    <div className="cfg-stack">
      <NodeBanner kind={isProvider ? "provider" : "agent"} />
      <FieldGrid>
        <Field
          label={isProvider ? "Provider" : "Agent"}
          param={`${path}.${isProvider ? "provider" : "agent"}`}
          hint="What actually serves the call. Derived from the route this sits under."
          set={ctx.pinned(`${path}.${isProvider ? "provider" : "agent"}`)}
        >
          <TextInput value={owner ?? ""} mono disabled placeholder="the provider path" onChange={() => undefined} />
        </Field>
        <Field
          label="Model"
          param={`${path}.model`}
          hint="As it knows it — bare, because the route's own name is already the prefix. Empty means the runtime's own default."
          set={ctx.pinned(`${path}.model`)}
        >
          <TextInput
            value={node.model ?? ""}
            mono
            placeholder="the runtime's own default"
            disabled={ctx.locked}
            onChange={(v) => ctx.set(`${path}.model`, v === "" ? undefined : v)}
          />
        </Field>
        <Field
          label="May only run"
          param={`${path}.allow`}
          hint="One pattern per line. 'opus' restricts a model; 'openrouter/*' restricts a provider. A state asking for anything else is refused before it runs."
          set={ctx.pinned(`${path}.allow`)}
        >
          <TextArea
            value={(node.allow ?? []).join("\n")}
            rows={2}
            placeholder="anything"
            disabled={ctx.locked}
            onChange={(v) => {
              const list = v.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
              ctx.set(`${path}.allow`, list.length > 0 ? list : undefined);
            }}
          />
        </Field>
      </FieldGrid>

      <Level title="Call settings" depth={3} hint="Merged under a state's own config.">
        <LlmConfigForm
          value={(node.defaults ?? {}) as LlmConfigDoc}
          disabled={ctx.locked}
          onChange={(next) => ctx.set(`${path}.defaults`, Object.keys(next).length === 0 ? undefined : next)}
        />
      </Level>

      <StepStack path={path} steps={node.steps} label="Around this route's calls" ctx={ctx} />
    </div>
  );
}

/**
 * The cross-cutting layers around ONE node.
 *
 * Numbered rather than draggable: the order is JaiRA's, because it is load-bearing — memoize
 * outermost so a hit skips everything, rate limiting inside retry so each attempt is admitted
 * separately rather than one slot being held across the whole loop and its backoff.
 */
function StepStack({
  path,
  steps,
  label,
  ctx,
}: {
  path: string;
  steps: JairaExecutorSteps | undefined;
  label: string;
  ctx: Ctx;
}): JSX.Element {
  const at = (name: string): string => (path.length === 0 ? `steps.${name}` : `${path}.steps.${name}`);
  const active = EXECUTOR_STEP_ORDER.filter((name) => steps?.[name] !== undefined);
  return (
    <Disclosure
      summary={label}
      desc={active.length === 0 ? "no layers" : active.join(" → ")}
      defaultOpen={active.length > 0}
    >
      <div className="cfg-stack">
        {EXECUTOR_STEP_ORDER.map((name, index) => {
          const spec = EXECUTOR_STEPS.find((s) => s.name === name)!;
          const on = steps?.[name] !== undefined;
          return (
            <div key={name} className={`cfg-step${on ? " on" : ""}`}>
              <div className="cfg-step-head">
                <span className="cfg-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="cfg-step-title">{spec.title}</span>
                <button
                  className="ghost"
                  disabled={ctx.locked}
                  onClick={() => ctx.set(at(name), on ? undefined : {})}
                >
                  {on ? "Remove" : "Add"}
                </button>
              </div>
              <p className="cfg-hint">{spec.hint}</p>
              <p className="cfg-hint">{spec.placement}</p>
              {on ? (
                <div className="cfg-step-body">
                  <SchemaForm
                    schema={spec.schema}
                    value={steps?.[name]}
                    onChange={(next) => ctx.set(at(name), next ?? {})}
                    ctx={{ path: at(name), disabled: ctx.locked, isSet: (p) => ctx.pinned(p) }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}

/** The call settings minus the model, which has its own field above. */
function withoutModel(defaults: Record<string, unknown> | undefined): LlmConfigDoc {
  const { model: _model, ...rest } = defaults ?? {};
  return rest as LlmConfigDoc;
}

/**
 * Which provider or agent a leaf names.
 *
 * Read from either field rather than branched on `kind`, because a route node legitimately has NO
 * kind of its own: the prefix it sits under supplies it, and resolution fills it in. Branching would
 * read the wrong field on exactly the nodes the routes map exists to let people write.
 */
function ownerOf(leaf: JairaProviderNode | JairaAgentNode): string | undefined {
  return (leaf as JairaProviderNode).provider ?? (leaf as JairaAgentNode).agent;
}

/** One line for a collapsed route. */
function summarisePromptNode(node: JairaPromptNode): string {
  if (node.kind === undefined || node.kind === "router") {
    return `router over ${Object.keys((node as JairaRouterNode).routes ?? {}).length} route(s)`;
  }
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

export type { ExecutorStepName };
