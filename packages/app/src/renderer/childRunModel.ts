/**
 * A run a conversation started (`start_task`, decision 0005): what the Chat view says about it.
 *
 * Starting a workflow from a conversation does not make a second task. The conversation becomes a
 * dynamic workflow and the started state runs as a CHILD of its root, on the same task (decision 0005
 * §3). So the task's `running` status, its instances and the gate it parks on are the child's as much
 * as the conversation's, and the Chat view has to tell the two apart to say anything true: the
 * conversation is not "working" while only its child is, and a question the child asks is not the
 * conversation's.
 *
 * What is decided here (the mockups of 2026-10-25, the person's rulings):
 *  - the run is drawn under the line its `start_task` left, the way a run is drawn anywhere — its own
 *    conversation, nested (`ChildRunLine`), or walked into as the main view;
 *  - what it waits for is said in words — "Waiting for answer" — each wait a pill over the box
 *    (`WaitPills`, design W3), and a press on a pill goes into the run at the step that asks;
 *  - where you stand is a SCOPE: in the conversation you see every wait; walked into a run you see
 *    only that run's, their paths from inside it, and nothing outside it but the breadcrumb's counts.
 *
 * Pure, so the rules can be tested: the components read it.
 */
import type { InstanceNode, PendingApproval, PendingInteraction, PendingQuestion, WorkflowOutcome } from "@jaira/shared/browser";
import { isAsking } from "./stateSurfaceModel";

/**
 * The conversation's own turns: a child under the conversation's own state — the instance its
 * messages are journaled as (`chatTurn.ts`), whatever workflow the conversation runs (decision 0021).
 * A run it started is a child under some OTHER state.
 */
const isOwnTurn = (root: InstanceNode, child: InstanceNode): boolean => child.stateId === root.stateId;

/** The runs a conversation started: its root's children that are not its own turns, oldest first. */
export function childRunsOf(instances: readonly InstanceNode[] | undefined): InstanceNode[] {
  const root = instances?.[0];
  if (root === undefined) return [];
  return root.children.filter((child) => !child.superseded && !isOwnTurn(root, child)).sort((a, b) => a.startedAt - b.startedAt);
}

/** The run a workflow tool's outcome stands for: the newest child under the key it entered. */
export function childRunFor(instances: readonly InstanceNode[] | undefined, outcome: WorkflowOutcome): InstanceNode | undefined {
  const key = outcome.standsAt.split("/")[0];
  return childRunsOf(instances)
    .filter((child) => (child.childKey ?? child.stateId) === key)
    .pop();
}

/** Whether any run the conversation started is still going — working, or waiting on someone. */
export function childRunLive(instances: readonly InstanceNode[] | undefined): boolean {
  return childRunsOf(instances).some((child) => child.endedAt === undefined && (child.status === "running" || child.status === "waiting_for_user" || child.status === "blocked"));
}

/**
 * Whether the conversation's OPENING RUN is what holds the task, as against a run it started. The
 * task's status is `running` for both; only the root's own operation says which.
 */
export function openingRunAnswering(instances: readonly InstanceNode[] | undefined, running: boolean): boolean {
  if (!running) return false;
  if (childRunsOf(instances).length === 0) return true;
  return instances?.[0]?.operation?.status === "running";
}

/**
 * Whether the CONVERSATION is answering — its opening run, or one of its turns — as against a run it
 * started.
 *
 * `producing` is the index's word that a call of the TASK is in flight (an open record). While a run
 * the conversation started is live that call may be the run's — a gate parked on you holds its record
 * open for as long as it waits — so then only the conversation's own turn says so: its root's child
 * under its own state, the one instance every message reopens (`chatTurn.ts`).
 */
export function conversationAnswering(instances: readonly InstanceNode[] | undefined, running: boolean, producing: number): boolean {
  if (openingRunAnswering(instances, running)) return true;
  if (!childRunLive(instances)) return producing > 0;
  const root = instances?.[0];
  return root !== undefined && root.children.some((child) => isOwnTurn(root, child) && (child.status === "running" || child.operation?.status === "running"));
}

// --- waits --------------------------------------------------------------------------------------------

