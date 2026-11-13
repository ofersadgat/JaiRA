/**
 * A subagent a conversation's agent started (an `Agent` call), as the Chat view draws it: the same way a
 * run the conversation started is drawn (`childRunModel.ts`; the person, 2026-11-12: "make viewing a
 * subagent in a session work the same way as viewing a nested workflow").
 *
 *  - under the call that started it, a run's line (`ChildRunLine`): the go-in chevron, what it is doing
 *    (waiting for something, or running a call), and "N steps · time ⌄", opening it in place;
 *  - walked into, it is the main view and the title a breadcrumb, one crumb per subagent walked through;
 *  - what it waits for is a pill over the box, a press going into it, and a scope: walked into a
 *    subagent you see only its waits.
 *
 * A subagent is named by the call that started it, and a subagent it started by that one's call: a
 * CHAIN of calls, outermost first, is where you stand. Pure, so the rules can be tested.
 */
import type { JsonValue } from "@declarative-ai/json";
import { approvalCallIndex } from "./approvalCall";
import type { RunWait } from "./childRunModel";
import type { TranscriptEntry, ToolEntry } from "./transcript";
import { toolLineOf } from "./transcriptRows";
import { isHostCall as isHostWork } from "./workSummary";

export interface Subagent {
  /** The call that started it: its key everywhere (`ToolEntry.sidechain`). */
  call: string;
  /** The calls from the conversation down to it, inclusive: where walking into it stands. */
  chain: string[];
  /** What its starter called it (`description`), else the call's summary. */
  name: string;
  /** Its kind (`subagent_type`), when the call said. */
  kind?: string;
  entries: TranscriptEntry[];
  /** The calls it made, and the subagents it started made: the line's tail. */
  steps: number;
  startedAt?: number;
  /** Its last word, while it is not running. */
  lastAt?: number;
  running: boolean;
  /** The call it is on while running, the deepest: its name, and the subagents it is in below this one. */
  step?: { step: string; path: string[]; call: string };
}

/** The calls JaiRA itself made on a call's behalf (an approval, a permission check): not the agent's steps. */
const isHostCall = (entry: TranscriptEntry): boolean => entry.kind === "tool" && (isHostWork(entry) || entry.calledBy !== undefined);

const unanswered = (entry: ToolEntry): boolean => entry.ok === undefined && entry.result === undefined;

/** A background agent's call answers at once, with this; it has not finished. */
const isLaunchNote = (result: JsonValue | undefined): boolean => JSON.stringify(result ?? null).includes("Async agent launched");

