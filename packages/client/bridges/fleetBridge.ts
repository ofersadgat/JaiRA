import { SHARED_SESSION, type IpcChannel, type JairaBridge, type PushMessage } from "@jaira/shared/browser";

/**
 * A phone's window onto every machine it is paired with (decision 0015, amended 2026-10-04: "the ui
 * populates the projects based on the machines it can connect to"). One `JairaBridge` for the store, over
 * one engine bridge per paired machine.
 *
 * An engine already reaches its whole fleet and lists every workspace in it (decision 0013 §1, §7), so
 * machines that are one fleet need ONE of them connected: the first that answers, the others standing
 * by. Machines of different fleets are each needed: their lists are merged and every other request goes
 * to the fleet that holds what it names. Which is which is the fleet each machine says it is in
 * (`machines:view`): two whose fleets share a machine are one fleet.
 *
 * - **Merged** (`MERGED`): the lists that are about every project at once — the projects, everything
 *   waiting on the person, every task. Each fleet is asked, the answers put end to end; the shared root
 *   (`kind: "shared"`) is the first fleet's alone: the shell has one, and every engine lists its own.
 * - **Routed**: a request that names a project (`project`, or `dir` when opening one) goes to the fleet
 *   whose list held it; one that answers a waiting thing (`requestId`) to the fleet that listed it;
 *   anything else to the fleet of the project last opened, else the first.
 * - **Pushed**: every fleet's pushes reach the store. A fleet arriving or leaving tells the store every
 *   scope may have changed, as a reconnection does.
 *
 * With one fleet every request goes straight to its engine, as before.
 */

/** One paired machine, as the fleet bridge sees it. */
export interface FleetMember {
  /** Its machine id. */
  id: string;
  bridge: JairaBridge;
  connected: boolean;
  /** The machine ids its engine says are its fleet (itself among them). Unknown until asked. */
  fleet?: ReadonlySet<string> | undefined;
}

/** The lists about every project at once, merged across fleets. */
export const MERGED: ReadonlySet<string> = new Set(["project:list", "interaction:pending", "approval:pending", "question:pending", "userEvent:pending", "task:all"]);

/** What a reconnection tells the store, said again when a fleet arrives or leaves. */
const RESYNC: PushMessage[] = (["tasks", "board", "task", "workflows", "config", "availability"] as const).map((scope) => ({ type: "store:invalidate", scope }) as PushMessage);

/**
 * The paired machines as fleets, in the order they were paired: two are one fleet when the fleets they
 * report share a machine (or one lists the other). A machine whose fleet is not known yet is its own.
 */
