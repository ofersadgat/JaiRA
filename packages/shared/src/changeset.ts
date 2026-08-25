/**
 * The changeset model (CHANGESETS.md §1) — a proposed change as a VALUE.
 *
 * Two things produce changes a person has to read before they land — a sync proposing state files,
 * an agent editing code in a worktree — and both lower to this one shape: a set of per-file changes
 * against a pinned `source`. A unified diff is derived for display and never stored as the truth.
 *
 * Three rules carried from the design, restated where the code enforces them:
 *
 *  - **The source is a version, not a location** (§1.2). A comment is a statement about particular
 *    text, and text at a path changes — so `source` is a URI naming a point in time (§2), parsed by
 *    {@link parseChangesetSource} and REFUSED rather than guessed at when unrecognised, the same
 *    stance REFERENCES.md §1 takes.
 *  - **Every content change lowers to a text edit** (§1.3). Strategies differ in how a change is
 *    FOUND and SHOWN (a JSON pointer, a line hunk); they are identical in how it is applied: a
 *    replacement of a range with a string ({@link applyHunks}). That is what keeps `merged` meaning
 *    one thing per changeset rather than one thing per file type.
 *  - **The gate returns every change it was given, each with a decision** (§4.1), and the only part
 *    of the outcome that is not derivable is `merged.content` — the user's own edit — which is why
 *    it is the only content a record has to keep (§11).
 *
 * This lives in `shared` because both halves of the boundary need it: the runtime produces and
 * applies changesets, the renderer displays them, and the main process re-validates every submitted
 * decision the way it re-validates every other component result.
 */
import type { JsonValue } from "@declarative-ai/json";
import { checkNotes, type ReviewNote } from "./reviewNotes";

// --- the value ---------------------------------------------------------------

/** The file-level action vocabulary — every git action, because a review of an agent's work will meet all of them (§1.1). */
export type ChangeAction = "create" | "update" | "delete" | "rename" | "chmod";

export const CHANGE_ACTIONS: readonly ChangeAction[] = ["create", "update", "delete", "rename", "chmod"];

/**
 * One reviewable region of a change's content — strategy-dependent in what it MEANS, uniform in what
 * it IS: a replacement of `[start, end)` of the change's `before` text with `text` (§1.3).
 */
export interface ChangeHunk {
  /** Stable within the change; what a per-hunk UI affordance anchors to. */
  id: string;
  /** Character offsets into `before`. `start === end` is an insertion. */
  start: number;
  end: number;
  /** The replacement. Empty is a deletion. */
  text: string;
  /** What to show beside it — a JSON pointer for a structural hunk, an `@@` header for a line hunk. */
  label?: string;
  /**
   * The structural operation this hunk lowers, when a structural strategy found it. Kept so the
   * strategy can re-apply a SUBSET sequentially (each application still a text-range edit) where
   * independent splices of the original would collide — array index shifts, comma placement.
   */
  op?: { kind: "add" | "remove" | "replace"; pointer: Array<string | number>; value?: JsonValue };
}

/** One file's change. The `action` is taken or not taken whole; content rides `before`/`after` (§1.3). */
export interface Change {
  /** Stable within the changeset; anchors every decision (§1.1). */
  id: string;
  /** Path after the change, repo-root/layer-root relative, forward slashes. */
  path: string;
  action: ChangeAction;
  /** A rename's source path. */
  fromPath?: string;
  /** Content at the source. Absent for `create` — and for a change that cannot be shown. */
  before?: string;
  /** Proposed content. Absent for `delete` — and for a change that cannot be shown. */
  after?: string;
  /**
   * Why the content cannot be shown (a binary file). Such a change carries no text and no hunks; it
   * can still be approved or denied, just not read (§1.1).
   */
  unshowable?: string;
  /** Reviewable regions, derived by a strategy (§7). Absent when there is no content to hunk. */
  hunks?: ChangeHunk[];
  /** Why the producer proposes it, when it said — a sync's per-edit reason survives the lowering. */
  reason?: string;
  /**
   * File modes as git reports them (`100644`, `100755`, `000000` for absent) — what makes a `chmod`
   * action APPLICABLE rather than merely representable. Absent for producers with no mode story
   * (a sync's whole-file proposals).
   */
  modes?: { before: string; after: string };
}

/** A set of changes against one pinned source — THE value (§1.1). */
export interface Changeset {
  /** §2 — a pinned version, never a live path. Parse with {@link parseChangesetSource}. */
  source: string;
  changes: Change[];
}

