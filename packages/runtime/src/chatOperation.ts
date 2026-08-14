/**
 * What a conversation continued by hand RUNS AS.
 *
 * A person typing into a run's transcript is a child state of the instance they are reading, whose
 * operation is an ordinary prompt op. It is a child that never participates in the state machine —
 * nothing binds to its output and no transition fires from it — so none of the engine is reachable
 * from here. What IS needed is the operation that child runs under, and that is this file.
 *
 * ## Where the settings come from, and why it is not a chain walk
 *
 * The obvious implementation walks the instance path collecting `environment` blocks and merges
 * them. It would be wrong twice over. The loader has ALREADY done that merge — `LoadedState`'s
 * doc comment says so outright: "the environment chain ... the loader merged it in, which is why
 * `environment` here is the RESOLVED execution environment rather than the partial defaults layer
 * the author wrote". Redoing it here would be a second implementation of §5's merge rules, drifting
 * from the first, and it would be reading the authored layers out of a snapshot that no longer
 * contains them.
 *
 * So the settings come from ONE state: the host — the state whose conversation is being continued.
 * Its `operation.config` carries the merged call configuration (model, reasoning, and every knob hw
 * passes through), its `operation.system` the merged system prompt, and its `environment` the
 * merged tools, permissions and conversation mode.
 *
 * ## The host's own operation, not what its children inherit
 *
 * These are different values, and the difference is deliberate. A state's children inherit its
 * resolution environment and explicitly NOT its `operation`. But a hand-written message is not a
 * sibling of the host's children — it continues the host's OWN transcript, which is the thing on
 * screen. Talking to that conversation with a different model than the one that wrote it would make
 * the transcript a record of two agents pretending to be one.
 *
 * ## What the path walk is actually for
 *
 * {@link chatPlanFor} takes a PATH — the instance's own state, then its ancestors — and reads the
 * first that speaks. The case that needs it is a reader addressing the CHAT CHILD itself: the reply
 * on screen is a node in the tree, it has no operation of its own, and "reply to this" has to
 * resolve to the state whose conversation it is part of.
 *
 * It is NOT what rescues a composite, and the doc used to claim it was. A composite has no operation
 * and no session — but its ancestors are composites too, because a state that speaks has no children
 * to be an ancestor OF. The walk runs off the top and finds nothing, which is the correct answer:
 * a composite's panel shows its CHILDREN's transcripts, and which of three conversations a message
 * belongs to is a question the reader answers by picking one, not one this can guess. The caller
 * reports that there is nothing here to continue and the composer disables itself.
 */
import type { ExecEnvironmentDecl, LoadedState } from "@declarative-ai/hw";
import type { InlineFamily, NamedParameter, PromptOp } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import type { ChatPlanView, ChatSettings, PermissionsDecl, SettingOrigin, UnresolvedSetting } from "@jaira/shared";
import type { ReasoningSpec } from "@declarative-ai/llm";


/**
 * The composer's vocabulary lives in `@jaira/shared`.
 *
 * Both this module and the renderer need these shapes, and shared is the package both can see —
 * see `operationVocabulary.ts` for why they are restated there in plain terms rather than imported
 * from `llm` and `hw`. Re-exported so a consumer of the runtime need not learn where they live.
 */
export type { ChatSettings, PermissionsDecl, SettingOrigin, UnresolvedSetting } from "@jaira/shared";

/**
 * What the composer shows, and what {@link chatOperationOf} will run.
 *
 * `origin` exists because "gpt-5, inherited from `plan/draft`" and "gpt-5, because you picked it"
 * are different facts, and a control that cannot tell them apart cannot offer to reset itself.
 *
 * `live`, `effective` and `available` are omitted for one reason: both are facts about the RUNNING app — what is
 * in flight, and which route would answer a state that named no model — while this function is pure
 * over a snapshot. The service adds them.
 */
