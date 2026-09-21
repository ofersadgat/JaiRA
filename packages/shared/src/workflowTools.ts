/**
 * The workflow tools (decision 0005 §3, step 6) — what each takes and what each answers.
 *
 * Eight tools a conversation holds: all of what `chat/control` has, and part of what `chat/session`
 * has. Each is the HOST's operation and not a second implementation of it — `move` is `connectTask`,
 * `start` is the generator and a `task_move`, `hold` / `release` / `stop` are what the board's
 * gestures call — so the shapes here are the contract between the tool a model calls
 * (`runtime/workflowTools.ts`) and the host that serves it (`AppService.workflowHost`).
 *
 * ## Inputs are the target's own (§0, §4)
 *
 * `start` and `move` take `inputs`: an object keyed by the TARGET STATE'S declared input names. The
 * platform names none of them. A call whose `inputs` leave a required input open DOES NOTHING and
 * answers `ok: false` with `missing` — each open input with its declared schema, description and why
 * nothing binds it — and `schema`, the target's whole input schema with what the host could bind
 * left out of `required`. The conversation then supplies the value from what was said, or asks the
 * person in words, and calls again. `asked` names the inputs whose value the person gave in answer
 * to such a question; every other supplied value is recorded `inferred`.
 *
 * A refusal is an ANSWER (`ok: false`), never a thrown error: the model reads it and says so.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ConnectCandidate, ConnectMissingInput } from "./connect";
import type { InputSettledVia } from "./adopt";

/** The eight names, in the order the standard list has them. */
export const WORKFLOW_TOOL_NAMES = ["workflows", "start", "move", "tasks", "answer", "hold", "release", "stop"] as const;
export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

/** Is this one of the eight — by its bare name, or as an agent spells an injected tool (`mcp__<server>__start`)? */
export function workflowToolOf(name: string): WorkflowToolName | undefined {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return (WORKFLOW_TOOL_NAMES as readonly string[]).includes(bare) ? (bare as WorkflowToolName) : undefined;
}

/** Values a conversation hands a target, and who each came from. */
export interface SuppliedInputs {
  /** By the target state's own declared input names. */
  inputs?: Record<string, JsonValue>;
  /** The names in `inputs` a PERSON answered, asked in words. Everything else is `inferred`. */
  asked?: string[];
  /** How sure the conversation is of what it inferred, 0–1. Recorded beside each inferred value. */
  confidence?: number;
}

/** One declared slot, as `workflows` says it. */
export interface WorkflowSlotView {
  schema: JsonValue;
  description?: string;
  /** Inputs only: nothing stands in for an absent value. */
  required?: boolean;
}

export interface WorkflowsInput {
  /** A state id (`feature`, `feature/ux`). Absent ⇒ the list of workflows. */
  state?: string;
}

export type WorkflowsResult =
  | { workflows: Array<{ id: string; label?: string; description?: string }> }
  | {
      state: {
        id: string;
        label?: string;
        description?: string;
        inputs: Record<string, WorkflowSlotView>;
        outputs: Record<string, WorkflowSlotView>;
        /** ONE level: the states this one mounts. Ask again with a child's `state` to go down. */
        children: Array<{ key: string; state: string; label?: string; description?: string }>;
      };
    }
  | { error: string };

export interface StartInput extends SuppliedInputs {
  /** The state to start, as a child of this conversation. */
  state: string;
}

/** How one input of a started or moved-to state was settled. */
export interface SettledInputView {
  name: string;
  via: InputSettledVia | "default";
  /** Where a `bound` value reads from, in words. */
  from?: string;
}

/** The refusal `start` and `move` share when required inputs are open: nothing was done. */
export interface InputsMissing {
  ok: false;
  code: "inputs-missing";
  reason: string;
  missing: ConnectMissingInput[];
  /** The target's input schema as ONE object schema; what the host binds is not in `required`. */
  schema: JsonValue;
  /** What the host settles on its own — do not supply these. */
  filled: SettledInputView[];
}

export type StartResult =
  | {
      ok: true;
      /** The task the child runs in — this conversation's own. */
      task: string;
      /** The child key the state is mounted under, and the state. */
      key: string;
      state: string;
      /**
       * `started` — the task was reopened and is entering the child; `queued` — something is running
       * in this task, and the child is entered when it ends; `held` — the running task has the move
       * and takes it when the state now running ends.
       */
      status: "started" | "queued" | "held";
      /** `split` — the source was a list and the target takes one element: tasks were made HELD. */
      mount: "plain" | "split";
      inputs: SettledInputView[];
    }
  | InputsMissing
  | { ok: false; code: string; reason: string };

export interface MoveInput extends SuppliedInputs {
  /** The task to move. Absent ⇒ the task this conversation is. */
  task?: string;
  /** The target state id. */
  to: string;
  /** The workflow the target is meant in, when more than one holds it. */
  workflow?: string;
  /** Go directly: interrupt what is running and record what is stepped over as skipped. */
  skip?: boolean;
}

