/**
 * What a state in a run IS, for the one header every state wears — the letterhead, and its alarmed
 * form.
 *
 * Every state wears a letterhead, and the letterhead says which kind it is: a conversation, a value
 * worked out from other states' outputs, a function that put a question to a person, a transition
 * parked on a gesture. It puts on the filled title block exactly while the state is running, asked,
 * waiting or broken, and reverts the moment it settles — so the loud form always means NOW rather
 * than "this kind of thing", and nobody chooses it, so nobody can choose wrong.
 *
 * The kinds, their words and icons, the tone, and which instance is asking are here; the universal
 * `SessionBands` and `RunTranscript` (`packages/universal/src/components/panel/`) draw them.
 */
import type { InstanceNode } from "@jaira/shared/browser";
import type { PATHS } from "./iconPaths";

/**
 * What a state IS — the four answers that used to be one card and one sentence.
 *
 * `conversation` is a prompt operation: a model was called and said things. `computed` is a state
 * with no operation at all, whose every output is an expression over values it was handed.
 * `asked` is a function operation, which is how a component is put in front of a person — unless
 * the workflow's shape says its functions ask nobody anything (`InstanceNode.plainCall`), and then it
 * is `called`: a call, drawn as what it ran and what came back (an events automation). `waiting`
 * is a transition parked on a gesture (`on_user_event`) — not an instance at all, which is why this
 * is a kind rather than a property of a node.
 */
export type SurfaceKind = "conversation" | "computed" | "called" | "asked" | "waiting";

/**
 * How loudly the header speaks — see the note above on why this is derived and never chosen.
 *
 * `undefined` is the letterhead: a rule under a line of type, and the resting state of everything.
 */
export type HeaderTone = "accent" | "amber" | "red" | undefined;

/** The verb each kind's heading opens with. A `conversation` has none — it is the unmarked case. */
export const KIND_WORD: Record<Exclude<SurfaceKind, "conversation">, string> = {
  computed: "computed",
  called: "called",
  asked: "asked of you",
  waiting: "waiting on you",
};

/** One glyph per kind — only ever drawn beside {@link KIND_WORD}, never alone. */
export const KIND_ICON: Record<Exclude<SurfaceKind, "conversation">, keyof typeof PATHS> = {
  computed: "sigma",
  called: "sigma",
  asked: "comment",
  waiting: "clock",
};

/**
 * Which kind a node is — read off the projection, never inferred from an absence.
 *
 * `projection.ts` sets `node.operation` on `operation.started` and on nothing else, so an instance
 * that dispatched always has one and an instance that did not never does. That is the same field the
 * error routing turns on (see `ranAnOperation` in `sessionBands.ts`), which is what keeps the two
 * from being able to disagree about what a state is.
 *
 * A COMPOSITE is undefined rather than any kind. Its silence is the ordinary silence of a state that
 * only orchestrates, `piecesOf` already declines to give it a piece, and a heading over it would
 * name something with no panel to head.
 *
 * `waiting` is never returned here. A parked transition is not the instance's own business — it sits
 * between states, and what names it is a `UserEventRequest` from the hub rather than a node status.
 * `projection.ts` sets `waiting_for_user` for both an interactive operation AND a guard's
 * `call.waiting`, so the two are indistinguishable once projected and reading it here would make an
 * asked state and a parked transition the same thing.
 */
export function surfaceKindOf(node: InstanceNode): SurfaceKind | undefined {
  if (node.children.length > 0) return undefined;
  if (node.operation === undefined) return "computed";
  if (node.operation.kind !== "function") return "conversation";
  // A function the workflow's shape says asks nobody anything — an events automation's `notify` and
  // `start_task` — is a CALL: what it ran, drawn as the calls a computed state made, never a gate.
  return node.plainCall === true ? "called" : "asked";
}

/**
 * Whether this state is asking a question RIGHT NOW — where a parked gate is drawn.
 *
 * A function operation that started and never settled, which is exactly what a parked gate leaves in
 * the projection: `operation.started` fires when the call is dispatched and neither terminal event
 * has arrived. Nothing else in a run looks like that — a settled function reads `completed` or
 * `failed`, and a prompt is not `function`.
 *
 * Deliberately NOT `status === "waiting_for_user"`. The projection only reaches that word when it
 * was handed the workflow's SHAPE (which functions are interactive), so a view that fetched the tree
 * without one would silently place nothing; and the same status is set for a transition parked on
 * `on_user_event`, which is not an instance's own business and has no panel here to be drawn in.
 *
 * ⚠️ One open gate per state, which is all a state can have: SPEC §7.1 gives an instance one
 * operation. Two gates open at once in one TASK — concurrent `async` children — are two different
 * instances, so each still lands in its own panel; what the caller must not do is hand the same
 * request to a tree where more than one instance matches, which for one task's tree cannot happen
 * while each parked call belongs to a distinct instance.
 */
export function isAsking(node: InstanceNode): boolean {
  return surfaceKindOf(node) === "asked" && node.operation?.status === "running";
}

/** Whether this subtree holds a state that is asking right now — see {@link isAsking}. */
export function hasAsking(node: InstanceNode): boolean {
  return isAsking(node) || node.children.some(hasAsking);
}