export interface ChatPlan extends Omit<ChatPlanView, "live" | "effective" | "available"> {
  /** The host's merged system prompt, carried so the continuation talks to the same agent. */
  system?: string;
  /** Everything else hw passes through — temperature, `configRef`, provider options. */
  passthrough: Record<string, JsonValue>;
  /**
   * How much transcript the call carries, inherited and not offered as a control.
   *
   * Left out of {@link ChatSettings} on purpose: §5.1 says `summary` is per SESSION rather than per
   * state, so one message switching mode would re-summarize the conversation for every state sharing
   * the stream — a per-message toggle for something that is not a per-message property.
   */
  conversation?: ExecEnvironmentDecl["conversation"];
  /**
   * Inherited settings that are expressions rather than values.
   *
   * Reported rather than silently defaulted. A composer that showed the project default model beside
   * a state whose model is `{"expr": …}` would be stating something false about what the call will
   * do, and the person would have no way to tell.
   */
  unresolved: UnresolvedSetting[];
}

/** hw's own fields on a prompt op's config bag — everything else is passed through to the call. */
const CONFIG_OWN = new Set(["model", "reasoning"]);

/** `{"expr": "…"}` — a value the loader kept for the engine to evaluate against an instance scope. */
function exprOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const expr = (value as Record<string, unknown>)["expr"];
  return typeof expr === "string" ? expr : undefined;
}

/** The config bag of a prompt op, as a record — `{}` for anything that is not one. */
function configOf(state: LoadedState | undefined): Record<string, JsonValue> {
  const op = state?.operation;
  if (op === undefined || op.kind !== "prompt") return {};
  const config = op.config as unknown;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  return config as Record<string, JsonValue>;
}

/**
 * True when this state has an operation worth continuing — see the module header on composites.
 *
 * Exported because the answer is needed TWICE and the two must agree. This function picks the state
 * whose settings a message inherits; the caller has to find the same state's INSTANCE, because that
 * is where the conversation's position and the chat child live. Two spellings of "does this state
 * speak" is how the plan came to walk out to an ancestor while the position lookup insisted on the
 * node that was clicked — and a composite could then be planned for and never sent to.
 */
export function holdsConversation(state: LoadedState | undefined): boolean {
  return state?.operation?.kind === "prompt";
}

/**
 * The plan for a conversation continued under `path`.
 *
 * `path` is the instance's own state first, then its ancestors outward. Only the first state that
 * has a prompt operation is read; the rest of the path is what lets a reader address the reply on
 * screen — a chat child, which has no operation of its own — and land on the state whose
 * conversation it belongs to. See the module header on why this does NOT rescue a composite.
 *
 * An empty result is a real answer: a run whose whole path is composites has no inherited model, and
 * the caller falls back to the project's configured default. Which is why `origin` says `unset`
 * rather than the plan simply lacking the key — "nothing was inherited" and "this was not asked
 * about" are different, and only one of them means the composer should show a default.
 */
