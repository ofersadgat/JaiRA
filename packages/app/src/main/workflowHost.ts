/**
 * The host behind the workflow tools (decision 0005 §3, step 6) — bound to ONE conversation.
 *
 * `runtime/workflowTools.ts` is what a model calls; this is what answers. Nothing here is a
 * mechanism of its own:
 *
 *  - `move`    is `AppService.connectTask` — the drop's and the CLI's one path — with `by: "control"`
 *              and the values the conversation supplied;
 *  - `start`   is `connect` FROM THE CONVERSATION ITSELF: the conversation's own task gains a child
 *              (the document generator) and takes a `task_move` to it (`moveTask`);
 *  - `answer`  is `submitInteraction` / `submitQuestion`, reached through the pending lists of the
 *              interaction and question hubs and through NOTHING else — the approval hub is not a
 *              dependency of this module, so an approval is not reachable from it by construction;
 *  - `hold`, `release`, `stop` are `cancelTask`, `resumeTask` and `startTask`, what the board calls;
 *  - `workflows` and `tasks` are reads.
 *
 * ## A session that starts work stays a session
 *
 * `start` never makes a `chat/control`. The conversation's task is pointed at a document rooted in
 * ITS OWN state: a task in no document has its frozen copy diverged (`mode: "clone"` — the frozen
 * root, operation and all, with the child and its standing rule grafted on), and a task already in
 * a document has it augmented. The root that speaks is the root that spoke.
 *
 * ## While an engine holds the task
 *
 * A running engine runs the bundle it loaded, and a version written now is one it cannot see. So a
 * `start` made while the conversation's own run is in flight — the opening message of a session is
 * such a run — writes the version and QUEUES the move (`afterRun`): the run-end handler takes it,
 * by reopening, the way it takes a move left on the port. A child already mounted in the version
 * the engine holds is moved to at once, and held by the engine until what is running ends.
 */
import type { JsonValue } from "@declarative-ai/json";
import { sourceStateId } from "@declarative-ai/hw";
import {
  ANSWERED_EVENT,
  MOVED_EVENT,
  workflowOutcomeOf,
  type AnsweredEvent,
  type MovedEvent,
  type AnswerInput,
  type AnswerResult,
  type ConnectMissingInput,
  type ConnectSupplied,
  type InputsMissing,
  type MoveInput,
  type MoveResult,
  type PendingInteraction,
  type PendingQuestion,
  type ResumePlan,
  type SettledInputView,
  type StartInput,
  type StartResult,
  type SuppliedInputs,
  type TaskConnectRequest,
  type TaskConnectResult,
  type TaskGestureInput,
  type TaskGestureResult,
  type TaskMoveRequest,
  type TaskMoveResult,
  type TaskStanding,
  type TasksInput,
  type TasksResult,
  type WorkflowBrowser,
  type WorkflowSlotView,
  type WorkflowsInput,
  type WorkflowsResult,
} from "@jaira/shared";
import {
  boardPathOf,
  bundleFor,
  generateDocumentVersion,
  generatorSupplied,
  holdingOf,
  latestVersion,
  readDocument,
  recordSupplied,
  stateShapeOf,
  taskRun,
  unsettledAsMissing,
  type GenerateVersionResult,
  type Project,
} from "@jaira/persistence";
import type { WorkflowToolCall, WorkflowToolHost } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";

/**
 * The gate components a conversation may answer (decision 0005 §4): questions, and judgement on a
 * document. `confirm_action` is an approval and `review_artifacts` applies, merges or publishes a
 * changeset — neither is a conversation's to give — and a function nobody built in is unknown.
 */
export const ANSWERABLE_COMPONENTS: ReadonlySet<string> = new Set(["choose_option", "fill_form", "review_artifact", "edit_artifact"]);

