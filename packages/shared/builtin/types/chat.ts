/**
 * The settings a person chose for a conversation's message — what the Chat view's composer sends, and
 * what a program conversation's `settings` input and `input()`'s message carry.
 *
 * GENERATED from `@jaira/shared` by `packages/shared/scripts/scriptTypes.mjs` — do not edit; change
 * the types there. Import it in a workflow script with
 *
 *   import type { ChatSettings } from "$SYSTEM/types/chat";
 */

/**
 * The knobs the composer turns, on top of what the state already inherits.
 *
 * `tools` is the WHOLE list rather than an addition, because the operation format merges it by
 * replacement and `[]` is how an inherited tool is dropped. A composer showing an empty box beside an
 * operation that inherits `shell` would be offering to add a tool the call already has — and taking it
 * away if the person sent without touching it.
 */
export interface ChatSettings {
  model?: string;
  reasoning?: ReasoningDecl;
  tools?: readonly string[];
  permissions?: PermissionsDecl;
  /**
   * Whose CODE runs a tool — ours, or the agent's own built-in. By logical name.
   *
   * A separate axis from permission, deliberately, because they are separate questions and the menu
   * used to conflate them into one option called "default". "Let the agent use its own `Read`" and
   * "let the agent read without asking" are not the same statement, and the old control could only
   * express them together: picking `default` handed over the implementation AND gave up the gate.
   *
   * Access is ALWAYS the app's. A native implementation still answers to the mode beside it — what
   * changes is which code executes, not who authorized it.
   *
   * Absent for a tool ⇒ whatever the transport does by default, which for an agent is its own
   * built-in unless something displaces it.
   */
  implementations?: Record<string, ToolImplementation>;
  /**
   * The same three things as ONE permission set (`permissionSets.ts`, decision 0007) — and, since
   * decision 0023, the conversation's STACK of them (§2.6, ruling 8):
   *
   * ```json
   * { "layers": ["$/permission-sets/ask-first", "$/permission-sets/web/docs-sites"], "write_file": "allow", "glob": "unavailable" }
   * ```
   *
   * `layers[0]` is the bottom layer (the preset), the rest are the conversation's own layers (§2.6
   * step 3), and the lines written beside them are the TOOLS layer (step 5): what the composer's Tools
   * card ticks and moves, `unavailable` for a tool unticked over a layer that offers it. The bucket's
   * standing layers (`permissions.layers.<bucket>` in settings, step 2) go between the bottom and the
   * rest, and the run's answers (step 4) between the rest and the tools — neither is written here.
   * A map with no `layers` is a stack of one layer, the tools layer, over the top level's (`""`) standing
   * layers. The service follows the references (`resolveChatPermissionStack`) before a turn runs;
   * `permissionSetOfSettings` reads a map that has none.
   *
   * When present it is the whole answer and `tools`, `permissions` and `implementations` are not
   * read — where a tool may act is a place map on its line; the three fields above are what a state's
   * lowered block still arrives as.
   */
  permissionSet?: ChatPermissionSetDecl;
}

