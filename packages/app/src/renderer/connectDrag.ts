/**
 * A drag that CONNECTS (decision 0005 §1, "What draws → The drop preview") — the board's half.
 *
 * A card dragged where no waiting rule offered it a place is still going somewhere: `connect(task,
 * target)` finds or makes the workflow that relates the two. What the board owes the person is the
 * answer BEFORE they let go — every column that can take the task lights, and the one under the
 * pointer says which of the three things a drop will do, where the task will stand, and what will be
 * asked afterwards. Then the drop is the commit; nothing is confirmed.
 *
 * ## Once per column per drag
 *
 * The answer comes from the host's DRY RUN, which loads workflows and folds a journal: it is asked
 * once per column per drag, never per mouse move. {@link ConnectDrag} is that memo. It is made when
 * a card is picked up, asks about every column at once (which is what lets them light before the
 * pointer reaches them), and is thrown away when the card is put down.
 *
 * ## The move table
 *
 * Every answer carries the table's verdict (`ConnectPlan.judgement`, decision 0005's rulings of
 * 2026-09-22): a column the task cannot reach from where it stands does not light and says why; a
 * column whose move ASKS first (a working task sent back, or into another workflow) lights and says
 * the drop will ask — the board puts that question in front of the commit; and a target lacking
 * inputs says they will be asked in the task's own conversation.
 *
 * No React and no DOM, so both halves — the memo and the words — are tested as plain functions.
 */
import type { BoardCard, BoardColumn, ConnectPlan, TaskConnectResult } from "@jaira/shared/browser";

/** What is known about one column while a card is in the air. */
export type ColumnAnswer = { status: "asking" } | { status: "answered"; result: TaskConnectResult } | { status: "failed"; message: string };

/** The dry run, as the board asks it. */
export type ConnectAsk = (card: BoardCard, column: Pick<BoardColumn, "key" | "stateId">) => Promise<TaskConnectResult>;

/** One drag's answers, by column key. */
export class ConnectDrag {
  private readonly answers = new Map<string, ColumnAnswer>();
  private dropped = false;

  constructor(
    readonly card: BoardCard,
    private readonly ask: ConnectAsk,
    /** Called when an answer arrives, so the board draws it. Never called after {@link end}. */
    private readonly changed: () => void,
  ) {}

  /** Ask about a column — ONCE. A second call for the same column is the memo's whole reason to exist. */
  resolve(column: Pick<BoardColumn, "key" | "stateId">): void {
    if (this.answers.has(column.key)) return;
    this.answers.set(column.key, { status: "asking" });
    void this.ask(this.card, column).then(
      (result) => this.settle(column.key, { status: "answered", result }),
      (e: unknown) => this.settle(column.key, { status: "failed", message: (e as Error).message }),
    );
  }

  private settle(key: string, answer: ColumnAnswer): void {
    this.answers.set(key, answer);
    if (!this.dropped) this.changed();
  }

  answer(key: string): ColumnAnswer | undefined {
    return this.answers.get(key);
  }

  /** Would a drop on this column DO something? Only an answered, unrefused dry run says yes. */
  accepts(key: string): boolean {
    const answer = this.answers.get(key);
    return answer?.status === "answered" && answer.result.ok;
  }

  /** The card was put down: late answers are dropped on the floor. */
  end(): void {
    this.dropped = true;
  }
}

/**
 * The column a card is IN, on this board — the one column a drag does not ask about.
 *
 * At the root listing that is the card's own workflow; below it, the column holding the card.
 */
export function ownColumnOf(columns: readonly BoardColumn[], card: BoardCard): string | undefined {
  return columns.find((column) => column.cards.some((c) => c.taskId === card.taskId))?.key;
}

/**
 * Whether a card can be picked up to be connected at all: a task that has never run stands nowhere.
 * A queued task WITH a path is one an adoption made, standing past the child it took up.
 */
export function canConnect(card: Pick<BoardCard, "status" | "activePath" | "origin" | "under">): boolean {
  // A task that stands for a CHILD of another — an element a mount made, a task somebody adopted —
  // is moved by moving the task it belongs to.
  if (card.origin?.kind === "task" || card.origin?.kind === "adopt" || card.under !== undefined) return false;
  return card.status !== "queued" || card.activePath.length > 0;
}

// ---------------------------------------------------------------------------------------------------
// the words
// ---------------------------------------------------------------------------------------------------

/** A run of text with the parts a preview draws strong or as code. */
export type Words = Array<string | { b: string } | { code: string }>;