/** What the service lends: its own operations, each exactly as its channel reaches it. */
export interface WorkflowHostDeps {
  project: Project;
  /** How the service names this project in a request. */
  projectRef: string;
  /** The task this conversation is. */
  taskId: string;
  connect(request: TaskConnectRequest): Promise<TaskConnectResult>;
  move(request: TaskMoveRequest): Promise<TaskMoveResult>;
  /** An engine is running the task in this process. */
  isLive(taskId: string): boolean;
  /** Take `run` when the task's current run ends well — see the header. */
  afterRun(taskId: string, run: () => Promise<unknown>): void;
  browse(): WorkflowBrowser;
  /** Gates and agent questions awaiting a PERSON. Approvals are deliberately not lent. */
  pendingInteractions(): PendingInteraction[];
  pendingQuestions(): PendingQuestion[];
  submitInteraction(requestId: string, value: JsonValue): unknown;
  submitQuestion(requestId: string, answers?: Record<string, string | string[]>): unknown;
  /**
   * Would this value settle that gate — the check `submitInteraction` makes, asked FIRST. `answer_question`
   * journals before it submits, so without it an answer the contract refuses would leave a
   * `jaira.answered` row claiming a settlement that never happened. Absent ⇒ unchecked here.
   */
  checkInteraction?(requestId: string, value: JsonValue): string | undefined;
  /**
   * The instance a task's question is parked on, when exactly one could be — what the answered row
   * names, so the gate it settled can draw who settled it and rewind to it. Absent or unsure ⇒ none.
   */
  askingInstance?(taskId: string, kind: "interaction" | "question"): string | undefined;
  cancel(taskId: string): unknown;
  resume(taskId: string): Promise<unknown>;
  startTask(taskId: string): Promise<unknown>;
  resumable(taskId: string): ResumePlan;
  invalidate(): void;
}

/** `inputs` / `asked` / `confidence`, as the values `connect` takes. */
export function suppliedOfTool(input: SuppliedInputs): Record<string, ConnectSupplied> | undefined {
  const entries = Object.entries(input.inputs ?? {});
  if (entries.length === 0) return undefined;
  const asked = new Set(input.asked ?? []);
  return Object.fromEntries(
    entries.map(([name, value]): [string, ConnectSupplied] => [
      name,
      asked.has(name) ? { value, via: "asked" } : { value, via: "inferred", ...(input.confidence !== undefined ? { confidence: input.confidence } : {}) },
    ]),
  );
}

const shortly = (value: unknown): string => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
};

