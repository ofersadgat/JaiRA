/**
 * The workflow tools (decision 0005 §3, step 6): `workflows`, `start`, `move`, `tasks`, `answer`,
 * `hold`, `release`, `stop`.
 *
 * Eight tools, and no behaviour of their own. Each validates the shape a model handed it and calls
 * the HOST — the app's service, which already has `connectTask`, the document generator, the hubs
 * and the task lifecycle — through {@link WorkflowToolHost}. That is the point of the decision's
 * table: the tools are "the host operations, not a second implementation of them", so a drop, the
 * CLI and a conversation's `move` are one code path.
 *
 * The host is bound to ONE conversation when the tools are registered: a registry is built per run
 * and per typed turn, for a known task, so "this conversation" is closed over rather than passed by
 * the model. A caller with no host — the CLI today, a test that registers every tool — gets
 * {@link noWorkflowHost}: the names resolve (a state that holds them loads and runs) and every call
 * answers why it cannot be served there.
 *
 * Like every tool here a refusal is RETURNED — `{ ok: false, … }` or `{ error }` — never thrown: the
 * model reads it and says so, or supplies what was missing and calls again.
 */
import type { Tool } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import type {
  AnswerInput,
  AnswerResult,
  MoveInput,
  MoveResult,
  StartInput,
  StartResult,
  TaskGestureInput,
  TaskGestureResult,
  TasksInput,
  TasksResult,
  WorkflowsInput,
  WorkflowsResult,
} from "@jaira/shared";

/** What serves the tools: the host's own operations, bound to the conversation that holds them. */
export interface WorkflowToolHost {
  workflows(input: WorkflowsInput): Promise<WorkflowsResult> | WorkflowsResult;
  start(input: StartInput): Promise<StartResult>;
  move(input: MoveInput): Promise<MoveResult>;
  tasks(input: TasksInput): Promise<TasksResult> | TasksResult;
  answer(input: AnswerInput): Promise<AnswerResult> | AnswerResult;
  hold(input: TaskGestureInput): Promise<TaskGestureResult>;
  release(input: TaskGestureInput): Promise<TaskGestureResult>;
  stop(input: TaskGestureInput): Promise<TaskGestureResult>;
}

/** A host for a place that has none: every call answers that it cannot be served here. */
export function noWorkflowHost(where = "here"): WorkflowToolHost {
  const reason = `the workflow tools are not served ${where} — they need the app, which holds the tasks and the conversation`;
  const gesture = (input: TaskGestureInput): Promise<TaskGestureResult> => Promise.resolve({ results: input.tasks.map((task) => ({ task, ok: false, reason })) });
  return {
    workflows: () => ({ error: reason }),
    start: () => Promise.resolve({ ok: false, code: "unserved", reason }),
    move: () => Promise.resolve({ ok: false, code: "unserved", reason }),
    tasks: () => ({ tasks: [] }),
    answer: () => ({ ok: false, reason }),
    hold: gesture,
    release: gesture,
    stop: gesture,
  };
}

const record = (input: unknown): Record<string, unknown> => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {});

const SUPPLIED_PROPERTIES = {
  inputs: {
    type: "object",
    description:
      "Values for the target state's OWN declared inputs, by their names (see `workflows`). Leave out what the workflow binds itself. Supply a value only when what was said determines it; otherwise ask the person in words first.",
  },
  asked: { type: "array", items: { type: "string" }, description: "The names in `inputs` whose value the person gave in answer to your question. Every other supplied value is recorded as inferred." },
  confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are of the values you inferred, 0 to 1." },
} as const;

