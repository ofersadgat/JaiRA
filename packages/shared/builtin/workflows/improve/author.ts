/**
 * What `improve/lesson` and `improve/conversation` share (decision 0029 §5): how a change is authored
 * from a lesson, and how a proposed change is shown to the person reviewing it. A helper module — no
 * `meta` — so it is code the two scripts import, not a workflow of its own.
 */

export const AUTHOR = `You improve JaiRA workflows from the corrections a person makes, so they never have to make the same correction twice.

You are given: the lesson (what the person corrected), the conversation where it happened, the files that define the workflow that was running (and whether that layer can be written), the instructions files, the skills, and the lessons already on record.

Choose the LEVER the lesson needs. The kind of lesson picks the family:
- "never do X" that a tool, command or place can express -> a permission-set line (permission).
- something code can decide (tests pass, a file exists, a format holds) -> a deterministic check: a function or script the workflow runs, its result routed into a step (check), with a loop back if it must converge (loop).
- a procedure that must happen at a fixed point -> another call in the workflow after the reply (step).
- knowledge about one kind of work -> a skill (skills/<name>/SKILL.md).
- a general preference -> instructions (instructions.md).
- "it needed more thinking" or "another model is better at this" -> the options of the call (call).
- "it got lost in a long context" -> where sessions are forked, fresh or summarized (session).
- "it did three of the five things" -> ask for the list as structured output and handle each item on a forked session, in parallel or in turn (decomposition).
- "one model keeps missing this" -> several agents or models, then a merge or a vote (consensus).
- "for this kind of work, follow that process" -> a sub-workflow, plus routing to it (routing).
Start a NEW lesson at the cheapest lever of its family. When the same lesson is already on record and its fix WAS in effect, move it to a more certain lever of the same family. When its fix was NOT in effect (a skill that was never loaded, a step that never ran), fix how it is delivered instead (a sharper skill description, the step's condition).

Where a conversation's behaviour lives: \`session\` — its system prompt, the reply, what it checks after replying, when it waits for the next message. A running conversation takes a changed \`session\` at its next wait for a message (\`input()\`), as long as what is alive across that wait — the variables the loop carries from one message to the next — is the same in both versions; so keep those, and put a new step's values in variables of its own inside the loop.

Write the change as WHOLE files, each a path relative to a layer root. Only these paths may be written: workflows/..., prompts/..., skills/..., functions/..., permission-sets/..., lessons/... and instructions.md. A file you change you rewrite whole, keeping what it said that the lesson does not change.
- A workflow from the built-in layer is read-only: write your version at the same path (its "override"), which wins.
- A workflow script (.ts) is a program: change the code itself (another llm() call, a loop, parallel(), a check). Keep its signature, so a running conversation can switch to it.
- A JSON state from the built-in layer can be overridden by a file holding {"$ref": "$SYSTEM/workflows/<id>"} with the changed keys beside it.
- A skill opens with frontmatter: name (lowercase letters, digits, hyphens, at most 64) and description (what it is for and WHEN to use it — that is what decides whether it is loaded).
- instructions.md is read by every call: add a short, specific line; never restate what is already there.
Make the smallest change that would have prevented the correction. If the correction is not a lesson about the workflow at all (a new request, a change of mind, a one-off fact about this task), answer lesson: false and no files.`;

/** A proposed change, as the author writes it. */
export interface Plan {
  /** Whether this is a lesson about the workflow at all. */
  lesson: boolean;
  /** The lesson as one rule, in a sentence. */
  rule: string;
  lever: string;
  /** What the change targets: a workflow id, a skill name, "instructions", a permission set. */
  target: string;
  /** Why this lever, in a sentence or two. */
  why: string;
  /** What the change does, for the person reviewing it. */
  summary: string;
  files: Array<{ path: string; content: string }>;
}

export function brief(lesson: string, digest: unknown, source: unknown, known: unknown, feedback: string, where: string = ""): string {
  return [
    "## The lesson",
    lesson,
    ...(where.length > 0 ? ["## Where the change belongs", where] : []),
    "## The conversation where it happened (most recent last)",
    JSON.stringify(digest, null, 2),
    "## The workflow that was running, its instructions and skills",
    JSON.stringify(source, null, 2),
    "## Lessons already on record",
    JSON.stringify(known, null, 2),
    ...(feedback.length > 0 ? ["## About your last proposal", feedback] : []),
  ].join("\n\n");
}

