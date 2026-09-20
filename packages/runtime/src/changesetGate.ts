/**
 * The changeset gate and its application step (CHANGESETS.md §4).
 *
 * Three registered names, split exactly where the design splits them:
 *
 *  - **`review_artifacts`** is NOT registered here. It is an interactive function, parked by
 *    the {@link ../interaction InteractionHub} and answerable only through `interaction:submit` —
 *    the registry is supplied by the host process, nothing running inside a workflow can reach the
 *    hub, and so an agent cannot fabricate a human decision about its own code (§4.1). All this
 *    module owns of it is the NAME and the workflow that mounts it.
 *  - **`apply-changeset`** ({@link registerApplyChangeset}) — given `(source, changeset, decisions)`
 *    the resulting files are determined, so application is separate from judgement (§4.2): testable
 *    without a UI, and a workflow can review now and apply later, or apply in a different worktree.
 *    With no workspace in ctx it computes the writes and touches nothing, which IS the pure half;
 *    with one, every write is anchor-guarded under the workspace root the way artifact destinations
 *    are — a path that escapes is refused, not clamped.
 *  - **`changeset-review-status`** ({@link registerChangesetReviewStatus}) — a pure helper deriving
 *    `settled` from the decisions, because §4.3's guard (`any(decisions, d => d.decision ===
 *    'comment')`) needs a higher-order expression and those are designed, not built (EXPRESSIONS.md
 *    §3.5). When they land, the helper retires and the guard moves into the transition where the
 *    design spells it.
 *
 * The loop stays IN the workflow (§4.3): {@link changesetReviewFiles} authors the transition policy
 * — settled ⇒ apply, comments left ⇒ terminate with the annotated changeset for the caller's next
 * round — so the UI submits an answer and never decides whether there is another round.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  failureOf,
  hostFunction,
  pureFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type JsonValue,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  applyDecisions,
  changesetOf,
  checkDecisions,
  CHANGESET_DECISIONS_SCHEMA,
  diffStrategyFor,
  mimeOfPath,
  reviewSettled,
  type Change,
  type ChangeDecision,
  type Changeset,
  type TreeState,
} from "@jaira/shared";
import { withinWorkspace } from "./artifactPath";
import { changesetDrift } from "./changesets";

export const REVIEW_ARTIFACTS = "review_artifacts";
export const APPLY_CHANGESET = "apply-changeset";
export const CHANGESET_REVIEW_STATUS = "changeset-review-status";

/** The review workflow's root id. */
export const CHANGESET_REVIEW_ID = "changeset/review";

// --- changeset-review-status --------------------------------------------------

/** What the pure status helper answers with. */
export interface ReviewStatus {
  /** True when no `comment` decisions remain — flow 1's "the workflow moves on" condition (§3.3). */
  settled: boolean;
  /** The comments, in change order — what the next round's model call answers. */
  comments: Array<{ id: string; comment?: string }>;
}

/** Derive the status from a decision list. Exported for the callers that loop outside a workflow. */
export function reviewStatusOf(decisions: readonly ChangeDecision[]): ReviewStatus {
  return {
    settled: reviewSettled(decisions),
    comments: decisions
      .filter((d) => d.decision === "comment")
      .map((d) => ({ id: d.id, ...(d.comment !== undefined ? { comment: d.comment } : {}) })),
  };
}

export function registerChangesetReviewStatus(registry: CapabilityRegistry<WorkflowMetrics>): void {
  registry.functions.set(
    CHANGESET_REVIEW_STATUS,
    pureFunction((inputs: FunctionInputs) => {
      const raw = inputs["decisions"];
      if (!Array.isArray(raw)) {
        return { error: failureOf(new Error("changeset-review-status needs a 'decisions' array")) };
      }
      return { value: reviewStatusOf(raw as unknown as ChangeDecision[]) as unknown as ResolvedValue };
    }, { memoizable: true }),
  );
}

// --- apply-changeset -----------------------------------------------------------

