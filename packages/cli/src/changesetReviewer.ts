/**
 * The CLI reviewer (CHANGESETS.md §8.4) — a separate implementation of the same registered
 * function: one change at a time, the same five decisions, the same changeset in and out.
 *
 * It composes with an existing limitation rather than fighting it: the interaction hub is
 * process-local, so a CLI-driven run answering at a CLI prompt needs no new channel — the function
 * is registered directly, interactive, and parks on the terminal instead of on a renderer. The
 * result it returns is checked by the same `checkDecisions` the app's main process uses, because
 * the workflow downstream must not be able to tell which reviewer answered.
 */
import type { Interface } from "node:readline/promises";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  changesetOf,
  checkDecisions,
  type Change,
  type ChangeDecision,
  type Changeset,
  type DecisionKind,
} from "@jaira/shared";
import {
  failureOf,
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { INTERACTIVE, REVIEW_ARTIFACTS } from "@jaira/runtime";

export interface ReviewerIo {
  input: Readable;
  output: Writable;
  /** Aborts the question in progress — the review was answered somewhere else. */
  signal?: AbortSignal;
}

const KEYS: Array<{ key: string; kind: DecisionKind; hint: string }> = [
  { key: "m", kind: "merged", hint: "merge (apply it)" },
  { key: "r", kind: "reverted", hint: "revert (roll it back)" },
  { key: "c", kind: "comment", hint: "comment (another round)" },
  { key: "a", kind: "approved", hint: "approve only (leave files)" },
  { key: "d", kind: "denied", hint: "deny only (leave files)" },
];

/** Render one change the way the app's unified-inline view does, in terminal clothing. */
function renderChange(change: Change, index: number, total: number, out: Writable): void {
  out.write(`\n[${index + 1}/${total}] ${change.action} ${change.fromPath !== undefined ? `${change.fromPath} → ` : ""}${change.path}\n`);
  if (change.reason !== undefined) out.write(`  why: ${change.reason}\n`);
  if (change.unshowable !== undefined) {
    out.write(`  (${change.unshowable})\n`);
    return;
  }
  if (change.before === undefined) {
    for (const line of (change.after ?? "").split("\n")) out.write(`  + ${line}\n`);
    return;
  }
  if (change.after === undefined) {
    for (const line of change.before.split("\n")) out.write(`  - ${line}\n`);
    return;
  }
  const hunks = [...(change.hunks ?? [])].sort((a, b) => a.start - b.start);
  for (const hunk of hunks) {
    if (hunk.label !== undefined) out.write(`  @ ${hunk.label}\n`);
    const removed = change.before.slice(hunk.start, hunk.end);
    for (const line of removed.split("\n")) if (line !== "" || removed !== "") out.write(`  - ${line}\n`);
    for (const line of hunk.text.split("\n")) if (line !== "" || hunk.text !== "") out.write(`  + ${line}\n`);
  }
  if (hunks.length === 0) out.write(`  (no textual difference)\n`);
}

/** Walk the changeset once, one decision per change — exported so a test can drive it directly. */
export async function reviewChangesetOnTerminal(changeset: Changeset, io: ReviewerIo): Promise<ChangeDecision[]> {
  const rl: Interface = createInterface({ input: io.input, output: io.output as NodeJS.WritableStream });
  // A question that can be WITHDRAWN (decision 0004): when the review is also a merge request and the
  // forge answers first, the prompt is aborted rather than left waiting for a reply nobody needs.
  const ask = (question: string): Promise<string> => rl.question(question, io.signal !== undefined ? { signal: io.signal } : {});
  try {
    io.output.write(`reviewing ${changeset.changes.length} change(s) against ${changeset.source}\n`);
    const decisions: ChangeDecision[] = [];
    for (const [index, change] of changeset.changes.entries()) {
      renderChange(change, index, changeset.changes.length, io.output);
      let kind: DecisionKind | undefined;
      while (kind === undefined) {
        const answer = (await ask(`  ${KEYS.map((k) => `[${k.key}]${k.kind}`).join(" ")}: `)).trim().toLowerCase();
        kind = KEYS.find((k) => k.key === answer || k.kind === answer)?.kind;
        if (kind === undefined) io.output.write(`  choose one of: ${KEYS.map((k) => `${k.key} = ${k.hint}`).join(", ")}\n`);
      }
      const decision: ChangeDecision = { id: change.id, decision: kind };
      if (kind === "comment") {
        const comment = (await ask("  comment: ")).trim();
        if (comment !== "") decision.comment = comment;
      }
      decisions.push(decision);
    }
    return decisions;
  } finally {
    rl.close();
  }
}

/**
 * Register the terminal-backed `review_artifacts`. The registry is supplied by the host
 * process and nothing inside a workflow can reach it — the same guarantee the hub gives the app
 * (§4.1), kept by the same arrangement.
 */
export function registerCliChangesetReviewer(
  registry: CapabilityRegistry<WorkflowMetrics>,
  io: ReviewerIo = { input: process.stdin, output: process.stdout },
): void {
  registry.functions.set(
    REVIEW_ARTIFACTS,
    hostFunction(async (inputs: FunctionInputs, ctx: { abortSignal?: AbortSignal } | undefined) => {
      try {
        const config = (inputs["config"] ?? {}) as Record<string, unknown>;
        const slot = typeof config["changeset"] === "string" ? config["changeset"] : "changeset";
        const changeset = changesetOf(inputs[slot]);
        const decisions = await reviewChangesetOnTerminal(changeset, { ...io, ...(ctx?.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}) });
        // The same re-validation the app's main process performs — a reviewer must not be able to
        // hand the workflow a partial or out-of-vocabulary judgement either.
        const checked = checkDecisions(changeset, { decisions });
        if (!checked.ok) return { error: failureOf(new Error(checked.errors)) };
        return { value: { decisions: checked.decisions } as unknown as ResolvedValue };
      } catch (e) {
        return { error: failureOf(e, REVIEW_ARTIFACTS) };
      }
    }, INTERACTIVE),
  );
}
