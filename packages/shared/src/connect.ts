/**
 * `connect(task, target)` (decision 0005 §1, step 5) — the contract.
 *
 * One host operation behind a board drop, a conversation's `move` tool and `jaira task move`: a task
 * is sent to a state, and the host finds — or makes — the workflow that relates the two. Three
 * resolutions, tried in order:
 *
 *  1. **move** — the target is in the task's own workflow. Behind where the task stands it is a
 *     backward move; ahead of it, a forward one ({@link ConnectForward}).
 *  2. **adopt** — a real workflow mounts both the task's root state and the target under one
 *     composite (or IS the target, and mounts the task's state). A new task is made in it, the task is
 *     adopted as the child it is, and rule 1 applies to the new task.
 *  3. **modify** — nothing relates the two, so the task's frozen workflow gains a standing move to
 *     the target: a finished task is wrapped in a `new` dynamic document and adopted into it, a
 *     task already in a document has it `augmented`, a task inside a real workflow has its copy
 *     `cloned`.
 *
 * Every resolution ends by settling the target's inputs from the workflow's own bindings. What they
 * leave open a conversation supplies (`supplied`); a connect whose required inputs still do not bind
 * is REFUSED, naming each missing input with its declared schema — except a drop that says
 * `askAfter`, which makes the conversation and has it ask.
 *
 * The platform never names a workflow's input (§0): everything here is derived from declared
 * schemas, bindings and descriptions.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { AdoptPlan, AdoptRefusal, InputProvenance } from "./adopt";
import type { ProjectRef } from "./ipc";
import type { TaskMoveResult } from "./userEvents";

/**
 * How a forward move crosses the states between.
 *
 * `fast-forward` — the decision's default — RUNS them, with a control conversation answering what
 * comes up (`TaskFastForwardRequest`, step 7). `skip` transitions directly and records what it
 * passed `skipped`. A host that drives no run (the CLI) cannot fast-forward, and there a forward move
 * that would step over states is refused unless it says `skip`. A forward move to the very next
 * state needs neither.
 */
export type ConnectForward = "fast-forward" | "skip";

export interface TaskConnectRequest {
  project?: ProjectRef;
  taskId: string;
  /** The target: a state id (`feature/ux`). A workflow's own root id means "into this workflow". */
  target: string;
  /** The workflow the target is meant in — the root state id of the composite that holds it. Narrows rule 2. */
  workflow?: string;
  /** How a forward move crosses what lies between. Absent ⇒ `fast-forward`. */
  forward?: ConnectForward;
  /** `skip: true` is `forward: "skip"` — the spelling the conversation's `move` tool and the CLI use. */
  skip?: boolean;
  /** Who asked: a person directly (the default), or a control conversation on their behalf. */
  by?: "person" | "control";
  /** Say what WOULD happen — which resolution, where the task will stand, what is missing — and change nothing. */
  dryRun?: boolean;
  /**
   * `false` leaves a task this connect MAKES queued where nothing has to run for the move to be made
   * (an adoption whose target is the state that comes next anyway). A move that an engine has to
   * take starts one regardless. Absent ⇒ start.
   */
  start?: boolean;
  /**
   * Values a conversation hands the target (§4 "Inputs"), by the target's OWN declared input names,
   * each with who settled it: `inferred` from what had been said, or `asked` of the person in words.
   * They win over a wire. On a move within a workflow they ride the directed transition; on a
   * modified workflow they are literals on the generated mount, provenance beside the value.
   */
  supplied?: Record<string, ConnectSupplied>;
  /**
   * What a DROP says (step 6): where a modified workflow leaves required inputs open, do not refuse —
   * make the conversation that controls the work anyway, with the target not yet mounted, and answer
   * `asking`. The host then gives that conversation its opening turn, which asks for them in words,
   * and the conversation's own `start_task` mounts the target with what it was told. A dry run with
   * it answers the same `asking` and writes nothing, which is what the board's hover says. Only a
   * modified workflow (rule 3) is asked after; a move within a workflow or an adoption that leaves a
   * required input open is still refused with what is missing.
   */
  askAfter?: boolean;
  /** Scripted gate answers and prompt rules for a run this starts (tests/demos). */
  interactions?: Record<string, JsonValue[]>;
  fake?: JsonValue;
}