export function fleetsOf(members: readonly FleetMember[]): FleetMember[][] {
  const groups: { ids: Set<string>; members: FleetMember[] }[] = [];
  for (const member of members) {
    const ids = new Set<string>([member.id, ...(member.fleet ?? [])]);
    const joined = groups.filter((g) => [...ids].some((id) => g.ids.has(id)));
    if (joined.length === 0) {
      groups.push({ ids, members: [member] });
      continue;
    }
    const into = joined[0]!;
    for (const id of ids) into.ids.add(id);
    into.members.push(member);
    for (const other of joined.slice(1)) {
      for (const id of other.ids) into.ids.add(id);
      into.members.push(...other.members);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups.map((g) => g.members);
}

/** Per fleet, the machine that answers for it: the first connected, in pairing order. */
export function answeringOf(members: readonly FleetMember[]): FleetMember[] {
  return fleetsOf(members).flatMap((fleet) => {
    const first = fleet.find((m) => m.connected);
    return first === undefined ? [] : [first];
  });
}

/** Answers put end to end; the shared root kept from the first fleet that has one. */
export function mergeLists(channel: string, answers: readonly (readonly unknown[])[]): unknown[] {
  const out: unknown[] = [];
  let shared = false;
  for (const answer of answers) {
    for (const item of answer) {
      const it = item as { project?: unknown; kind?: unknown };
      if (channel === "project:list" && (it.kind === "shared" || it.project === SHARED_SESSION)) {
        if (shared) continue;
        shared = true;
      }
      out.push(item);
    }
  }
  return out;
}

/** The fleet bridge: install `bridge` in the store, and say which machines answer with `setMembers`. */
export function fleetBridge(): { bridge: JairaBridge; setMembers: (members: readonly FleetMember[]) => void; answering: () => readonly FleetMember[] } {
  let answering: FleetMember[] = [];
  /** Which answering machine holds a project, and a waiting thing — learned from the merged lists. */
  const projectOwner = new Map<string, string>();
  const requestOwner = new Map<string, string>();
  let current: string | undefined;
  const listeners = new Set<(message: PushMessage) => void>();
  const unsubscribes = new Map<string, () => void>();
  /** Requests made while no machine answers: sent once one does. */
  let waiting: Array<() => void> = [];

  const byId = (id: string | undefined): FleetMember | undefined => (id === undefined ? undefined : answering.find((m) => m.id === id));
  const routeOf = (request: unknown): FleetMember | undefined => {
    const r = (request ?? {}) as Record<string, unknown>;
    const project = typeof r["project"] === "string" ? r["project"] : typeof r["dir"] === "string" ? r["dir"] : undefined;
    if (project !== undefined && project !== SHARED_SESSION) {
      const owner = byId(projectOwner.get(project));
      if (owner !== undefined) return owner;
    }
    if (typeof r["requestId"] === "string") {
      const owner = byId(requestOwner.get(r["requestId"]));
      if (owner !== undefined) return owner;
    }
    return byId(current) ?? answering[0];
  };
  const learn = (member: FleetMember, channel: string, answer: readonly unknown[]): void => {
    for (const item of answer) {
      const it = item as { project?: unknown; requestId?: unknown };
      if (channel === "project:list" && typeof it.project === "string" && it.project !== SHARED_SESSION && !projectOwner.has(it.project)) projectOwner.set(it.project, member.id);
      if (typeof it.requestId === "string") requestOwner.set(it.requestId, member.id);
    }
  };

  const ask = async (channel: string, request: unknown): Promise<unknown> => {
    if (answering.length === 0) return new Promise((resolve, reject) => waiting.push(() => void ask(channel, request).then(resolve, reject)));
    if (answering.length > 1 && MERGED.has(channel)) {
      const settled = await Promise.allSettled(answering.map((m) => m.bridge.invoke(channel as IpcChannel, request as never)));
      const answers: unknown[][] = [];
      settled.forEach((s, i) => {
        if (s.status !== "fulfilled" || !Array.isArray(s.value)) return;
        learn(answering[i]!, channel, s.value);
        answers.push(s.value);
      });
      if (answers.length === 0) throw (settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined)?.reason ?? new Error(`${channel}: no machine answered`);
      return mergeLists(channel, answers);
    }
    const member = routeOf(request)!;
    const answer = await member.bridge.invoke(channel as IpcChannel, request as never);
    if (channel === "project:open") current = member.id;
    if (Array.isArray(answer)) learn(member, channel, answer);
    return answer;
  };

  const bridge: JairaBridge = {
    invoke: ((channel: IpcChannel, request: unknown) => ask(channel, request)) as JairaBridge["invoke"],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };

  const setMembers = (members: readonly FleetMember[]): void => {
    const next = answeringOf(members);
    const changed = next.length !== answering.length || next.some((m, i) => m !== answering[i]);
    answering = next;
    // Every answering machine's pushes reach the store, and only theirs.
    for (const [id, off] of unsubscribes) {
      if (answering.some((m) => m.id === id)) continue;
      off();
      unsubscribes.delete(id);
    }
    for (const member of answering) {
      if (!unsubscribes.has(member.id)) unsubscribes.set(member.id, member.bridge.subscribe((message) => listeners.forEach((on) => on(message))));
    }
    if (answering.length > 0 && waiting.length > 0) {
      const now = waiting;
      waiting = [];
      now.forEach((go) => go());
    }
    if (changed) for (const message of RESYNC) listeners.forEach((on) => on(message));
  };

  return { bridge, setMembers, answering: () => answering };
}
