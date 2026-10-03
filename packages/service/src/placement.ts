/**
 * Where a task runs (decision 0013 §5): the first of its project's workspaces, in the project's order,
 * that is on a reachable machine with the tags its workflow requires, with room by that machine's
 * resources, under its cap if it has one, and with usage left on its accounts. None free: the task
 * waits in this machine's queue, and starts when one frees up (ruled: "3a"). A queued task can be sent
 * to a workspace by hand (ruled: "4a").
 *
 * A person may narrow where it runs to one machine or one workspace (`RunTarget`, ruled 2026-10-02): the
 * same walk over fewer workspaces, and the same wait when none of them has room — it is never started
 * somewhere it was not sent. What waits keeps the whole start it waits for (the composer's settings, the
 * scripted answers), so it starts as it was asked to, however long it waited.
 *
 * The order, until the person sets one, is the other machines' workspaces in the order the machines
 * were paired, then this machine's (ruled: "other machines first, this one last"). The rules — order and
 * caps, per project — sync across the fleet (ruling 11).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { parseRemoteProjectKey, projectNameOf, type ChatSettings, type PlacementAsk, type ProjectSummary, type QueuedPlacement, type RunTarget } from "@jaira/shared";
import type { Fleet } from "./fleet";
import type { MachineResources } from "./resources";

/** What a machine says about its room to run, to whoever is placing a task. */
export interface MachineCapacity {
  machineId: string;
  tags: string[];
  resources: MachineResources;
  /** Runs working now, by workspace directory. */
  running: Record<string, number>;
  /** Accounts with a reading there, and which of them are out of usage. */
  accounts: string[];
  spent: string[];
}

/** One project's rules, synced across the fleet: the order of its workspaces, and caps on runs at once. */
export interface PlacementRules {
  /** Workspaces as `machineId|dir`, first tried first. Ones not listed follow, in the default order. */
  order?: string[];
  /** Runs at once, by `machineId|dir`. Absent: resources decide alone. */
  caps?: Record<string, number>;
  updatedAt: number;
}

export interface PlacementThresholds {
  /** A machine busier than this (0–1 of all cores) takes no new run. */
  cpuLimit: number;
  /** A machine with less than this share of its memory free takes no new run. */
  memoryFloor: number;
}

export const DEFAULT_THRESHOLDS: PlacementThresholds = { cpuLimit: 0.9, memoryFloor: 0.1 };

/** A reading older than this is no reading: the machine is not considered. */
const FRESH_MS = 15_000;

export interface QueuedTask {
  taskId: string;
  /** The workspace it is recorded in while it waits: this machine's. */
  project: string;
  identity: string;
  requires: string[];
  /** The accounts its models spend — see `whyNot`. */
  needs?: string[];
  since: number;
  /** Where it was sent, when the person chose. Absent: anywhere. */
  target?: RunTarget;
  /** The start it waits for, kept whole: what the composer picked, and a test's scripted answers. */
  start?: HeldStart;
  /** Workspaces asked so far, how many had no room, and how many times it has waited to ask again. */
  asked?: number;
  refused?: number;
  waits?: number;
  /** The latest round, and when it was asked. */
  asks?: PlacementAsk[];
  askedAt?: number;
}

/** What a start carries besides the task: everything `task:start` was given that the run needs. */
export interface HeldStart {
  overrides?: ChatSettings;
  interactions?: Record<string, JsonValue[]>;
  fake?: JsonValue;
}

/** How often what waits asks again (`AppService.placementTimer`). */
export const ASK_AGAIN_MS = 10_000;

/** A waiting task as a window reads it. `phase` is `placing` only for one being asked about for the first time. */
export function queuedView(item: QueuedTask, phase: QueuedPlacement["phase"]): QueuedPlacement {
  return {
    taskId: item.taskId,
    project: item.project,
    requires: item.requires,
    since: item.since,
    phase,
    ...(item.target !== undefined ? { target: item.target } : {}),
    ...(item.start?.overrides !== undefined ? { settings: item.start.overrides } : {}),
    asked: item.asked ?? 0,
    refused: item.refused ?? 0,
    waits: item.waits ?? 0,
    asks: item.asks ?? [],
    ...(item.askedAt !== undefined ? { askedAt: item.askedAt, ...(phase === "waiting" ? { nextAt: item.askedAt + ASK_AGAIN_MS } : {}) } : {}),
  };
}

