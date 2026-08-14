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
 */
import { lazy, Suspense, useEffect, useMemo, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import {
  changesetOf,
  diffStrategyFor,
  mimeOfPath,
  type Change,
  type ChangeDecision,
  type Changeset,
  type DecisionKind,
  type DiffStrategy,
  type UserApproveChangesetConfig,
} from "@jaira/shared/browser";

// Loaded on first expand, not with the reviewer: Monaco is megabytes, and most reviews are read and
// decided at conversation width without ever opening the pane (§8.3 — the pane is the affordance,
// not the default).
const MonacoDiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));

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
}

export interface MountContext {
  config: UserApproveChangesetConfig;
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

type Drafts = Record<string, { decision?: DecisionKind; comment: string; content?: string }>;

function ChangesetReview({ ctx }: { ctx: MountContext }): JSX.Element {
  const parsed = useMemo((): { changeset?: Changeset; error?: string } => {
    try {
      return { changeset: changesetOf(ctx.inputs[ctx.config.changeset]) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [ctx.inputs, ctx.config.changeset]);

  const [drafts, setDrafts] = useState<Drafts>({});
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
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

  if (parsed.changeset === undefined) {
    return <p className="reason">This state&apos;s changeset input is malformed: {parsed.error}</p>;
  }
  const changeset = parsed.changeset;

  const draftOf = (id: string): Drafts[string] => drafts[id] ?? { comment: "" };
  const set = (id: string, patch: Partial<Drafts[string]>): void =>
    setDrafts((d) => ({ ...d, [id]: { ...draftOf(id), ...(d[id] ?? {}), ...patch } }));

  const undecided = changeset.changes.filter((c) => draftOf(c.id).decision === undefined);
  const submit = (): void => {
    const decisions: ChangeDecision[] = changeset.changes.map((change) => {
      const draft = draftOf(change.id);
      const decision: ChangeDecision = { id: change.id, decision: draft.decision! };
      if (draft.comment.trim() !== "") decision.comment = draft.comment.trim();
      if (draft.decision === "merged" && draft.content !== undefined && draft.content !== change.after) {
        decision.content = draft.content;
      }
      return decision;
    });
    ctx.onSubmit({ decisions });
  };

  const expandedChange = changeset.changes.find((c) => c.id === expanded);

  return (
    <div className="changeset-review" data-testid="changeset-review">
      <div className="changeset-source">
        against <code>{changeset.source}</code>
      </div>
      {changeset.changes.map((change) => (
        <ChangeCard
          key={change.id}
          change={change}
          tree={ctx.config.tree}
          draft={draftOf(change.id)}
          onDraft={(patch) => set(change.id, patch)}
          onExpand={() => setExpanded(change.id)}
          services={ctx.services}
          moved={moved.has(change.id)}
        />
      ))}
      <div className="options">
        <button disabled={undecided.length > 0} onClick={submit} data-testid="submit-review">
          {undecided.length > 0
            ? `${undecided.length} change${undecided.length === 1 ? "" : "s"} still undecided`
            : "Submit review"}
        </button>
      </div>
      {expandedChange !== undefined ? (
        <DiffPane
          change={expandedChange}
          tree={ctx.config.tree}
          draft={draftOf(expandedChange.id)}
          onDraft={(patch) => set(expandedChange.id, patch)}
          onClose={() => setExpanded(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * The full-pane view (§8.3's affordance): Monaco's DiffEditor over one change, modified side
 * editable — typing there IS §4.1's `merged.content`, so the first edit marks the change merged.
 * The stored hunks are not overlaid here (see monacoDiff.tsx on why that dissolves §10.2); the
 * decisions row is the same one the card shows, because the pane is a bigger window on the same
 * review, not a second reviewer.
 */
function DiffPane({
  change,
  tree,
  draft,
  onDraft,
  onClose,
}: {
  change: Change;
  tree: "base" | "proposal";
  draft: { decision?: DecisionKind; comment: string; content?: string };
  onDraft(patch: Partial<{ decision: DecisionKind; comment: string; content?: string }>): void;
  onClose(): void;
}): JSX.Element {
  return (
    <div className="diff-pane" data-testid="diff-pane">
      <div className="diff-pane-head">
        <span className={`change-action change-action-${change.action}`}>{change.action}</span>
        <code className="change-path">
          {change.fromPath !== undefined ? `${change.fromPath} → ` : ""}
          {change.path}
        </code>
        <span className="diff-pane-spacer" />
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {change.unshowable !== undefined ? (
        <div className="change-unshowable">{change.unshowable}</div>
      ) : (
        <Suspense fallback={<div className="diff-pane-loading">loading the diff editor…</div>}>
          <MonacoDiffPane
            original={change.before ?? ""}
            modified={draft.content ?? change.after ?? ""}
            mime={mimeOfPath(change.path)}
            readOnly={change.after === undefined}
            onModified={(text) => {
              // An edit implies accepting the edited result — the same rule as the card's editor.
              onDraft(
                text === change.after
                  ? { content: undefined }
                  : { content: text, ...(draft.decision === undefined ? { decision: "merged" as const } : {}) },
              );
            }}
          />
        </Suspense>
      )}
      <div className="options change-decisions">
        <DecisionButtons draft={draft} onDraft={onDraft} />
      </div>
      {draft.decision === "comment" || draft.comment !== "" ? (
        <textarea
          className="change-comment"
          rows={2}
          placeholder="What should change about this?"
          value={draft.comment}
          onChange={(e) => onDraft({ comment: e.target.value })}
        />
      ) : null}
      <div className="change-files-note">{noteFor(draft.decision, tree)}</div>
    </div>
  );
}

/** §4.1's decision surface: the defaults the UI offers, and the two the workflow may want. */
const OFFERED: Array<{ kind: DecisionKind; label: string; danger?: boolean }> = [
  { kind: "merged", label: "Merge" },
  { kind: "reverted", label: "Revert", danger: true },
  { kind: "comment", label: "Comment" },
  { kind: "approved", label: "Approve only" },
  { kind: "denied", label: "Deny only", danger: true },
];

/** The five buttons, shared by the card and the full pane — one review, two windows onto it. */
function DecisionButtons({
  draft,
  onDraft,
}: {
  draft: { decision?: DecisionKind };
  onDraft(patch: { decision: DecisionKind }): void;
}): JSX.Element {
  return (
    <>
      {OFFERED.map((option) => (
        <button
          key={option.kind}
          className={[option.danger ? "danger" : "", draft.decision === option.kind ? "selected" : "ghost"].join(" ")}
          onClick={() => onDraft({ decision: option.kind })}
        >
          {option.label}
          {draft.decision === option.kind ? " ✓" : ""}
        </button>
      ))}
    </>
  );
}

function ChangeCard({
  change,
  tree,
  draft,
  onDraft,
  onExpand,
  services,
  moved,
}: {
  change: Change;
  tree: "base" | "proposal";
  draft: { decision?: DecisionKind; comment: string; content?: string };
  onDraft(patch: Partial<{ decision: DecisionKind; comment: string; content?: string }>): void;
  onExpand(): void;
  services: ComponentServices;
  /** §3.2: the file no longer holds what this review is about. */
  moved?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  // The unsaved-edit map (§8.2's `drafts`): a change targeting a file someone is mid-edit on in the
  // editor deserves a flag before a merge silently races their typing.
  const hasDraft =
    services.drafts !== undefined &&
    (services.drafts.has(`project:${change.path}`) || services.drafts.has(`base:${change.path}`));

  const pathLabel = `${change.fromPath !== undefined ? `${change.fromPath} → ` : ""}${change.path}`;

  return (
    <div className="change-card" data-testid={`change-${change.id}`}>
      <div className="change-head">
        <span className={`change-action change-action-${change.action}`}>{change.action}</span>
        {services.openFile !== undefined ? (
          // The host supplied a way into the editor (§8.2's `openFile`) — a layer-file review links
          // each change to the file it would change.
          <button className="link change-path" onClick={() => services.openFile!("project", change.path)}>
            {pathLabel}
          </button>
        ) : (
          <code className="change-path">{pathLabel}</code>
        )}
      </div>
      {change.reason !== undefined ? <div className="change-reason">{change.reason}</div> : null}
      {moved === true ? (
        <div className="change-drift">
          ⚠ this file moved since the review was produced — what you merge may not be what you read (§3.2);
          applying will re-check and refuse
        </div>
      ) : null}
      {hasDraft ? (
        <div className="change-drift">✎ this file has unsaved edits in the editor — a merge writes past them</div>
      ) : null}
      {change.unshowable !== undefined ? (
        <div className="change-unshowable">{change.unshowable}</div>
      ) : editing ? (
        <textarea
          className="change-editor"
          rows={10}
          value={draft.content ?? change.after ?? ""}
          onChange={(e) => onDraft({ content: e.target.value })}
          spellCheck={false}
        />
      ) : (
        <InlineDiff change={change} />
      )}
      <div className="options change-decisions">
        <DecisionButtons draft={draft} onDraft={onDraft} />
        {change.unshowable === undefined ? (
          <button className="ghost" onClick={onExpand}>
            Open diff editor
          </button>
        ) : null}
        {change.after !== undefined ? (
          <button
            className="ghost"
            onClick={() => {
              // Editing implies accepting the edited result — §4.1's `merged.content`.
              if (!editing) onDraft({ decision: "merged", content: draft.content ?? change.after });
              setEditing(!editing);
            }}
          >
            {editing ? "Done editing" : "Edit before merging"}
          </button>
        ) : null}
      </div>
      {draft.decision === "comment" || draft.comment !== "" ? (
        <textarea
          className="change-comment"
          rows={2}
          placeholder="What should change about this?"
          value={draft.comment}
          onChange={(e) => onDraft({ comment: e.target.value })}
        />
      ) : null}
      <div className="change-files-note">
        {noteFor(draft.decision, tree)}
      </div>
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

/**
 * Unified-inline rendering (§8.3): the before text with each hunk's removal struck and its
 * replacement inserted, in document order. A create shows the whole after; a delete the whole
 * before. The hunks are the STORED ones — see the module note.
 */
function InlineDiff({ change }: { change: Change }): JSX.Element {
  if (change.action === "create" || change.before === undefined) {
    return <pre className="inline-diff"><span className="diff-add">{change.after ?? ""}</span></pre>;
  }
  if (change.action === "delete" || change.after === undefined) {
    return <pre className="inline-diff"><span className="diff-del">{change.before}</span></pre>;
  }
  const hunks = [...(change.hunks ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: JSX.Element[] = [];
  let cursor = 0;
  hunks.forEach((hunk, i) => {
    if (hunk.start > cursor) {
      parts.push(<Fold key={`ctx-${i}`} text={change.before!.slice(cursor, hunk.start)} first={i === 0} />);
    }
    if (hunk.label !== undefined) {
      parts.push(<span key={`label-${i}`} className="diff-label">{hunk.label}</span>);
    }
    if (hunk.end > hunk.start) {
      parts.push(<span key={`del-${i}`} className="diff-del">{change.before!.slice(hunk.start, hunk.end)}</span>);
    }
    if (hunk.text.length > 0) {
      parts.push(<span key={`add-${i}`} className="diff-add">{hunk.text}</span>);
    }
    cursor = Math.max(cursor, hunk.end);
  });
  if (cursor < change.before.length) {
    parts.push(<Fold key="ctx-tail" text={change.before.slice(cursor)} last />);
  }
  return <pre className="inline-diff">{parts}</pre>;
}

/** Unchanged context, clipped to its edges so a long file reads as a diff and not as the file. */
function Fold({ text, first, last }: { text: string; first?: boolean; last?: boolean }): JSX.Element {
  const lines = text.split("\n");
  const keep = 3;
  if (lines.length <= keep * 2 + 1) return <span className="diff-ctx">{text}</span>;
  const head = first === true ? [] : lines.slice(0, keep);
  const tail = last === true ? [] : lines.slice(-keep);
  const elided = lines.length - head.length - tail.length;
  return (
    <span className="diff-ctx">
      {head.length > 0 ? head.join("\n") + "\n" : ""}
      <span className="diff-fold">⋯ {elided} unchanged lines ⋯{"\n"}</span>
      {tail.join("\n")}
    </span>
  );
}