export function registerApplyChangeset(registry: CapabilityRegistry<WorkflowMetrics>): void {
  registry.functions.set(
    APPLY_CHANGESET,
    hostFunction(
      async (inputs: FunctionInputs, ctx: unknown) => {
        try {
          const changeset = changesetOf(inputs["changeset"]);
          const checked = checkDecisions(changeset, { decisions: inputs["decisions"] });
          if (!checked.ok) return { error: failureOf(new Error(`apply-changeset: ${checked.errors}`)) };
          // After a REMOTE merge there is nothing left to write (decision 0004): the task's worktree
          // already IS the forge's history, and that history is not necessarily what was pushed — the
          // reviewer may have squashed or added a fixup. Writing `after` over it would undo their work
          // with ours, so the settled-by that says "adopt" makes this step a no-op.
          const by = (inputs["settled_by"] ?? {}) as { via?: unknown; effect?: unknown };
          if (by.via === "remote" && by.effect === "adopt") return { value: { applied: [], writes: [] } as unknown as ResolvedValue };
          // A function op's `args` block arrives as the single `config` input (the loader's
          // lowering); a direct input of the same name wins so a caller can bind it dynamically.
          const config = (inputs["config"] ?? {}) as Record<string, JsonValue>;
          const treeRaw = inputs["tree"] ?? config["tree"];
          const tree: TreeState = treeRaw === "base" ? "base" : "proposal";
          const writes = applyDecisions(changeset, checked.decisions, tree);
          const asData = writes.map((w) => ({
            path: w.path,
            content: w.content ?? null,
            ...(w.mode !== undefined ? { mode: w.mode } : {}),
          })) as unknown as JsonValue;
          const root = (ctx as { workspace?: { root?: string } }).workspace?.root;
          if (root === undefined || inputs["dryRun"] === true || config["dryRun"] === true) {
            // The pure half: review now, apply later — the writes ARE the answer.
            return { value: { applied: [], writes: asData } as unknown as ResolvedValue };
          }
          // §3.2 before anything is written: has the tree moved since the reviewer was shown this
          // changeset? Only the changes a decision would TOUCH are checked (approved/denied/comment
          // leave the tree alone), and the check is against what the tree is supposed to hold for
          // its state — `before` under a base tree, `after` under a proposal tree. Refused rather
          // than clamped, with the drifted files named; the caller re-reviews against the tree as
          // it now stands. `verify: false` is for the one caller that KNOWS the mismatch — the
          // review loop's apply, whose changeset is a revision the worktree never held.
          const verify = inputs["verify"] ?? config["verify"];
          if (verify !== false) {
            const touched = new Set(
              checked.decisions.filter((d) => d.decision === "merged" || d.decision === "reverted").map((d) => d.id),
            );
            const drift = await changesetDrift(
              { source: changeset.source, changes: changeset.changes.filter((c) => touched.has(c.id)) },
              async (path) => {
                const target = withinWorkspace(root, path);
                if (target === undefined) return undefined;
                try {
                  return await readFile(target, "utf8");
                } catch {
                  return undefined;
                }
              },
              tree,
            );
            if (drift !== undefined) {
              const moved = drift.changes.map((c) => c.path).join(", ");
              return {
                error: failureOf(
                  new Error(
                    `apply-changeset: the tree moved while the review was pending (${moved}) — ` +
                      "re-review against the tree as it now stands rather than overwriting what nobody saw",
                  ),
                ),
              };
            }
          }
          // Anchor-guarded like artifact destinations: a changeset path is producer content, and a
          // producer must not be able to name a file outside the workspace it reviews (§8.5's rule,
          // applied on the write side).
          const applied: string[] = [];
          for (const write of writes) {
            const target = withinWorkspace(root, write.path);
            if (target === undefined) {
              return { error: failureOf(new Error(`apply-changeset: '${write.path}' escapes the workspace root`)) };
            }
            if (write.content === undefined) {
              await rm(target, { force: true });
            } else {
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, write.content, "utf8");
              // The chmod half of the write (§1.1's fifth action, applicable at last). On Windows
              // the executable bit does not exist and this is a no-op — the mode still travels in
              // the record and in `writes`, so a POSIX checkout applies it faithfully.
              if (write.mode !== undefined) {
                await chmod(target, write.mode === "executable" ? 0o755 : 0o644).catch(() => undefined);
              }
            }
            applied.push(write.path);
          }
          return { value: { applied, writes: asData } as unknown as ResolvedValue };
        } catch (e) {
          return { error: failureOf(e, "apply-changeset") };
        }
      },
      // §4.2's table: not interactive, not read-only, memoizable — and when it writes a worktree the
      // memo layer's own rule applies: `withMemoize` refuses a workspace-mutating call without a
      // pinned `treeHash`, so the pinning is supplied by whatever calls it (§10.4, accepted).
      { interactive: false, readOnly: false, memoizable: true },
    ),
  );
}