/** What a waiting task waits for, and why each workspace asked had no room — the log's sentence. */
export function waitsForWords(item: QueuedTask): string {
  const what = item.target?.project !== undefined ? "the workspace it was sent to" : item.target?.machine !== undefined ? "a workspace with room on the machine it was sent to" : "a workspace with room";
  const asks = item.asks ?? [];
  if (asks.length === 0) return `${what}: none of them is open`;
  return `${what}: ${asks.map((ask) => `${ask.label} / ${projectNameOf(ask.dir)} — ${ask.why ?? "has room"}`).join("; ")}`;
}

/** The workspaces a task may run on: all of the project's, or the ones the person narrowed it to. */
export function candidatesOf(members: readonly ProjectSummary[], target: RunTarget | undefined, selfId: string): ProjectSummary[] {
  if (target?.project !== undefined) return members.filter((m) => m.project === target.project);
  if (target?.machine !== undefined) return members.filter((m) => (m.machine?.id ?? selfId) === target.machine);
  return [...members];
}

/** One workspace considered, and why it was passed over. */
export interface Considered {
  project: string;
  machineId: string;
  label: string;
  why?: string;
}

export interface PlacementOptions {
  baseDir: string;
  fleet: Fleet;
  /** This machine's own capacity, measured here. */
  localCapacity: () => MachineCapacity;
  thresholds?: () => PlacementThresholds;
  log?: (level: "info" | "warn", message: string) => void;
}

export const workspaceKey = (machineId: string, dir: string): string => `${machineId}|${dir}`;

export class Placement {
  constructor(private readonly options: PlacementOptions) {}

  // --- rules, synced ------------------------------------------------------------------------------------

  private rulesFile(): string {
    return join(this.options.baseDir, "system", "placement.json");
  }

  allRules(): Record<string, PlacementRules> {
    try {
      return JSON.parse(readFileSync(this.rulesFile(), "utf8")) as Record<string, PlacementRules>;
    } catch {
      return {};
    }
  }

  rules(identity: string): PlacementRules | undefined {
    return this.allRules()[identity];
  }