/**
 * WHICH instance is asking — the same walk, returning the state rather than a yes.
 *
 * Every surface that draws a parked gate needs this and each of them was deriving it separately or
 * not at all. The letterhead's tint needs it (a canceled instance still holding a live question is
 * not a settled state — see `headerToneOf`), the run index needs it for the same reason, and the
 * conversation already needed it to decide which panel the question goes in.
 *
 * A pairing, not a lookup: `pending_interactions` records the component and the task, never the
 * instance, so nothing in the store says which state a surviving question belongs to. What says it
 * is the tree — exactly one instance has a function operation that dispatched and never settled —
 * which is why this is only ever asked when the hub is actually holding a request. The FIRST such
 * instance, since SPEC §7.1 gives an instance one operation and one task's tree cannot hold two
 * parked calls on one state.
 */
/**
 * The instance whose CALL is running and which has no running child — where an agent that asks is
 * asking from. Deepest first, since a running composite's own call is never the one talking.
 */
export function runningLeafOf(nodes: readonly InstanceNode[]): string | undefined {
  for (const node of nodes) {
    if (node.superseded) continue;
    const inside = runningLeafOf(node.children);
    if (inside !== undefined) return inside;
    if (node.status === "running" && node.operation?.status === "running") return node.instanceId;
  }
  return undefined;
}

export function askingInstanceOf(nodes: readonly InstanceNode[]): string | undefined {
  for (const node of nodes) {
    if (isAsking(node)) return node.instanceId;
    const inside = askingInstanceOf(node.children);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/**
 * How loud a node's header is, from its own status and its operation's.
 *
 * Order is the whole rule, and it is failure first: a state whose call errored is the thing somebody
 * opened a failed run to find, and it stays red whatever else is true of it.
 *
 * ⚠️ The two statuses can DISAGREE, and run 11 is the case. Its gate dispatched (`operation.started`
 * with no completion, so `operation.status` is still `running`) and then the run was canceled, so
 * `node.status` is `canceled`. Reading the operation alone would draw that as a live question
 * somebody could still answer. The instance is asked first, which is what makes the panel say
 * "never answered" instead.
 *
 * A CANCELLATION is not a failure. Somebody pressed Stop; nothing went wrong, and a red bar over it
 * would be the run accusing the person who stopped it.
 */
export function headerToneOf(node: InstanceNode, kind: SurfaceKind | undefined, asking = false): HeaderTone {
  if (node.status === "failed" || node.operation?.status === "failed") return "red";
  /**
   * A QUESTION STILL ON OFFER outranks how the instance around it ended.
   *
   * This is the close-and-reopen case, and the two lines below swallow it without this one. Shutting
   * the app stops the machine, so the gate's instance is terminated `canceled` with an `endedAt` on
   * it — while the question itself survives in `pending_interactions` and is seeded straight back
   * into the hub on the next start (see `InteractionHub.seed`). The run reopened with the gate drawn
   * and answerable under a letterhead in the resting grey of a state that had finished: the one
   * header on the page actually waiting on somebody was the only one not saying so.
   *
   * ⚠️ `asking` is a fact the CALLER holds, and it cannot be re-derived here. {@link isAsking} says
   * the operation never settled, which is true of a surviving question AND of run 11 — a gate that
   * dispatched and was then canceled with the run, leaving nothing behind to answer. Those two draw
   * differently and the node cannot tell them apart, because what separates them is whether the hub
   * is holding a request. So the surface that has the hub's answer passes it, and the default is the
   * conservative one: no question on offer, and the instance's own ending decides.
   *
   * AMBER rather than accent. Accent is the machine working; amber is the app waiting on a person,
   * which is already what a parked transition's sheet (`WaitingOn`) and the board's
   * `waiting_for_user` badge use. A gate is that same fact in a different place, and three
   * vocabularies for one state is how a reader learns to ignore all of them.
   */
  if (asking && isAsking(node)) return "amber";
  if (node.status === "canceled") return undefined;
  if (node.endedAt !== undefined) return undefined;
  // Still open: asking is accent whether or not the projection sharpened it to `waiting_for_user`,
  // and so is a model that is still writing.
  if (kind === "asked" || node.operation?.status === "running") return "accent";
  return undefined;
}

/**
 * Where a parked transition wants the task moved, when a gesture can satisfy it at all.
 *
 * `options.to_state`, which the hub fills in from the rule's own `to` when the author left it out
 * (see `optionsOf` in `userEvents.ts`). Read from the REQUEST and never re-derived from the workflow
 * file: a second reader of the same expression language is how two parts of one app come to disagree
 * about which column a card belongs in, and the hub is the one that already knows.
 *
 * ABSENT is a real answer and not a missing field. A rule going to a `terminate.*` pseudo-state ends
 * the run rather than moving the task, so there is no column to drop on — the hub declines to claim
 * one, and a surface that offered "Advance to…" anyway would be promising a move nothing can make.
 */
export function advanceTargetOf(request: { options: Record<string, unknown> }): string | undefined {
  const to = request.options["to_state"];
  return typeof to === "string" && to.length > 0 ? to : undefined;
}