/** One value a conversation supplied, and how it came by it. */
export interface ConnectSupplied {
  value: JsonValue;
  via: "inferred" | "asked";
  /** How sure the conversation was of an `inferred` value, 0–1. */
  confidence?: number;
}

export type ConnectResolution = "move" | "adopt" | "modify";

/** One required input nothing binds — what a refusal lists, and what step 6's conversation will ask. */
export interface ConnectMissingInput {
  /** The state whose input it is: the target, or an ancestor entered on the way down to it. */
  state: string;
  name: string;
  schema?: JsonValue;
  description?: string;
  /** Why it does not bind: no wire, a wire reading a state that has not run, several outputs that fit. */
  reason: string;
}

/** A workflow that could adopt the task and holds the target — returned when there is more than one. */
export interface ConnectCandidate {
  workflow: string;
  label?: string;
  /** The child key the task would be adopted as. */
  childKey: string;
  /** The child key of the target, absent when the target is the workflow itself. */
  targetKey?: string;
}

export interface ConnectRefusal {
  code:
    | "unknown-task"
    | "unknown-target"
    | "already-there"
    | "never-run"
    | "running"
    | "unloadable"
    | "ambiguous-workflow"
    | "fast-forward"
    | "inputs-missing"
    | "adopt"
    | "generate"
    /** An earlier connect of this task stopped part-way, and only the same drop may finish it. */
    | "connecting";
  message: string;
  /** `inputs-missing`: exactly which, with their schemas. */
  missing?: ConnectMissingInput[];
  /** `ambiguous-workflow`: the workflows to choose between — call again naming one. */
  candidates?: ConnectCandidate[];
  /** `adopt`: the adoption's own refusal. */
  adopt?: AdoptRefusal;
}

/** The directed transition a connect ends in, where it ends in one. */
export interface ConnectMove {
  /**
   * `backward` — re-entered as the next occurrence, with the usual reset; `next` — the state that
   * comes next anyway; `forward` — states lie between; `aside` — the target is on no spine (a
   * document's children are entered only by moves).
   */
  direction: "backward" | "next" | "forward" | "aside";
  /** The composite whose child is entered, by instance id. Absent ⇒ the task's root instance. */
  instanceId?: string;
  /** The child key entered. */
  to: string;
  /** Child keys entered beneath it on the way down to a nested target, in order. */
  path: string[];
  /** The states a forward move steps over, as paths of child keys — what `skip` records `skipped`. */
  passes: string[];
  /**
   * The state the task STOPPED in, which the move steps past: nothing is running in a task that is
   * not running, so there is nothing to wait out, and the state is recorded `skipped` rather than
   * continued first. Absent for a running task (a move is held until its state ends, unless `skip`)
   * and for one that had finished.
   */
  stepsPast?: string;
  /** A transition of the workflow is already waiting on exactly this move: it is answered, and nothing is stepped over by us. */
  answersRule?: boolean;
}

/** How one input of the target is settled. */
export interface ConnectInput {
  name: string;
  /** `wire` — the workflow's binding; `literal` — a value recorded on a generated mount; `default` — the slot's own. */
  via: "wire" | "literal" | "default";
  /** Where a wire reads from, in words: `product.brief`, `inputs.issue`. */
  from?: string;
  /** The wire takes ONE element of a list: the mount is a generated split, its tasks made held. */
  each?: "split";
}

