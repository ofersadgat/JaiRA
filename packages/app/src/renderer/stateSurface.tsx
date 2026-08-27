/**
 * ONE HEADER for every state in a run — the letterhead, and its alarmed form.
 *
 * ## Why there is only one
 *
 * There used to be two, and they disagreed. A conversation got a {@link RunCard}: a chevron, a
 * status dot, a call signature, and a body indented behind a rule. Anything that was not a
 * conversation got one sentence — `this state ran no model call, so there is no conversation to
 * show` — which four different kinds of thing collected: a value worked out from other states'
 * outputs, a function that put a question to a person, a transition parked on a gesture, and a
 * genuinely empty record. The gate was the worst of them: twenty-seven seconds spent showing
 * somebody twenty kilobytes of deliverables and three options, reported as silence.
 *
 * So every state wears a letterhead — a line of type inside the sheet's top margin with a rule under
 * it — and the letterhead says which kind it is. The card is gone, and with it the indent: the words
 * start at the sheet's own margin, which is a fifth of the width back.
 *
 * ## The heading is available BECAUSE a conversation has none
 *
 * `sessionPanels.tsx` removed the bar that used to run across the top of a session's sheet — "a
 * header inside the border made every conversation open with a strip of chrome before its first
 * word". That removal is what leaves a heading free to mean something here rather than being
 * decoration on top of a heading.
 *
 * ## The title block is a STATE, not a taste
 *
 * A letterhead puts on a filled bar to the sheet's own edges — the title block — exactly while the
 * state is {@link running}, {@link asked}, {@link waiting} or broken, and reverts the moment it
 * settles. So the loud form always means NOW rather than "this kind of thing", and nobody chooses
 * it, so nobody can choose wrong. An earlier revision made it an Appearance preference; a preference
 * that can switch a settled computation into the loud form is a preference for lying about the run.
 *
 * ⚠️ **Tint only.** No pulse, no motion. The liveness of a running state is carried by the words
 * under it ("writing…"), which is a thing that stops.
 *
 * ⚠️ **No `width` anywhere on the header.** See `.lh` in `styles.css`: a `<button>` sizes
 * `width: auto` as fit-content, so a title block with the negative margins that bleed it to the
 * sheet edges shrank to its text — and `width: 100%` is measured against the CONTENT box, which put
 * it a padding short on the right. `align-items: stretch` does the sizing instead, which means the
 * header's own PARENT has to be the column flex box: `.st-block`, not `.sb-body`. That is a real
 * distinction and it was got wrong — `align-self: stretch` is a request made of the parent, and a
 * plain block container has no axis to answer it on, so the rule stopped in the middle of the sheet
 * and read as an underline instead of the head of a page.
 */
import type { JSX, ReactNode } from "react";
import type { InstanceNode } from "@jaira/shared/browser";
import { Icon, type PATHS } from "./icons";

/**
 * What a state IS — the four answers that used to be one card and one sentence.
 *
 * `conversation` is a prompt operation: a model was called and said things. `computed` is a state
 * with no operation at all, whose every output is an expression over values it was handed.
 * `asked` is a function operation, which is how a component is put in front of a person. `waiting`
 * is a transition parked on a gesture (`on_user_event`) — not an instance at all, which is why this
 * is a kind rather than a property of a node.
 */
export type SurfaceKind = "conversation" | "computed" | "asked" | "waiting";

/**
 * How loudly the header speaks — see the note above on why this is derived and never chosen.
 *
 * `undefined` is the letterhead: a rule under a line of type, and the resting state of everything.
 */
export type HeaderTone = "accent" | "amber" | "red" | undefined;

/** The verb each kind's heading opens with. A `conversation` has none — it is the unmarked case. */
const KIND_WORD: Record<Exclude<SurfaceKind, "conversation">, string> = {
  computed: "computed",
  asked: "asked of you",
  waiting: "waiting on you",
};