// --- changeset-revise ---------------------------------------------------------

export const CHANGESET_REVISE = "changeset-revise";

/** One whole-file answer to a comment — §11's rule: models cannot count line numbers, so complete
 *  files come in and hunks are re-derived here. */
export interface ReviseEdit {
  path: string;
  /** The COMPLETE revised file. */
  text: string;
  reason?: string;
}

/**
 * Fold a model's whole-file answers into the pending changeset — flow 1's "produces an updated one"
 * (§3.3), as a pure function so the update is derived, not trusted.
 *
 * Ids are kept STABLE for revised changes: a comment anchors to a change id, and the next round's
 * reviewer must find the change it commented on under the same id. The `before` side and the
 * `source` are kept too — the base did not move, only the proposal did; drift stays §3.2's
 * separate question. An edit naming a path the changeset never touched becomes a new `create`
 * change with a fresh id.
 */
export function reviseChangeset(changeset: Changeset, edits: readonly ReviseEdit[]): Changeset {
  const byPath = new Map(edits.map((e) => [e.path, e] as const));
  let maxId = 0;
  for (const change of changeset.changes) {
    const n = /^c(\d+)$/.exec(change.id);
    if (n !== null) maxId = Math.max(maxId, Number(n[1]));
  }
  const rederive = (change: Change): Change => {
    if (change.before === undefined || change.after === undefined) return change;
    return { ...change, hunks: diffStrategyFor(mimeOfPath(change.path)).hunks(change.before, change.after) };
  };
  const changes = changeset.changes.map((change) => {
    const edit = byPath.get(change.path);
    if (edit === undefined || change.unshowable !== undefined) return change;
    byPath.delete(change.path);
    return rederive({
      ...change,
      // A delete the model answered with content is a proposal again — believe the content.
      action: change.action === "delete" ? "update" : change.action,
      after: edit.text,
      ...(edit.reason !== undefined ? { reason: edit.reason } : {}),
    });
  });
  for (const edit of byPath.values()) {
    changes.push(
      rederive({
        id: `c${++maxId}`,
        path: edit.path,
        action: "create",
        after: edit.text,
        ...(edit.reason !== undefined ? { reason: edit.reason } : {}),
      }),
    );
  }
  return { source: changeset.source, changes };
}

export function registerChangesetRevise(registry: CapabilityRegistry<WorkflowMetrics>): void {
  registry.functions.set(
    CHANGESET_REVISE,
    pureFunction((inputs: FunctionInputs) => {
      try {
        const changeset = changesetOf(inputs["changeset"]);
        const raw = inputs["edits"];
        if (!Array.isArray(raw)) return { error: failureOf(new Error("changeset-revise needs an 'edits' array")) };
        const edits: ReviseEdit[] = [];
        for (const [i, row] of raw.entries()) {
          const e = row as { path?: unknown; text?: unknown; reason?: unknown };
          if (typeof e?.path !== "string" || typeof e?.text !== "string") {
            return { error: failureOf(new Error(`changeset-revise: edits[${i}] must carry path and the complete text`)) };
          }
          edits.push({ path: e.path, text: e.text, ...(typeof e.reason === "string" ? { reason: e.reason } : {}) });
        }
        return { value: { changeset: reviseChangeset(changeset, edits) } as unknown as ResolvedValue };
      } catch (e) {
        return { error: failureOf(e, CHANGESET_REVISE) };
      }
    }, { memoizable: true }),
  );
}

/** The non-interactive halves, for hosts that register the whole family at once. */
export function registerChangesetFunctions(registry: CapabilityRegistry<WorkflowMetrics>): void {
  registerApplyChangeset(registry);
  registerChangesetReviewStatus(registry);
  registerChangesetRevise(registry);
}

// --- the review workflow (§4.3) ------------------------------------------------