/** What a connect does — or, from a dry run, would do. */
export interface ConnectPlan {
  resolution: ConnectResolution;
  /** `modify`: which of the three modifications. */
  modification?: "new" | "augmented" | "cloned";
  /** The workflow the task will stand in: its own, the adopting one, or the document's root. */
  workflow: string;
  workflowLabel?: string;
  /** Where the task will stand: child keys from the workflow's root, and the state there. */
  standsAt: { path: string[]; stateId: string; label?: string };
  /** The move that takes it there. Absent when the adoption alone does (the target comes next, or is the workflow itself). */
  move?: ConnectMove;
  /**
   * How a FORWARD move crosses what lies between, when it steps over anything (§4): `fast-forward`
   * runs those states with a conversation answering on the way; `skip` records them `skipped` and
   * goes directly. Absent for any other move.
   */
  forward?: ConnectForward;
  /** `adopt`, and `modify` of a finished task: the adoption that is part of it. Absent from a `new` dry run, whose parent does not exist yet. */
  adopt?: AdoptPlan;
  /** `adopt`/`new`: the child key the task becomes. */
  adoptedAs?: string;
  /** `modify`: the mount the document gains — `split` makes held tasks, one per element. */
  mount?: "plain" | "split";
  /** How the target's inputs settle. */
  inputs: ConnectInput[];
  /** What will be asked afterwards: inputs nothing determines that are NOT required (a required one refuses). */
  asks: ConnectMissingInput[];
  /** The branch the new parent takes up, when the adopted task had one. */
  branch?: string;
}

/**
 * How to take a connect back — handed out by a real connect, handed back to `task:connectUndo`.
 *
 *  - `adopt` — the parent is rewound past the mirror row, which un-adopts; a parent the connect made
 *    that holds nothing else is removed with it (its worktree, which is the adopted task's, is not).
 *  - `move`  — the task is rewound to before the move. A rewind behind the row that moved it into a
 *    document puts it back under its previous pin, which is how a clone is undone.
 */
export type ConnectUndo =
  | {
      kind: "adopt";
      parentTaskId: string;
      adoptedTaskId: string;
      made: boolean;
      /** The drop's `jaira.connect` rows (`CONNECT_EVENT`): its `intent` is the adopted task's place at the drop. */
      mark: string;
    }
  | {
      kind: "move";
      taskId: string;
      /**
       * The drop's `jaira.connect` rows (`CONNECT_EVENT`): its `intent` row is the task's first row of
       * the drop, and the cut is made there.
       */
      mark: string;
      pin?: { snapshotHash: string; documentId?: string };
      /** The task had finished: it goes back to having finished. */
      wasCompleted?: boolean;
      /**
       * An `askAfter` drop that made or reused a conversation and moved nothing: what was written from
       * the `intent` row on — the conversation's opening turn — is cut and the pin put back, and nothing is resumed.
       */
      asking?: true;
    };

export type TaskConnectResult =
  | {
      ok: true;
      dryRun: boolean;
      plan: ConnectPlan;
      /** The task that stands at the target — the moved task, or the parent a connect made. Absent from a dry run that would make one. */
      taskId?: string;
      /**
       * How the move landed, when there was one to make. `fast-forwarding` is the forward case
       * (§4): no transition was handed to anybody — the machine is running the states between, with
       * a conversation answering on the way and Skip showing.
       */
      moved?: TaskMoveResult["status"] | "fast-forwarding";
      /** The conversation answering on the way, when this started a fast-forward. */
      controlTaskId?: string;
      undo?: ConnectUndo;
      /**
       * `askAfter`: the conversation exists and the task has NOT moved — these required inputs are
       * what its conversation is about to ask for. `taskId` is the task that conversation is.
       */
      asking?: ConnectMissingInput[];
    }
  | { ok: false; dryRun: boolean; refusal: ConnectRefusal; /** How far the resolution got, for a preview that explains the refusal. */ plan?: ConnectPlan };

/**
 * A connect's INTENT — written on the dragged task's journal before the connect writes anything
 * (`CONNECT_EVENT`, `at: "intent"`), so a retry and the next open after a crash finish the drop as it
 * was first meant (decision 0005, "A connect that stops part-way", 2026-09-22). Nothing in it is
 * re-resolved: the resolution was decided once, here, and the steps are carried out in order, each
 * marking itself done with what it made.
 */
export interface ConnectIntent {
  /** What was asked, as it was asked: the target, the supplied inputs, skip, askAfter, the scripts. */
  request: Omit<TaskConnectRequest, "dryRun" | "project">;
  /** The plan as resolved, before anything was written — what the done connect answers with, completed by the steps' results. */
  plan: ConnectPlan;
  steps: ConnectStep[];
  /** How the dragged task stood before the drop — what a move's Undo puts back. */
  before: { pin?: { snapshotHash: string; documentId?: string }; wasCompleted?: true };
  /** `askAfter`: what the conversation it makes will ask for. */
  asking?: ConnectMissingInput[];
}