/** One glyph per kind — only ever drawn beside {@link KIND_WORD}, never alone. */
const KIND_ICON: Record<Exclude<SurfaceKind, "conversation">, keyof typeof PATHS> = {
  computed: "sigma",
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
  return node.operation.kind === "function" ? "asked" : "conversation";
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
export function headerToneOf(node: InstanceNode, kind: SurfaceKind | undefined): HeaderTone {
  if (node.status === "failed" || node.operation?.status === "failed") return "red";
  if (node.status === "canceled") return undefined;
  if (node.endedAt !== undefined) return undefined;
  // Still open: asking is accent whether or not the projection sharpened it to `waiting_for_user`,
  // and so is a model that is still writing.
  if (kind === "asked" || node.operation?.status === "running") return "accent";
  return undefined;
}

/** What a red header calls the failure — the two ways an operation can end badly. */
export function failureWordOf(node: InstanceNode): string {
  return node.operation?.kind === "function" ? "function threw" : "call failed";
}

/**
 * The header itself: one line, and everything a reader needs to decide whether to open it.
 *
 * `label` and `summary` are the same slot seen from two sides, and only one is ever drawn. Open, the
 * label says what this run of the state is FOR ("Judge these deliverables"); folded, the body is
 * gone and what you need instead is what is behind it ("max severity significant · 4 findings"). A
 * header that kept the label when folded would answer a question the reader has stopped asking.
 */
export function StateHeader({
  open,
  kind,
  tone,
  name,
  label,
  summary,
  meta,
  status,
  onToggle,
}: {
  open: boolean;
  /** Absent ⇒ a plain state header with no kind word — see {@link SurfaceKind}. */
  kind?: SurfaceKind | undefined;
  tone?: HeaderTone;
  /** The child key, or the last segment of the state id — see `signatureOf`. */
  name: string;
  /** What this run of it is called. Drawn only while open. */
  label?: string | undefined;
  /** What is behind the fold. Drawn only while shut. */
  summary?: string | undefined;
  /** The clock and the duration, already formatted — the header does no arithmetic. */
  meta?: string | undefined;
  /** The outcome dot, for a settled conversation. Absent ⇒ no dot, which is what a kind word replaces. */
  status?: InstanceNode["status"] | undefined;
  onToggle: () => void;
}): JSX.Element {
  const word = kind !== undefined && kind !== "conversation" ? KIND_WORD[kind] : undefined;
  const glyph = kind !== undefined && kind !== "conversation" ? KIND_ICON[kind] : undefined;
  return (
    <button
      type="button"
      className={`lh${tone !== undefined ? ` tb ${tone}` : ""}${open ? "" : " shut"}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className={`lh-chev${open ? " open" : ""}`}>
        <Icon name="chevron" />
      </span>
      {/* A glyph OR a dot, never both: the kind word beside the glyph and the outcome behind the dot
          are two answers to "what am I looking at", and a row carrying both asks the reader to
          reconcile them. A conversation has no kind to name, so the dot is what it gets. */}
      {glyph !== undefined ? <Icon name={glyph} className="lh-ico" /> : null}
      {glyph === undefined && status !== undefined ? <span className={`lh-dot ts-dot-${status}`} /> : null}
      {word !== undefined ? <span className="lh-kind">{word}</span> : null}
      <span className="lh-name mono">{name}</span>
      {open
        ? label !== undefined && label.length > 0
          ? <span className="lh-label ellip">{label}</span>
          : null
        : summary !== undefined && summary.length > 0
          ? <span className="lh-sum ellip">{summary}</span>
          : null}
      {meta !== undefined && meta.length > 0 ? <span className="lh-meta">{meta}</span> : null}
    </button>
  );
}

/**
 * One state inside a sheet: its header, and its body while it is open.
 *
 * The block exists so the CSS can space one state against the next (`.st-block + .st-block`) without
 * every caller remembering to. It is also what a fold hides: the header stays, the body goes.
 */
export function StateBlock({
  open,
  header,
  children,
}: {
  open: boolean;
  header: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={`st-block${open ? "" : " is-shut"}`}>
      {header}
      {open ? children : null}
    </div>
  );
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