export function createWorkflowHost(deps: WorkflowHostDeps): WorkflowToolHost {
  const { project, taskId } = deps;

  /** The conversation's task, and every task filed under it or made or adopted by it, transitively. */
  const family = (): Map<string, TaskStanding["relation"]> => {
    const out = new Map<string, TaskStanding["relation"]>([[taskId, "this"]]);
    const metas = project.tasks.list();
    for (let grew = true; grew; ) {
      grew = false;
      for (const meta of metas) {
        if (out.has(meta.id)) continue;
        const via = meta.origin !== undefined && out.has(meta.origin.taskId) ? (meta.origin.kind === "adopt" ? "adopted" : "made") : meta.parentTaskId !== undefined && out.has(meta.parentTaskId) ? "child" : undefined;
        if (via === undefined) continue;
        out.set(meta.id, via);
        grew = true;
      }
    }
    return out;
  };

  const targetSurface = (state: string): ReturnType<typeof stateShapeOf> | undefined => {
    const bundle = bundleFor(project, state);
    const root = bundle?.states[bundle.rootId];
    return root !== undefined ? stateShapeOf(root) : undefined;
  };

  /** The refusal `start` and `move` share: nothing was done, here is what to supply. */
  const inputsMissing = (target: string, reason: string, missing: ConnectMissingInput[], filled: SettledInputView[]): InputsMissing => {
    const surface = targetSurface(target);
    const open = new Set(missing.filter((m) => sourceStateId(m.state) === sourceStateId(target)).map((m) => m.name));
    const properties: Record<string, JsonValue> = {};
    for (const [name, slot] of Object.entries(surface?.inputs ?? {})) {
      const schema = (slot.schema !== null && typeof slot.schema === "object" && !Array.isArray(slot.schema) ? slot.schema : {}) as Record<string, JsonValue>;
      properties[name] = { ...schema, ...(slot.description !== undefined && schema["description"] === undefined ? { description: slot.description } : {}) };
    }
    return { ok: false, code: "inputs-missing", reason, missing, schema: { type: "object", properties, required: [...open] }, filled };
  };

  const settledOf = (generated: GenerateVersionResult["generated"], supplied: Record<string, ConnectSupplied> | undefined): SettledInputView[] => [
    ...generated.wires.map((wire): SettledInputView => ({ name: wire.input, via: "bound", from: `${wire.from.child}.${wire.from.output}` })),
    ...generated.literals.map((literal): SettledInputView => ({ name: literal.input, via: supplied?.[literal.input]?.via ?? "inferred" })),
  ];

  const gesture = async (input: TaskGestureInput, act: (id: string, title: string) => Promise<string>): Promise<TaskGestureResult> => {
    const mine = family();
    const results: TaskGestureResult["results"] = [];
    for (const id of input.tasks) {
      const meta = project.tasks.tryRead(id);
      if (meta === undefined || project.runtime.get(id) === undefined) results.push({ task: id, ok: false, reason: `unknown task '${id}'` });
      else if (!mine.has(id)) results.push({ task: id, ok: false, reason: `'${meta.title}' was not started from this conversation — \`list_tasks\` lists what was` });
      else {
        try {
          results.push({ task: id, ok: true, did: await act(id, meta.title) });
        } catch (e) {
          results.push({ task: id, ok: false, reason: (e as Error).message });
        }
      }
    }
    deps.invalidate();
    return { results };
  };

  /**
   * Journal what a successful `start_task` / `move_task` did, on THIS conversation's task
   * (`jaira.moved`), and hand the answer back unchanged. The row is what the conversation's rail draws
   * the note from, placed at the call that did it (`toolCallId`); a refusal writes nothing, because it
   * did nothing.
   */
  const journalMoved = <R extends StartResult | MoveResult>(tool: MovedEvent["tool"], result: R, call: WorkflowToolCall | undefined): R => {
    const outcome = workflowOutcomeOf(result);
    const settled: StartResult | MoveResult = result;
    if (outcome !== undefined && settled.ok) {
      const event: MovedEvent = { type: MOVED_EVENT, tool, task: settled.task, outcome, ...(call?.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}) };
      try {
        project.events.recorder(taskId).record(event as unknown as EngineEvent, Date.now());
      } catch {
        // The move happened; a row that could not be written loses the rail's note, not the move.
      }
    }
    return result;
  };

  const release = async (id: string): Promise<string> => {
    const plan = deps.resumable(id);
    if (plan.kind === "fresh") {
      await deps.startTask(id);
      return "started";
    }
    if (plan.kind === "none") throw new Error(plan.blocked ?? `it is ${project.runtime.get(id)?.status ?? "gone"}, and there is nothing to release`);
    await deps.resume(id);
    return plan.kind === "continue" ? "continued from where it stood" : "started again at the state that ended it";
  };

  return {
    workflows(input: WorkflowsInput): WorkflowsResult {
      if (input.state === undefined) {
        return {
          workflows: deps
            .browse()
            .workflows.filter((entry) => entry.loadError === undefined)
            .map((entry) => {
              const bundle = bundleFor(project, entry.rootId);
              const description = bundle?.states[bundle.rootId]?.description;
              return { id: entry.rootId, ...(entry.label !== undefined ? { label: entry.label } : {}), ...(description !== undefined ? { description } : {}) };
            }),
        };
      }
      const bundle = bundleFor(project, input.state);
      const root = bundle?.states[bundle.rootId];
      if (bundle === undefined || root === undefined) return { error: `no state '${input.state}' was found on the workflow path` };
      const surface = stateShapeOf(root);
      const slots = (section: typeof surface.inputs, inputs: boolean): Record<string, WorkflowSlotView> =>
        Object.fromEntries(
          Object.entries(section).map(([name, slot]) => [name, { schema: slot.schema ?? {}, ...(slot.description !== undefined ? { description: slot.description } : {}), ...(inputs ? { required: slot.optional !== true } : {}) }]),
        );
      return {
        state: {
          id: surface.id,
          ...(root.label !== undefined ? { label: root.label } : {}),
          ...(root.description !== undefined ? { description: root.description } : {}),
          inputs: slots(surface.inputs, true),
          outputs: slots(surface.outputs, false),
          children: Object.entries(root.children ?? {}).map(([key, child]) => {
            const state = bundle.states[child.state];
            return { key, state: sourceStateId(child.state), ...(state?.label !== undefined ? { label: state.label } : {}), ...(state?.description !== undefined ? { description: state.description } : {}) };
          }),
        },
      };
    },

    async start(input: StartInput, call?: WorkflowToolCall): Promise<StartResult> {
      const row = project.runtime.get(taskId);
      const meta = project.tasks.tryRead(taskId);
      if (row === undefined || meta === undefined) return { ok: false, code: "unknown-task", reason: `this conversation's task '${taskId}' is gone` };
      const target = sourceStateId(input.state);
      if (targetSurface(target) === undefined) return { ok: false, code: "unknown-target", reason: `no state '${target}' was found on the workflow path — \`list_workflows\` lists what there is` };
      if (row.snapshotHash === undefined && row.documentId === undefined) return { ok: false, code: "never-run", reason: "this conversation has not run yet" };
      const supplied = suppliedOfTool(input);
      const literals = generatorSupplied(supplied);
      // The conversation's OWN root stays the root: a document keeps the conversation it has, and a
      // task in none diverges under the state it runs — never under `chat/control`.
      const conversation = row.documentId !== undefined ? readDocument(project.paths.snapshotsDir, row.documentId).conversation : sourceStateId(meta.workflow);
      const generate = (dryRun: boolean): Promise<GenerateVersionResult> =>
        generateDocumentVersion(project, { taskId, target, conversation, mode: "clone", ...(literals !== undefined ? { supplied: literals } : {}), ...(dryRun ? { dryRun: true } : {}) });
      let made: GenerateVersionResult;
      try {
        const preview = await generate(true);
        if (preview.resolution === "unsettled") {
          const missing = preview.generated.unsettled.filter((u) => u.required).map((u) => unsettledAsMissing(target, u));
          return inputsMissing(target, `'${target}' was not started: ${missing.length === 1 ? "a required input is" : "required inputs are"} open`, missing, settledOf(preview.generated, supplied));
        }
        made = await generate(false);
      } catch (e) {
        return { ok: false, code: "generate", reason: (e as Error).message };
      }
      const key = made.generated.targetKey;
      // A child that was already mounted is re-entered with what was supplied handed over the
      // mount's own wiring; a new mount holds the values as literals, and nothing rides the move.
      const handed = made.generated.existing ? Object.fromEntries(Object.entries(supplied ?? {}).map(([name, entry]) => [name, entry.value])) : {};
      recordSupplied(project, taskId, { to: key }, supplied, made.generated.existing ? Object.keys(handed) : made.generated.literals.map((literal) => literal.input));
      const request: TaskMoveRequest = { project: deps.projectRef, taskId, toState: key, by: "control", ...(Object.keys(handed).length > 0 ? { inputs: handed } : {}) };
      const answer = (status: "started" | "queued" | "held"): StartResult =>
        journalMoved("start_task", { ok: true, task: taskId, key, state: target, status, mount: made.generated.mount, inputs: settledOf(made.generated, supplied) }, call);
      try {
        if (deps.isLive(taskId)) {
          const engineHolds = made.document === undefined || latestVersion(made.document).snapshotHash === project.runtime.get(taskId)?.snapshotHash;
          if (!engineHolds) {
            deps.afterRun(taskId, () => deps.move(request));
            return answer("queued");
          }
          const moved = await deps.move(request);
          return answer(moved.status === "held" ? "held" : "started");
        }
        await deps.move(request);
        return answer("started");
      } catch (e) {
        return { ok: false, code: "move", reason: `'${target}' is mounted as '${key}', and the move to it was refused: ${(e as Error).message}` };
      } finally {
        deps.invalidate();
      }
    },

    async move(input: MoveInput, call?: WorkflowToolCall): Promise<MoveResult> {
      const moved = input.task ?? taskId;
      const supplied = suppliedOfTool(input);
      let result: TaskConnectResult;
      try {
        result = await deps.connect({
          project: deps.projectRef,
          taskId: moved,
          target: input.to,
          by: "control",
          ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
          ...(input.skip === true ? { skip: true } : {}),
          ...(supplied !== undefined ? { supplied } : {}),
        });
      } catch (e) {
        return { ok: false, code: "move", reason: (e as Error).message };
      }
      if (!result.ok) {
        const { refusal } = result;
        if (refusal.code === "inputs-missing" && refusal.missing !== undefined) {
          const filled = (result.plan?.inputs ?? []).map((entry): SettledInputView => ({ name: entry.name, via: entry.via === "default" ? "default" : "bound", ...(entry.from !== undefined ? { from: entry.from } : {}) }));
          return inputsMissing(input.to, refusal.message, refusal.missing, filled);
        }
        return { ok: false, code: refusal.code, reason: refusal.message, ...(refusal.candidates !== undefined ? { candidates: refusal.candidates } : {}) };
      }
      const { plan } = result;
      return journalMoved("move_task", {
        ok: true,
        task: result.taskId ?? moved,
        resolution: plan.resolution,
        ...(plan.modification !== undefined ? { modification: plan.modification } : {}),
        workflow: plan.workflow,
        standsAt: plan.standsAt.path.join("/") || plan.workflow,
        ...(plan.adoptedAs !== undefined ? { adoptedAs: plan.adoptedAs } : {}),
        ...(plan.mount !== undefined ? { mount: plan.mount } : {}),
        ...(result.moved !== undefined ? { moved: result.moved } : {}),
        ...(result.controlTaskId !== undefined ? { answeredBy: result.controlTaskId } : {}),
        ...(result.moved === "fast-forwarding" && plan.move !== undefined && plan.move.passes.length > 0 ? { through: [...plan.move.passes] } : {}),
      }, call);
    },

    tasks(input: TasksInput): TasksResult {
      const mine = family();
      const interactions = deps.pendingInteractions();
      const questions = deps.pendingQuestions();
      const out: TaskStanding[] = [];
      for (const row of project.runtime.list()) {
        const relation = mine.get(row.taskId);
        if (relation === undefined && input.all !== true) continue;
        const meta = project.tasks.tryRead(row.taskId);
        if (meta === undefined) continue;
        const standing: TaskStanding = { task: row.taskId, title: meta.title, status: row.status, workflow: meta.workflow, ...(relation !== undefined ? { relation } : {}) };
        if (relation !== undefined) {
          const path = boardPathOf(taskRun(project, row.taskId)).flatMap((step) => (step.childKey !== undefined ? [step.childKey] : []));
          if (path.length > 0) standing.standsAt = path.join("/");
          const waits = holdingOf(project, meta);
          if (waits.length > 0) standing.waitsFor = waits.map((held) => held.title);
          if (row.status === "queued" && (meta.origin?.kind !== "split" || meta.origin.start === "manual" || waits.length > 0)) standing.held = true;
          const asking: NonNullable<TaskStanding["asking"]> = [
            // ONLY what a conversation may answer: an approval-shaped gate is not listed, so it cannot be named.
            ...interactions
              .filter((pending) => pending.taskId === row.taskId && ANSWERABLE_COMPONENTS.has(pending.component))
              .map((pending) => ({ request: pending.requestId, kind: pending.component, ...(pending.config !== undefined ? { questions: pending.config as unknown as JsonValue } : {}) })),
            ...questions.filter((pending) => pending.taskId === row.taskId).map((pending) => ({ request: pending.requestId, kind: "agent_question", questions: pending.questions as unknown as JsonValue })),
          ];
          if (asking.length > 0) standing.asking = asking;
          if (row.outputsJson !== undefined) {
            try {
              const outputs = JSON.parse(row.outputsJson) as unknown;
              if (outputs !== null && typeof outputs === "object" && !Array.isArray(outputs)) standing.outputs = Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, shortly(value)]));
            } catch {
              // Unreadable outputs are simply not listed.
            }
          }
        }
        out.push(standing);
      }
      return { tasks: out };
    },

    answer(input: AnswerInput): AnswerResult {
      const mine = family();
      const settled_by = { via: "control" as const, confidence: input.confidence };
      const journal = (askedTaskId: string, kind: AnsweredEvent["kind"], instanceId?: string, toolCallId?: string): void => {
        const event: AnsweredEvent = {
          type: ANSWERED_EVENT,
          requestId: input.request,
          kind,
          ...(instanceId !== undefined ? { instanceId } : {}),
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          byTaskId: taskId,
          settled_by,
        };
        project.events.recorder(askedTaskId).record(event as unknown as EngineEvent, Date.now());
      };
      // The two lists a QUESTION can be on. There is no third lookup: an approval — a tool
      // permission, a publish, a push, a merge — lives on a hub this module was never handed.
      const gate = deps.pendingInteractions().find((pending) => pending.requestId === input.request);
      if (gate !== undefined) {
        if (!mine.has(gate.taskId)) return { ok: false, reason: "that question belongs to a task this conversation did not start" };
        if (!ANSWERABLE_COMPONENTS.has(gate.component)) {
          return { ok: false, reason: `'${gate.component}' is an approval, not a question — it is the person's to give, and \`answer_question\` cannot reach it` };
        }
        if (input.value === undefined) return { ok: false, reason: `a '${gate.component}' gate is answered with \`value\`, in the shape it asks for` };
        // Checked BEFORE the row: an answer the contract refuses settles nothing, and must say nothing.
        const refused = deps.checkInteraction?.(input.request, input.value);
        if (refused !== undefined) return { ok: false, reason: refused };
        try {
          // Journaled first: the answer resumes the run, and the row belongs before what follows it.
          journal(gate.taskId, "interaction", deps.askingInstance?.(gate.taskId, "interaction"));
          deps.submitInteraction(input.request, input.value);
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
        return { ok: true, request: input.request, settled_by };
      }
      const question = deps.pendingQuestions().find((pending) => pending.requestId === input.request);
      if (question !== undefined) {
        if (question.taskId === undefined || !mine.has(question.taskId)) return { ok: false, reason: "that question belongs to a task this conversation did not start" };
        if (input.answers === undefined) return { ok: false, reason: "an agent's questions are answered with `answers`: question text → the chosen label" };
        try {
          // The row names the instance that asked and the `AskUserQuestion` call it answered, both as
          // the request carries them (the engine stamps the instance; the transport reports the call),
          // so the transcript marks exactly that block.
          journal(question.taskId, "question", question.instanceId ?? deps.askingInstance?.(question.taskId, "question"), question.toolCallId);
          deps.submitQuestion(input.request, input.answers);
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
        return { ok: true, request: input.request, settled_by };
      }
      return { ok: false, reason: `no question '${input.request}' is waiting — \`list_tasks\` lists what is being asked. An approval is never listed and cannot be answered here` };
    },

    hold: (input) =>
      gesture(input, async (id) => {
        const row = project.runtime.get(id)!;
        if (row.status === "running" || row.status === "stopping") {
          deps.cancel(id);
          return "stopped where it stands — release continues it";
        }
        const meta = project.tasks.read(id);
        if (row.status === "queued" && meta.origin?.kind === "split" && meta.origin.start !== "manual") {
          project.tasks.write({ ...meta, origin: { ...meta.origin, start: "manual" } });
          return "held — it no longer starts on its own";
        }
        return row.status === "queued" ? "already held" : `nothing to hold: it is ${row.status}`;
      }),
    release: (input) => gesture(input, (id) => release(id)),
    stop: (input) =>
      gesture(input, async (id) => {
        const status = project.runtime.get(id)!.status;
        if (status !== "running" && status !== "stopping") throw new Error(`it is ${status}, not running`);
        deps.cancel(id);
        return "stopped";
      }),
  };
}
