/**
 * `review_artifacts` with a `remote` (decision 0004 §3): two doors, one answer.
 *
 * With no `remote` — none written, none inherited, or `null` — the gate is local only, exactly as it
 * always was, and this module does nothing but ask it. With one, the gate is asked EXACTLY as it is
 * today and the same request also lives on the forge: the review is pushed, a merge request is
 * opened (or found — a loop's next round gets the same one), the row is marked awaited, and then
 * whichever side settles first answers the state.
 *
 *  - **The forge settles it** → this function wakes with the settlement and — when the request was
 *    MERGED — adopts the forge's history before returning.
 *  - **The person settles it here** → the row stops being awaited, the notes they wrote are posted as
 *    inline threads, and one closing comment says what was decided. Approve at the gate does not
 *    merge the request; what happens to it afterwards is the workflow's to say.
 *
 * Both halves of the adoption and the telling live HERE, after the ask, rather than in whoever
 * answered — because the answer may arrive as a seed on a resumed run, days later, in a process that
 * was not there when it was given.
 *
 * ## Who asks
 *
 * The HOST, through {@link RemoteReviewOptions.ask}. The app parks the gate on its interaction hub,
 * which the forge's settlement can be submitted to like any answer. The CLI asks at a terminal,
 * which nothing can answer from outside — so it also supplies {@link RemoteReviewOptions.forge}, and
 * the two are raced here, the loser withdrawn through the abort signal `ask` was given.
 *
 * ## A revise round answers the threads it addressed
 *
 * The loop's next pass arrives with `addressed` — the responder's edits, each with the `reason` it
 * gave. After the revision is pushed, every unresolved forge thread on a revised file gets that
 * reason as a reply, and is resolved when the responder said `fixed`. Threads carry over; nothing
 * is replied to twice, because a thread whose last word is already JaiRA's is left alone.
 */
import { failureOf, type FunctionInputs, type FunctionResult, type JsonValue, type ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  changesetInputOf,
  handleOfRow,
  parseDuration,
  type Change,
  type ChangeDecision,
  type Changeset,
  type ForgeAnchor,
  type ForgeProvider,
  type RemoteHandle,
  type RemoteHandlePort,
  type RemoteHandleRow,
  type ReviewNote,
} from "@jaira/shared";
import { REVIEW_ARTIFACTS } from "./changesetGate";
import type { AdoptReport, RemotePrimitives } from "./remote";

type Result = FunctionResult<ResolvedValue, WorkflowMetrics>;

export interface AskHooks {
  /** Called with the request's id the moment the question is actually put — never for a seeded answer. */
  onParked(requestId: string): void;
  /** Aborted when the OTHER door answered first, for an asker that can withdraw its question. */
  signal: AbortSignal;
}

export interface RemoteReviewOptions {
  taskId: string;
  taskTitle?: string;
  /** Put the gate's question to a person, however this host does that. */
  ask: (inputs: Record<string, JsonValue>, hooks: AskHooks) => Promise<Result>;
  /**
   * The forge's settlement of this request, for a host whose {@link ask} cannot be answered from
   * outside. Absent ⇒ the host delivers the forge's answer THROUGH `ask` (the app's hub does).
   */
  forge?: (row: RemoteHandleRow, requestId: string) => Promise<JsonValue>;
  handles: RemoteHandlePort;
  primitives: RemotePrimitives;
  workspace: { root: string; isWorktree: boolean };
  /** `git config user.name` — who a local answer is attributed to, on the forge and in the result. */
  who: () => Promise<string | undefined>;
  /** A wait just began: probe now. */
  onAwaiting: () => void;
  log: (message: string) => void;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The `remote` a gate was given — `undefined` when it has none, which includes the explicit `null`. */
export function remoteOf(inputs: FunctionInputs): Record<string, unknown> | undefined {
  const held = inputs["remote"] ?? record(inputs["config"])["remote"];
  return held === undefined || held === null ? undefined : record(held);
}

/** What the request says about itself: the prompt, then what is in the set. */
export function describeReview(prompt: string, changeset: Changeset | undefined): string {
  if (changeset === undefined || changeset.changes.length === 0) return prompt;
  const lines = changeset.changes.map((change) => `- \`${change.path}\` — ${change.action}${change.reason !== undefined ? `: ${change.reason}` : ""}`);
  return `${prompt}\n\n${lines.join("\n")}\n\n_Opened by JaiRA. Comment here, or reply with a single decision word — \`approve\`, \`revise\`, \`cut\` — to answer the review._`;
}

/** Where a note sits in the file, from the words it quotes — a note anchors by quote, a forge by line. */
export function anchorOfNote(note: ReviewNote, change: Change): ForgeAnchor | undefined {
  const side = note.side ?? "after";
  const text = (side === "before" ? change.before : change.after) ?? "";
  const needle = note.quote.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (needle === undefined) return undefined;
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(needle.trim()));
  return index < 0 ? undefined : { path: side === "before" ? (change.fromPath ?? change.path) : change.path, line: index + 1, side };
}

