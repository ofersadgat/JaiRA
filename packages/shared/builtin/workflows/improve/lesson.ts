/**
 * Improve a workflow from ONE lesson (decision 0029 §3, §5): read where the correction happened, find
 * what owns the behaviour, choose the lever the lesson needs, write the change as whole files, TRY it
 * where the correction was made, have it reviewed (by default), and apply it — where JaiRA, not the
 * model, writes and re-validates the files.
 *
 * Trying it (`simulate`, §5 step 5): the conversation is forked at the message whose reply the person
 * corrected, the fork is handed the change — read as if written, written nowhere — and the message is
 * sent again, for one pass in a throwaway copy of the workspace, under a set that cannot write outside
 * it, push or publish, with nobody to ask. A judge reads what the conversation did then: if the person
 * would still have had to say it, the change goes back to be written again.
 *
 * Callable from anywhere: a conversation's program starts it on a clear correction, and a person can
 * start it with a lesson typed in. `workflow` may be null: then the conversation in `context` says which
 * workflow was running.
 */
import { llm } from "@declarative-ai/hw/script";
import { apply_change, choose_option, conversation_digest, decline_change, lessons_list, simulate_change, workflow_source } from "$REGISTRY";
import { AUTHOR, brief, describe, describeTried, JUDGE, judgeBrief, type Judgement, type Plan, type Tried } from "./author";

export const meta = {
  name: "Improve from a lesson",
  description: "Turn one correction into a change to the workflow that needed it — instructions, a skill, a call's model or effort, how sessions are used, splitting the work, a step, a deterministic check, a loop, consensus, routing, or a permission — tried first on a copy of the conversation where it was made, and reviewed before it is applied unless approval says otherwise.",
};

export default async function improve(
  lesson: string,
  workflow: string | null = null,
  context: { task?: string; session?: { id: string } } = {},
  approval: string = "propose",
  scope: string = "project",
  // Try the change on the conversation before offering it — by default whenever `context` names where
  // in it the correction was made.
  simulate: boolean | null = null,
): Promise<{ status: string; rule: string; lever: string; written: string[]; lessonFile: string; reason: string; proposal: unknown; tried: unknown }> {
  const digest = await conversation_digest({ task: context.task, session: context.session, last: 16 });
  const source = await workflow_source({ workflow: workflow, task: digest.task });
  const known = await lessons_list({ scope: scope });
  const trying = simulate === null ? context.session !== undefined && context.session !== null : simulate;
  let feedback = "";
  let attempt = 0;
  while (attempt < 3) {
    attempt = attempt + 1;
    const plan = await llm<Plan>({ prompt: brief(lesson, digest, source, known, feedback), system: AUTHOR, label: "author" });
    if (!plan.lesson || plan.files.length === 0) {
      return { status: "nothing", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: plan.why, proposal: null, tried: null };
    }
    // Tried where the correction was made, before anybody is asked to agree to it (§5 step 5).
    let tried: Tried | null = null;
    let verdict: Judgement | null = null;
    if (trying) {
      // Through a typed `const`: a registry call answers `any`, and `any` assigned to `tried` would leave
      // it `Tried | null` below, where it is never null.
      const trial: Tried = await simulate_change({ files: plan.files, lesson: plan.rule, scope: scope, context: { task: digest.task, session: context.session } });
      tried = trial;
      if (tried.simulated && tried.version !== undefined && tried.version.kind === "declined") {
        // The conversation running when the change lands could not switch to it: it would reach only
        // the next one. That is the change's to fix.
        feedback = "Your change was tried on the conversation, and a running conversation could not switch to it: " + String(tried.version.reason ?? "") + ". Keep what is alive across the wait for the next message — the variables the loop carries — the same in both versions.";
        if (attempt < 3) continue;
      } else if (tried.simulated && tried.version !== undefined && tried.version.taken) {
        verdict = await llm<Judgement>({ prompt: judgeBrief(lesson, plan, tried), system: JUDGE, label: "judge" });
        if (verdict.stillNeeded && attempt < 3) {
          feedback = "Your change was tried: the message was sent again to a copy of the conversation running it, and the person would STILL have had to make the correction — " + verdict.why + "\n\nWhat the conversation did with your change:\n" + JSON.stringify(tried.after, null, 2);
          continue;
        }
      }
    }
    // A change the trial says does not hold is never applied without a person.
    const unproven = verdict !== null && verdict.stillNeeded;
    if (approval === "return" || (approval === "auto" && unproven)) {
      return { status: approval === "return" ? "proposed" : "unproven", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: unproven ? verdict!.why : plan.summary, proposal: plan, tried: tried };
    }
    if (approval === "propose") {
      const trial = describeTried(tried, verdict);
      // The prompt is the gate's heading, so it stays the question; the proposal is the Markdown body.
      const review = await choose_option({
        prompt: "Apply this change to " + plan.target + "?",
        body: describe(plan) + (trial.length > 0 ? "\n\n" + trial : ""),
        options: [
          { value: "apply", label: "Apply", description: "Write these files; the workflow changes from its next use." },
          { value: "revise", label: "Revise", description: "Send it back with your comment." },
          { value: "discard", label: "Discard", description: "Change nothing." },
        ],
        comments: true,
      });
      if (review.decision === "discard") {
        // Turned down: on record as such, so the next proposal for it knows, and so it is counted.
        await decline_change({
          lesson: { rule: plan.rule, lever: plan.lever, target: plan.target, why: plan.why, quote: lesson, task: digest.task, session: context.session ? context.session.id : undefined },
          scope: scope,
          comment: String(review.comment ?? ""),
        });
        return { status: "discarded", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: String(review.comment ?? ""), proposal: plan, tried: tried };
      }
      if (review.decision === "revise") {
        feedback = "The person reviewed it and asked for a revision: " + String(review.comment ?? "(no comment)");
        continue;
      }
    }
    const applied = await apply_change({
      files: plan.files,
      lesson: { rule: plan.rule, lever: plan.lever, target: plan.target, why: plan.why, quote: lesson, task: digest.task, session: context.session ? context.session.id : undefined },
      scope: scope,
    });
    if (applied.ok) {
      return { status: "applied", rule: plan.rule, lever: plan.lever, written: applied.written, lessonFile: applied.lesson, reason: plan.summary, proposal: plan, tried: tried };
    }
    feedback = "Your last proposal was not applied: " + JSON.stringify(applied.problems ?? applied.refused) + ". Fix it.";
  }
  return { status: "failed", rule: lesson, lever: "", written: [], lessonFile: "", reason: feedback, proposal: null, tried: null };
}