  private writeRules(all: Record<string, PlacementRules>): void {
    const file = this.rulesFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  /** The person changed a project's rules here: kept, and sent to every machine. */
  setRules(identity: string, rules: Omit<PlacementRules, "updatedAt">): PlacementRules {
    const next = { ...rules, updatedAt: Date.now() };
    this.writeRules({ ...this.allRules(), [identity]: next });
    for (const peer of this.options.fleet.peers()) void this.options.fleet.client(peer.id)?.invoke("fleet:placement", { identity, rules: next }).catch(() => undefined);
    return next;
  }

  /** Another machine's rules for a project, kept when newer than what is here. */
  merge(identity: string, rules: PlacementRules): boolean {
    const all = this.allRules();
    if ((all[identity]?.updatedAt ?? 0) >= rules.updatedAt) return false;
    this.writeRules({ ...all, [identity]: rules });
    return true;
  }

  // --- the order ------------------------------------------------------------------------------------------

  /** A group's workspaces in the order they are tried. */
  ordered(identity: string, members: readonly ProjectSummary[], selfId: string): ProjectSummary[] {
    const keyOf = (m: ProjectSummary): string => {
      const remote = parseRemoteProjectKey(m.project);
      return remote !== undefined ? workspaceKey(remote.machineId, remote.dir) : workspaceKey(selfId, m.project);
    };
    const peerOrder = this.options.fleet.peers().map((p) => p.id);
    const rank = (m: ProjectSummary): number => {
      const machineId = m.machine?.id ?? selfId;
      if (machineId === selfId) return peerOrder.length;
      const at = peerOrder.indexOf(machineId);
      return at < 0 ? peerOrder.length - 0.5 : at;
    };
    const defaults = [...members].sort((a, b) => rank(a) - rank(b));
    const order = this.rules(identity)?.order ?? [];
    const listed = order.flatMap((key) => defaults.filter((m) => keyOf(m) === key));
    return [...listed, ...defaults.filter((m) => !listed.includes(m))];
  }

  // --- choosing -------------------------------------------------------------------------------------------

  /** A machine's room to run, asked of it now; undefined when it cannot be reached. */
  async capacityOf(machineId: string, selfId: string): Promise<MachineCapacity | undefined> {
    if (machineId === selfId) return this.options.localCapacity();
    const client = this.options.fleet.client(machineId);
    if (client === undefined) return undefined;
    return (await client.invoke("fleet:capacity").catch(() => undefined)) as MachineCapacity | undefined;
  }

  /**
   * The first workspace with room, and what was said about each one considered — what a queued task's
   * "Run on" menu shows beside every choice.
   */
  async choose(
    identity: string,
    members: readonly ProjectSummary[],
    requires: readonly string[],
    selfId: string,
    needs: readonly string[] = [],
  ): Promise<{ chosen?: ProjectSummary; considered: Considered[] }> {
    const thresholds = this.options.thresholds?.() ?? DEFAULT_THRESHOLDS;
    const caps = this.rules(identity)?.caps ?? {};
    const capacities = new Map<string, MachineCapacity | undefined>();
    const considered: Considered[] = [];
    let chosen: ProjectSummary | undefined;
    for (const member of this.ordered(identity, members, selfId)) {
      const machineId = member.machine?.id ?? selfId;
      const label = member.machine?.label ?? "this machine";
      const dir = parseRemoteProjectKey(member.project)?.dir ?? member.project;
      if (!capacities.has(machineId)) capacities.set(machineId, await this.capacityOf(machineId, selfId));
      const capacity = capacities.get(machineId);
      const why = whyNot(capacity, dir, requires, caps[workspaceKey(machineId, dir)], thresholds, Date.now(), needs);
      considered.push({ project: member.project, machineId, label, ...(why !== undefined ? { why } : {}) });
      if (why === undefined && chosen === undefined) chosen = member;
    }
    return { ...(chosen !== undefined ? { chosen } : {}), considered };
  }

  // --- the queue ------------------------------------------------------------------------------------------

  private queueFile(): string {
    return join(this.options.baseDir, "system", "placement-queue.json");
  }

  queue(): QueuedTask[] {
    try {
      return JSON.parse(readFileSync(this.queueFile(), "utf8")) as QueuedTask[];
    } catch {
      return [];
    }
  }

  private writeQueue(items: QueuedTask[]): void {
    const file = this.queueFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(items, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  enqueue(item: QueuedTask): void {
    this.writeQueue([...this.queue().filter((q) => q.taskId !== item.taskId), item]);
  }

  /** Put a changed item back where it stands in the line; nothing happens if it has left. */
  replace(item: QueuedTask): void {
    const items = this.queue();
    if (items.some((q) => q.taskId === item.taskId)) this.writeQueue(items.map((q) => (q.taskId === item.taskId ? item : q)));
  }

  /** Write what a round found into an item that is still waiting. */
  patch(taskId: string, found: Pick<QueuedTask, "asked" | "refused" | "waits" | "asks" | "askedAt">): void {
    const item = this.queue().find((q) => q.taskId === taskId);
    if (item !== undefined) this.replace({ ...item, ...found });
  }

  dequeue(taskId: string): QueuedTask | undefined {
    const items = this.queue();
    const item = items.find((q) => q.taskId === taskId);
    if (item !== undefined) this.writeQueue(items.filter((q) => q.taskId !== taskId));
    return item;
  }
}

/**
 * Why a workspace takes no new run now, or undefined when it can.
 *
 * `needs` is the accounts the task's models spend (`accountOfRoute`): the workspace is out of usage
 * when one of THOSE is spent there. With nothing known about what it spends, out of usage is every
 * account the machine has a reading for being spent.
 */
export function whyNot(
  capacity: MachineCapacity | undefined,
  dir: string,
  requires: readonly string[],
  cap: number | undefined,
  thresholds: PlacementThresholds,
  now = Date.now(),
  needs: readonly string[] = [],
): string | undefined {
  if (capacity === undefined) return "offline";
  const missing = requires.filter((tag) => !capacity.tags.includes(tag));
  if (missing.length > 0) return `not ${missing.join(", ")}`;
  if (now - capacity.resources.at > FRESH_MS) return "no recent reading";
  const running = capacity.running[dir] ?? 0;
  if (cap !== undefined && running >= cap) return `${running} of ${cap} running`;
  if (capacity.resources.cpu >= thresholds.cpuLimit) return `busy (${Math.round(capacity.resources.cpu * 100)}% CPU)`;
  const free = capacity.resources.totalMemory > 0 ? capacity.resources.freeMemory / capacity.resources.totalMemory : 1;
  if (free <= thresholds.memoryFloor) return `low on memory (${Math.round(free * 100)}% free)`;
  const spentNeeded = needs.filter((account) => capacity.spent.includes(account));
  if (spentNeeded.length > 0) return `out of usage (${spentNeeded.join(", ")})`;
  if (needs.length === 0 && capacity.accounts.length > 0 && capacity.accounts.every((a) => capacity.spent.includes(a))) return "out of usage";
  return undefined;
}
