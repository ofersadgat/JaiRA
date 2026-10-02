/**
 * The changeset reviewer's logic, apart from how it is drawn (CHANGESETS.md §8, decision 0002): reading
 * a review, counting it, wording it, wiring it and answering it. The reviewer itself is
 * `packages/universal/src/components/artifact/ChangesetReview.tsx`. The mount contract
 * (`ComponentServices`, `MountContext`) is here too: it is what a host supplies.
 */
import type { JsonValue } from "@declarative-ai/json";
import {
  diffStrategyFor,
  mediaKindOf,
  mediaSrcOf,
  mimeOfPath,
  REVIEW_NOTE_ARTIFACT,
  type BaselineFile,
  type Change,
  type ChangeDecision,
  type Changeset,
  type ComponentOption,
  type DecisionKind,
  type DiffStrategy,
  type FileCheck,
  type IpcRequest,
  type IpcResponse,
  type RemoteStatusView,
  type ReviewArtifactsConfig,
  type ReviewDraft,
  type ReviewNote,
  type CheckFileRequest,
} from "@jaira/shared/browser";
import { mergeForgeNotes } from "./remoteStrip";

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
   * What the compiler says about one side of one change — the `file:check` channel, bound to the
   * reviewed task's worktree by whoever supplied this.
   *
   * Bound rather than addressed here for the reason {@link readUri} is: the component knows a
   * change's PATH and nothing about where the review is happening, and a self-mounting component
   * that went looking for the worktree itself is exactly what §8.2 exists to prevent.
   *
   * Absent means no diagnostics, which is right for every host that is not the app — the CLI has no
   * Monaco to draw a marker on, and a test mounting the component is not testing the compiler.
   */
  checkFile?(request: { path: string; text: string; baseline?: BaselineFile[] }): Promise<FileCheck>;
  /** Withdraw a buffer this reviewer had checked — see `CheckFileRequest`'s note on `file:release`. */
  releaseFile?(path: string): void;
  /**
   * The gate's SECOND DOOR (decision 0004): what the forge has said about this review, and a way to
   * go and look now. Supplied by a host that can reach main; absent, the strip still draws where the
   * request lives — from the gate's own `remote` — and simply has nothing live to add.
   */
  remote?: {
    status(): Promise<RemoteStatusView[]>;
    check(): Promise<RemoteStatusView[]>;
    /** Reply on a forge thread; answers with the request as re-read, so the reply comes back as the forge's copy. */
    reply(thread: string, body: string, resolve?: boolean): Promise<RemoteStatusView[]>;
  };
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
  /**
   * The review has been SUBMITTED, and this is what it submitted: draw it as decided, inert.
   *
   * `undefined` inside the field (as opposed to the field absent) is a review that was never
   * submitted — stopped, or the process gone — drawn with nothing decided. `onSubmit` is never
   * called while the field is present.
   */
  settled?: JsonValue | undefined;
}

/**
 * The drafts a submitted review's DECISIONS spell — the inverse of `deriveDecisions`, so the
 * chooser and the detail draw a settled review from the same state they draw a live one.
 *
 * `denied` and `reverted` were an X; `comment` was words, which are in the decision itself;
 * `approved` and `merged` were nothing at all. The set-level conversion (comment ⇒ approved,
 * silence ⇒ merged) needs no undoing: it is recomputed from these drafts and the review comment.
 */
export function draftsOfDecisions(decisions: JsonValue | undefined): Drafts {
  const out: Drafts = {};
  if (!Array.isArray(decisions)) return out;
  for (const decided of decisions) {
    if (decided === null || typeof decided !== "object" || Array.isArray(decided)) continue;
    const row = decided as Record<string, JsonValue>;
    if (typeof row["id"] !== "string") continue;
    const draft: Draft = {};
    if (row["decision"] === "denied" || row["decision"] === "reverted") draft.excluded = true;
    if (typeof row["comment"] === "string") draft.comment = row["comment"];
    if (Array.isArray(row["notes"])) draft.notes = row["notes"] as unknown as NonNullable<Draft["notes"]>;
    if (typeof row["content"] === "string") draft.content = row["content"];
    out[row["id"]] = draft;
  }
  return out;
}