// --- decisions (§4.1) --------------------------------------------------------

/**
 * The five decisions, on TWO axes rather than one (decision 0002).
 *
 *  - **Disposition** — in (`merged`/`approved`) or out (`reverted`/`denied`).
 *  - **Whether this round is being applied** — `merged`/`reverted` say the tree now reflects the
 *    answer; `approved`/`denied` are the same judgements on a round that is NOT being applied,
 *    because somebody left a comment and the set is going back for another pass.
 *
 * `comment` is neither: it is "this one needs work", which is why it is the value
 * {@link reviewSettled} looks for.
 *
 * Nobody clicks any of these. {@link deriveDecisions} computes all five from what the reviewer
 * actually did — which is the point of the pair existing at all.
 */
export type DecisionKind = "approved" | "merged" | "denied" | "reverted" | "comment";

export const DECISION_KINDS: readonly DecisionKind[] = ["approved", "merged", "denied", "reverted", "comment"];

export interface ChangeDecision {
  /** The change this decides — {@link Change.id}. */
  id: string;
  decision: DecisionKind;
  /**
   * What the user said about the change AS A WHOLE.
   *
   * Not made redundant by {@link notes}: a note points at a passage, and some changes have no
   * passage to point at — a binary file, a rename, anything `unshowable`. Those can still be
   * commented on, and this is how.
   */
  comment?: string;
  /** Notes anchored to passages inside the change (decision 0002). */
  notes?: ReviewNote[];
  /**
   * What the user typed, when they edited the change themselves rather than asking for it to be
   * redone. The ONLY part of the outcome that is not derivable (§4.1), and therefore the only
   * content the record has to store.
   *
   * Allowed on any decision that keeps the change — `merged`, `approved`, `comment` — and refused
   * on `denied`/`reverted`, where there is no change left to hold it. It was `merged`-only until
   * derivation (decision 0002) made the wider case real: an edit plus somebody else's comment
   * elsewhere yields `approved` for THIS change on a round that is not being applied, and dropping
   * the edit there would silently throw away the reviewer's own work between rounds.
   */
  content?: string;
}

/** What the gate returns: the changeset it was given, annotated (§4.1). */
export interface ChangesetReview {
  decisions: ChangeDecision[];
}

/**
 * True when a review round is finished and its decisions are ready to apply (§3.3 flow 1).
 *
 * "Every decision is in APPLIED form" rather than "no decision is `comment`", and the difference is
 * the review-level comment (decision 0002). A reviewer who writes "this whole approach is wrong"
 * and touches no individual change leaves every change `approved` — no `comment` decision anywhere,
 * yet plainly not settled. {@link deriveDecisions} only converts to `merged`/`reverted` when there
 * is no comment ANYWHERE, so the applied form is exactly the signal, with nothing extra to carry.
 *
 * Compatible with a reviewer that answers explicitly: the CLI offers `merged`/`reverted`/`comment`
 * and never the judgement-only pair, so a settled CLI review still reads as settled.
 */
export function reviewSettled(decisions: readonly ChangeDecision[]): boolean {
  return decisions.every((d) => d.decision === "merged" || d.decision === "reverted");
}

/** What a reviewer did to one change, before it is turned into a decision. */
export interface ReviewDraft {
  /** X'd out of the review — the gesture that means "not this one". */
  excluded?: boolean;
  /** A comment on the change as a whole. */
  comment?: string;
  /** Notes anchored inside it. */
  notes?: ReviewNote[];
  /** The reviewer's own edit, when they rewrote the change before accepting it (§4.1). */
  content?: string;
}

/** True when this draft carries anything a model would have to answer. */
function speaks(draft: ReviewDraft | undefined): boolean {
  if (draft === undefined) return false;
  return (draft.comment ?? "").trim().length > 0 || (draft.notes ?? []).length > 0;
}

/**
 * Turn what the reviewer DID into decisions (decision 0002).
 *
 * Nothing here is chosen from a menu. Per change, the gesture already says which of three states it
 * is in — untouched, X'd out, or commented — and those map to `approved` / `denied` / `comment`.
 * Then one rule over the whole set: **if nobody commented anywhere, the review is final**, and the
 * judgements become applications — `approved` → `merged`, `denied` → `reverted`.
 *
 * That set-level rule is a pull request's two verdicts. Comments mean "another pass", and a pass
 * that is going around again must not have written anything to the tree first.
 *
 * `reviewComment` is the review-level box, and it counts as a comment on everything — it blocks the
 * conversion without overwriting any change's own disposition, so an X'd change stays refused even
 * on a round that is only being commented on.
 */
