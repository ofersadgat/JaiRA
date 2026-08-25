/**
 * The changeset reviewer (CHANGESETS.md §8) — and the mount contract it introduces.
 *
 * The contract is a MOUNT FUNCTION, not a React element (§8.1): the caller decides where the node
 * is — a pane, a modal, a frame, a second window — and the component does not know. A component
 * that owns its own root cannot reach anything through React context, so everything it needs
 * arrives explicitly on {@link ComponentServices} (§8.2) — which is the public surface the day
 * third-party components are allowed, specified now rather than accumulated. Built-ins only for
 * now: opening the contract means workflow content gains a code-execution path into the renderer,
 * and the trust model for that is not designed here.
 *
 * Rendering is unified-inline (§8.3): side-by-side is unreadable at conversation width, and this
 * component renders wherever its host puts it. The hunks it shows are the ones stored on the
 * changeset — derived by the same strategy registry the app resolves through `diffStrategy`, so the
 * regions a decision anchors to are the regions the record pinned (§5.3), not a re-derivation that
 * could disagree.
 *
 * ## What decision 0002 changed
 *
 * The layout is a CHOOSER and a DETAIL pane rather than a stack of cards, and nothing offers a
 * decision to click: `deriveDecisions` reads the gestures. §8.3's argument for unified-inline
 * rendering survives — the two panes collapse to one below a container width, which is what lets
 * the same component sit in a conversation pane — but the CLI reviewer is now a DIFFERENT surface
 * (`packages/cli/src/changesetReviewer.ts`), sharing the derivation and not the layout.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import {
  changesetInputOf,
  changesetOf,
  deriveDecisions,
  diffStrategyFor,
  mediaKindOf,
  mediaSrcOf,
  mimeOfPath,
  reviewSettled,
  type Change,
  type Changeset,
  type DecisionKind,
  type DiffStrategy,
  type ReviewArtifactsConfig,
  type ReviewDraft,
} from "@jaira/shared/browser";
import { Icon } from "./icons";
import { ImageDiff, type ImageLayout } from "./imageDiff";
import {
  NoteComposer,
  NoteList,
  reselect,
  useHoveredNote,
  useNoteHighlights,
  type PendingSelection,
} from "./reviewNotes";

// Loaded on first expand, not with the reviewer: Monaco is megabytes, and most reviews are read and
// decided at conversation width without ever opening the pane (§8.3 — the pane is the affordance,
// not the default).
const MonacoDiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));
type DiffActions = import("./monacoDiff").DiffActions;

/**
 * What a self-mounting component may reach (§8.2). Every member optional-friendly on purpose: a
 * host that cannot supply one (the CLI has no editor to open) passes less, and the component
 * degrades rather than reaches around the contract.
 */
export interface ComponentServices {
  /** Resolve `$PROJECT/…`, `git:…`, `db://…` — the `uri:read` channel (§8.5). */
  readUri(uri: string): Promise<{ uri: string; mime: string; text: string; drifted?: boolean }>;
  /** Theme tokens, so a component matches the window. The built-ins inherit CSS variables instead. */
  theme?: Record<string, string>;
  /** The unsaved-edit map, for changes targeting open files. */
  drafts?: ReadonlyMap<string, string>;
  /** Link a change to the editor. */
  openFile?(layer: string, path: string): void;
  /** §7.1's registry, so a component renders diffs the way the app does. */
  diffStrategy(mime: string): DiffStrategy;
  /**
   * Who a note is signed as (decision 0002).
   *
   * Supplied by the HOST rather than looked up here, and for the same reason every other member is:
   * the identity comes from `git config` over IPC, and a self-mounting component reaching for the
   * bridge itself is the thing §8.2 exists to prevent. Absent ⇒ "you", which is what the CLI gets.
   */
  author?: string;
}

export interface MountContext {
  config: ReviewArtifactsConfig;
  inputs: Record<string, unknown>;
  services: ComponentServices;
  onSubmit(value: unknown): void;
}

/**
 * Mount the reviewer into a host-owned node. Returns the unmount function — the whole §8.1
 * contract: `mount(node, ctx): () => void`.
 */
