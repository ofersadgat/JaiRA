/**
 * `review_artifacts` with a `remote` (decision 0004 §3): two doors, one answer.
 *
 * With no `remote` — none written, none inherited, or `null` — the gate is local only, exactly as it
 * always was, and this module does nothing but park it. With one, the gate parks EXACTLY as it does
 * today and the same request also lives on the forge: the review is pushed, a merge request is
 * opened (or found — a loop's next round gets the same one), the row is marked awaited with the
 * gate's request id, and then whichever side settles first answers the state.
 *
 *  - **The forge settles it** → the watcher submits the settlement to the hub, this function wakes
 *    with it, and — when the request was MERGED — adopts the forge's history before returning.
 *  - **The person settles it here** → the row stops being awaited, the notes they wrote are posted as
 *    inline threads, and one closing comment says what was decided. Approve at the gate does not
 *    merge the request; what happens to it afterwards is the workflow's to say.
 *
 * Both halves of the adoption and the telling live HERE, after the park, rather than in whoever
 * answered — because the answer may arrive as a seed on a resumed run, days later, in a process that
 * was not there when it was given.
 */
import { failureOf, type FunctionInputs, type FunctionResult, type JsonValue, type ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { REVIEW_ARTIFACTS, type AdoptReport, type InteractionHub, type RemotePrimitives } from "@jaira/runtime";
import {
  changesetInputOf,
  handleOfRow,
  parseDuration,
  type Change,
  type ChangeDecision,
  type Changeset,
  type ForgeAnchor,
  type RemoteHandlePort,
  type RemoteHandleRow,
  type ReviewNote,
} from "@jaira/shared";

type Result = FunctionResult<ResolvedValue, WorkflowMetrics>;

export interface RemoteReviewOptions {
  taskId: string;
  taskTitle?: string;
  hub: InteractionHub;
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

export async function reviewWithRemote(options: RemoteReviewOptions, inputs: FunctionInputs, ctx: unknown): Promise<Result> {
  const { hub, taskId, handles, primitives } = options;
  const remote = remoteOf(inputs);
  if (remote === undefined) return hub.ask(REVIEW_ARTIFACTS, inputs as Record<string, JsonValue>, taskId);

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
    if (/publishing was declined/.test(message)) return hub.ask(REVIEW_ARTIFACTS, { ...(inputs as Record<string, JsonValue>), remote: null }, taskId);
    return { error: failureOf(new Error(`${REVIEW_ARTIFACTS}: ${message}`)) };
  }
  const handle = handleOfRow(row);
  if (handle === undefined) return { error: failureOf(new Error(`${REVIEW_ARTIFACTS}: the merge request could not be opened`)) };

  // --- park: the gate as today, and the same request on the forge ------------------------------------
  const settleAfter = typeof remote["settle_after"] === "string" ? parseDuration(remote["settle_after"]) : undefined;
  const parked = { ...(inputs as Record<string, JsonValue>), remote: { ...remote, ...handle, key: row.key } as unknown as JsonValue };
  const result = await hub.ask(REVIEW_ARTIFACTS, parked, taskId, (requestId) => {
    handles.update(taskId, row.key, { awaiting: true, requestId, settleAfterMs: settleAfter ?? null });
    options.onAwaiting();
  });

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