export function deriveDecisions(
  changes: readonly Pick<Change, "id" | "after">[],
  drafts: Readonly<Record<string, ReviewDraft>>,
  reviewComment?: string,
): ChangeDecision[] {
  const judged = changes.map((change): ChangeDecision => {
    const draft = drafts[change.id];
    const decision: ChangeDecision =
      draft?.excluded === true
        ? { id: change.id, decision: "denied" }
        : speaks(draft)
          ? { id: change.id, decision: "comment" }
          : { id: change.id, decision: "approved" };
    const comment = (draft?.comment ?? "").trim();
    if (comment.length > 0) decision.comment = comment;
    if ((draft?.notes ?? []).length > 0) decision.notes = [...draft!.notes!];
    // The reviewer's own edit rides only a change that is staying in — and only when it differs
    // from what was proposed, since content equal to `after` is not an edit.
    if (draft?.excluded !== true && draft?.content !== undefined && draft.content !== change.after) {
      decision.content = draft.content;
    }
    return decision;
  });

  const anyComment = judged.some((d) => d.decision === "comment") || (reviewComment ?? "").trim().length > 0;
  if (anyComment) return judged;
  return judged.map((d) => ({ ...d, decision: d.decision === "denied" ? "reverted" : "merged" }) as ChangeDecision);
}

// --- the source grammar (§2) -------------------------------------------------

export type ChangesetSource =
  /** `git:<sha>` (a commit — the base a worktree diff is taken against) or `git:<sha>:<path>` (one blob). Immutable. */
  | { scheme: "git"; rev: string; path?: string }
  /** `db://operation_records/<session>@<seq>.<pointer>` — a PLACED call's value, addressed by the position it claimed. Immutable, machine-local (§2). */
  | { scheme: "db"; table: string; session: string; seq: number; pointer: string[] }
  /**
   * `db://operation_records/<operationId>.<pointer>` — a call addressed by its CONTENT id, placed
   * or not (§10.6, settled): the id settled `operation.*` events carry, and the id an unplaced
   * record is keyed by. Spelled without an `@`, which is what distinguishes the two forms.
   */
  | { scheme: "db"; table: string; recordId: string; pointer: string[] }
  /**
   * `file:<path>#sha256=<hex>` — the working tree at a moment, for a source with no commit.
   * Verifiable, not resolvable: the hash detects drift but cannot recover the content once the tree
   * moves (§2).
   */
  | { scheme: "file"; path: string; sha256?: string };

/**
 * Parse a changeset source URI. Throws on anything unrecognised — the grammar's standing rule is
 * that an unknown scheme is refused rather than guessed at (REFERENCES.md §1).
 */
export function parseChangesetSource(uri: string): ChangesetSource {
  if (uri.startsWith("git:")) {
    const body = uri.slice("git:".length);
    const colon = body.indexOf(":");
    const rev = colon < 0 ? body : body.slice(0, colon);
    if (!/^[0-9a-fA-F]{4,64}$/.test(rev)) {
      throw new Error(`'${uri}' does not name a git object: '${rev}' is not a hex object id`);
    }
    return colon < 0 ? { scheme: "git", rev } : { scheme: "git", rev, path: body.slice(colon + 1) };
  }
  if (uri.startsWith("db://")) {
    const body = uri.slice("db://".length);
    const slash = body.indexOf("/");
    if (slash <= 0) throw new Error(`'${uri}' names no record: expected db://<table>/<session>@<seq>.<pointer>`);
    const table = body.slice(0, slash);
    const rest = body.slice(slash + 1);
    // Split on the LAST `@`, exactly as the session store does — a derived session id may carry one.
    const at = rest.lastIndexOf("@");
    if (at <= 0) {
      // No position ⇒ the CONTENT-id form: `db://<table>/<operationId>[.<pointer>]` — the id
      // settled operation events carry, which addresses a record whether or not it ever claimed a
      // conversation seat (§10.6).
      const dot = rest.indexOf(".");
      const recordId = dot < 0 ? rest : rest.slice(0, dot);
      if (recordId.length === 0) throw new Error(`'${uri}' names no record`);
      const pointer = dot < 0 ? [] : rest.slice(dot + 1).split(".").filter((p) => p.length > 0);
      return { scheme: "db", table, recordId, pointer };
    }
    const session = rest.slice(0, at);
    const tail = rest.slice(at + 1);
    const dot = tail.indexOf(".");
    const seq = Number(dot < 0 ? tail : tail.slice(0, dot));
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`'${uri}' has no integer position after '@'`);
    const pointer = dot < 0 ? [] : tail.slice(dot + 1).split(".").filter((p) => p.length > 0);
    return { scheme: "db", table, session, seq, pointer };
  }
  if (uri.startsWith("file:")) {
    const body = uri.slice("file:".length);
    const hash = body.indexOf("#");
    const path = hash < 0 ? body : body.slice(0, hash);
    if (path.length === 0) throw new Error(`'${uri}' names no path`);
    if (hash < 0) return { scheme: "file", path };
    const fragment = body.slice(hash + 1);
    const match = /^sha256=([0-9a-fA-F]{64})$/.exec(fragment);
    if (match === null) {
      throw new Error(`'${uri}' has an unrecognised fragment '${fragment}' — expected #sha256=<64 hex digits>`);
    }
    return { scheme: "file", path, sha256: match[1]!.toLowerCase() };
  }
  throw new Error(`unrecognised changeset source '${uri}' — expected git:, db:// or file: (refused rather than guessed at)`);
}

