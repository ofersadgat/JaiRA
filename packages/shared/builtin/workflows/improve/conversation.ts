/**
 * Review a whole conversation for lessons (decision 0029 §6): run when the conversation ends or sits
 * idle. It sees what one message cannot — the same small correction made several times, the person
 * redoing something themselves, a correction that only makes sense in context — and turns each lesson
 * into a change the way `improve/lesson` does (`./author`) — tried first on a copy of the conversation
 * at the message the person corrected, found by their words (§5 step 5) — gathered into ONE review
 * rather than one per lesson.
 */
import { llm } from "@declarative-ai/hw/script";
import { apply_change, choose_option, conversation_digest, decline_change, lessons_list, simulate_change, workflow_source } from "$REGISTRY";
import { AUTHOR, brief, describe, describeTried, JUDGE, judgeBrief, type Judgement, type Plan, type Tried } from "./author";

export const meta = {
  name: "Review a conversation for lessons",
  description: "Read a finished (or idle) conversation for the corrections the person made, propose a change for each lesson, and apply what the person accepts in one review.",
};

const FIND = `You read a conversation between a person and an agent, looking for LESSONS: corrections the person made that the workflow should take into account so they never have to make them again.

A lesson is a correction of how the agent works — "you keep doing X", "don't do Y", "always check Z first", the person redoing something the agent did, the same small fix asked for more than once, a tool call they refused, a message they edited and sent again because of what the agent did with it. It is NOT a new request, a change of mind about this task, or a fact about this one task.

Lessons already on record are listed: do not report one again unless it happened again here (then say so in the lesson). One whose status is "declined" was proposed before and the person turned the change down — report it again only if it clearly happened again. Report each lesson once, as one sentence a reviewer would accept as a rule, with the person's words that showed it. Report none when there are none — most conversations have none.

Lessons the person's OTHER projects have learned are listed too, each naming its project. When a lesson you report is one of those — the same rule, learned again here — name that project in \`elsewhere\`: it is a lesson about how they work everywhere, and belongs to every project rather than to each one.`;