export function mountChangesetReview(node: HTMLElement, ctx: MountContext): () => void {
  const root = createRoot(node);
  root.render(<ChangesetReview ctx={ctx} />);
  return () => root.unmount();
}

/** The default services a renderer host wires — `readUri` over IPC, the shared strategy registry. */
export function rendererServices(
  invoke: (
    channel: "uri:read",
    request: { uri: string; taskId?: string; project?: string },
  ) => Promise<{ uri: string; mime: string; text: string }>,
  /**
   * What `$WORKTREE` means for THIS review — the reviewed task (`pending.about`), whose worktree is
   * where the changes live. Without it the worktree anchor simply fails to resolve and the drift
   * check falls through to the layer anchors, which is right for a sync review.
   */
  scope: { taskId?: string; project?: string } = {},
): ComponentServices {
  return {
    readUri: (uri) =>
      invoke("uri:read", {
        uri,
        ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
        ...(scope.project !== undefined ? { project: scope.project } : {}),
      }),
    diffStrategy: diffStrategyFor,
  };
}

/**
 * What a change's file holds RIGHT NOW, read through the anchors a review can be about, most
 * specific first: the reviewed task's worktree, then the layer roots. An anchor that does not
 * resolve for this review (no worktree; a path outside the layer) is simply the next one's turn,
 * and nothing readable anywhere is `undefined` — the caller stays silent rather than guessing.
 */
async function readCurrent(services: ComponentServices, path: string): Promise<string | undefined> {
  for (const uri of [`$WORKTREE/${path}`, `$JAIRA/${path}`, `$PROJECT/${path}`]) {
    try {
      return (await services.readUri(uri)).text;
    } catch {
      // Not this anchor — the next may own the path.
    }
  }
  return undefined;
}

// --- the component -----------------------------------------------------------

/** What the reviewer has done to one change, before {@link deriveDecisions} reads it. */
type Draft = ReviewDraft & { content?: string };
type Drafts = Record<string, Draft>;

/**
 * The reviewer: a chooser on the left, one artifact under review on the right (decision 0002).
 *
 * This replaced a stack of cards, each with five decision buttons. Two things were wrong with that
 * shape. A fourteen-file review was fourteen scrolls of diff with no way to see the shape of the
 * set; and every card asked the reviewer to restate in a click what their gesture had already said.
 * So the set is a list you can read at a glance, and there are no decision buttons at all — X a
 * change to refuse it, comment to send it back, leave it alone to take it, and
 * {@link deriveDecisions} turns that into the five kinds.
 */