export function chatPlanFor(path: readonly (LoadedState | undefined)[], overrides: ChatSettings = {}): ChatPlan {
  const host = path.find(holdsConversation);
  const config = configOf(host);
  const unresolved: UnresolvedSetting[] = [];

  /** An inherited value, unless it is an expression — in which case it is a reported gap. */
  const inherited = <T>(field: string, value: unknown): T | undefined => {
    const expr = exprOf(value);
    if (expr !== undefined) {
      unresolved.push({ field, expr });
      return undefined;
    }
    return value === undefined ? undefined : (value as T);
  };

  const model = inherited<string>("model", config["model"]);
  const reasoning = inherited<ReasoningSpec>("reasoning", config["reasoning"]);
  const tools = inherited<readonly string[]>("tools", host?.environment?.tools);
  const permissions = inherited<PermissionsDecl>("permissions", host?.environment?.permissions);

  const passthrough: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!CONFIG_OWN.has(key) && value !== undefined) passthrough[key] = value;
  }

  /** Nearest wins, per field — the same rule §5.2 states for the layers this one sits on top of. */
  const pick = <K extends keyof ChatSettings>(key: K, base: ChatSettings[K]): [ChatSettings[K], SettingOrigin] => {
    const over = overrides[key];
    if (over !== undefined) return [over, "override"];
    return base !== undefined ? [base, "inherited"] : [undefined, "unset"];
  };

  const [pickedModel, modelOrigin] = pick("model", model);
  const [pickedReasoning, reasoningOrigin] = pick("reasoning", reasoning);
  const [pickedTools, toolsOrigin] = pick("tools", tools);
  const [pickedPermissions, permissionsOrigin] = pick("permissions", permissions);

  return {
    settings: {
      ...(pickedModel !== undefined ? { model: pickedModel } : {}),
      ...(pickedReasoning !== undefined ? { reasoning: pickedReasoning } : {}),
      ...(pickedTools !== undefined ? { tools: pickedTools } : {}),
      ...(pickedPermissions !== undefined ? { permissions: pickedPermissions } : {}),
    },
    origin: {
      model: modelOrigin,
      reasoning: reasoningOrigin,
      tools: toolsOrigin,
      permissions: permissionsOrigin,
    },
    ...(host?.id !== undefined ? { from: host.id } : {}),
    ...(host?.operation?.kind === "prompt" && typeof host.operation.system === "string"
      ? { system: host.operation.system }
      : {}),
    passthrough,
    ...(host?.environment?.conversation !== undefined ? { conversation: host.environment.conversation } : {}),
    unresolved,
  };
}

/** A prompt op and the environment it runs under — what an executor is handed. */
export interface ChatOperation {
  /**
   * A real `PromptOp<InlineFamily>`, ready for `Executor.start`.
   *
   * Assembled here rather than by the caller because the two fields nobody thinks about — an empty
   * `input` map and a bare text `output` — are exactly the ones a hand-built op gets wrong, and a
   * prompt op missing its output slot fails inside the provider call rather than at the type.
   */
  operation: PromptOp<InlineFamily>;
  environment: ExecEnvironmentDecl;
}

/**
 * What a chat turn returns: text, and nothing the workflow can bind to.
 *
 * `text` rather than a structured contract, because a person asking a question in a transcript is not
 * declaring a schema, and holding the model to one would turn "why did that fail?" into a validation
 * error. It is also what makes the no-bindings decision safe — there is no shape here for a later
 * state to have depended on.
 */
const CHAT_OUTPUT: NamedParameter<InlineFamily> = { name: "text", kind: "text" };

/**
 * The operation one typed message runs as.
 *
 * The session is bound to an exact POSITION — the end of the transcript being read — and never to a
 * name. That is the whole of the continue-or-fork behaviour: the sessions model (DESIGN §7.3) appends when the
 * position is still the head and forks when it is not, so a reply to a conversation nothing else has
 * touched continues it, and a reply to one that has moved on branches. There is no flag here for
 * that, deliberately — `fork` is left absent, because setting it would force a branch even when an
 * append was available, and asking for a fork is a different intent from continuing a conversation.
 */
export function chatOperationOf(plan: ChatPlan, args: { message: string; session: { id: string } }): ChatOperation {
  const { settings } = plan;
  return {
    operation: {
      kind: "prompt",
      ...(plan.system !== undefined ? { system: plan.system } : {}),
      user: args.message,
      config: {
        ...plan.passthrough,
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(settings.reasoning !== undefined ? { reasoning: settings.reasoning as unknown as JsonValue } : {}),
      },
      input: {},
      output: CHAT_OUTPUT,
    },
    environment: {
      session: args.session,
      ...(plan.conversation !== undefined ? { conversation: plan.conversation } : {}),
      // Declared, and RESOLVED by the caller through `gateTools` — which puts each one under the
      // policy with the same primitive the engine uses. Declaring them without that would be worse
      // than dropping them: the model would be told about tools nothing had gated.
      ...(settings.tools !== undefined ? { tools: [...settings.tools] } : {}),
      ...(settings.permissions !== undefined ? { permissions: settings.permissions } : {}),
    },
  };
}