export interface ChangesetReviewOptions {
  /** What the tree under review currently holds. Default `proposal` — a worktree an agent edited. */
  tree?: TreeState;
  /** The gate's heading. */
  prompt?: string;
}

const DECISIONS_SLOT = { schema: CHANGESET_DECISIONS_SCHEMA.properties.decisions };
const CHANGESET_SLOT = { schema: { type: "object", description: "a changeset (CHANGESETS.md §1.1)" } };

/**
 * The state files of the built-in review workflow, loadable with `loadBundle`.
 *
 * One ROUND of flow 1 (§3.3): gate → status, then the authored transition applies when the round
 * settled and terminates with the annotated changeset when comments remain. Successive rounds are
 * successive invocations, which is §4.4's session shape — each round a record at the next position.
 * The state that ANSWERS the comments is deliberately not here: what a model does with a comment is
 * workflow-specific, and the sync/agent workflows mount their own respond state around this one.
 */
export function changesetReviewFiles(options: ChangesetReviewOptions = {}): Record<string, unknown> {
  const tree = options.tree ?? "proposal";
  return {
    [CHANGESET_REVIEW_ID]: {
      label: "Review a changeset",
      description: "A human decides every change; settled decisions are applied, comments end the round.",
      inputs: { changeset: CHANGESET_SLOT },
      outputs: {
        decisions: { ...DECISIONS_SLOT, binding: ".children.gate.output.decisions" },
        settled: { schema: { type: "boolean" }, binding: ".children.status.output.settled" },
        comments: {
          schema: { type: "array", items: { type: "object" } },
          binding: ".children.status.output.comments",
        },
      },
      children: {
        gate: { inputs: { changeset: ".inputs.changeset" } },
        status: { inputs: { decisions: ".children.gate.output.decisions" } },
        apply: { inputs: { changeset: ".inputs.changeset", decisions: ".children.gate.output.decisions" } },
      },
      // The whole spine is declared so the validator can prove every consumer's producers ran on
      // every path; the TRANSITIONS are the policy (§4.3) — an unsettled round terminates before
      // `apply` is reached, so the application step runs exactly when no comments remain. The UI
      // submits an answer and never decides whether there is another round.
      sequence: ["gate", "status", "apply"],
      // Every guard reads a child DELIBERATELY: the reachability analysis (hw validate §7.2) takes
      // the earliest point any transition could fire, and a guard reading no child counts as "as
      // soon as the operation completes" — which would un-prove the whole spine. Reading `status`
      // pins the first two to after it; the last conjunct reads `apply` for the same reason.
      transitions: [
        { to: "terminate.success", when: ".run.cursor === 'status' && .children.status.output.settled === false" },
        { to: "apply", when: ".run.cursor === 'status' && .children.status.output.settled === true" },
        { to: "terminate.success", when: ".run.cursor === 'apply' && .children.apply.outcome === 'success'" },
      ],
      limits: { max_iterations: 5 },
    },
    [`${CHANGESET_REVIEW_ID}/gate`]: {
      label: "Approve the changes",
      inputs: { changeset: CHANGESET_SLOT },
      outputs: { decisions: DECISIONS_SLOT },
      operation: {
        kind: "function",
        function: REVIEW_ARTIFACTS,
        // NO `changeset` arg. It meant "the input slot named changeset", and an arg and a state's
        // input share ONE namespace — so naming the slot overwrote what was in it with its own name.
        //
        // That silently unmade CHANGESETS.md §5.3, whose whole point is that the changeset lands in
        // `request_json` so a worktree-produced one survives the worktree moving. It also broke the
        // answer check: the gate's decisions were validated against the string `"changeset"`.
        // Compare the sibling `apply` state, whose request pins the changeset correctly.
        args: { prompt: options.prompt ?? "Review the proposed changes", tree },
      },
    },
    [`${CHANGESET_REVIEW_ID}/status`]: {
      label: "Any comments left?",
      inputs: { decisions: DECISIONS_SLOT },
      outputs: {
        settled: { schema: { type: "boolean" } },
        comments: { schema: { type: "array", items: { type: "object" } } },
      },
      operation: { kind: "function", function: CHANGESET_REVIEW_STATUS },
    },
    [`${CHANGESET_REVIEW_ID}/apply`]: {
      label: "Apply the settled decisions",
      inputs: { changeset: CHANGESET_SLOT, decisions: DECISIONS_SLOT },
      outputs: {
        applied: { schema: { type: "array", items: { type: "string" } } },
        writes: { schema: { type: "array", items: { type: "object" } } },
      },
      operation: { kind: "function", function: APPLY_CHANGESET, args: { tree } },
    },
  };
}

