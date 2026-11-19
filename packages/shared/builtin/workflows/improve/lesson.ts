/**
 * Improve a workflow from ONE lesson (decision 0029 §3, §5): read where the correction happened, find
 * what owns the behaviour, choose the lever the lesson needs, write the change as whole files, have it
 * reviewed (by default), and apply it — where JaiRA, not the model, writes and re-validates the files.
 *
 * Callable from anywhere: a conversation's program starts it on a clear correction, the end-of-
 * conversation review calls it for each lesson it found, and a person can start it with a lesson typed
 * in. `workflow` may be null: then the conversation in `context` says which workflow was running.
 */
import { llm } from "@declarative-ai/hw/script";
import { apply_change, choose_option, conversation_digest, lessons_list, workflow_source } from "$REGISTRY";
import { AUTHOR, brief, describe, type Plan } from "./author";

export const meta = {
  name: "Improve from a lesson",
  description: "Turn one correction into a change to the workflow that needed it — instructions, a skill, a call's model or effort, how sessions are used, splitting the work, a step, a deterministic check, a loop, consensus, routing, or a permission — reviewed before it is applied unless approval says otherwise.",
};

export default async function improve(
  lesson: string,
  workflow: string | null = null,
  context: { task?: string; session?: { id: string } } = {},
  approval: string = "propose",
  scope: string = "project",
): Promise<{ status: string; rule: string; lever: string; written: string[]; lessonFile: string; reason: string; proposal: unknown }> {
  const digest = await conversation_digest({ task: context.task, session: context.session, last: 16 });
  const source = await workflow_source({ workflow: workflow, task: digest.task });
  const known = await lessons_list({ scope: scope });
  let feedback = "";
  let attempt = 0;
  while (attempt < 3) {
    attempt = attempt + 1;
    const plan = await llm<Plan>({ prompt: brief(lesson, digest, source, known, feedback), system: AUTHOR, label: "author" });
    if (!plan.lesson || plan.files.length === 0) {
      return { status: "nothing", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: plan.why, proposal: null };
    }
    if (approval === "return") {
      return { status: "proposed", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: plan.summary, proposal: plan };
    }
    if (approval === "propose") {
      const review = await choose_option({
        prompt: describe(plan),
        options: [
          { value: "apply", label: "Apply", description: "Write these files; the workflow changes from its next use." },
          { value: "revise", label: "Revise", description: "Send it back with your comment." },
          { value: "discard", label: "Discard", description: "Change nothing." },
        ],
        comments: true,
      });
      if (review.decision === "discard") {
        return { status: "discarded", rule: plan.rule, lever: plan.lever, written: [], lessonFile: "", reason: String(review.comment ?? ""), proposal: plan };
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
      return { status: "applied", rule: plan.rule, lever: plan.lever, written: applied.written, lessonFile: applied.lesson, reason: plan.summary, proposal: plan };
    }
    feedback = "Your last proposal was not applied: " + JSON.stringify(applied.problems ?? applied.refused) + ". Fix it.";
  }
  return { status: "failed", rule: lesson, lever: "", written: [], lessonFile: "", reason: feedback, proposal: null };
}