export interface ConnectPreview {
  /** `Adopt into` · `Move within` · `New transition` — which of the three a drop is. */
  kind: string;
  say: Words;
  facts: Words[];
  /** The line in the accent: what letting go does. Absent when the drop is refused. */
  drop?: string;
  /** Why a drop here does nothing, in the host's words. */
  refused?: string;
  /** The move table ASKS before this drop commits: the question the board puts to the person. */
  confirm?: string;
}

const KIND: Record<ConnectPlan["resolution"], string> = { adopt: "Adopt into", move: "Move within", modify: "New transition" };
const last = (id: string): string => id.split("/").at(-1) ?? id;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the hovered column says — see the module header. `undefined` while the answer is on its way. */
export function previewOf(answer: ColumnAnswer | undefined, card: Pick<BoardCard, "workflow">, column: Pick<BoardColumn, "key" | "stateId" | "label">): ConnectPreview | undefined {
  if (answer === undefined || answer.status === "asking") return undefined;
  if (answer.status === "failed") return { kind: "Cannot move here", say: [answer.message], facts: [], refused: answer.message };
  const { result } = answer;
  const plan = result.plan;
  // Unreachable from where the task stands (the move table's ILLEGAL row): said plainly, and nothing lights.
  if (!result.ok && result.refusal.code === "illegal") {
    return { kind: "Cannot move here", say: [result.refusal.message], facts: [], refused: "The workflow does not go there from where this task stands." };
  }
  if (plan === undefined) {
    const refusal = result.ok ? "" : result.refusal.message;
    const candidates = result.ok ? [] : (result.refusal.candidates ?? []);
    return {
      kind: candidates.length > 0 ? "Adopt into" : "Cannot move here",
      say: [refusal],
      facts: candidates.map((c): Words => ["could join ", { b: c.label ?? c.workflow }, " as ", { code: c.childKey }]),
      refused: refusal,
    };
  }
  const name = plan.workflowLabel ?? column.label ?? last(plan.workflow);
  const at = plan.standsAt.path.join("/");
  const facts: Words[] = [];
  let say: Words;
  let drop: string;
  if (plan.resolution === "adopt") {
    // A fanned-out mount takes the task as ONE ELEMENT of its batch (decision 0005, 2026-09-22).
    const element = plan.adopt?.adopted.find((child) => child.childKey === plan.adoptedAs && child.shape === "element");
    say =
      element !== undefined
        ? [
            { b: name },
            " runs ",
            { code: plan.adoptedAs ?? "" },
            element.each === "task" ? " once per element of a list, each as a task. " : " once per element of a list. ",
            result.ok ? `The task becomes one of those ${element.each === "task" ? "tasks" : "elements"}; nothing runs again.` : `The task would become one of those ${element.each === "task" ? "tasks" : "elements"}.`,
          ]
        : [{ b: name }, " mounts this task's state as ", { code: plan.adoptedAs ?? "" }, result.ok ? ". The task becomes that child; nothing runs again." : ". The task would become that child."];
    if (element !== undefined) {
      facts.push(
        element.appended === true
          ? ["added to its batch as element ", { b: String((element.index ?? 0) + 1) }]
          : (element.index ?? 0) === 0
            ? ["the batch is this task alone"]
            : ["element ", { b: String((element.index ?? 0) + 1) }, element.each === "task" ? " of the list; the rest are made as tasks" : " of the list; the rest run here"],
      );
    }
    if (at.length > 0) facts.push(["stands at ", { b: at }]);
    for (const [input, settled] of Object.entries(plan.adopt?.provenance ?? {})) {
      if (settled.via === "bound" && settled.from !== undefined) facts.push([{ b: input }, " taken from what ", plan.adoptedAs ?? "it", " ran with"]);
    }
    drop = "Drop to adopt";
  } else if (plan.resolution === "move") {
    const move = plan.move;
    const passes = move?.passes ?? [];
    say =
      move?.direction === "backward"
        ? [{ b: at }, " is behind where this task stands. It is entered again, as the next pass."]
        : passes.length > 0
          ? [{ b: at }, ` is ${count(passes.length, "state")} ahead in this task's workflow.`]
          : [{ b: at }, move?.direction === "next" ? " is the state that comes next." : " is a state of this task's workflow."];
    // A FAST-FORWARD runs them (decision 0005 §4, the default for every forward move); a skip steps
    // over them; a refused forward move only names what lies between.
    const fastForward = result.ok && passes.length > 0 && plan.forward !== "skip";
    if (passes.length > 0) {
      facts.push(
        !result.ok
          ? [{ b: passes.join(" → ") }, passes.length === 1 ? " lies between" : " lie between"]
          : fastForward
            ? ["runs ", { b: passes.join(" → ") }, " on the way, the conversation answering what comes up"]
            : ["steps over ", { b: passes.join(" → ") }, ", recorded as skipped"],
      );
    }
    if (move?.stepsPast !== undefined) facts.push(["steps past ", { b: move.stepsPast }, ", where it stopped"]);
    if (move?.answersRule === true) facts.push(["the workflow is waiting for exactly this move"]);
    drop = move?.direction === "backward" ? "Drop to go back" : fastForward ? "Drop to fast-forward" : passes.length > 0 ? "Drop to skip ahead" : "Drop to move";
  } else {
    const own = last(card.workflow);
    say =
      plan.modification === "augmented"
        ? ["This task's workflow ", result.ok ? "gains" : "would gain", " a move to ", { b: last(plan.standsAt.stateId) }, "."]
        : [
            "No workflow holds both ",
            { b: own },
            " and ",
            { b: last(plan.standsAt.stateId) },
            ". ",
            // A refused drop says what it WOULD have been: nothing is made by hovering, or by letting go.
            plan.modification === "new"
              ? `A new one ${result.ok ? "is" : "would be"} made around this task, with a move to it.`
              : `This task's copy of the workflow ${result.ok ? "gains" : "would gain"} a move to it.`,
          ];
    if (plan.modification === "cloned") facts.push(["the copy stops following ", { b: own }]);
    if (plan.modification === "new") facts.push(["this task becomes its first child, ", { code: plan.adoptedAs ?? "" }]);
    if (plan.mount === "split") facts.push(["one task per element, made ", { b: "held" }, " — none starts"]);
    drop = "Drop to add the move and take it";
  }
  for (const input of plan.inputs) {
    if (input.via === "wire" && input.from !== undefined) facts.push([{ b: input.name }, input.each === "split" ? " takes one element of " : " comes from ", { b: input.from }]);
  }
  // What the move will ASK for in this task's own conversation, after what the workflow binds.
  if (result.ok) for (const input of plan.question ?? []) facts.push([{ b: input.name }, " will be asked in this task's conversation", ...(input.description !== undefined ? [` — ${input.description}`] : [])]);
  if (plan.asks.length > 0) facts.push([{ b: count(plan.asks.length, "input") }, " can be given afterwards"]);
  if (plan.branch !== undefined) facts.push(["works on branch ", { b: plan.branch }]);

  if (!result.ok) {
    const missing = result.refusal.missing ?? [];
    for (const input of missing) facts.push([{ b: input.name }, ` is required and unbound — ${input.reason}`]);
    // A forward move the app cannot run says why in its own words — a running task with no
    // conversation, nothing left to run — which is exactly what a hover should say.
    const refused = missing.length > 0 ? `${count(missing.length, "required input")} would not be bound.` : result.refusal.message;
    return { kind: KIND[plan.resolution], say, facts, refused };
  }
  // The move table's ASK cells: the drop still commits, once the person has said yes to this.
  const judgement = plan.judgement;
  if (judgement?.confirm !== undefined) {
    return {
      kind: KIND[plan.resolution],
      say,
      facts,
      drop: judgement.confirm === "stop-and-rewind" ? "Drop, then confirm: stop it and go back" : "Drop, then confirm: pause it and move it",
      ...(judgement.sentence !== undefined ? { confirm: judgement.sentence } : {}),
    };
  }
  if ((plan.question ?? []).length > 0) drop = `${drop}, then answer in its conversation`;
  return { kind: KIND[plan.resolution], say, facts, drop };
}

// ---------------------------------------------------------------------------------------------------
// filing: an adopted task under the task that adopted it
// ---------------------------------------------------------------------------------------------------

/**
 * A column's cards with each ADOPTED task pulled out from wherever its own status filed it and put
 * beneath the task that adopted it — when that task is in this column too.
 *
 * An adopted task is finished and its parent usually is not, so the lanes would put them at opposite
 * ends of the column; what relates them is not a status. A child whose parent is elsewhere (another
 * column of the parent's own board) stays an ordinary card.
 */
export function nestUnder<T extends Pick<BoardCard, "taskId" | "under">>(cards: readonly T[]): { top: T[]; beneath: Map<string, T[]> } {
  const here = new Set(cards.map((card) => card.taskId));
  const beneath = new Map<string, T[]>();
  const top: T[] = [];
  for (const card of cards) {
    if (card.under !== undefined && here.has(card.under) && card.under !== card.taskId) {
      const list = beneath.get(card.under);
      if (list === undefined) beneath.set(card.under, [card]);
      else list.push(card);
    } else top.push(card);
  }
  return { top, beneath };
}