/** The default services a renderer host wires — `readUri` over IPC, the shared strategy registry. */
export function rendererServices(
  invoke: <C extends "uri:read" | "file:check" | "file:release">(
    channel: C,
    request: IpcRequest<C>,
  ) => Promise<IpcResponse<C>>,
  /**
   * What `$WORKTREE` means for THIS review — the reviewed task (`pending.about`), whose worktree is
   * where the changes live. Without it the worktree anchor simply fails to resolve and the drift
   * check falls through to the layer anchors, which is right for a sync review.
   */
  scope: { taskId?: string; project?: string } = {},
): ComponentServices {
  /**
   * Where a change's path lives, for both of the file channels.
   *
   * `layer: "project"` with the reviewed task's id: a change's path is repo-root relative, and the
   * repo the review is about is that task's worktree. A review with no task behind it — a sync —
   * resolves to nothing and the channel refuses, which the caller reads as "no diagnostics here".
   */
  const at = (path: string): CheckFileRequest => ({
    layer: "project",
    path,
    ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
    ...(scope.project !== undefined ? { project: scope.project } : {}),
  });
  return {
    readUri: (uri) =>
      invoke("uri:read", {
        uri,
        ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
        ...(scope.project !== undefined ? { project: scope.project } : {}),
      }),
    checkFile: (request) =>
      invoke("file:check", {
        ...at(request.path),
        text: request.text,
        ...(request.baseline === undefined ? {} : { baseline: request.baseline }),
      }),
    releaseFile: (path) => {
      void invoke("file:release", at(path)).catch(() => {
        // Closing a review is not a place to report that a cache could not be cleared.
      });
    },
    diffStrategy: diffStrategyFor,
  };
}

/**
 * Everything a parked changeset gate is wired to: the renderer defaults, the second door when the
 * gate has one, and then the HOST's own services over both — so a host that must not reach main
 * (the Components view, whose project is a placeholder) replaces a door rather than guarding it.
 */
export function gateServices(
  invoke: <C extends "uri:read" | "file:check" | "file:release" | "remote:status" | "remote:check" | "remote:reply">(
    channel: C,
    request: IpcRequest<C>,
  ) => Promise<IpcResponse<C>>,
  wiring: {
    config: ReviewArtifactsConfig;
    about?: string | undefined;
    project?: string | undefined;
    author: string;
    /** The task that parked the gate, and its project — see `ChangesetGate`'s `gate`. */
    gate?: { taskId: string; project?: string | undefined } | undefined;
  },
  host: Partial<ComponentServices> = {},
): ComponentServices {
  const { config, about, project, gate } = wiring;
  const parked = gate === undefined ? undefined : { taskId: gate.taskId, ...(gate.project !== undefined ? { project: gate.project } : {}) };
  return {
    ...rendererServices(invoke, {
      ...(about !== undefined ? { taskId: about } : {}),
      ...(project !== undefined ? { project } : {}),
    }),
    author: wiring.author,
    // The second door, for a gate that has one and a host that can reach main.
    ...(parked !== undefined && config.remote?.number !== undefined
      ? {
          remote: {
            status: () => invoke("remote:status", parked),
            check: () => invoke("remote:check", parked),
            reply: (thread: string, body: string, resolve?: boolean) =>
              invoke("remote:reply", {
                ...parked,
                key: config.remote?.key ?? "review",
                thread,
                body,
                ...(resolve === true ? { resolve: true } : {}),
              }),
          },
        }
      : {}),
    ...host,
  };
}

/**
 * What a change's file holds RIGHT NOW, read through the anchors a review can be about, most
 * specific first: the reviewed task's worktree, then the layer roots. An anchor that does not
 * resolve for this review (no worktree; a path outside the layer) is simply the next one's turn,
 * and nothing readable anywhere is `undefined` — the caller stays silent rather than guessing.
 */
export async function readCurrent(services: ComponentServices, path: string): Promise<string | undefined> {
  for (const uri of [`$WORKTREE/${path}`, `$JAIRA/${path}`, `$PROJECT/${path}`]) {
    try {
      return (await services.readUri(uri)).text;
    } catch {
      // Not this anchor — the next may own the path.
    }
  }
  return undefined;
}

/** What the reviewer has done to one change, before {@link deriveDecisions} reads it. */
export type Draft = ReviewDraft & { content?: string };
export type Drafts = Record<string, Draft>;

/** The glyph beside a change's action word. Beside, never instead: a glyph on its own is a guess. */
const ACTION_ICON = {
  create: "fileAdd",
  delete: "fileDel",
  update: "fileEdit",
  rename: "fileEdit",
} as const;

export function actionIcon(action: Change["action"]): "fileAdd" | "fileDel" | "fileEdit" {
  return ACTION_ICON[action as keyof typeof ACTION_ICON] ?? "fileEdit";
}