/** Spell a source back into its URI. Inverse of {@link parseChangesetSource}. */
export function formatChangesetSource(source: ChangesetSource): string {
  switch (source.scheme) {
    case "git":
      return source.path === undefined ? `git:${source.rev}` : `git:${source.rev}:${source.path}`;
    case "db": {
      const address = "recordId" in source ? source.recordId : `${source.session}@${source.seq}`;
      return `db://${source.table}/${address}${source.pointer.length > 0 ? `.${source.pointer.join(".")}` : ""}`;
    }
    case "file":
      return source.sha256 === undefined ? `file:${source.path}` : `file:${source.path}#sha256=${source.sha256}`;
  }
}

// --- applying (§1.3, §4.2) ---------------------------------------------------

/**
 * Apply hunks to a text: sorted descending so earlier splices do not shift later offsets. The one
 * way content is EVER applied (§1.3) — a structural strategy that must re-derive its edits for a
 * subset still lowers each application to exactly this shape.
 */
export function applyHunks(before: string, hunks: readonly ChangeHunk[]): string {
  const ordered = [...hunks].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = before;
  for (const hunk of ordered) {
    out = out.slice(0, hunk.start) + hunk.text + out.slice(hunk.end);
  }
  return out;
}

/** What the tree a set of decisions is applied AGAINST currently holds. */
export type TreeState =
  /** The base — the proposal exists only as data (a sync's edits). Applying `merged` writes it. */
  | "base"
  /** The proposal — the changes are already on disk (an agent's worktree). Applying `reverted` undoes it. */
  | "proposal";

/** One file operation the application step decided on. `content: undefined` deletes the path. */
export interface FileWrite {
  path: string;
  content: string | undefined;
  /**
   * Set when the decision also changes the file's MODE — the applicable half of a `chmod` action
   * (§1.1). Only ever accompanies a content write; the content of a pure chmod is the unchanged
   * bytes, which keeps `content: undefined` meaning exactly one thing (delete).
   */
  mode?: "executable" | "normal";
}

/** The mode a git mode string means to a filesystem write. */
const modeOf = (gitMode: string): "executable" | "normal" => (gitMode === "100755" ? "executable" : "normal");

/**
 * The pure application step (§4.2): given the tree's current state, a changeset and its decisions,
 * the writes are determined. No filesystem — the caller supplies content only through the changeset
 * itself, and receives writes to make. That is what makes it testable without a UI, and lets a
 * workflow review now and apply later, or apply in a different worktree.
 *
 * Per §4.1's files column: `merged` applies the proposal (with the user's `content` when they edited
 * it), `reverted` rolls back to the base, and `approved` / `denied` / `comment` leave the tree
 * exactly as it stands — which of those is a no-op depends on {@link TreeState}, and that is the
 * whole reason the parameter exists.
 */