/** One line for the forge saying what was decided in JaiRA. */
export function closingComment(who: string | undefined, value: Record<string, unknown>): string {
  const decisions = (Array.isArray(value["decisions"]) ? value["decisions"] : []) as ChangeDecision[];
  const counts = new Map<string, number>();
  for (const d of decisions) counts.set(d.decision, (counts.get(d.decision) ?? 0) + 1);
  const tally = [...counts.entries()].map(([kind, n]) => `${n} ${kind}`).join(", ");
  const level = typeof value["decision"] === "string" ? `**${value["decision"]}**` : "the review was answered";
  return `Decided in JaiRA${who !== undefined ? ` by ${who}` : ""}: ${level}${tally.length > 0 ? ` (${tally})` : ""}.`;
}

/** One thing the responder did, as the revise round hands it to the gate. */
export interface AddressedEdit {
  path: string;
  reason?: string;
}

/** `fixed`, as the FIRST word of a reason: the responder's way of saying a thread can be closed. */
export const saysFixed = (reason: string | undefined): boolean => reason !== undefined && /^\s*fixed\b/i.test(reason);

/**
 * What to say on which thread after a revision was pushed — pure, so the rule is a test.
 *
 * A thread is answered when it is UNRESOLVED, sits on a file the round revised, somebody other than
 * JaiRA has spoken on it, and its last word is not already JaiRA's. That last condition is what makes
 * this safe to run on every park: a resumed run re-reaches the gate, and must not say it all again.
 */
export function threadReplies(
  threads: ReadonlyArray<{ id: string; resolved: boolean; anchor?: { path: string }; comments: ReadonlyArray<{ own: boolean }> }>,
  addressed: readonly AddressedEdit[],
  head: string,
): Array<{ thread: string; body: string; resolve: boolean }> {
  const byPath = new Map(addressed.map((edit) => [edit.path, edit]));
  const out: Array<{ thread: string; body: string; resolve: boolean }> = [];
  for (const thread of threads) {
    const edit = thread.anchor !== undefined ? byPath.get(thread.anchor.path) : undefined;
    if (edit === undefined || thread.resolved) continue;
    if (!thread.comments.some((c) => !c.own) || thread.comments.at(-1)?.own === true) continue;
    const said = edit.reason !== undefined && edit.reason.trim().length > 0 ? edit.reason.trim() : "Revised.";
    out.push({ thread: thread.id, body: `${said} (${head.slice(0, 8)})`, resolve: saysFixed(edit.reason) });
  }
  return out;
}

function addressedOf(inputs: FunctionInputs): AddressedEdit[] {
  const raw = inputs["addressed"] ?? record(inputs["config"])["addressed"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const edit = record(entry);
    return typeof edit["path"] === "string" ? [{ path: edit["path"], ...(typeof edit["reason"] === "string" ? { reason: edit["reason"] } : {}) }] : [];
  });
}

async function answerThreads(provider: ForgeProvider, handle: RemoteHandle, addressed: readonly AddressedEdit[], head: string): Promise<number> {
  if (addressed.length === 0) return 0;
  const state = await provider.read(handle);
  const replies = threadReplies(state.threads, addressed, head);
  for (const reply of replies) await provider.reply(handle, reply.thread, reply.body, reply.resolve);
  return replies.length;
}

