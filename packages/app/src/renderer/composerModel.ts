/**
 * What the composer SAYS at rest — the facts its chips are read from, and the words on them — moved out
 * of `composer.tsx` unchanged, so the desktop's composer and the universal one (decision 0015) derive
 * them once. The cards that open from the chips stay in `composer.tsx`.
 */
import {
  declaresTools,
  DEFAULT_PERMISSION_SET_BUCKET,
  heldTools,
  matchPermissionSet,
  permissionSetBuckets,
  permissionSetLabel,
  permissionSetOfSettings,
  permissionSetsOfBucket,
  type ChatPlanView,
  type ModelParametersView,
  type PermissionSetChoice,
} from "@jaira/shared/browser";

/** The half before the first slash — who answers. Empty when the id names no route. */
export function routeOf(model: string): string {
  const cut = model.indexOf("/");
  return cut > 0 ? model.slice(0, cut) : "";
}

/**
 * The provider whose models an AGENT route can be asked for.
 *
 * `claude-cli` runs Anthropic's models on a subscription and `codex-cli` passes `-c model=…` through
 * to OpenAI's, so "which model" is a real question for both — they just have no catalog rows of their
 * own, because what they publish is a binary rather than a price list. Borrowing the provider's list
 * is what makes them choosable instead of a dead end reading "picks its own".
 */
export const ROUTE_BORROWS: Record<string, string> = {
  "claude-cli": "anthropic",
  "claude-code": "anthropic",
  "codex-cli": "openai",
};

/**
 * Everything the composer reads off the plan: the settings in force, where each came from, the map of
 * tools and what it matches, the effective values, and the route. `picked` is the bucket the person
 * chose on the Permissions card, if any.
 */
export function composerFactsOf(plan: ChatPlanView | null, picked: string | undefined) {
  const settings = plan?.settings ?? {};
  const origin = plan?.origin ?? {
    model: "unset" as const,
    reasoning: "unset" as const,
    tools: "unset" as const,
    permissions: "unset" as const,
    implementations: "unset" as const,
    permissionSet: "unset" as const,
  };
  // What this project can hold a line for, and THE MAP in force over it: one permission set, read from
  // wherever the settings keep it — the map an earlier edit here wrote, or the list, block and
  // implementations a state's own declaration arrives as. The map is what reaches the executor; a
  // permission set's name is only what to CALL it, and no match means the map is nobody's — `custom`.
  const offered = plan?.available.tools ?? [];
  const registered = offered.map((tool) => tool.name);
  const map = permissionSetOfSettings(settings).permissionSet;
  const tools = heldTools(map);
  const permissionSets: readonly PermissionSetChoice[] = plan?.available.permissionSets ?? [];
  const buckets = permissionSetBuckets(permissionSets);
  const openedOn = plan?.available.bucket ?? DEFAULT_PERMISSION_SET_BUCKET;
  const bucket = picked !== undefined && buckets.some((row) => row.path === picked) ? picked : openedOn;
  const rows = permissionSetsOfBucket(permissionSets, bucket);
  const matched = matchPermissionSet(map, permissionSets, bucket, registered);
  // Never blank. A control with nothing in it cannot be read as "this is what will happen", which is
  // the only question this row exists to answer.
  const effective = plan?.effective ?? { reasoning: "…", permissions: "…" };
  // Which CLI is answering, if one is — it changes what "default" means for both model and tools.
  const cliRoute = ROUTE_BORROWS[routeOf(effective.model ?? "")] !== undefined ? routeOf(effective.model ?? "") : undefined;
  // What the box edits: the override if there is one, else the resolved value it would replace.
  const current = settings.model ?? effective.model ?? "";
  // The route the message would go out on — whose account's allowance the number beside the model
  // reads, and whether a message sent now waits for a reset (usage-readings contract).
  const route = routeOf(effective.model ?? "") || undefined;
  // One origin for both permission cards, for the same reason: a map chosen here is the person's
  // choice on both, and otherwise each says where its half of the state's declaration came from.
  const chosen = origin.permissionSet === "override";
  const permissionsOrigin = chosen ? ("override" as const) : origin.permissions;
  const toolsOrigin = chosen ? ("override" as const) : origin.tools;
  return { settings, origin, offered, registered, map, tools, permissionSets, buckets, openedOn, bucket, rows, matched, effective, cliRoute, current, route, permissionsOrigin, toolsOrigin };
}
export type ComposerFacts = ReturnType<typeof composerFactsOf>;

/** The four chips' words at rest: the model, the thinking level, the permission set, the tools. */
export function chipValuesOf(plan: ChatPlanView | null, facts: ComposerFacts, thinking: ModelParametersView | undefined): { model: string; thinking: string; permissions: string; tools: string } {
  const { effective, tools, matched, cliRoute, settings } = facts;
  return {
    model: effective.model ?? "no model configured",
    // "—" for a model that takes no level: a level shown there would be one nothing sends.
    thinking: thinking?.reasoning === false ? "—" : effective.reasoning,
    // A MATCH, never a memory: the permission set's name while the map is exactly that permission set's,
    // `custom` the moment a line differs. A call that declares no tools has no map to
    // match, and says what decides instead — main words that, from the compiled policy.
    permissions: plan === null || tools.length === 0 ? effective.permissions : matched !== undefined ? permissionSetLabel(matched) : "custom",
    // An empty list means two different things and the chip has to say which. On a CLI
    // route with nothing declared it is the DEFAULT — leave the agent its own tools — and
    // reading "no tools" there was the chip contradicting what would run.
    tools:
      tools.length === 0
        ? cliRoute !== undefined && !declaresTools(settings)
          ? "default tools"
          : "no tools"
        : tools.length === 1
          ? tools[0]!
          : `${tools.length} tools`,
  };
}

/** The send button's tooltip: what Enter will do right now. */
export function sendTitleOf(spent: boolean, busy: boolean | undefined): string {
  return spent ? "Enter to send — it waits until the limit resets" : busy === true ? "Enter to send — this joins the turn in flight" : "Enter to send, Shift+Enter for a new line";
}

/** Whether Enter does anything right now — `joinable` names the two hosts that say no while busy. */
export function canSendOf(disabled: string | undefined, busy: boolean | undefined, joinable: boolean | undefined): boolean {
  return disabled === undefined && (busy !== true || joinable === true);
}