/** An effort LEVEL and/or a token BUDGET — models differ in which they accept, so both are carried. */
export interface ReasoningDecl {
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

/**
 * A `permissions` block in the shape the upstream engine takes — what a permission set LOWERS to.
 *
 * An author writes a permission set in `tools` (`permissionSets.ts`, decision 0007) and nothing here:
 * every key of this block is written by lowering (`permissionsOfPermissionSet`) and read back by
 * `permissionSetOfEnvironment`. Where a tool may act is a place map on its line (decision 0023 §3); the
 * state table `permissions.scopes` is gone and the linter refuses it. The engine still knows a `profile`
 * and a `default`; nothing JaiRA writes carries either, and the linter refuses an authored one.
 */
export interface PermissionsDecl {
  /**
   * WRITTEN BY LOWERING: each tool entry's mode as the upstream gate takes it — a function as `ask`
   * (see {@link functions}), and the shell's as `ask` whatever it says (see {@link subjects}).
   */
  tools?: Record<string, PermissionMode>;
  /**
   * The mode for a tool that is not in the vocabulary at all — see `toolVocabulary.ts`.
   *
   * NOT the same field as {@link PermissionsDecl.default}, and the difference is the whole reason a
   * delegated agent's built-ins ran ungoverned. `default` answers for a tool we KNOW and nobody has
   * set: "I have not decided about `write_file` yet". `other` answers for a name that turns up at
   * run time and is in no table — an agent's own `Glob`, a tool from somebody else's MCP server.
   * With one field those two questions had one answer, and only one of them deserves `deny`.
   */
  other?: PermissionMode;
  /**
   * WRITTEN BY LOWERING, never authored, and on EVERY lowered map (empty when no line has places): each
   * line's PLACE MAP (decision 0023 §3), by subject, as authored — `{ "read_file": { "**": "deny",
   * "docs/product": "allow" } }`, the line's own mode as its `**` where it has one, and each place's
   * decision in its authored spelling: `allow`, `ask`, `deny`, or a FUNCTION by name.
   *
   * Authored words, not gate modes, because nothing upstream reads this key: `tools` and `subjects`
   * hold gate modes only because the upstream gate reads them, and {@link functions} exists to carry
   * what a gate mode cannot say. A place's function is therefore found HERE, by the narrowing and by
   * `decideCommand`, and routed to its function the way a line's is.
   *
   * Where a line has places, this is the line: `tools` holds its LOOSEST answer for the gate (decision
   * 0023 §3.10), and `subjects` its own mode where it has one; `permissionSetOfEnvironment` reads the
   * line back from here. Always written, for the reason {@link functions} is: `permissions` merges per
   * key down the `environment` chain, and a child whose map wrote no places would otherwise judge its
   * own `read_file: "allow"` at its parent's places.
   *
   * Where the old state table `permissions.scopes` was: those tables were moved onto lines as place
   * maps (decision 0023 §3.7) and the key is gone. An executor's `scopes` are a separate FLOOR, kept.
   */
  places?: Record<string, Record<string, string>>;
  /**
   * WRITTEN BY LOWERING, never authored: a permission set's command subjects and `script`, with their modes
   * (`"git commit": "allow"`). A map-form state reaches the engine as a list and this block, and
   * these are the entries neither has a place for.
   *
   * What a shell line's PARTS are judged against (decision 0007 §4). The shell's own entry is here
   * too — `shell`, the mode for any command nothing else names — because `tools.shell` is lowered as
   * `ask`, so that no line runs before the host has read it. A subject whose entry is a function is
   * `ask` here, as it is at the gate, and named in {@link functions}.
   */
  subjects?: Record<string, PermissionMode>;
  /**
   * WRITTEN BY LOWERING, never authored, and on EVERY lowered map (empty when nothing is a function):
   * the subjects whose entry is a function, by subject — a tool, a command, `script`, `shell` or
   * `other` — each to the function's reference (`{ "shell": "smart" }`).
   *
   * Always written because `permissions` merges per key down the `environment` chain: a child whose
   * map named no function would otherwise inherit its parent's, and a line it meant to ASK about would
   * be handed to the parent's function instead.
   */
  functions?: Record<string, string>;
  /**
   * WRITTEN BY LOWERING, never authored, and only beside {@link subjects}: where those subjects came
   * from — the reference the state named its permission set by (`$/permission-sets/ask-first`), or `inline`
   * for a map written on the state (a `$ref` with siblings counts as written on the state: a sibling
   * is an entry no file holds). Written WITH `subjects` every time, so a child block that replaces
   * the one replaces the other, and an approval never names a parent's file for a child's map.
   *
   * It is how an approval can say which permission set asked, and which file "add to the permission set" edits.
   */
  source?: string;
  /** WRITTEN BY LOWERING, never authored: a permission set entry's `implementation`, by tool. */
  implementations?: Record<string, ToolImplementation>;
  /**
   * WRITTEN BY LOWERING, never authored, on every map a STATE lowers: the stack of layers the set was
   * composed from (decision 0023 §2.6) and who set each line (§2.7) — what a part's row names as its
   * layer (`CommandPart.decidedBy.layer`) and what an approval lists for "Add to". Written on every
   * such map for the reason {@link functions} is: a child's map must never name its parent's layers.
   */
  stack?: PermissionStackDecl;
}

/** Whose implementation runs — see {@link ChatSettings.implementations}. */
export type ToolImplementation = "app" | "native";

/**
 * A conversation's permission set as its SETTINGS keep it (`ChatSettings.permissionSet`, decision 0023
 * §2.6, decision 0034): a reference to one set, or its STACK — the layers by reference (`layers`, oldest
 * first; the bottom one may come as `$ref`), its unsaved layers' lines by key (`$unsaved`), and the tools
 * layer's own lines beside them. References not yet followed — the service follows them
 * (`resolveChatPermissionStack`) before a turn runs, into a {@link PermissionSetDecl}.
 *
 * Spelled out (2026-11-24) because a workflow script is handed this type (`builtin/types/chat.ts`) and
 * its run checks a value against it: typed as the followed map, a stack's `layers` was refused.
 */
export type ChatPermissionSetDecl = string | ChatPermissionStackDecl;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type PermissionMode = "allow" | "deny" | "ask";

/**
 * A stack of permission sets as a lowered block, or a turn's policy, carries it (decision 0023 §2.7).
 *
 * `layers` oldest first, each by its id (`ask-first`, `app/build`, `inline`, `tools`) and, for a
 * layer in a file, the reference it was read through. `lines` is who set each line — by normalized
 * subject, `other` included: the layer behind its own mode (`everywhere`), behind each other place, and
 * behind its implementation. Absent for a stack of one layer, which set every line.
 */
export interface PermissionStackDecl {
  layers: Array<{ id: string; reference?: string }>;
  lines?: Record<string, { everywhere?: string; places: Record<string, string>; implementation?: string }>;
}

/** {@link ChatPermissionSetDecl}'s stack. */
export interface ChatPermissionStackDecl {
  /** The layers by reference, oldest first: `layers[0]` the bottom — usually a preset. */
  layers?: string[];
  /** The bottom layer, as a set starts from another. */
  $ref?: string;
  /** The unsaved layers' lines, by the key `layers` names them by (`$unsaved/<key>`). */
  $unsaved?: Record<string, PermissionSetDecl>;
  /** The tools layer's own lines, by subject. */
  [subject: string]: PermissionSetEntryDecl | string[] | Record<string, PermissionSetDecl> | undefined;
}

/** A permission set as AUTHORED, references already followed: subject → entry. */
export type PermissionSetDecl = Record<string, PermissionSetEntryDecl>;

/**
 * One authored entry (decision 0023 §1): a line's value — a decision string or a place map — or that
 * value with the implementation chosen too, `{ "mode": …, "implementation": … }`.
 */
export type PermissionSetEntryDecl = PermissionModeDecl | { mode: PermissionModeDecl; implementation?: ToolImplementation };

/** A line's value as authored: a decision everywhere, or a place map (decision 0023 §1). */
export type PermissionModeDecl = PermissionDecisionDecl | PlaceMapDecl;

/**
 * A decision as AUTHORED (decision 0023 §1): one of the {@link PERMISSION_MODES}, {@link UNAVAILABLE},
 * or any other non-empty string, which names a function. Plain `string`, because the function's name
 * is free text; `parsePermissionSet` says which a given string is.
 */
export type PermissionDecisionDecl = string;

/**
 * A PLACE MAP as authored: place → decision (`{ "src": "allow", "infra": "deny", "**": "ask" }`). A map
 * speaks only at its places (§3.4); `**` is how it gives itself a default. `unavailable` is refused
 * inside one. A path literally named `mode` or `implementation` is written `./mode`, because an object
 * whose keys are only those two is the entry wrapper (`PermissionSetEntryDecl`). A key that is a KIND of
 * place the line's tool decides by holds that kind's own map ({@link KindMapDecl}).
 */
export type PlaceMapDecl = Record<string, PermissionDecisionDecl | KindMapDecl>;

/**
 * One KIND's rule map inside a place map (decision 0023 §3.1, amended 2026-11-23): `"owner": { "session": "allow" }`
 * on a line whose tool's resources have owners. Every kind must allow a resource.
 */
export type KindMapDecl = Record<string, PermissionDecisionDecl>;