// --- the LOOPING review workflow (§3.3 flow 1, whole) --------------------------

/** The root id of the looping variant. A sibling of {@link CHANGESET_REVIEW_ID}, not a child — ids are paths. */
export const CHANGESET_REVIEW_LOOP_ID = "changeset/review-loop";

/**
 * A validator-satisfying stand-in, never read at runtime: the carry ternary always resolves to the
 * respond chain or the root input. It exists because a transition-driven loop makes NOTHING
 * provable to the reachability analysis — a guard reading only a non-sequence child counts as
 * able to fire immediately, so every child-reading slot needs the `default` opt-out (hw validate
 * §7.2). The spelling parses (`file:` scheme) so `changesetOf` would accept it even if it were
 * ever seen.
 */
const EMPTY_CHANGESET = { source: "file:never-read", changes: [] };

const RESPOND_PROMPT = `You proposed a set of changes and a reviewer answered some of them with comments instead of
accepting them. Answer the comments by revising your proposal.

The changeset you proposed:

{{.inputs.changeset}}

The reviewer's decisions — every change, decided; the ones that need your attention are the
\`comment\` ones:

{{.inputs.decisions}}

For each commented change, return the COMPLETE revised file for that path — the whole file, not a
fragment or a diff, because everything you leave out is deleted. Leave changes the reviewer merged
or reverted alone. If a comment asks for something you cannot express as a file, say so in notes
rather than inventing content.`;

/**
 * What the responder is told when the review is also a merge request: its `reason` is not a private
 * note any more. It is posted, under the connection's name, as the reply on each reviewer's thread
 * about that file — and `fixed` as its first word resolves the thread.
 */
const REMOTE_RESPOND_NOTE = `

This review is also open as a merge request, and the decisions above carry the reviewers' own threads
as notes. Give every edit a \`reason\`: one or two sentences saying what you changed and why. It is
posted as your reply on each thread about that file. Begin it with the word \`fixed\` ONLY when the
edit fully does what the thread asked — that resolves the thread; anything less, say what is still
open instead.`;

const REVISE_EDITS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "the path of the change being revised" },
      text: { type: "string", description: "the COMPLETE revised file" },
      reason: { type: "string", description: "how this answers the comment" },
    },
    required: ["path", "text"],
    additionalProperties: false,
  },
};

export interface ChangesetReviewLoopOptions extends ChangesetReviewOptions {
  /** Rounds before the loop gives up unsettled (terminate.error). Default 5. */
  maxRounds?: number;
  /** The respond state's prompt. Default {@link RESPOND_PROMPT}. */
  respondPrompt?: string;
  /** Model for the respond state. Absent ⇒ the run's default executor answers. */
  model?: string;
  /**
   * Also open the review as a merge request (decision 0004 §3) — `{ to, target, settle_after, draft }`.
   *
   * The request is carried BY NAME: `review` is scoped on the loop's root, above the loop, so every
   * round's gate resolves the same `(name, scope)` and pushes to the same branch and the same
   * request. The configuration is the plain keys beside the `$ref` (NAMES.md §4).
   */
  remote?: Record<string, JsonValue>;
}

