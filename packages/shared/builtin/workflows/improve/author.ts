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

export function brief(lesson: string, digest: unknown, source: unknown, known: unknown, feedback: string): string {
  return [
    "## The lesson",
    lesson,
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
