/**
 * Review a whole conversation for lessons (decision 0029 §6): run when the conversation ends or sits
 * idle. It sees what one message cannot — the same small correction made several times, the person
 * redoing something themselves, a correction that only makes sense in context — and turns each lesson
 * into a change the way `improve/lesson` does (`./author`), gathered into ONE review rather than one per
 * lesson.
 */
import { llm } from "@declarative-ai/hw/script";
import { apply_change, choose_option, conversation_digest, lessons_list, workflow_source } from "$REGISTRY";
import { AUTHOR, brief, describe, type Plan } from "./author";

export const meta = {
  name: "Review a conversation for lessons",
  description: "Read a finished (or idle) conversation for the corrections the person made, propose a change for each lesson, and apply what the person accepts in one review.",
};

const FIND = `You read a conversation between a person and an agent, looking for LESSONS: corrections the person made that the workflow should take into account so they never have to make them again.

A lesson is a correction of how the agent works — "you keep doing X", "don't do Y", "always check Z first", the person redoing something the agent did, the same small fix asked for more than once, a tool call they refused, a message they edited and sent again because of what the agent did with it. It is NOT a new request, a change of mind about this task, or a fact about this one task.

Lessons already on record are listed: do not report one again unless it happened again here (then say so in the lesson). Report each lesson once, as one sentence a reviewer would accept as a rule, with the person's words that showed it. Report none when there are none — most conversations have none.`;

export default async function review(
  context: { task?: string; session?: { id: string } } = {},
  approval: string = "propose",
  scope: string = "project",
): Promise<{ found: number; applied: number; statuses: string[] }> {
  const digest = await conversation_digest({ task: context.task, session: context.session });
  const known = await lessons_list({ scope: scope });
  const found = await llm<{ lessons: Array<{ lesson: string; quote: string }> }>({
    prompt:
      "## Lessons on record\n\n" + JSON.stringify(known, null, 2) +
      "\n\n## The conversation\n\n" + JSON.stringify(digest.messages, null, 2) +
      "\n\n## What the record says the person did\n\nTool calls they refused, and messages they edited and sent again (with the replies they replaced):\n\n" + JSON.stringify(digest.signals, null, 2),
    system: FIND,
    label: "find lessons",
  });
  const source = await workflow_source({ workflow: digest.workflow, task: digest.task });
  let proposals: Array<{ plan: Plan; quote: string }> = [];
  let statuses: string[] = [];
  for (const one of found.lessons) {
    const plan = await llm<Plan>({ prompt: brief(one.lesson, digest, source, known, ""), system: AUTHOR, label: "author" });
    if (!plan.lesson || plan.files.length === 0) {
      statuses = [...statuses, "nothing"];
      continue;
    }
    if (approval === "auto") {
      const done = await apply_change({ files: plan.files, lesson: { rule: plan.rule, lever: plan.lever, target: plan.target, why: plan.why, quote: one.quote, task: digest.task }, scope: scope });
      statuses = [...statuses, done.ok ? "applied" : "failed"];
      continue;
    }
    proposals = [...proposals, { plan: plan, quote: one.quote }];
    statuses = [...statuses, "proposed"];
  }
  if (proposals.length === 0) return { found: found.lessons.length, applied: statuses.filter((s) => s === "applied").length, statuses };
  // One review for everything this conversation taught: apply all, or none.
  const listed = proposals.map((p, i) => "## " + (i + 1) + ".\n\n" + describe(p.plan)).join("\n\n");
  const decision = await choose_option({
    prompt: "This conversation taught " + proposals.length + " lesson(s):\n\n" + listed,
    options: [
      { value: "apply", label: "Apply all", description: "Write every change listed." },
      { value: "discard", label: "Discard", description: "Change nothing." },
    ],
    comments: true,
  });
  let applied = 0;
  if (decision.decision === "apply") {
    for (const p of proposals) {
      const done = await apply_change({ files: p.plan.files, lesson: { rule: p.plan.rule, lever: p.plan.lever, target: p.plan.target, why: p.plan.why, quote: p.quote, task: digest.task }, scope: scope });
      statuses = [...statuses, done.ok ? "applied" : "failed"];
      if (done.ok) applied = applied + 1;
    }
  }
  return { found: found.lessons.length, applied, statuses };
}