export function describe(plan: Plan): string {
  const files = plan.files.map((f) => "### " + f.path + "\n\n```\n" + f.content + "\n```").join("\n\n");
  return "**Lesson:** " + plan.rule + "\n\n**Lever:** " + plan.lever + " — " + plan.why + "\n\n" + plan.summary + "\n\n" + files;
}

/** What `simulate_change` answers (decision 0029 §5 step 5). */
export interface Tried {
  /** Whether a pass was made at all; when not, `reason` says why. */
  simulated: boolean;
  reason?: string;
  /** The message sent again — the one whose reply the person corrected. */
  message?: string;
  /** What the conversation said and did the first time, which the person then corrected. */
  before?: unknown;
  /** What it said and did with the change. */
  after?: unknown;
  /** Whether the pass ran the change: `taken`, `declined` (a running conversation could not take it), or `unchanged` (the change is not to this conversation's own workflow). */
  version?: { taken: boolean; kind: string; reason?: string };
  /** Where the pass stopped. */
  ended?: string;
}

/** The judge's reading of a pass. */
export interface Judgement {
  /** Whether the person would STILL have had to make the correction. */
  stillNeeded: boolean;
  /** Why, in a sentence or two, pointing at what the pass said or did. */
  why: string;
}

export const JUDGE = `You judge whether a change to a workflow fixed what a person had to correct.

You are given the lesson (the correction the person made), the message they had sent, what the conversation said and did in answer to it the first time — which the person then corrected — and what it said and did when the same message was sent again with the change in place. The second time ran in a sandbox: it could not ask anybody anything, start other work, or write outside a throwaway copy of the workspace, so a call refused for one of those reasons says what it TRIED to do.

Answer stillNeeded: true when the person would still have had to make the same correction after this answer — the behaviour they corrected is still there, or the change made it worse. Answer false when the answer no longer gives them a reason to say it. Judge the corrected behaviour only, not the answer's other qualities.`;

/** What the judge is shown. */
export function judgeBrief(lesson: string, plan: Plan, tried: Tried): string {
  return [
    "## The lesson",
    lesson,
    "## The change",
    plan.summary,
    "## The message the person had sent",
    String(tried.message ?? ""),
    "## What the conversation did the first time (the person corrected this)",
    JSON.stringify(tried.before ?? [], null, 2),
    "## What it did with the change",
    JSON.stringify(tried.after ?? [], null, 2),
    "## Where that pass stopped",
    String(tried.ended ?? ""),
  ].join("\n\n");
}

/** The text a pass's turns say, run together and cut short. */
function saidIn(turns: unknown): string {
  const text = (Array.isArray(turns) ? turns : [])
    .map((turn) => (turn !== null && typeof turn === "object" && typeof (turn as { text?: unknown }).text === "string" && (turn as { role?: unknown }).role !== "user" ? String((turn as { text: string }).text) : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return text.length > 1200 ? text.slice(0, 1200) + "…" : text;
}

/** How a simulation reads in a review — or nothing, when none was made. */
export function describeTried(tried: Tried | null, verdict: Judgement | null): string {
  if (tried === null) return "";
  if (!tried.simulated) return "**Not tried first:** " + String(tried.reason ?? "");
  if (tried.version !== undefined && !tried.version.taken) return "**Not tried first:** " + String(tried.version.reason ?? "");
  const said = saidIn(tried.after);
  const outcome =
    verdict === null
      ? ""
      : verdict.stillNeeded
        ? "**It would still have needed the correction:** " + verdict.why
        : "**It no longer needed the correction:** " + verdict.why;
  return "**Tried first** on a copy of the conversation, sending again: \"" + String(tried.message ?? "") + "\"\n\n" + outcome + (said.length > 0 ? "\n\nWhat it answered with the change:\n\n> " + said.split("\n").join("\n> ") : "");
}
