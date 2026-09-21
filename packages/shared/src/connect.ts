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
 * Every resolution ends by settling the target's inputs from the workflow's own bindings. Until the
 * conversations exist (step 6) a connect whose required inputs do not all bind is REFUSED, naming
 * each missing input with its declared schema.
 *
 * The platform never names a workflow's input (§0): everything here is derived from declared
 * schemas, bindings and descriptions.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { AdoptPlan, AdoptRefusal } from "./adopt";
import type { ProjectRef } from "./ipc";
import type { TaskMoveResult } from "./userEvents";

/**
 * How a forward move crosses the states between.
 *
 * `fast-forward` — the decision's default — RUNS them, with a control conversation answering what
 * comes up. It is step 7's, and until it exists a forward move that would step over states is
 * refused unless it says `skip`, which transitions directly and records what it passed `skipped`. A
 * forward move to the very next state needs neither.
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
   * `asking`. The host then has that conversation ask, in words, and the conversation's own `start`
   * mounts the target with what it was told. Ignored by a dry run, which still says what is missing.
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
    | "generate";
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
  | { kind: "adopt"; parentTaskId: string; adoptedTaskId: string; made: boolean }
  | { kind: "move"; taskId: string; after: number; pin?: { snapshotHash: string; documentId?: string }; /** The task had finished: it goes back to having finished. */ wasCompleted?: boolean };

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

export interface TaskConnectUndoRequest {
  project?: ProjectRef;
  undo: ConnectUndo;
}

export interface TaskConnectUndoResult {
  /** The task the person is left looking at: the un-adopted task, or the task put back. */
  taskId: string;
  /** A parent the connect had made was removed. */
  removed?: string;
}