/** `inputs`, `asked`, `confidence` — read leniently, refused where the shape cannot mean anything. */
function suppliedOf(args: Record<string, unknown>): { inputs?: Record<string, JsonValue>; asked?: string[]; confidence?: number } | { error: string } {
  const out: { inputs?: Record<string, JsonValue>; asked?: string[]; confidence?: number } = {};
  if (args["inputs"] !== undefined) {
    if (args["inputs"] === null || typeof args["inputs"] !== "object" || Array.isArray(args["inputs"])) return { error: "`inputs` is an object keyed by the target state's input names" };
    out.inputs = args["inputs"] as Record<string, JsonValue>;
  }
  if (args["asked"] !== undefined) {
    if (!Array.isArray(args["asked"]) || args["asked"].some((name) => typeof name !== "string")) return { error: "`asked` is a list of input names" };
    const unknown = (args["asked"] as string[]).filter((name) => out.inputs?.[name] === undefined);
    if (unknown.length > 0) return { error: `\`asked\` names ${unknown.map((n) => `'${n}'`).join(", ")}, which \`inputs\` does not supply` };
    out.asked = args["asked"] as string[];
  }
  if (typeof args["confidence"] === "number" && args["confidence"] >= 0 && args["confidence"] <= 1) out.confidence = args["confidence"];
  return out;
}

/** `tasks: [...]`, or the `task: "…"` a model writes when there is one. */
function tasksOf(args: Record<string, unknown>): string[] | undefined {
  const list = Array.isArray(args["tasks"]) ? args["tasks"] : typeof args["task"] === "string" ? [args["task"]] : undefined;
  if (list === undefined || list.length === 0 || list.some((id) => typeof id !== "string" || id.length === 0)) return undefined;
  return list as string[];
}

const GESTURE_SCHEMA = {
  type: "object",
  properties: { tasks: { type: "array", items: { type: "string" }, minItems: 1, description: "Task ids, from `tasks`." } },
  required: ["tasks"],
} as const;

function gestureTool(description: string, call: (input: TaskGestureInput) => Promise<TaskGestureResult>): Tool {
  return {
    description,
    inputSchema: GESTURE_SCHEMA as unknown as Tool["inputSchema"],
    readOnly: false,
    run: async (input) => {
      const tasks = tasksOf(record(input));
      if (tasks === undefined) return { error: "name the tasks: `tasks` is a list of task ids" };
      return (await call({ tasks })) as unknown as JsonValue;
    },
  };
}