export type MoveResult =
  | {
      ok: true;
      /** The task that stands at the target — the moved task, or the parent a move made. */
      task: string;
      resolution: "move" | "adopt" | "modify";
      modification?: "new" | "augmented" | "cloned";
      workflow: string;
      standsAt: string;
      adoptedAs?: string;
      mount?: "plain" | "split";
      moved?: "answered" | "taking" | "held" | "reopened";
    }
  | InputsMissing
  | { ok: false; code: string; reason: string; candidates?: ConnectCandidate[] };

export interface TasksInput {
  /** Every task of the project, shortly, instead of what was started here. */
  all?: boolean;
}

export interface TaskStanding {
  task: string;
  title: string;
  status: string;
  workflow: string;
  /** `this` — the conversation's own task; `child` — filed under it; `adopted` — taken up by it; `made` — made by a fan-out. */
  relation?: "this" | "child" | "adopted" | "made";
  /** Where it stands: child keys from its root. */
  standsAt?: string;
  /** Queued and started by nobody until it is released. */
  held?: boolean;
  /** Titles of the tasks it waits for. */
  waitsFor?: string[];
  /** What it is asking a person — what `answer` takes. Never an approval. */
  asking?: Array<{ request: string; kind: string; title?: string; questions?: JsonValue }>;
  /** What it produced, shortened. */
  outputs?: Record<string, string>;
}

export interface TasksResult {
  tasks: TaskStanding[];
}

export interface AnswerInput {
  /** The request id, from `tasks` → `asking`. */
  request: string;
  /** A gate's value, in the shape its component returns. */
  value?: JsonValue;
  /** An agent's questions, answered by question text. */
  answers?: Record<string, string | string[]>;
  /** How sure the conversation is, 0–1. Recorded with the answer. */
  confidence: number;
}

/** Who settled a question on a person's behalf (decision 0005 §4). */
export interface SettledByControl {
  via: "control";
  confidence: number;
}

export type AnswerResult = { ok: true; request: string; settled_by: SettledByControl } | { ok: false; reason: string };

export interface TaskGestureInput {
  /** The tasks, by id. */
  tasks: string[];
}

export interface TaskGestureResult {
  results: Array<{ task: string; ok: boolean; did?: string; reason?: string }>;
}

/** The journal row an `answer` leaves on the task that asked — host vocabulary, as `workflow.version` is. */
export const ANSWERED_EVENT = "jaira.answered";

export interface AnsweredEvent {
  type: typeof ANSWERED_EVENT;
  requestId: string;
  /** `interaction` — a gate component; `question` — an agent's AskUserQuestion. */
  kind: "interaction" | "question";
  instanceId?: string;
  /** The conversation's task. */
  byTaskId: string;
  settled_by: SettledByControl;
}

/** The journal row that says how values a conversation handed an entry were settled. */
export const SUPPLIED_EVENT = "jaira.supplied";

export interface SuppliedEvent {
  type: typeof SUPPLIED_EVENT;
  /** The composite whose child is entered. Absent ⇒ the task's root instance. */
  instanceId?: string;
  /** The child key entered next. */
  to: string;
  /** The entry is further down than a child of `instanceId`: matched by key, under whatever composite enters it. */
  nested?: boolean;
  provenance: Record<string, { via: "inferred" | "asked"; confidence?: number }>;
}

const shortly = (value: unknown, max = 40): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `“${flat.slice(0, max)}…”` : typeof value === "string" ? `“${flat}”` : flat;
};

/**
 * A workflow tool's call, on one line — what its row in the conversation says beside the name.
 *
 * `start` → `feature/product · issue: “Let a person pause…”`; `move` → `<task> → feature/ux · skip`;
 * `release` → the tasks named. Pure over the call's arguments, so a record read a year later draws
 * the same line.
 */
export function workflowToolSummary(name: WorkflowToolName, args: unknown, titleOf: (taskId: string) => string | undefined = () => undefined): string {
  const a = (args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const named = (id: unknown): string => (typeof id === "string" ? (titleOf(id) ?? id) : "");
  const inputs = a["inputs"] !== null && typeof a["inputs"] === "object" && !Array.isArray(a["inputs"]) ? Object.entries(a["inputs"] as Record<string, unknown>) : [];
  const supplied = inputs.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : shortly(value)}`);
  switch (name) {
    case "workflows":
      return typeof a["state"] === "string" ? a["state"] : "all";
    case "start":
      return [typeof a["state"] === "string" ? a["state"] : "", ...supplied].filter((part) => part !== "").join(" · ");
    case "move":
      return [`${a["task"] !== undefined ? `${named(a["task"])} ` : ""}→ ${typeof a["to"] === "string" ? a["to"] : ""}`, ...(a["skip"] === true ? ["skip"] : []), ...supplied].join(" · ");
    case "tasks":
      return a["all"] === true ? "all" : "started here";
    case "answer":
      return typeof a["request"] === "string" ? a["request"] : "";
    case "hold":
    case "release":
    case "stop": {
      const tasks = Array.isArray(a["tasks"]) ? a["tasks"] : a["task"] !== undefined ? [a["task"]] : [];
      return tasks.map(named).join(" · ");
    }
  }
}