/** §4.1's files column, said to the person deciding — what will happen to the tree. */
export function noteFor(decision: DecisionKind | undefined, tree: "base" | "proposal"): string {
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
 * The drafts with the forge's threads laid over the person's own notes, which are never touched — a
 * thread gains replies and gets resolved there, so it is replaced wholesale each read.
 */
export function withForgeNotes(held: Drafts, theirs: Readonly<Record<string, readonly unknown[]>>): Drafts {
  const next: Drafts = { ...held };
  const ids = new Set([...Object.keys(held), ...Object.keys(theirs)]);
  for (const id of ids) {
    if (id === REVIEW_NOTE_ARTIFACT) continue;
    const merged = mergeForgeNotes(held[id]?.notes, theirs[id]);
    if (merged.length === 0 && held[id]?.notes === undefined) continue;
    next[id] = { ...(held[id] ?? {}), notes: merged };
  }
  return next;
}

/**
 * §3.2 surfaced BEFORE submission: which changes' files no longer hold what this review is about —
 * read through `services.readUri` and compared to what the tree is supposed to hold for its state.
 * Conservative on silence: a path nothing can read gets no badge.
 */
export async function driftedChanges(changeset: Changeset, tree: "base" | "proposal", services: ComponentServices): Promise<Set<string>> {
  const flagged = new Set<string>();
  for (const change of changeset.changes) {
    if (change.unshowable !== undefined) continue;
    const expected = tree === "proposal" ? (change.action === "delete" ? undefined : change.after) : change.before;
    if (expected === undefined) continue;
    const current = await readCurrent(services, change.path);
    if (current !== undefined && current !== expected) flagged.add(change.id);
  }
  return flagged;
}

/** What the review will do, in the four numbers that decide it — `unopened` the one a summary would leave out. */
export function reviewCounts(changes: readonly Change[], decisions: readonly ChangeDecision[], opened: ReadonlySet<string>): { keeping: number; removed: number; commented: number; unopened: number } {
  return {
    keeping: decisions.filter((d) => d.decision === "merged" || d.decision === "approved").length,
    removed: decisions.filter((d) => d.decision === "reverted" || d.decision === "denied").length,
    commented: decisions.filter((d) => d.decision === "comment").length,
    unopened: changes.filter((c) => !opened.has(c.id)).length,
  };
}

/** The review's answer: every change's decision, the review-level decision when one was picked, and the comment. */
export function changesetAnswerOf(decisions: readonly ChangeDecision[], level: string | undefined, reviewComment: string): Record<string, unknown> {
  return {
    decisions,
    ...(level === undefined ? {} : { decision: level }),
    ...(reviewComment.trim() === "" ? {} : { comments: reviewComment.trim() }),
  };
}

/** The verdict under the counts, and the one button's word, by whether the round is applied. */
export const changesetVerdictOf = (going: boolean): string => (going ? "no comments — this round is applied" : "comments left — nothing is written, the set goes back");
export const changesetSubmitOf = (going: boolean): string => (going ? "Apply the review" : "Send back with comments");

/** A change's path as the detail names it, a rename's old path first. */
export const pathLabelOf = (change: Change): string => `${change.fromPath !== undefined ? `${change.fromPath} → ` : ""}${change.path}`;

/**
 * The two versions of a picture, when this change is one and the bytes are actually here — most image
 * changes are `unshowable: "binary"` and carry none.
 */
export function pictureOf(change: Change, draft: Draft): { before?: string; after?: string } | undefined {
  const mime = mimeOfPath(change.path);
  if (mediaKindOf(mime) !== "image") return undefined;
  const before = mediaSrcOf(change.before, mime);
  const after = mediaSrcOf(draft.content ?? change.after, mime);
  return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
}

/** A review-level option's button: settled, the chosen one keeps its fill and the others go quiet. */
export function optionKindOf(option: ComponentOption, readOnly: boolean, recorded: Record<string, JsonValue>): "primary" | "danger" | "ghost" {
  if (readOnly) return recorded["decision"] === option.value ? (option.tone === "danger" ? "danger" : "primary") : "ghost";
  return option.tone === "danger" ? "danger" : "primary";
}

/** A settled review's record as a record. */
export function recordedOf(settled: JsonValue | undefined): Record<string, JsonValue> {
  return settled !== null && typeof settled === "object" && !Array.isArray(settled) ? (settled as Record<string, JsonValue>) : {};
}