/**
 * Flow 1 in ONE workflow (§3.3): gate → status; comments left ⇒ respond (a model answers them) ⇒
 * revise (the answers folded into an updated changeset, hunks re-derived) ⇒ back to the gate with
 * the UPDATED changeset; no comments left ⇒ apply.
 *
 * The mechanism that makes the loop expressible — found empirically, engine.ts `enterChild` — is
 * that sequence-reset clearing supersedes SEQUENCE members only: `respond` and `revise` sit outside
 * the spine, entered by transition, so their records survive the jump back to `gate`, and the carry
 * binding is a null-coalesce over the VALUE:
 *
 * ```
 * coalesce(.children.revise.output.changeset, .inputs.changeset)
 * ```
 *
 * A never-entered child's outputs read as undefined (coalesces to the input — round one), a
 * RUNNING child's read is PENDING and `coalesce` is strict, so the dataflow join still parks the
 * consumer (never a premature fallback), and a completed child carries its revision forward.
 * Deliberately NOT an `.outcome === 'success'` ternary: that spelling would fall back to the input
 * when revise ERRORED, silently restarting the loop from round one — a failed revision must fail
 * the round instead, which the transitions enforce (no transition handles an errored respond or
 * revise, so the workflow terminates with the error).
 *
 * The price is that the reachability analysis can prove nothing here (a guard reading a
 * non-sequence child counts as firing immediately), so every child-reading slot carries the
 * `default` opt-out; the defaults are never read at runtime.
 */