export function applyDecisions(
  changeset: Changeset,
  decisions: readonly ChangeDecision[],
  tree: TreeState,
): FileWrite[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const writes: FileWrite[] = [];
  // The mode rider for a content write, when the change flips one — the applicable half of `chmod`,
  // and of any update/rename that changes the executable bit alongside its content.
  const modeFor = (change: Change, side: "before" | "after"): Pick<FileWrite, "mode"> => {
    const modes = change.modes;
    if (modes === undefined || modes.before === modes.after) return {};
    const target = modes[side];
    if (!/^100\d{3}$/.test(target)) return {}; // absent or non-blob (a symlink) — nothing to set
    return { mode: modeOf(target) };
  };
  for (const change of changeset.changes) {
    const decision = byId.get(change.id);
    if (decision === undefined) continue;
    if (decision.decision === "merged") {
      // The proposal (or the user's edit of it) becomes the tree's content — UNCONDITIONALLY, which
      // is §4.1's table ("merged → applied"). Against a tree already holding the proposal the write
      // is idempotent; against one that has moved past it — a revised changeset over a worktree
      // whose files still hold round one's proposal — the write is the point. A change with no
      // content to write (a merged binary) writes nothing.
      const content = decision.content ?? change.after;
      if (change.action === "delete") {
        writes.push({ path: change.path, content: undefined });
      } else if (change.action === "rename") {
        if (change.fromPath !== undefined) writes.push({ path: change.fromPath, content: undefined });
        writes.push({ path: change.path, content: content ?? change.before ?? "", ...modeFor(change, "after") });
      } else if (content !== undefined) {
        writes.push({ path: change.path, content, ...modeFor(change, "after") });
      }
    } else if (decision.decision === "reverted" && tree === "proposal") {
      // Roll the tree back to the base's view of this file.
      if (change.action === "create") {
        writes.push({ path: change.path, content: undefined });
      } else if (change.action === "rename") {
        writes.push({ path: change.path, content: undefined });
        if (change.fromPath !== undefined) {
          writes.push({ path: change.fromPath, content: change.before ?? "", ...modeFor(change, "before") });
        }
      } else if (change.before !== undefined) {
        writes.push({ path: change.path, content: change.before, ...modeFor(change, "before") });
      }
    }
  }
  return writes;
}

// --- defensive parse (the wire) ----------------------------------------------

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Read a changeset off the wire — an op's inputs, a recorded `request_json`. Throws with a
 * path-shaped message on anything malformed, because this is where a producer's value becomes the
 * thing a human is asked to judge, and a silently empty review is worse than a loud failure.
 */
export function changesetOf(value: unknown): Changeset {
  const root = record(value, "changeset");
  const source = root["source"];
  if (typeof source !== "string" || source.length === 0) throw new Error("changeset.source is required");
  parseChangesetSource(source); // refuse an address nothing could resolve
  const rawChanges = root["changes"];
  if (!Array.isArray(rawChanges)) throw new Error("changeset.changes must be an array");
  const seen = new Set<string>();
  const changes = rawChanges.map((raw, i) => {
    const row = record(raw, `changes[${i}]`);
    const id = row["id"];
    const path = row["path"];
    const action = row["action"];
    if (typeof id !== "string" || id.length === 0) throw new Error(`changes[${i}].id is required`);
    if (seen.has(id)) throw new Error(`changes[${i}].id '${id}' is not unique — decisions anchor to it`);
    seen.add(id);
    if (typeof path !== "string" || path.length === 0) throw new Error(`changes[${i}].path is required`);
    if (typeof action !== "string" || !(CHANGE_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`changes[${i}].action must be one of: ${CHANGE_ACTIONS.join(", ")}`);
    }
    const change: Change = { id, path, action: action as ChangeAction };
    if (typeof row["fromPath"] === "string") change.fromPath = row["fromPath"];
    if (typeof row["before"] === "string") change.before = row["before"];
    if (typeof row["after"] === "string") change.after = row["after"];
    if (typeof row["unshowable"] === "string") change.unshowable = row["unshowable"];
    if (typeof row["reason"] === "string") change.reason = row["reason"];
    const modes = row["modes"] as { before?: unknown; after?: unknown } | undefined;
    if (modes !== undefined && typeof modes.before === "string" && typeof modes.after === "string") {
      change.modes = { before: modes.before, after: modes.after };
    }
    if (Array.isArray(row["hunks"])) {
      change.hunks = row["hunks"].map((h, j) => {
        const hunk = record(h, `changes[${i}].hunks[${j}]`);
        if (typeof hunk["id"] !== "string" || typeof hunk["start"] !== "number" || typeof hunk["end"] !== "number" || typeof hunk["text"] !== "string") {
          throw new Error(`changes[${i}].hunks[${j}] must carry id, start, end and text`);
        }
        return {
          id: hunk["id"],
          start: hunk["start"],
          end: hunk["end"],
          text: hunk["text"],
          ...(typeof hunk["label"] === "string" ? { label: hunk["label"] } : {}),
          ...(hunk["op"] !== undefined ? { op: hunk["op"] as ChangeHunk["op"] } : {}),
        };
      });
    }
    return change;
  });
  return { source, changes };
}