export async function reviewWithRemote(options: RemoteReviewOptions, inputs: FunctionInputs, ctx: unknown): Promise<Result> {
  const { taskId, handles, primitives } = options;
  const never = new AbortController();
  const plain = (given: Record<string, JsonValue>): Promise<Result> => options.ask(given, { onParked: () => undefined, signal: never.signal });
  const remote = remoteOf(inputs);
  if (remote === undefined) return plain(inputs as Record<string, JsonValue>);

  const config = record(inputs["config"]);
  const changeset = changesetInputOf(inputs as Record<string, unknown>).changeset;
  const prompt = String(inputs["prompt"] ?? config["prompt"] ?? "Review the proposed changes");
  const tree = inputs["tree"] ?? config["tree"];

  // --- publish: push, then open or find ------------------------------------------------------------
  let row: RemoteHandleRow;
  try {
    row = await primitives.publish(
      {
        ...inputs,
        remote: {
          title: options.taskTitle ?? prompt,
          description: describeReview(prompt, changeset),
          ...remote,
        },
        // A base tree has no commit to push; the proposal is materialized from the changeset.
        ...(tree === "base" && changeset !== undefined ? { tree: "base", changeset } : {}),
      } as unknown as FunctionInputs,
      ctx,
    );
  } catch (error) {
    const message = (error as Error).message;
    // "Review here only": the person declined to publish, which is an answer about the FORGE and not
    // about the review. The gate goes ahead as the local one it always was.
    if (/publishing was declined/.test(message)) return plain({ ...(inputs as Record<string, JsonValue>), remote: null });
    return { error: failureOf(new Error(`${REVIEW_ARTIFACTS}: ${message}`)) };
  }
  const handle = handleOfRow(row);
  if (handle === undefined) return { error: failureOf(new Error(`${REVIEW_ARTIFACTS}: the merge request could not be opened`)) };

  // --- a revise round says what it did, on the threads that asked ------------------------------------
  try {
    const told = await answerThreads(primitives.providerFor(row), handle, addressedOf(inputs), row.pushedHead ?? handle.head);
    if (told > 0) options.log(`replied on ${told} thread(s) the revision addressed`);
  } catch (error) {
    // The revision is pushed and the review goes on; a reply that could not be posted is a warning.
    options.log(`the revision was pushed, but its threads could not be answered: ${(error as Error).message}`);
  }

  // --- ask: the gate as today, and the same request on the forge -------------------------------------
  const settleAfter = typeof remote["settle_after"] === "string" ? parseDuration(remote["settle_after"]) : undefined;
  const parked = { ...(inputs as Record<string, JsonValue>), remote: { ...remote, ...handle, key: row.key } as unknown as JsonValue };
  const withdrawn = new AbortController();
  let parkedAs: string | undefined;
  const asked = options.ask(parked, {
    signal: withdrawn.signal,
    onParked: (requestId) => {
      parkedAs = requestId;
      handles.update(taskId, row.key, { awaiting: true, requestId, settleAfterMs: settleAfter ?? null });
      options.onAwaiting();
    },
  });
  // Whichever settles first answers. A host that delivers the forge's answer through `ask` has
  // nothing to race; one that cannot be answered from outside races the two here.
  let result: Result;
  if (options.forge === undefined) {
    result = await asked;
  } else {
    const forge = options.forge;
    const settled = (async (): Promise<Result> => {
      // Not until the question is actually out: a seeded answer parks nothing and races nothing.
      while (parkedAs === undefined) await new Promise((next) => setTimeout(next, 5));
      return { value: (await forge(row, parkedAs)) as ResolvedValue };
    })();
    result = await Promise.race([asked, settled]);
    withdrawn.abort();
    // The loser's promise is abandoned, not awaited: a withdrawn terminal prompt rejects, and that
    // rejection is nobody's error.
    void asked.catch(() => undefined);
  }

  const stop = (): void => void handles.update(taskId, row.key, { awaiting: false, requestId: null, settleAt: null });
  if ("error" in result && result.error !== undefined) {
    // A shutdown, not an answer: the row stays awaited and the question stays open, so the forge can
    // still settle it while no run is live. A CANCEL clears the rows on its own path.
    return result;
  }

  const value = { ...record((result as { value?: unknown }).value) };
  const by = record(value["settled_by"]);

  // --- the forge answered -------------------------------------------------------------------------
  if (by["via"] === "remote") {
    stop();
    if (by["effect"] === "adopt") {
      try {
        const report: AdoptReport = await primitives.adopt(handles.get(taskId, row.key) ?? row, options.workspace.root, options.workspace.isWorktree);
        value["remote"] = { ...record(value["remote"]), head: report.head, adopted: report };
      } catch (error) {
        // The review IS settled — the merge happened on the forge. Failing the state here would
        // throw that away over a local git problem, so the problem is reported beside the answer.
        value["remote"] = { ...record(value["remote"]), adopted: { reset: false, target: "left-alone", why: (error as Error).message } };
        options.log(`could not adopt the merged history: ${(error as Error).message}`);
      }
    }
    return { value: value as ResolvedValue };
  }

  // --- the person answered here -------------------------------------------------------------------
  stop();
  const who = await options.who().catch(() => undefined);
  try {
    const provider = primitives.providerFor(row);
    for (const decision of (Array.isArray(value["decisions"]) ? value["decisions"] : []) as ChangeDecision[]) {
      const change = changeset?.changes.find((c) => c.id === decision.id);
      if (change === undefined) continue;
      // Only what the forge has not already got: a note that came FROM it carries its source.
      for (const note of (decision.notes ?? []).filter((n) => n.source === undefined)) {
        await provider.comment(handle, note.body, anchorOfNote(note, change));
      }
      if (decision.comment !== undefined && decision.comment.trim().length > 0) await provider.comment(handle, `\`${change.path}\` — ${decision.comment}`);
    }
    if (typeof value["comments"] === "string" && value["comments"].trim().length > 0) await provider.comment(handle, value["comments"]);
    await provider.comment(handle, closingComment(who, value));
  } catch (error) {
    // The decision was made and stands. A forge that could not be told is a warning, not a failure.
    options.log(`the review was answered, but ${row.host} could not be told: ${(error as Error).message}`);
  }
  value["settled_by"] = { via: "local", ...(who !== undefined ? { who } : {}), act: "answered" };
  value["remote"] = { ...handle, key: row.key };
  return { value: value as ResolvedValue };
}