export function changesetReviewLoopFiles(options: ChangesetReviewLoopOptions = {}): Record<string, unknown> {
  const tree = options.tree ?? "proposal";
  const maxRounds = options.maxRounds ?? 5;
  // The current changeset: last revision if a round has happened, the input on round one.
  const CURRENT = "coalesce(.children.revise.output.changeset, .inputs.changeset)";
  const changesetSlot = { schema: CHANGESET_SLOT.schema, default: EMPTY_CHANGESET };
  const decisionsSlot = { ...DECISIONS_SLOT, default: [] };
  const remote = options.remote;
  // With a second door, the review answers a routing question too: a forge APPROVAL leaves every
  // change `approved` — approving is not merging — which is not "settled" and is not a comment either.
  const level = ".children.gate.output.decision";
  return {
    [CHANGESET_REVIEW_LOOP_ID]: {
      label: "Review a changeset, in rounds",
      ...(remote !== undefined
        ? {
            environment: {
              // Scoped HERE, above the loop: one request on every pass (NAMES.md §3).
              names: { review: {} },
              functions: { [REVIEW_ARTIFACTS]: { args: { remote: { $ref: "review", ...remote } } } },
            },
          }
        : {}),
      description: "Comments go back to the model, the revised changeset comes back to the gate; settled decisions apply.",
      inputs: { changeset: CHANGESET_SLOT },
      outputs: {
        decisions: { ...DECISIONS_SLOT, optional: true, binding: ".children.gate.output.decisions" },
        changeset: { schema: CHANGESET_SLOT.schema, optional: true, binding: CURRENT },
        applied: { schema: { type: "array", items: { type: "string" } }, optional: true, binding: ".children.apply.output.applied" },
      },
      children: {
        gate: {
          inputs: {
            changeset: CURRENT,
            // What the last round's responder did, so the gate can say so on the threads that asked
            // (decision 0004). `respond` sits outside the sequence and survives the loop-back, like
            // `revise`; on round one it never ran and the slot's default stands.
            ...(remote !== undefined ? { addressed: ".children.respond.output.edits" } : {}),
          },
        },
        status: { inputs: { decisions: ".children.gate.output.decisions" } },
        apply: {
          inputs: {
            changeset: CURRENT,
            decisions: ".children.gate.output.decisions",
            ...(remote !== undefined ? { settled_by: ".children.gate.output.settled_by" } : {}),
          },
        },
        // Entered by TRANSITION only, and deliberately OUTSIDE the sequence: the loop-back to
        // `gate` clears the spine, and these two surviving it is what carries a round's answer
        // into the next round's gate.
        respond: {
          inputs: {
            changeset: CURRENT,
            decisions: ".children.gate.output.decisions",
            comments: ".children.status.output.comments",
          },
        },
        revise: { inputs: { changeset: CURRENT, edits: ".children.respond.output.edits" } },
      },
      sequence: ["gate", "status", "apply"],
      transitions: [
        // Approved or cut, on the forge or here, with nothing applied: the review is over. What
        // happens to the request afterwards is the caller's to say (`remote_merge`, `remote_close`).
        ...(remote !== undefined
          ? [
              { to: "terminate.success", when: `.run.cursor === 'status' && .children.status.output.settled === false && ${level} === 'approve'` },
              { to: "terminate.success", when: `.run.cursor === 'status' && .children.status.output.settled === false && ${level} === 'cut'` },
            ]
          : []),
        { to: "respond", when: ".run.cursor === 'status' && .children.status.output.settled === false && .run.iteration < .limits.max_iterations" },
        { to: "revise", when: ".run.cursor === 'respond' && .children.respond.outcome === 'success'" },
        { to: "gate", when: ".run.cursor === 'revise' && .children.revise.outcome === 'success'" },
        { to: "apply", when: ".run.cursor === 'status' && .children.status.output.settled === true" },
        { to: "terminate.success", when: ".run.cursor === 'apply' && .children.apply.outcome === 'success'" },
        // Out of rounds with comments still open: fail loudly rather than applying an unsettled
        // review — the sequence would otherwise fall through to `apply`.
        { to: "terminate.error", when: ".run.cursor === 'status' && .children.status.output.settled === false" },
      ],
      limits: { max_iterations: maxRounds * 3 + 2 },
    },
    [`${CHANGESET_REVIEW_LOOP_ID}/gate`]: {
      label: "Approve the changes",
      inputs: { changeset: changesetSlot, ...(remote !== undefined ? { addressed: { schema: REVISE_EDITS_SCHEMA, default: [] } } : {}) },
      outputs: {
        decisions: DECISIONS_SLOT,
        ...(remote !== undefined
          ? {
              decision: { schema: { type: "string" }, optional: true },
              settled_by: { schema: { type: "object" }, optional: true },
              remote: { schema: { type: "object" }, optional: true },
            }
          : {}),
      },
      operation: {
        kind: "function",
        function: REVIEW_ARTIFACTS,
        // No `changeset` arg — see the note on the non-looping gate above. And no `remote` either:
        // it arrives from the root's `environment.functions`, under the name scoped there.
        args: { prompt: options.prompt ?? "Review the proposed changes", tree, ...(remote !== undefined ? { options: ["approve", "revise", "cut"] } : {}) },
      },
    },
    [`${CHANGESET_REVIEW_LOOP_ID}/status`]: {
      label: "Any comments left?",
      inputs: { decisions: decisionsSlot },
      outputs: {
        settled: { schema: { type: "boolean" } },
        comments: { schema: { type: "array", items: { type: "object" } } },
      },
      operation: { kind: "function", function: CHANGESET_REVIEW_STATUS },
    },
    [`${CHANGESET_REVIEW_LOOP_ID}/respond`]: {
      label: "Answer the comments",
      inputs: {
        changeset: changesetSlot,
        decisions: decisionsSlot,
        comments: { schema: { type: "array", items: { type: "object" } }, default: [] },
      },
      outputs: {
        edits: { schema: REVISE_EDITS_SCHEMA },
        notes: { schema: { type: "array", items: { type: "string" } }, optional: true },
      },
      operation: {
        kind: "prompt",
        prompt: `${options.respondPrompt ?? RESPOND_PROMPT}${remote !== undefined ? REMOTE_RESPOND_NOTE : ""}`,
        ...(options.model !== undefined ? { model: options.model } : {}),
      },
    },
    [`${CHANGESET_REVIEW_LOOP_ID}/revise`]: {
      label: "Fold the answers into the changeset",
      inputs: { changeset: changesetSlot, edits: { schema: REVISE_EDITS_SCHEMA, default: [] } },
      outputs: { changeset: { schema: CHANGESET_SLOT.schema } },
      operation: { kind: "function", function: CHANGESET_REVISE },
    },
    [`${CHANGESET_REVIEW_LOOP_ID}/apply`]: {
      label: "Apply the settled decisions",
      inputs: { changeset: changesetSlot, decisions: decisionsSlot, ...(remote !== undefined ? { settled_by: { schema: { type: "object" }, default: {} } } : {}) },
      outputs: {
        applied: { schema: { type: "array", items: { type: "string" } } },
        writes: { schema: { type: "array", items: { type: "object" } } },
      },
      // `verify: false`, deliberately and only here: after a revision round the changeset's `after`
      // is content the worktree never held, which is exactly what the drift check refuses — but the
      // gate showed the user this revision moments ago, so the mismatch is the loop working, not
      // the world moving (§3.2's check belongs to reviews with a real pending window).
      operation: { kind: "function", function: APPLY_CHANGESET, args: { tree, verify: false } },
    },
  };
}