/**
 * Check submitted decisions against the changeset they decide. The main-process re-validation
 * (DESIGN §7.1): a renderer bug cannot push an undeclared decision, a decision about a change that
 * was never proposed, or a partial answer into a workflow's outputs — §4.1 requires EVERY change
 * decided.
 */
export function checkDecisions(changeset: Changeset, value: unknown): { ok: true; decisions: ChangeDecision[] } | { ok: false; errors: string } {
  const bad = (errors: string): { ok: false; errors: string } => ({ ok: false, errors });
  const root = value === null || typeof value !== "object" || Array.isArray(value) ? undefined : (value as Record<string, unknown>);
  const raw = root?.["decisions"];
  if (!Array.isArray(raw)) return bad("result.decisions must be an array");
  const decisions: ChangeDecision[] = [];
  const decided = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (row === null || typeof row !== "object" || Array.isArray(row)) return bad(`decisions[${i}] must be an object`);
    const d = row as Record<string, unknown>;
    if (typeof d["id"] !== "string") return bad(`decisions[${i}].id must be a string`);
    if (typeof d["decision"] !== "string" || !(DECISION_KINDS as readonly string[]).includes(d["decision"])) {
      return bad(`decisions[${i}].decision must be one of: ${DECISION_KINDS.join(", ")}`);
    }
    if (!changeset.changes.some((c) => c.id === d["id"])) {
      return bad(`decisions[${i}] decides '${String(d["id"])}', which is not a change in this changeset`);
    }
    if (decided.has(d["id"])) return bad(`decisions[${i}] decides '${String(d["id"])}' twice`);
    decided.add(d["id"]);
    if (d["comment"] !== undefined && typeof d["comment"] !== "string") return bad(`decisions[${i}].comment must be a string`);
    const notes = checkNotes(d["notes"]);
    if (!notes.ok) return bad(`decisions[${i}].${notes.errors}`);
    if (d["content"] !== undefined && typeof d["content"] !== "string") return bad(`decisions[${i}].content must be a string`);
    if (d["content"] !== undefined && (d["decision"] === "denied" || d["decision"] === "reverted")) {
      return bad(`decisions[${i}].content is meaningless on '${String(d["decision"])}' — the change is not being kept`);
    }
    const decision: ChangeDecision = { id: d["id"], decision: d["decision"] as DecisionKind };
    if (typeof d["comment"] === "string") decision.comment = d["comment"];
    if (notes.notes.length > 0) decision.notes = notes.notes;
    if (typeof d["content"] === "string") decision.content = d["content"];
    decisions.push(decision);
  }
  const missing = changeset.changes.filter((c) => !decided.has(c.id));
  if (missing.length > 0) {
    return bad(`every change needs a decision; undecided: ${missing.map((c) => c.id).join(", ")}`);
  }
  return { ok: true, decisions };
}

/** The JSON Schema of the gate's result, for a state's declared outputs to reference. */
export const CHANGESET_DECISIONS_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: [...DECISION_KINDS] },
          comment: { type: "string", description: "about the change as a whole" },
          notes: {
            type: "array",
            description: "notes anchored to passages inside the change (decision 0002)",
            items: {
              type: "object",
              properties: {
                artifact: { type: "string" },
                quote: { type: "string" },
                range: {
                  type: "object",
                  properties: { start: { type: "integer" }, end: { type: "integer" } },
                  required: ["start", "end"],
                  additionalProperties: false,
                },
                side: { type: "string", enum: ["before", "after"] },
                body: { type: "string" },
                author: { type: "string" },
                at: { type: "string" },
                replies: {
                  type: "array",
                  description: "the rest of the conversation about this passage, oldest first",
                  items: {
                    type: "object",
                    properties: { author: { type: "string" }, body: { type: "string" }, at: { type: "string" } },
                    required: ["author", "body", "at"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["artifact", "quote", "body", "author", "at"],
              additionalProperties: false,
            },
          },
          content: { type: "string", description: "the user's own edit; refused where the change is not kept" },
        },
        required: ["id", "decision"],
        additionalProperties: false,
      },
    },
    decision: { type: "string", description: "the review-level answer, when the state named options" },
    comments: { type: "string", description: "the review-level comment — a comment on everything" },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;