export default async function review(
  // `maybes`: what the conversation's strict check noted as possibly a correction, message by message.
  context: { task?: string; session?: { id: string }; maybes?: Array<{ lesson: string; quote: string }> } = {},
  // How each change is applied: "propose" puts every one in one review for the person; "auto" applies
  // those its trial showed to hold and puts the unclear ones in the review; "accept" applies them all
  // without asking.
  approval: "propose" | "auto" | "accept" = "propose",
  scope: string = "project",
  // Try each change on the conversation before offering it (§5 step 5).
  simulate: boolean = true,
): Promise<{ found: number; applied: number; statuses: string[] }> {
  const digest = await conversation_digest({ task: context.task, session: context.session });
  const known = await lessons_list({ scope: scope });
  // What other projects have learned (decision 0029 §7): a lesson learned twice is the person's, not a project's.
  const elsewhere = await lessons_list({ elsewhere: true });
  const found = await llm<{ lessons: Array<{ lesson: string; quote: string; elsewhere?: string }> }>({
    prompt:
      "## Lessons on record\n\n" + JSON.stringify(known, null, 2) +
      "\n\n## Lessons the person's other projects have learned\n\n" + JSON.stringify(elsewhere, null, 2) +
      "\n\n## The conversation\n\n" + JSON.stringify(digest.messages, null, 2) +
      "\n\n## What the record says the person did\n\nTool calls they refused, messages they edited and sent again (with the replies they replaced), what they took back with a rewind, replies they redirected, and gates or changes they turned down or commented on:\n\n" + JSON.stringify(digest.signals, null, 2) +
      "\n\n## Noted during the conversation as possibly a correction\n\nEach was a \"maybe\" when it was said: decide now, with the whole conversation in view.\n\n" + JSON.stringify(context.maybes ?? [], null, 2),
    system: FIND,
    label: "find lessons",
  });
  const source = await workflow_source({ workflow: digest.workflow, task: digest.task });
  let proposals: Array<{ plan: Plan; quote: string; layer: string; also: string; trial: string }> = [];
  let statuses: string[] = [];
  for (const one of found.lessons) {
    // Learned in another project too: written for every project — the person's own layer, Shared.
    const promoted = typeof one.elsewhere === "string" && one.elsewhere.length > 0;
    const layer = promoted ? "shared" : scope;
    const note = promoted ? "The project '" + one.elsewhere + "' learned this lesson too: write the change for EVERY project, in the Shared layer (~/.jaira) — its paths are relative to that layer's root, as they would be to a project's." : "";
    let feedback = "";
    let plan = await llm<Plan>({ prompt: brief(one.lesson, digest, source, known, feedback, note), system: AUTHOR, label: "author" });
    // Tried at the message the person corrected — found by their words — and written once more when
    // the person would still have had to say it (§5 step 5).
    let tried: Tried | null = null;
    let verdict: Judgement | null = null;
    let attempt = 0;
    while (simulate && plan.lesson && plan.files.length > 0 && attempt < 2) {
      attempt = attempt + 1;
      // Through a typed `const`: a registry call answers `any`, and `any` assigned to `tried` would leave
      // it `Tried | null` below, where it is never null.
      const trial: Tried = await simulate_change({ files: plan.files, lesson: plan.rule, scope: layer, context: { task: digest.task, quote: one.quote } });
      tried = trial;
      verdict = null;
      if (tried.simulated && tried.version !== undefined && tried.version.kind === "declined") {
        feedback = "Your change was tried on the conversation, and a running conversation could not switch to it: " + String(tried.version.reason ?? "") + ". Keep what is alive across the wait for the next message the same in both versions.";
      } else if (tried.simulated && tried.version !== undefined && tried.version.taken) {
        verdict = await llm<Judgement>({ prompt: judgeBrief(one.lesson, plan, tried), system: JUDGE, label: "judge" });
        if (!verdict.stillNeeded) break;
        feedback = "Your change was tried: the message was sent again to a copy of the conversation running it, and the person would STILL have had to make the correction — " + verdict.why + "\n\nWhat the conversation did with your change:\n" + JSON.stringify(tried.after, null, 2);
      } else {
        break;
      }
      if (attempt >= 2) break;
      plan = await llm<Plan>({ prompt: brief(one.lesson, digest, source, known, feedback, note), system: AUTHOR, label: "author" });
    }
    if (!plan.lesson || plan.files.length === 0) {
      statuses = [...statuses, "nothing"];
      continue;
    }
    // Whether the trial showed the change holds; anything short of that — not tried, or tried and still
    // needed — is unclear, and `auto` puts it in the review with the rest. `accept` applies it regardless.
    const held = verdict !== null && !verdict.stillNeeded;
    if (approval === "accept" || (approval === "auto" && held)) {
      const done = await apply_change({ files: plan.files, lesson: { rule: plan.rule, lever: plan.lever, target: plan.target, why: plan.why, quote: one.quote, task: digest.task }, scope: layer });
      statuses = [...statuses, done.ok ? "applied" : "failed"];
      continue;
    }
    proposals = [...proposals, { plan: plan, quote: one.quote, layer: layer, also: promoted ? String(one.elsewhere) : "", trial: describeTried(tried, verdict) }];
    statuses = [...statuses, "proposed"];
  }
  if (proposals.length === 0) return { found: found.lessons.length, applied: statuses.filter((s) => s === "applied").length, statuses };
  // One review for everything this conversation taught: apply all, or none. The prompt is the gate's
  // heading, so it stays a short question; the proposals are the Markdown body (as in improve/lesson).
  const items = proposals.map((p) => (p.also.length > 0 ? "Learned in '" + p.also + "' too — proposed for every project (Shared).\n\n" : "") + describe(p.plan) + (p.trial.length > 0 ? "\n\n" + p.trial : ""));
  const listed = items.length === 1 ? items[0] : items.map((text, i) => "## " + (i + 1) + ".\n\n" + text).join("\n\n");
  const decision = await choose_option({
    prompt: proposals.length === 1 ? "Apply this change to " + proposals[0].plan.target + "?" : "Apply the " + proposals.length + " changes this conversation taught?",
    body: listed,
    options: [
      { value: "apply", label: "Apply all", description: "Write every change listed." },
      { value: "discard", label: "Discard", description: "Change nothing." },
    ],
    comments: true,
  });
  let applied = 0;
  for (const p of proposals) {
    const lesson = { rule: p.plan.rule, lever: p.plan.lever, target: p.plan.target, why: p.plan.why, quote: p.quote, task: digest.task };
    if (decision.decision === "apply") {
      const done = await apply_change({ files: p.plan.files, lesson: lesson, scope: p.layer });
      statuses = [...statuses, done.ok ? "applied" : "failed"];
      if (done.ok) applied = applied + 1;
    } else {
      // Turned down: on record as such, so the next proposal for it knows, and so it is counted.
      await decline_change({ lesson: lesson, scope: p.layer, comment: String(decision.comment ?? "") });
      statuses = [...statuses, "declined"];
    }
  }
  return { found: found.lessons.length, applied, statuses };
}