function argOf(entry: ToolEntry, key: string): string | undefined {
  const args = entry.args as Record<string, unknown> | null | undefined;
  const value = args !== null && typeof args === "object" ? args[key] : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The agents a live turn says have ENDED: each `task_notification` on the stream names the call that
 * started the agent it reports. A background agent's call answered long before it ended, so this is how
 * its end is known while the turn goes on.
 */
export function endedAgentsOf(liveEntries: readonly JsonValue[] | undefined): Set<string> {
  const ended = new Set<string>();
  for (const raw of liveEntries ?? []) {
    const rec = raw as { kind?: unknown; event?: { type?: unknown; payload?: unknown } } | null;
    if (rec === null || typeof rec !== "object" || rec.kind !== "event") continue;
    const line = (rec.event?.type === "provider_event" ? rec.event.payload : rec.event) as { subtype?: unknown; tool_use_id?: unknown } | undefined;
    if (line?.subtype === "task_notification" && typeof line.tool_use_id === "string") ended.add(line.tool_use_id);
  }
  return ended;
}

/**
 * Every subagent in a conversation, by its call, nested ones included.
 *
 * `chainOf` reads a chain's entries (`sidechainEntriesOf`); `streaming` is the set of chains the live turn
 * holds turns of. One runs while the conversation is being written (`answering`), its call is not known
 * to have ended, and either its call waits for its answer or its chain is streaming by.
 */
export function subagentsOf(input: {
  entries: readonly TranscriptEntry[];
  chainOf: (call: string) => TranscriptEntry[];
  streaming: ReadonlySet<string>;
  ended: ReadonlySet<string>;
  answering: boolean;
}): Map<string, Subagent> {
  const found = new Map<string, Subagent>();
  const walk = (entries: readonly TranscriptEntry[], above: string[], open: boolean): void => {
    for (const entry of entries) {
      if (entry.kind !== "tool" || entry.sidechain === undefined || found.has(entry.sidechain)) continue;
      const call = entry.sidechain;
      const chain = [...above, call];
      const inside = input.chainOf(call);
      const finished = input.ended.has(call) || (entry.result !== undefined && !isLaunchNote(entry.result)) || entry.ok === false;
      const running = open && !finished && (unanswered(entry) || input.streaming.has(call));
      const kind = argOf(entry, "subagent_type");
      const times = inside.map((e) => (e as { at?: number }).at).filter((at): at is number => typeof at === "number");
      const sub: Subagent = {
        call,
        chain,
        name: argOf(entry, "description") ?? (entry.summary.length > 0 ? entry.summary : "subagent"),
        ...(kind !== undefined ? { kind } : {}),
        entries: inside,
        steps: 0,
        ...(entry.at !== undefined ? { startedAt: entry.at } : times.length > 0 ? { startedAt: Math.min(...times) } : {}),
        ...(times.length > 0 ? { lastAt: Math.max(...times) } : {}),
        running,
      };
      found.set(call, sub);
      walk(inside, chain, running);
    }
  };
  walk(input.entries, [], input.answering);
  // Counted once every subagent is known: a subagent's steps include those of the ones it started.
  const stepsOf = (sub: Subagent): number =>
    sub.entries.reduce((n, e) => (e.kind === "tool" && !isHostCall(e) ? n + 1 + (e.sidechain !== undefined && found.has(e.sidechain) ? stepsOf(found.get(e.sidechain)!) : 0) : n), 0);
  // Its last word is the last word of any subagent it started too: one that waits on its own subagent ran as long.
  const lastOf = (sub: Subagent): number | undefined => {
    const nested = sub.entries.flatMap((e) => (e.kind === "tool" && e.sidechain !== undefined && found.has(e.sidechain) ? [lastOf(found.get(e.sidechain)!)] : []));
    const all = [sub.lastAt, ...nested].filter((at): at is number => at !== undefined);
    return all.length > 0 ? Math.max(...all) : undefined;
  };
  for (const sub of found.values()) {
    const last = lastOf(sub);
    if (last !== undefined) sub.lastAt = last;
    sub.steps = stepsOf(sub);
    if (sub.running) {
      const step = runningStepIn(sub, found);
      if (step !== undefined) sub.step = step;
    }
  }
  return found;
}

/** The call a running subagent is on: its newest unanswered call, followed into the subagent that call started. */
function runningStepIn(sub: Subagent, all: ReadonlyMap<string, Subagent>): Subagent["step"] {
  for (let i = sub.entries.length - 1; i >= 0; i--) {
    const entry = sub.entries[i]!;
    if (entry.kind !== "tool" || isHostCall(entry) || entry.callId === undefined) continue;
    const nested = entry.sidechain !== undefined ? all.get(entry.sidechain) : undefined;
    if (nested?.running === true) {
      const deeper = runningStepIn(nested, all);
      if (deeper !== undefined) return { ...deeper, path: [nested.name, ...deeper.path] };
    }
    if (!unanswered(entry)) continue;
    return { step: toolLineOf(entry, true, false).name, path: [], call: entry.callId };
  }
  return undefined;
}

/** The subagent whose own conversation holds the pending approval's call — the deepest, being its asker. */
export function subagentOfApproval(subagents: ReadonlyMap<string, Subagent>, requestId: string | undefined): Subagent | undefined {
  if (requestId === undefined) return undefined;
  let found: Subagent | undefined;
  for (const sub of subagents.values()) {
    if (approvalCallIndex(sub.entries, requestId) < 0) continue;
    if (found === undefined || sub.chain.length > found.chain.length) found = sub;
  }
  return found;
}

/** The names along a chain, outermost first: a wait's path, a breadcrumb. */
export function namesOf(subagents: ReadonlyMap<string, Subagent>, chain: readonly string[]): string[] {
  return chain.map((call) => subagents.get(call)?.name ?? "subagent");
}

/**
 * The waits with an approval a subagent asked for made THAT subagent's: its path the names down to it,
 * its `chain` where a press goes. The conversation's own approval wait (`waitsOf` makes every approval
 * not in a run the conversation's) is replaced.
 */
export function withSubagentWaits(waits: readonly RunWait[], asker: Subagent | undefined, subagents: ReadonlyMap<string, Subagent>): RunWait[] {
  if (asker === undefined) return [...waits];
  return waits.map((wait) => {
    if (wait.kind !== "approve" || wait.own !== true) return wait;
    const { own: _own, ...rest } = wait;
    return { ...rest, path: namesOf(subagents, asker.chain), chain: asker.chain };
  });
}

/**
 * The waits as seen from inside a subagent (`chain`, the calls walked through): only those inside it,
 * their paths from inside it. Walked into a subagent, a run's or the conversation's wait is outside.
 */
export function chainScopedWaits(waits: readonly RunWait[], chain: readonly string[]): RunWait[] {
  if (chain.length === 0) return [...waits];
  return waits.filter((wait) => wait.chain !== undefined && chain.every((call, i) => wait.chain![i] === call)).map((wait) => ({ ...wait, path: wait.path.slice(chain.length) }));
}

/** How many waits are inside each level of a breadcrumb walked into subagents: the conversation, then each. */
export function chainWaitCounts(waits: readonly RunWait[], chain: readonly string[]): number[] {
  return [0, ...chain.map((_, i) => i + 1)].map((depth) => chainScopedWaits(waits, chain.slice(0, depth)).length);
}

/**
 * Which chain a pending approval's call is in, read off the live turn alone — for the title bar, which
 * holds no transcript. The approval's call rides the chain of the call that asked (`hostCall`), and a
 * chain's own call rides the chain it was made in, so the chain is followed out to the conversation.
 */
export function liveChainOfApproval(sidechains: Readonly<Record<string, readonly JsonValue[]>> | undefined, requestId: string | undefined): string[] | undefined {
  if (sidechains === undefined || requestId === undefined) return undefined;
  const callsIn = (raw: JsonValue): string[] => {
    const content = (raw as { content?: { content?: unknown } | unknown } | null)?.content;
    const parts = Array.isArray(content) ? content : Array.isArray((content as { content?: unknown } | undefined)?.content) ? ((content as { content: unknown[] }).content) : [];
    return parts.flatMap((p) => ((p as { type?: unknown }).type === "tool_use" && typeof (p as { id?: unknown }).id === "string" ? [(p as { id: string }).id] : []));
  };
  const holder = (id: (call: string) => boolean): string | undefined => Object.entries(sidechains).find(([, entries]) => entries.some((raw) => callsIn(raw).some(id)))?.[0];
  let at = holder((call) => call.startsWith("approve_") && call.endsWith(`_${requestId}`));
  if (at === undefined) return undefined;
  const chain = [at];
  for (let depth = 0; depth < 16; depth++) {
    const up = holder((call) => call === chain[0]);
    if (up === undefined) break;
    chain.unshift(up);
    at = up;
  }
  return chain;
}