/**
 * One step of a connect. `on: "parent"` is the task an earlier `parent` or `adopt` step made; a
 * `move` after a `document` step enters the key the document gave the target.
 */
export type ConnectStep =
  /** Generate and write the document version the move needs — `new`, `augmented` or `cloned`. */
  | { kind: "document"; conversation: string; withoutTarget?: true }
  /** Make the document's task: the conversation, with the source adopted into it next. */
  | { kind: "parent"; title: string; inputs?: Record<string, JsonValue>; provenance?: Record<string, InputProvenance> }
  /** Adopt the dragged task — into the `parent` step's task, or into a new task of `workflow`. */
  | { kind: "adopt"; intoParent?: true; workflow?: string; childKey?: string; start: boolean; inputs?: Record<string, JsonValue>; suppliedVia?: "inferred" | "asked" }
  /** Journal how the values a conversation handed the entry were settled (`jaira.supplied`). */
  | { kind: "supplied"; on: "task" | "parent"; to: string; instanceId?: string; nested?: true; names: string[] }
  /** `task_move`, published. */
  | { kind: "move"; on: "task" | "parent"; move: ConnectMove; inputs?: Record<string, JsonValue> }
  /** Run the machine to the target (§4). */
  | { kind: "fastForward"; on: "task" | "parent"; move: ConnectMove; inputs?: Record<string, JsonValue> };

/** What a step made — carried on its `step` row, so a later step (and a retry) can use it. */
export interface ConnectStepResult {
  documentId?: string;
  /** The document's root state id. */
  rootId?: string;
  /** The child key the document mounts the target under. */
  targetKey?: string;
  /** The child key the document mounts the dragged task's state under (`new`). */
  sourceKey?: string;
  /** The task a `parent` or `adopt` step made. */
  parentTaskId?: string;
  adopt?: AdoptPlan;
  moved?: TaskMoveResult["status"] | "fast-forwarding";
  controlTaskId?: string;
}

export interface TaskConnectUndoRequest {
  project?: ProjectRef;
  /**
   * The card whose Undo was pressed. The token that card's task KEEPS (`TaskMeta.connectUndo`) is the
   * only one there is: it is judged against the journal when it is used, and a stale one is refused.
   */
  taskId: string;
}

/**
 * A connect's Undo as the task file KEEPS it, so it survives a restart (decision 0005 step 5, made
 * durable 2026-09-22) — and what it takes to judge whether it still means "take back what I just
 * did" (2026-09-22, the same day: a card no longer offers Undo forever).
 *
 * The WATCHED journal is the moved task's for a move, and the parent's for an adoption. Every place
 * in a journal is a ROW, found by the token's `mark` (the drop's `jaira.connect` rows): not a count
 * of rows, which drifts when a retry deletes a row from before the drop, and not a seq, which a
 * file-backed journal's replay re-mints.
 *
 *  - A move: its `intent` row is where the Undo cuts back to, and where judging starts.
 *  - An adoption: its `intent` row is on the ADOPTED task, which must do nothing past it.
 *  - Either: its `done` row, on the watched journal, closes the drop's own writes — a held move, a
 *    fast-forward, a reopening or a supplied start after it is a later move, not this drop.
 */
export interface StoredConnectUndo {
  undo: ConnectUndo;
  /** Where the drop landed: `ConnectPlan.standsAt.path`, child keys from the watched task's root. */
  landing: string[];
  /**
   * The drop opened a conversation that asks for the target's inputs (`askAfter`) and moved nothing:
   * its turns are the drop's, and the conversation's `start_task` mounting the target ends the Undo.
   */
  asking?: true;
}

export interface TaskConnectUndoResult {
  /** The task the person is left looking at: the un-adopted task, or the task put back. */
  taskId: string;
  /** A parent the connect had made was removed. */
  removed?: string;
}