function ChangesetReview({ ctx }: { ctx: MountContext }): JSX.Element {
  const parsed = useMemo((): { changeset?: Changeset; error?: string } => {
    // By SHAPE, not by a configured name — see `changesetInputOf`, and the collision that made a
    // name impossible. The renderer and the validator ask the same question of the same inputs, so
    // what a person is shown and what their answer is judged against cannot come apart.
    const found = changesetInputOf(ctx.inputs);
    return found.changeset === undefined ? { error: found.error ?? "no input holds a changeset" } : { changeset: found.changeset };
  }, [ctx.inputs]);

  const [drafts, setDrafts] = useState<Drafts>({});
  const [reviewComment, setReviewComment] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /**
   * Which changes were actually put on screen.
   *
   * Derivation makes doing nothing mean "approved", which removes the forcing function the old
   * Submit had — it was disabled until every change was decided. This is what replaces it: not a
   * guard, a disclosure. The summary says how many nobody opened, and that number is the honest
   * cost of one-click approval (decision 0002's "Hard" consequence).
   */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  /** The change whose notes an X is about to discard — see {@link DiscardNotes}. */
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  // §3.2 surfaced BEFORE submission: which changes' files no longer hold what this review is about.
  // Read through `services.readUri` (the reviewed worktree first, then the layer anchors) and
  // compared to what the tree is supposed to hold for its state. Conservative on silence: a path
  // nothing can read gets no badge — apply-changeset re-verifies with the workspace in hand anyway.
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const changesetForDrift = parsed.changeset;
  useEffect(() => {
    if (changesetForDrift === undefined) return undefined;
    let alive = true;
    void (async () => {
      const flagged = new Set<string>();
      for (const change of changesetForDrift.changes) {
        if (change.unshowable !== undefined) continue;
        const expected =
          ctx.config.tree === "proposal" ? (change.action === "delete" ? undefined : change.after) : change.before;
        if (expected === undefined) continue;
        const current = await readCurrent(ctx.services, change.path);
        if (current !== undefined && current !== expected) flagged.add(change.id);
      }
      if (alive) setMoved(flagged);
    })();
    return () => {
      alive = false;
    };
  }, [changesetForDrift, ctx.services, ctx.config.tree]);

  // Open the first change on mount. A reviewer landing on an empty right pane has to click before
  // the component does anything, and the first file is the one they would have clicked.
  const firstId = changesetForDrift?.changes[0]?.id;
  useEffect(() => {
    if (firstId === undefined) return;
    setSelected(firstId);
    setOpened((seen) => new Set([...seen, firstId]));
  }, [firstId]);

  if (parsed.changeset === undefined) {
    return <p className="reason">This state&apos;s changeset input is malformed: {parsed.error}</p>;
  }
  const changeset = parsed.changeset;

  const draftOf = (id: string): Draft => drafts[id] ?? {};
  const set = (id: string, patch: Partial<Draft>): void =>
    setDrafts((d) => ({ ...d, [id]: { ...draftOf(id), ...(d[id] ?? {}), ...patch } }));

  const show = (id: string): void => {
    setSelected(id);
    setOpened((seen) => new Set([...seen, id]));
  };

  /**
   * X a change. When it carries comments they are DISCARDED, behind a confirm: the X is the stronger
   * statement, and a note on something that is not in the review is a note about nothing.
   */
  const exclude = (id: string): void => {
    const draft = draftOf(id);
    const speaks = (draft.comment ?? "").trim().length > 0 || (draft.notes ?? []).length > 0;
    if (speaks) {
      setConfirming(id);
      return;
    }
    set(id, { excluded: true });
  };

  const decisions = deriveDecisions(changeset.changes, drafts, reviewComment);
  const decisionOf = (id: string): DecisionKind => decisions.find((d) => d.id === id)!.decision;
  const counts = {
    keeping: decisions.filter((d) => d.decision === "merged" || d.decision === "approved").length,
    removed: decisions.filter((d) => d.decision === "reverted" || d.decision === "denied").length,
    commented: decisions.filter((d) => d.decision === "comment").length,
    unopened: changeset.changes.filter((c) => !opened.has(c.id)).length,
  };
  const going = reviewSettled(decisions);

  const submit = (level?: string): void => {
    ctx.onSubmit({
      decisions,
      ...(level === undefined ? {} : { decision: level }),
      ...(reviewComment.trim() === "" ? {} : { comments: reviewComment.trim() }),
    });
  };

  const change = changeset.changes.find((c) => c.id === selected);
  const confirmingChange = changeset.changes.find((c) => c.id === confirming);

  return (
    <div className="review-artifacts" data-testid="changeset-review">
      <div className="review-head">
        against <code>{changeset.source}</code>
      </div>

      <div className="review-body">
        <div className="review-chooser" data-testid="review-chooser">
          {changeset.changes.map((c) => (
            <ChooserRow
              key={c.id}
              change={c}
              decision={decisionOf(c.id)}
              selected={c.id === selected}
              opened={opened.has(c.id)}
              moved={moved.has(c.id)}
              notes={(draftOf(c.id).notes ?? []).length}
              onShow={() => show(c.id)}
            />
          ))}
        </div>

        <div className="review-detail" data-testid="review-detail">
          {change === undefined ? (
            <p className="empty">Pick a change on the left.</p>
          ) : (
            <ChangeDetail
              change={change}
              tree={ctx.config.tree}
              decision={decisionOf(change.id)}
              draft={draftOf(change.id)}
              onDraft={(patch) => set(change.id, patch)}
              services={ctx.services}
              moved={moved.has(change.id)}
            />
          )}
        </div>
      </div>

      <div className="review-foot">
        <label className="field">
          <span>Comment on the whole review (optional)</span>
          <textarea
            className="review-comment"
            rows={2}
            placeholder="Anything that is about the set rather than one file…"
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
          />
        </label>

        <ReviewSummary counts={counts} going={going} />

        <div className="options">
          {ctx.config.options === undefined ? (
            <button className="primary" onClick={() => submit()} data-testid="submit-review">
              {going ? "Apply the review" : "Send back with comments"}
            </button>
          ) : (
            ctx.config.options.map((option) => (
              <button
                key={option.value}
                className={option.tone === "danger" ? "danger" : "primary"}
                onClick={() => submit(option.value)}
                data-testid={`submit-${option.value}`}
              >
                {option.label ?? option.value}
              </button>
            ))
          )}
        </div>
      </div>

      {confirmingChange !== undefined ? (
        <DiscardNotes
          change={confirmingChange}
          notes={(draftOf(confirmingChange.id).notes ?? []).length}
          hasComment={(draftOf(confirmingChange.id).comment ?? "").trim().length > 0}
          onCancel={() => setConfirming(undefined)}
          onDiscard={() => {
            set(confirmingChange.id, { excluded: true, comment: "", notes: [] });
            setConfirming(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * What the review will do, in the four numbers that decide it.
 *
 * `unopened` is the one that matters and the one a summary would normally leave out. It is stated
 * because derivation approves by default, so a large review submitted without scrolling approves
 * work nobody read — and the point is to make that visible rather than to forbid it.
 */
function ReviewSummary({
  counts,
  going,
}: {
  counts: { keeping: number; removed: number; commented: number; unopened: number };
  going: boolean;
}): JSX.Element {
  return (
    <div className="review-summary" data-testid="review-summary">
      <span className="review-count">
        <Icon name="check" /> {counts.keeping} keeping
      </span>
      {counts.removed > 0 ? (
        <span className="review-count removed">
          <Icon name="cross" /> {counts.removed} removed
        </span>
      ) : null}
      {counts.commented > 0 ? (
        <span className="review-count commented">
          <Icon name="comment" /> {counts.commented} commented
        </span>
      ) : null}
      {counts.unopened > 0 ? (
        <span className="review-count unopened" title="derivation approves what you did not touch">
          <Icon name="alert" /> {counts.unopened} you did not open
        </span>
      ) : null}
      <span className="review-verdict">
        {going ? "no comments — this round is applied" : "comments left — nothing is written, the set goes back"}
      </span>
    </div>
  );
}

/** The confirm that stands between an X and somebody's words. */
function DiscardNotes({
  change,
  notes,
  hasComment,
  onCancel,
  onDiscard,
}: {
  change: Change;
  notes: number;
  hasComment: boolean;
  onCancel(): void;
  onDiscard(): void;
}): JSX.Element {
  const what = [notes > 0 ? `${notes} note${notes === 1 ? "" : "s"}` : "", hasComment ? "a comment" : ""]
    .filter((s) => s !== "")
    .join(" and ");
  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="discard-notes">
        <h3>Remove this change and discard what you wrote?</h3>
        <div className="sub">
          <code>{change.path}</code>
        </div>
        <p className="reason-note">
          It carries {what}. A change that is not in the review has nothing for a note to be about, so removing it
          throws them away.
        </p>
        <div className="options">
          <button className="danger" onClick={onDiscard}>
            Remove and discard
          </button>
          <button className="ghost" onClick={onCancel}>
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}

/** The glyph beside a change's action word. Beside, never instead — see `icons.tsx`. */
const ACTION_ICON = {
  create: "fileAdd",
  delete: "fileDel",
  update: "fileEdit",
  rename: "fileEdit",
} as const;

function actionIcon(action: Change["action"]): "fileAdd" | "fileDel" | "fileEdit" {
  return ACTION_ICON[action as keyof typeof ACTION_ICON] ?? "fileEdit";
}

/** One row of the chooser: what the change is, what it is about to become, and the X. */
function ChooserRow({
  change,
  decision,
  selected,
  opened,
  moved,
  notes,
  onShow,
}: {
  change: Change;
  decision: DecisionKind;
  selected: boolean;
  opened: boolean;
  moved: boolean;
  notes: number;
  onShow(): void;
}): JSX.Element {
  const out = decision === "denied" || decision === "reverted";
  return (
    <div className={["chooser-row", selected ? "selected" : "", out ? "excluded" : ""].join(" ").trim()}>
      <button className="chooser-pick" onClick={onShow} data-testid={`chooser-${change.id}`}>
        <span className={`change-action change-action-${change.action}`}>
          <Icon name={actionIcon(change.action)} /> {change.action.slice(0, 3)}
        </span>
        <span className="chooser-path" title={change.path}>
          {change.fromPath !== undefined ? `${change.fromPath} → ` : ""}
          {change.path}
        </span>
        {notes > 0 ? (
          <span className="chooser-notes" title={`${notes} note${notes === 1 ? "" : "s"}`}>
            <Icon name="comment" /> {notes}
          </span>
        ) : null}
        {moved ? <span className="chooser-flag" title="this file moved since the review was produced">⚠</span> : null}
        {!opened ? <span className="chooser-unopened" title="you have not opened this one">•</span> : null}
      </button>
      {/* No action here on purpose. Reverting is a decision about a change you are LOOKING at — its
          button lives in the detail header beside the diff, where the thing being refused is on
          screen. A row in a list is where you see the state, not where you change it. */}
      {out ? <span className="chooser-state">reverted</span> : null}
    </div>
  );
}

/**
 * The artifact under review — the right pane, and the same shape `review_artifact` has: the thing
 * itself, then anchored notes on it, then what will happen to it.
 *
 * The notes machinery is shared with the single-artifact gate (`reviewNotes.tsx`), which is what
 * makes "a changeset is N artifacts" true in the code rather than only in the doc. `artifact` on
 * each note is the CHANGE ID, so a note read out of a run's outputs says which file it was about.
 */
function ChangeDetail({
  change,
  tree,
  decision,
  draft,
  onDraft,
  services,
  moved,
}: {
  change: Change;
  tree: "base" | "proposal";
  decision: DecisionKind;
  draft: Draft;
  onDraft(patch: Partial<Draft>): void;
  services: ComponentServices;
  moved: boolean;
}): JSX.Element {
  const well = useRef<HTMLDivElement>(null);
  // The well is still the notes' host element; the diff inside it is Monaco's own DOM.

  /**
   * A selection inside Monaco, which the DOM hook cannot see.
   *
   * Monaco owns its selection model, so the `selectionchange` listener that serves the inline diff
   * reports nothing from in there. Moving the detail pane to Monaco therefore removed anchored
   * notes from the very view that shows the most diff — the feature stayed and its only surface
   * went away. Two sources, one composer.
   */
  const [monacoSelection, setMonacoSelection] = useState<PendingSelection | null>(null);
  const [layout, setLayout] = useState<"inline" | "split">("inline");
  const [diffActions, setDiffActions] = useState<DiffActions | null>(null);
  const [canRevertLines, setCanRevertLines] = useState(false);
  const [imageLayout, setImageLayout] = useState<ImageLayout>("overlay");
  /**
   * The two versions of a picture, when this change is one and the bytes are actually here.
   *
   * A worktree differ marks images `unshowable: "binary"` and carries no content, so most image
   * changes still have nothing to show — correctly. Where a producer DOES supply the bytes (an
   * artifact envelope, a data URI), the reviewer compares them rather than printing "binary".
   */
  const picture =
    mediaKindOf(mimeOfPath(change.path)) === "image"
      ? {
          ...(mediaSrcOf(change.before, mimeOfPath(change.path)) === undefined
            ? {}
            : { before: mediaSrcOf(change.before, mimeOfPath(change.path))! }),
          ...(mediaSrcOf(draft.content ?? change.after, mimeOfPath(change.path)) === undefined
            ? {}
            : { after: mediaSrcOf(draft.content ?? change.after, mimeOfPath(change.path))! }),
        }
      : undefined;
  const selection = monacoSelection;
  const clearSelection = (): void => setMonacoSelection(null);
  const notes = draft.notes ?? [];
  const hovered = useHoveredNote(well, notes);
  const [hotThread, setHotThread] = useState<number | null>(null);
  useNoteHighlights(well, notes, hovered ?? hotThread);
  /**
   * The text a note anchors against: the MODIFIED document.
   *
   * Monaco owns its own DOM, so reading `textContent` off the host returns nothing and every note
   * reads as an orphan. What a Monaco selection quoted from is the modified model, so that is what
   * its notes resolve against.
   */
  const flatText = draft.content ?? change.after ?? "";
  const author = services.author ?? "you";

  // The unsaved-edit map (§8.2's `drafts`): a change targeting a file someone is mid-edit on in the
  // editor deserves a flag before a merge silently races their typing.
  const hasDraft =
    services.drafts !== undefined &&
    (services.drafts.has(`project:${change.path}`) || services.drafts.has(`base:${change.path}`));

  const pathLabel = `${change.fromPath !== undefined ? `${change.fromPath} → ` : ""}${change.path}`;
  // A create shows only new text and a delete only old text, so a note on either has an honest
  // side. An update's inline rendering interleaves both, and claiming a side there would be a guess.
  const side: "before" | "after" | undefined =
    change.action === "create" ? "after" : change.action === "delete" ? "before" : undefined;

  return (
    <div className="detail" data-testid={`detail-${change.id}`}>
      <div className="detail-head">
        {/* Inline or side by side, the same pair the read-only changes view offers. Two columns is
            the better reading of a rewrite and needs width; one is the better reading of a scattered
            edit — and neither is right everywhere, which is why it is a control and not a default. */}
        <span className={`change-action change-action-${change.action}`}>
          <Icon name={actionIcon(change.action)} /> {change.action}
        </span>
        {services.openFile !== undefined ? (
          <button className="link change-path" onClick={() => services.openFile!("project", change.path)}>
            {pathLabel}
          </button>
        ) : (
          <code className="change-path">{pathLabel}</code>
        )}
        <span className="detail-spacer" />
        {picture === undefined && change.unshowable === undefined ? (
          <span className="vv-toggle" role="group" aria-label="How to lay the diff out">
            <button type="button" className={layout === "inline" ? "on" : undefined} onClick={() => setLayout("inline")}>
              Inline
            </button>
            <button type="button" className={layout === "split" ? "on" : undefined} onClick={() => setLayout("split")}>
              Side by side
            </button>
          </span>
        ) : null}
        {draft.excluded === true ? (
          // `content: undefined` as well: putting a change back restores what was PROPOSED, not the
          // proposal plus edits that were discarded on the way out. Leaving the edit behind meant a
          // restored change came back looking unchanged until "Undo my edits" was pressed too.
          <button className="ghost" onClick={() => onDraft({ excluded: false, content: undefined })}>
            Put it back
          </button>
        ) : (
          <button
            className="danger"
            title={
              canRevertLines
                ? "put the original back over the selected lines"
                : "refuse this change — select lines first to revert only those"
            }
            onClick={() => {
              // With lines selected, revert exactly those; with none, refuse the whole change. One
              // button, and which of the two it means is what the person is pointing at.
              const reverted = canRevertLines ? diffActions?.revertSelectedLines() : null;
              if (reverted !== null && reverted !== undefined) onDraft({ content: reverted });
              // Refusing the whole change drops the edits with it — an edit is a change to something
              // that is staying, and this one is not.
              // Everything about a change you are refusing goes with it: the edits, the whole-file
              // comment, and the anchored notes. A note on a change that is not in the review is a
              // note about nothing — the same rule the confirm dialog states when you X one.
              else onDraft({ excluded: true, content: undefined, comment: "", notes: [] });
            }}
          >
            {canRevertLines ? "Revert these lines" : "Revert"}
          </button>
        )}
        {draft.excluded !== true && draft.content !== undefined && draft.content !== change.after ? (
          <button className="ghost" onClick={() => onDraft({ content: undefined })}>
            Undo my edits
          </button>
        ) : null}
      </div>

      {change.reason !== undefined ? <div className="change-reason">{change.reason}</div> : null}
      {moved ? (
        <div className="change-drift">
          ⚠ this file moved since the review was produced — what you merge may not be what you read (§3.2);
          applying will re-check and refuse
        </div>
      ) : null}
      {hasDraft ? (
        <div className="change-drift">✎ this file has unsaved edits in the editor — a merge writes past them</div>
      ) : null}

      {/* The diff — Monaco, at every width.
          It used to fall back to a hand-rolled inline renderer below 720px, on the argument that
          three megabytes of editor is a poor trade for reading fourteen lines. That was a real
          argument and it was outweighed: a review that renders one way in a modal and a visibly
          poorer way in a conversation pane is two products, and the reviewer cannot tell which one
          they are looking at or why. The editor is lazy-loaded either way, and a review is exactly
          the moment its weight is worth paying. What still follows the width is the LAYOUT — one
          column or two — which is a question about room rather than about fidelity. */}
      {picture !== undefined ? (
        <ImageDiff before={picture.before} after={picture.after} layout={imageLayout} onLayout={setImageLayout} />
      ) : change.unshowable !== undefined ? (
        <div className="change-unshowable">{change.unshowable}</div>
      ) : (
        <Suspense fallback={<div className="diff-pane-loading">loading the diff editor…</div>}>
          <MonacoDiffPane
            original={change.before ?? ""}
            // A REVERTED change has no diff, and showing the proposal anyway was the reviewer
            // claiming something is about to happen that they had just refused.
            modified={draft.excluded === true ? (change.before ?? "") : (draft.content ?? change.after ?? "")}
            mime={mimeOfPath(change.path)}
            readOnly={change.after === undefined}
            onModified={(text) => onDraft({ content: text === change.after ? undefined : text })}
            onSelect={(picked) => {
              setMonacoSelection(picked);
              // Recomputed on every selection change rather than on click: the button's LABEL has to
              // say which of its two meanings is live before it is pressed.
              setCanRevertLines(diffActions?.hasChangedSelection() === true);
            }}
            onReady={setDiffActions}
            sideBySide={layout === "split"}
          />
        </Suspense>
      )}

      {selection !== null ? (
        <NoteComposer
          selection={selection}
          author={author}
          onCancel={clearSelection}
          onSave={(body) => {
            onDraft({
              notes: [
                ...notes,
                {
                  artifact: change.id,
                  quote: selection.quote,
                  range: { start: selection.start, end: selection.end },
                  // A Monaco selection is always in the MODIFIED side, so it always has an honest
                  // side — unlike an interleaved inline rendering, where a quote could span both.
                  side: "after" as const,
                  body,
                  author,
                  at: new Date().toISOString(),
                },
              ],
            });
            window.getSelection()?.removeAllRanges();
            clearSelection();
          }}
        />
      ) : null}

      <NoteList
        notes={notes}
        text={flatText}
        author={author}
        hovered={hovered ?? hotThread}
        onHover={setHotThread}
        onReselect={(note) => reselect(well.current, note)}
        onReply={(i, body) =>
          onDraft({
            notes: notes.map((note, at) =>
              at === i
                ? { ...note, replies: [...(note.replies ?? []), { author, body, at: new Date().toISOString() }] }
                : note,
            ),
          })
        }
        onRemove={(i) => onDraft({ notes: notes.filter((_, at) => at !== i) })}
      />

      <label className="field">
        <span>Comment on this {change.unshowable !== undefined ? "change" : "whole file"} (optional)</span>
        <textarea
          className="change-comment"
          rows={2}
          placeholder={
            change.unshowable !== undefined
              ? "Nothing here to select, so say it about the change as a whole…"
              : "For anything that is not about one passage…"
          }
          value={draft.comment ?? ""}
          onChange={(e) => onDraft({ comment: e.target.value })}
        />
      </label>

      <div className="change-files-note">{noteFor(decision, tree)}</div>
    </div>
  );
}

/** §4.1's files column, said to the person deciding — what will happen to the tree. */
function noteFor(decision: DecisionKind | undefined, tree: "base" | "proposal"): string {
  switch (decision) {
    case "merged":
      return tree === "base" ? "will be written" : "stays as proposed";
    case "reverted":
      return tree === "base" ? "will not be written" : "will be rolled back to the base";
    case "approved":
    case "denied":
      return "judged, files left alone";
    case "comment":
      return "left alone; your comment goes back to the model";
    default:
      return "";
  }
}