/** One thing the conversation, or a run it started, waits on the person for. */
export interface RunWait {
  /** Where a press goes: the instance that asks. */
  instanceId: string;
  /** Child keys from the conversation down to where the wait is. Empty: the conversation's own. */
  path: string[];
  /** What is waited for: the step, or the action an agent asks to take ("git push"). */
  step: string;
  /** Said before the step, in the same ink: "approve". */
  verb?: string;
  kind: "ask" | "approve";
  /** What it holds: "5 questions", "a shell command". */
  note?: string;
  /** When it started waiting. */
  since?: number;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The keys from `nodes` down to the instance, inclusive; undefined when it is not under them. */
export function keysTo(nodes: readonly InstanceNode[], instanceId: string): string[] | undefined {
  for (const node of nodes) {
    const key = node.childKey ?? node.stateId.split("/").pop() ?? node.stateId;
    if (node.instanceId === instanceId) return [key];
    const below = keysTo(node.children, instanceId);
    if (below !== undefined) return [key, ...below];
  }
  return undefined;
}

function askingNodes(node: InstanceNode): InstanceNode[] {
  if (node.superseded) return [];
  return [...(isAsking(node) ? [node] : []), ...node.children.flatMap(askingNodes)];
}

/** What a gate holds, in a few words: the questions of a stepped choice. */
function gateNote(gate: PendingInteraction | undefined): string | undefined {
  const questions = (gate?.config as { questions?: unknown[] } | undefined)?.questions;
  return questions !== undefined && questions.length > 0 ? plural(questions.length, "question") : undefined;
}

/** An approval's action, as the pill names it: the command's first two words, else the tool. */
function approvalStep(approval: PendingApproval): { step: string; note?: string } {
  const words = approval.command?.trim().split(/\s+/) ?? [];
  if (words.length > 0) return { step: words.slice(0, 2).join(" "), note: "a shell command" };
  return { step: approval.tool };
}

/**
 * Every wait of the conversation and the runs it started: each run's asking steps (a gate), and the
 * agents' approvals and questions — a run's when its instance is in the run, else the conversation's.
 */
export function waitsOf(input: {
  instances: readonly InstanceNode[] | undefined;
  gate?: PendingInteraction | undefined;
  approval?: PendingApproval | undefined;
  question?: PendingQuestion | undefined;
}): RunWait[] {
  const runs = childRunsOf(input.instances);
  const waits: RunWait[] = [];
  for (const run of runs) {
    for (const node of askingNodes(run)) {
      const keys = keysTo([run], node.instanceId) ?? [];
      const note = gateNote(input.gate);
      waits.push({ instanceId: node.instanceId, path: keys.slice(0, -1), step: keys[keys.length - 1] ?? node.stateId, kind: "ask", ...(note !== undefined ? { note } : {}), since: node.startedAt });
    }
  }
  const placed = (instanceId: string | undefined): string[] => (instanceId === undefined ? [] : (runs.map((run) => keysTo([run], instanceId)).find((keys) => keys !== undefined) ?? []));
  if (input.approval !== undefined) {
    const { step, note } = approvalStep(input.approval);
    waits.push({ instanceId: input.approval.instanceId ?? "", path: placed(input.approval.instanceId), step, verb: "approve", kind: "approve", ...(note !== undefined ? { note } : {}), since: input.approval.at });
  }
  if (input.question !== undefined) {
    waits.push({ instanceId: input.question.instanceId ?? "", path: placed(input.question.instanceId), step: "answer", kind: "ask", note: plural(input.question.questions.length, "question"), since: input.question.at });
  }
  return waits;
}

/**
 * The waits as seen from where you stand (`scope`: the keys walked into, none in the conversation):
 * only those inside it, their paths from inside it. Nothing outside the scope is anyone's business here.
 */
export function scopedWaits(waits: readonly RunWait[], scope: readonly string[]): RunWait[] {
  return waits.filter((wait) => scope.every((key, i) => wait.path[i] === key)).map((wait) => ({ ...wait, path: wait.path.slice(scope.length) }));
}

/** How many waits are inside each level of a breadcrumb: the conversation, then each run walked into. */
export function waitCountsByLevel(waits: readonly RunWait[], scope: readonly string[]): number[] {
  return [0, ...scope.map((_, i) => i + 1)].map((depth) => scopedWaits(waits, scope.slice(0, depth)).length);
}

// --- the running step ---------------------------------------------------------------------------------

/** The step a run is working on, for the pill and the line while nothing waits. */
export function runningStepOf(run: InstanceNode): { instanceId: string; path: string[]; step: string; since: number } | undefined {
  const leaf = deepestRunning(run);
  if (leaf === undefined) return undefined;
  const keys = keysTo([run], leaf.instanceId) ?? [];
  return { instanceId: leaf.instanceId, path: keys.slice(0, -1), step: keys[keys.length - 1] ?? leaf.stateId, since: leaf.startedAt };
}

function deepestRunning(node: InstanceNode): InstanceNode | undefined {
  if (node.superseded) return undefined;
  for (const child of [...node.children].reverse()) {
    const inside = deepestRunning(child);
    if (inside !== undefined) return inside;
  }
  return node.children.length === 0 && node.endedAt === undefined && node.status === "running" ? node : undefined;
}

/** How many steps a run has taken (its leaves) — the line's tail. */
export function stepsIn(node: InstanceNode): number {
  return node.children.length === 0 ? 1 : node.children.reduce((sum, child) => sum + stepsIn(child), 0);
}

// --- fitting the pills to the room --------------------------------------------------------------------

/**
 * How much a pill says, most to least, one level for the whole row: 4 where it is (the whole path), what
 * it holds and since when; 3 the step's parent and what it holds; 2 what it holds; 1 the step alone, on
 * one line; 0 the step, cut. The most that lets every pill sit on one line wins.
 */
export type PillLevel = 0 | 1 | 2 | 3 | 4;

/** Character widths of the pill's faces, in CSS px — the first line's (12.5 app, the step in data 600) and the second's (10 app). */
const BIG = 6.6;
const STEP = 7.6;
const SMALL = 5.3;
/** The pill's frame: its padding, the mark and the gap after it. */
const FRAME = 12 + 12 + 8 + 14;
export const PILL_GAP = 8;
/** The "+N waiting" pill. */
const MORE = 110;

/** The words of a wait's second line at a level. */
export function secondLine(wait: RunWait, level: PillLevel, clock: (at: number) => string): string {
  if (level < 2) return "";
  const where = wait.path.length === 0 ? "in this conversation" : level >= 4 ? `in ${wait.path.join(" › ")}` : level === 3 ? `in ${wait.path[wait.path.length - 1]}` : "";
  return [where, wait.note ?? "", level >= 4 && wait.since !== undefined ? clock(wait.since) : ""].filter((part) => part !== "").join(" · ");
}

/** "8 steps", the step's name cut at level 0. */
export const CUT = 10;

export function pillWidth(wait: RunWait, level: PillLevel, clock: (at: number) => string = () => "00:00 PM"): number {
  const name = level === 0 ? Math.min(wait.step.length, CUT) : wait.step.length;
  const first = "Waiting for ".length * BIG + (wait.verb !== undefined ? (wait.verb.length + 1) * BIG : 0) + name * STEP;
  const second = secondLine(wait, level, clock).length * SMALL;
  return FRAME + Math.max(first, second);
}

/** The level every pill can share in `room` px, and how many pills that leaves room for (the rest are "+N"). */
export function fitPills(waits: readonly RunWait[], room: number, clock?: (at: number) => string): { level: PillLevel; shown: number } {
  const total = (level: PillLevel, n: number): number => waits.slice(0, n).reduce((sum, wait) => sum + pillWidth(wait, level, clock), 0) + Math.max(0, n - 1) * PILL_GAP;
  for (const level of [4, 3, 2, 1, 0] as PillLevel[]) if (total(level, waits.length) <= room) return { level, shown: waits.length };
  let shown = waits.length;
  while (shown > 0 && total(0, shown) + PILL_GAP + MORE > room) shown -= 1;
  return { level: 0, shown };
}