/** The eight tools over one host, by name. */
export function createWorkflowTools(host: WorkflowToolHost): Record<string, Tool> {
  return {
    workflows: {
      description:
        "List the project's workflows, or — given `state` — say what one state is: its label and description, the inputs it takes and the outputs it produces (each with its schema and description), and the states it mounts, ONE level down. Ask again with a child's `state` to go further.",
      inputSchema: { type: "object", properties: { state: { type: "string", description: "A state id, e.g. `feature` or `feature/ux`. Absent lists the workflows." } } },
      readOnly: true,
      run: async (input) => {
        const state = record(input)["state"];
        return (await host.workflows(typeof state === "string" && state.length > 0 ? { state } : {})) as unknown as JsonValue;
      },
    },
    start: {
      description:
        "Start a state as a child of this conversation. `inputs` are the TARGET STATE'S own inputs. The host binds what the workflow wires itself; if a required input is still open the call does nothing and answers `ok: false` with `missing` (each open input, its schema and description) and `schema` (the target's input schema) — supply the values, or ask the person in words and name what they answered in `asked`, then call again.",
      inputSchema: { type: "object", properties: { state: { type: "string", description: "The state to start, e.g. `feature/product`." }, ...SUPPLIED_PROPERTIES }, required: ["state"] } as unknown as Tool["inputSchema"],
      readOnly: false,
      run: async (input) => {
        const args = record(input);
        if (typeof args["state"] !== "string" || args["state"].length === 0) return { error: "name the state to start: `state`" };
        const supplied = suppliedOf(args);
        if ("error" in supplied) return supplied;
        return (await host.start({ state: args["state"], ...supplied })) as unknown as JsonValue;
      },
    },
    move: {
      description:
        "Move a task to another state — forward, backward, or across workflows. The host finds or makes the workflow that relates the two. `task` absent means the task this conversation is. `skip: true` goes there directly instead of running what lies between. `inputs` works as in `start`: a call that leaves a required input open does nothing and answers `missing`.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task id, from `tasks`. Absent: this conversation's own task." },
          to: { type: "string", description: "The target state id, e.g. `feature/ux`." },
          workflow: { type: "string", description: "The workflow the target is meant in, when the answer said more than one holds it." },
          skip: { type: "boolean", description: "Go directly; what is stepped over is recorded as skipped." },
          ...SUPPLIED_PROPERTIES,
        },
        required: ["to"],
      } as unknown as Tool["inputSchema"],
      readOnly: false,
      run: async (input) => {
        const args = record(input);
        if (typeof args["to"] !== "string" || args["to"].length === 0) return { error: "name the target state: `to`" };
        const supplied = suppliedOf(args);
        if ("error" in supplied) return supplied;
        return (await host.move({
          to: args["to"],
          ...(typeof args["task"] === "string" && args["task"].length > 0 ? { task: args["task"] } : {}),
          ...(typeof args["workflow"] === "string" && args["workflow"].length > 0 ? { workflow: args["workflow"] } : {}),
          ...(args["skip"] === true ? { skip: true } : {}),
          ...supplied,
        })) as unknown as JsonValue;
      },
    },
    tasks: {
      description:
        "What was started from this conversation: each task, where it stands, whether it is held or waiting for another, what it is asking a person (with the `request` id `answer` takes), and what it produced. `all: true` lists every task of the project, shortly.",
      inputSchema: { type: "object", properties: { all: { type: "boolean" } } },
      readOnly: true,
      run: async (input) => (await host.tasks(record(input)["all"] === true ? { all: true } : {})) as unknown as JsonValue,
    },
    answer: {
      description:
        "Settle a QUESTION a task is asking a person — a choice, a form, an agent's question, a judgement on a document — on the person's behalf, from what has been said here. Never an approval: a permission, a publish, a push or a merge is not yours to give and cannot be reached with this. `request` is the id from `tasks`; `value` is the gate's answer in the shape it asks for, or `answers` maps an agent's question text to the chosen label. Say how sure you are in `confidence`.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string" },
          value: { description: "A gate's answer, in the shape the gate asks for." },
          answers: { type: "object", description: "An agent's questions: question text → the chosen option's label, or labels." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["request", "confidence"],
      } as unknown as Tool["inputSchema"],
      readOnly: false,
      run: async (input) => {
        const args = record(input);
        if (typeof args["request"] !== "string" || args["request"].length === 0) return { ok: false, reason: "name the request: `request`, from `tasks`" };
        const confidence = args["confidence"];
        if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return { ok: false, reason: "`confidence` is a number from 0 to 1, and an answer is not recorded without it" };
        const answers = args["answers"];
        if (answers !== undefined && (answers === null || typeof answers !== "object" || Array.isArray(answers))) return { ok: false, reason: "`answers` maps a question's text to the chosen label" };
        if (args["value"] === undefined && answers === undefined) return { ok: false, reason: "give the answer: `value` for a gate, `answers` for an agent's questions" };
        return (await host.answer({
          request: args["request"],
          confidence,
          ...(args["value"] !== undefined ? { value: args["value"] as JsonValue } : {}),
          ...(answers !== undefined ? { answers: answers as Record<string, string | string[]> } : {}),
        })) as unknown as JsonValue;
      },
    },
    hold: gestureTool("Hold tasks where they stand: a queued task is kept from starting on its own, a running one is stopped where it is and can be released later.", (input) => host.hold(input)),
    release: gestureTool("Release held tasks: start the ones named — a task made held, one that was held, or one that was stopped — from where each stands.", (input) => host.release(input)),
    stop: gestureTool("Stop tasks that are running. A stopped task keeps its place and can be released later.", (input) => host.stop(input)),
  };
}

/** Register the eight tools — over `host`, or over {@link noWorkflowHost} where there is none. */
export function registerWorkflowTools(registry: { tools: Map<string, Tool> }, host: WorkflowToolHost = noWorkflowHost()): void {
  for (const [name, tool] of Object.entries(createWorkflowTools(host))) registry.tools.set(name, tool);
}
