/**
 * The functions a workflow that LEARNS calls (decision 0029 §3–§5): what a conversation said and
 * which of its turns the person corrected, the files that define the workflow being improved, the
 * lessons already on record, and the one place a change is WRITTEN.
 *
 * They are host functions a script imports from `$REGISTRY` — `session`, `improve/lesson` and
 * `improve/conversation` call them — and they are the whole of what an improver can touch outside
 * its own model calls. In particular a model never writes a file: it PROPOSES files, and
 * `apply_change` (JaiRA's code) decides whether each path is one a lesson may change, writes it,
 * re-validates what it wrote, and puts everything back if the result does not load.
 */
import { hostFunction, type CapabilityRegistry, type FunctionInputs, type FunctionResult, type ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";

export const CONVERSATION_DIGEST = "conversation_digest";
export const WORKFLOW_SOURCE = "workflow_source";
export const LESSONS_LIST = "lessons_list";
export const APPLY_CHANGE = "apply_change";
export const DECLINE_CHANGE = "decline_change";
export const SIMULATE_CHANGE = "simulate_change";

/** Every function this module registers. */
export const IMPROVE_FUNCTIONS: readonly string[] = [CONVERSATION_DIGEST, WORKFLOW_SOURCE, LESSONS_LIST, APPLY_CHANGE, DECLINE_CHANGE, SIMULATE_CHANGE];

/** One file a change proposes: a path under a layer root, and its whole new content. */
export interface ChangeFile {
  path: string;
  content: string;
}

/** Which layer a lesson and its change live in (decision 0029 §7). */
export type LessonScope = "project" | "shared";

/** What a lesson records about itself — the frontmatter of `lessons/<slug>.md`. */
export interface LessonRecord {
  rule: string;
  /** The lever the change uses: instructions, skill, call, session, decomposition, step, check, loop, consensus, routing, permission. */
  lever: string;
  /** What the change targets — a workflow id, a skill name, `instructions`, a permission set. */
  target: string;
  /** Why the lesson exists, in a sentence or two — the body of the file. */
  why?: string;
  /** The person's words that showed it. */
  quote?: string;
  /** Where it happened. */
  task?: string;
  session?: string;
}

/** What a host must answer for these functions — the service implements it over a project. */
export interface ImproveHost {
  /**
   * A conversation as an improver reads it: its messages in order, and the signals the record holds
   * about each (a stopped turn, a failed one), plus what was in effect — the task's workflow and the
   * version it ran. `task` absent ⇒ the calling task's own.
   */
  digest(request: { task?: string; session?: { id: string } | null; last?: number }, callerTask: string | undefined): Promise<JsonValue>;
  /**
   * The files that define a workflow, as an improver edits them: the state or script by its id, which
   * layer supplies it, whether that layer can be written, and — for a built-in one — where an override
   * belongs. With the instructions file of each layer and the skills there are.
   */
  source(request: { workflow?: string; task?: string }, callerTask: string | undefined): Promise<JsonValue>;
  /** The lessons on record in a layer, newest first: each one's rule, lever, target and how often it recurred. */
  /**
   * The lessons on record in a layer — or, with `elsewhere`, those this machine's OTHER projects have
   * recorded, each naming its project: what a lesson turning up in a second project is told by
   * (decision 0029 §7).
   */
  lessons(request: { scope?: LessonScope; elsewhere?: boolean }): Promise<JsonValue>;
  /**
   * Write a change: refuse a path a lesson may not touch, write the rest, load what changed and
   * restore every file if it does not, then record the lesson. Answers what was written, or why not.
   */
  apply(request: { files: ChangeFile[]; lesson: LessonRecord; scope?: LessonScope }): Promise<JsonValue>;
  /**
   * Record that the person turned a proposed change down at its review: one more occurrence of the
   * lesson, DECLINED, with what they said — what tells how often the improver's proposals are turned
   * down ("Revisit when"), and tells the next proposal for it what the person did not want.
   */
  decline(request: { lesson: LessonRecord; scope?: LessonScope; comment?: string }): Promise<JsonValue>;
  /**
   * Try a change before it is offered (decision 0029 §5 step 5): fork the conversation in `context` at
   * the message the corrected reply answered, hand the fork the proposed files — read as if written, and
   * written nowhere — and send that message again, for one pass in a throwaway workspace, under a set
   * that cannot write outside it, push or publish, with nobody to ask. Answers what the conversation said
   * and did then, beside what it said the first time, and whether it took the new version; or
   * `simulated: false` and why it could not be tried.
   */
  simulate(request: { files: ChangeFile[]; lesson: string; scope?: LessonScope; context: { task?: string; session?: { id: string } | null; quote?: string } }, callerTask: string | undefined): Promise<JsonValue>;
}

const PLAIN = { interactive: false, readOnly: true, memoizable: false } as const;
const WRITES = { interactive: false, readOnly: false, memoizable: false } as const;

function ok(value: JsonValue): FunctionResult<ResolvedValue, WorkflowMetrics> {
  return { value: value as ResolvedValue, metrics: { durationMs: 0, costUsd: 0, costSource: "provider" } } as FunctionResult<ResolvedValue, WorkflowMetrics>;
}

function failed(error: unknown): FunctionResult<ResolvedValue, WorkflowMetrics> {
  return {
    error: { classification: "permanent", reason: (error as Error)?.message ?? String(error) },
    metrics: { durationMs: 0, costUsd: 0, costSource: "provider" },
  } as unknown as FunctionResult<ResolvedValue, WorkflowMetrics>;
}

function args(inputs: FunctionInputs): Record<string, unknown> {
  return inputs as unknown as Record<string, unknown>;
}

/** Register the improver's functions on a run's registry, answering for `callerTask`. */
export function registerImproveFunctions(registry: CapabilityRegistry<WorkflowMetrics>, host: ImproveHost, callerTask?: string): void {
  const wrap = (fn: (a: Record<string, unknown>) => Promise<JsonValue>) => async (inputs: FunctionInputs) => {
    try {
      return ok(await fn(args(inputs)));
    } catch (e) {
      return failed(e);
    }
  };
  registry.functions.set(
    CONVERSATION_DIGEST,
    hostFunction(
      wrap((a) =>
        host.digest(
          {
            ...(typeof a.task === "string" ? { task: a.task } : {}),
            ...(a.session !== undefined ? { session: a.session as { id: string } | null } : {}),
            ...(typeof a.last === "number" ? { last: a.last } : {}),
          },
          callerTask,
        ),
      ),
      PLAIN,
    ),
  );
  registry.functions.set(
    WORKFLOW_SOURCE,
    hostFunction(
      wrap((a) => host.source({ ...(typeof a.workflow === "string" ? { workflow: a.workflow } : {}), ...(typeof a.task === "string" ? { task: a.task } : {}) }, callerTask)),
      PLAIN,
    ),
  );
  registry.functions.set(LESSONS_LIST, hostFunction(wrap((a) => host.lessons({ ...(a.scope === "shared" || a.scope === "project" ? { scope: a.scope } : {}), ...(a.elsewhere === true ? { elsewhere: true } : {}) })), PLAIN));
  registry.functions.set(
    APPLY_CHANGE,
    hostFunction(
      wrap((a) => {
        const files = Array.isArray(a.files) ? (a.files as ChangeFile[]) : [];
        const lesson = (a.lesson ?? {}) as LessonRecord;
        if (typeof lesson.rule !== "string" || lesson.rule.trim() === "") throw new Error("apply_change needs the lesson's rule");
        return host.apply({ files, lesson, ...(a.scope === "shared" || a.scope === "project" ? { scope: a.scope } : {}) });
      }),
      WRITES,
    ),
  );
  registry.functions.set(
    SIMULATE_CHANGE,
    hostFunction(
      wrap((a) => {
        const files = Array.isArray(a.files) ? (a.files as ChangeFile[]) : [];
        const context = (a.context ?? {}) as { task?: unknown; session?: unknown; quote?: unknown };
        return host.simulate(
          {
            files,
            lesson: typeof a.lesson === "string" ? a.lesson : "",
            ...(a.scope === "shared" || a.scope === "project" ? { scope: a.scope } : {}),
            context: {
              ...(typeof context.task === "string" ? { task: context.task } : {}),
              ...(context.session !== undefined ? { session: context.session as { id: string } | null } : {}),
              ...(typeof context.quote === "string" ? { quote: context.quote } : {}),
            },
          },
          callerTask,
        );
      }),
      // It writes nothing anybody keeps, but it runs a pass — model calls, a workspace — so it is no read.
      WRITES,
    ),
  );
  registry.functions.set(
    DECLINE_CHANGE,
    hostFunction(
      wrap((a) => {
        const lesson = (a.lesson ?? {}) as LessonRecord;
        if (typeof lesson.rule !== "string" || lesson.rule.trim() === "") throw new Error("decline_change needs the lesson's rule");
        return host.decline({
          lesson,
          ...(a.scope === "shared" || a.scope === "project" ? { scope: a.scope } : {}),
          ...(typeof a.comment === "string" && a.comment.length > 0 ? { comment: a.comment } : {}),
        });
      }),
      WRITES,
    ),
  );
}
