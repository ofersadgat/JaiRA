/**
 * Which renderer draws a call, and whether a view shows it (decision 0033 §2–§3).
 *
 * One registry for a program's calls (`input()`, `llm()`, `conversation_digest`, `start_task`) and a
 * model's tool calls alike, so a function looks the same wherever it is called from. It is keyed by
 * (function, role). `"*"` is stored explicitly: a function registered alone is `(function, "*")`, a
 * renderer for any function is `("*", role)`. Lookup runs
 *
 *   (function, role) → ("*", role) → (function, "*") → ("*", "*")
 *
 * and `("*", "*")` is the tool-call row, so a function nobody wrote a renderer for reads as a tool call.
 *
 * A renderer is app code; an entry here is data: which renderer, and the options bound to it — the same
 * renderer configured differently is two entries. Roles are open strings; what a role decides is
 * whether each view shows its calls, folds them or hides them, apart from which renderer draws them.
 * Hiding is presentation: the record is untouched, and the task view folds what chat hides.
 *
 * Not configurable by the person (for now): the registry is this file's, plus what a script says with
 * `renderUI` (its scopes' overrides, {@link withOverrides}).
 */
import type { JsonValue } from "@declarative-ai/json";

/** The renderers the app has. `none` draws nothing — `renderUI`'s `renderer: null`. */
export type RendererId = "conversation" | "message" | "tool" | "child-run" | "told" | "none";

/** A registry entry: a renderer, and the options bound to it. */
export interface RendererEntry {
  renderer: RendererId;
  options?: Readonly<Record<string, JsonValue>>;
}

/** The two levels of detail one run is drawn at (§1). */
export type CallView = "chat" | "task";

/** What a view does with a role's calls. */
export type Visibility = "shown" | "folded" | "hidden";

/** The explicit wildcard, for a function or a role. */
export const ANY = "*";

export interface CallRegistry {
  /** By `keyOf(function, role)`. */
  readonly entries: ReadonlyMap<string, RendererEntry>;
  /** What each view does with a role's calls; a role not listed is `"*"`'s. */
  readonly roles: ReadonlyMap<string, Readonly<Record<CallView, Visibility>>>;
  /** The role a function's calls take when nothing says otherwise — `now()` is `hidden`. */
  readonly defaultRoles: ReadonlyMap<string, string>;
}

const keyOf = (fn: string, role: string): string => `${fn}\u0000${role}`;

export interface RegistryDefinition {
  /** `[function, role, entry]`; `"*"` for either. */
  entries?: ReadonlyArray<readonly [string, string, RendererEntry]>;
  roles?: Readonly<Record<string, Readonly<Record<CallView, Visibility>>>>;
  defaultRoles?: Readonly<Record<string, string>>;
}

export function registryOf(definition: RegistryDefinition): CallRegistry {
  return {
    entries: new Map((definition.entries ?? []).map(([fn, role, entry]) => [keyOf(fn, role), entry] as const)),
    roles: new Map(Object.entries(definition.roles ?? {})),
    defaultRoles: new Map(Object.entries(definition.defaultRoles ?? {})),
  };
}

/**
 * A registry with a scope's overrides laid over it (a `renderUI` scope, §4): what the overrides name
 * replaces the base's entry for the same key; everything else is the base's. Lookup still runs its
 * order over the merged keys — the nearest scope's entries are simply the ones present.
 */
export function withOverrides(base: CallRegistry, overrides: RegistryDefinition): CallRegistry {
  const over = registryOf(overrides);
  return {
    entries: new Map([...base.entries, ...over.entries]),
    roles: new Map([...base.roles, ...over.roles]),
    defaultRoles: new Map([...base.defaultRoles, ...over.defaultRoles]),
  };
}

/** The entry that draws `fn` under `role`: (fn, role) → ("*", role) → (fn, "*") → ("*", "*"). */
export function lookup(registry: CallRegistry, fn: string, role: string = ANY): RendererEntry {
  for (const key of [keyOf(fn, role), keyOf(ANY, role), keyOf(fn, ANY), keyOf(ANY, ANY)]) {
    const found = registry.entries.get(key);
    if (found !== undefined) return found;
  }
  return TOOL;
}

/** What `view` does with `role`'s calls. A role nobody listed is shown, as `"*"` is. */
export function visibilityOf(registry: CallRegistry, role: string, view: CallView): Visibility {
  return (registry.roles.get(role) ?? registry.roles.get(ANY))?.[view] ?? "shown";
}

/** The role a call takes: the one it was given, else its function's default, else `"*"`. */
export function roleOf(registry: CallRegistry, fn: string, given?: string): string {
  return given ?? registry.defaultRoles.get(fn) ?? ANY;
}

/**
 * The function a call is of, in the registry's terms. A model's tool reaches it under its transport's
 * name (`mcp__jaira__start_task`), and a reference may carry where it lives (`user:…/confidence.ts#score`):
 * both are the function they call. A `prompt` operation is `llm`.
 */
export function functionNameOf(name: string | undefined, kind?: string): string {
  if (name === undefined || name === "") return kind === "prompt" ? "llm" : ANY;
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  const hashed = bare.includes("#") ? bare.slice(bare.lastIndexOf("#") + 1) : bare;
  return hashed;
}

const TOOL: RendererEntry = { renderer: "tool" };

/** The app's registry (decision 0033 §5). */
export const CALL_RENDERERS: CallRegistry = registryOf({
  entries: [
    [ANY, ANY, TOOL],
    ["input", ANY, { renderer: "message" }],
    ["llm", ANY, { renderer: "conversation" }],
    ["agent", ANY, { renderer: "conversation" }],
    ["start_task", ANY, { renderer: "child-run" }],
    ["workflow", ANY, { renderer: "child-run" }],
    ["notify", ANY, { renderer: "told" }],
  ],
  roles: {
    [ANY]: { chat: "shown", task: "shown" },
    hidden: { chat: "hidden", task: "folded" },
    aside: { chat: "folded", task: "shown" },
  },
  defaultRoles: { now: "hidden", random: "hidden", log: "hidden" },
});
