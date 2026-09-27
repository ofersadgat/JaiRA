/**
 * Other machines' workspaces, used from this one (decision 0013 §4, §7): listed beside this machine's
 * projects, reached through the fleet's links, and answered from here.
 *
 * A workspace on another machine is a project whose key names that machine (`remoteProjectKey`). A
 * request carrying such a key is FORWARDED to the machine, with the key put back to the directory it
 * knows. Its engine's pushes come back with their keys rewritten, so the board, a conversation, a gate
 * and the composer work on a remote task exactly as on a local one.
 *
 * Until replication (§6), what is shown is what the machine says now: an offline machine's projects stay
 * listed from the last time it answered, and its boards are empty until it is back. An answer to an
 * offline machine — a gate's decision, an approval, an agent's question, a message — waits in the
 * outbox and is delivered when it reconnects (ruling 13).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRemoteProjectKey, remoteProjectKey, type ProjectSummary, type PushMessage } from "@jaira/shared";
import type { Fleet } from "./fleet";

/** Answers that may wait for an offline machine: the ones a person gives, which have nowhere else to go. */
export const QUEUEABLE = new Set(["approval:submit", "question:submit", "interaction:submit", "chat:send", "task:cancel"]);

/** Answers addressed by request id alone, found on the machine that asked. */
const BY_REQUEST = new Set(["approval:submit", "question:submit", "interaction:submit", "userEvent:deliver"]);

/** Pushes that are about one machine and mean nothing on another. */
const MACHINE_LOCAL = new Set([
  "open:external",
  "log:entry",
  "health:changed",
  "update:changed",
  "plugin:changed",
  "engine:changed",
  "machines:changed",
  "limits:changed",
  "waiting:changed",
  "frame:contextMenu",
  "forge:signInFinished",
]);

export interface OutboxItem {
  id: string;
  machineId: string;
  channel: string;
  request: unknown;
  at: number;
}

type Pending = { requestId: string; project?: string } & Record<string, unknown>;

export interface FederationOptions {
  baseDir: string;
  publish: (message: PushMessage) => void;
  log?: (level: "info" | "warn", message: string) => void;
}

export class Federation {
  /** Each machine's projects, as it last listed them — kept on disk for when it is offline. */
  private readonly projects = new Map<string, ProjectSummary[]>();
  /** Requests a machine is waiting on a person for, by id: which machine, and the request. */
  private readonly pending = new Map<string, { machineId: string; kind: "approval" | "question" | "interaction" | "userEvent"; request: Pending }>();
  private readonly refreshing = new Map<string, ReturnType<typeof setTimeout>>();
  private nextOutbox = 1;

  constructor(
    private readonly fleet: Fleet,
    private readonly options: FederationOptions,
  ) {
    fleet.onPeerPush((machineId, message) => this.relay(machineId, message as PushMessage));
    fleet.onPeerState((machineId, online) => {
      if (online) {
        this.refresh(machineId, 0);
        void this.fetchPending(machineId);
        void this.deliver(machineId);
      } else {
        for (const [id, entry] of this.pending) if (entry.machineId === machineId) this.pending.delete(id);
        this.options.publish({ type: "store:invalidate", scope: "tasks" });
      }
    });
  }

  // --- listing ------------------------------------------------------------------------------------------

  private cacheFile(machineId: string): string {
    return join(this.options.baseDir, "remote", machineId, "projects.json");
  }

  /** Every paired machine's workspaces, keyed for forwarding, with the machine and its state. */
  remoteProjects(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const peer of this.fleet.peers()) {
      let list = this.projects.get(peer.id);
      if (list === undefined) {
        try {
          list = JSON.parse(readFileSync(this.cacheFile(peer.id), "utf8")) as ProjectSummary[];
          this.projects.set(peer.id, list);
        } catch {
          continue;
        }
      }
      for (const summary of list) {
        if (summary.kind !== "user") continue;
        out.push({
          ...summary,
          project: remoteProjectKey(peer.id, summary.project),
          machine: { id: peer.id, label: peer.label, state: peer.state },
          // What is running there is news only while it can be acted on.
          ...(peer.state === "online" ? {} : { waiting: 0 }),
        });
      }
    }
    return out;
  }

  /** Ask a machine for its projects again, shortly: many pushes arrive together. */
  refresh(machineId: string, delayMs = 400): void {
    if (this.refreshing.has(machineId)) return;
    this.refreshing.set(
      machineId,
      setTimeout(() => {
        this.refreshing.delete(machineId);
        const client = this.fleet.client(machineId);
        if (client === undefined) return;
        client.invoke("project:list").then(
          (list) => {
            // Its own clones only: what it lists of OTHER machines (this one included) is theirs to say.
            const projects = (list as ProjectSummary[]).filter((p) => p.kind === "user" && parseRemoteProjectKey(p.project) === undefined);
            this.projects.set(machineId, projects);
            const file = this.cacheFile(machineId);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, JSON.stringify(projects));
            renameSync(`${file}.tmp`, file);
            this.options.publish({ type: "store:invalidate", scope: "tasks" });
          },
          () => undefined,
        );
      }, delayMs),
    );
  }

  // --- forwarding ---------------------------------------------------------------------------------------

  /**
   * Whether a request belongs to another machine, and if so its answer from there. Undefined: answer it
   * here. A queueable answer to a machine that is offline goes to the outbox.
   */
  route(channel: string, request: unknown): Promise<unknown> | undefined {
    const body = request !== null && typeof request === "object" ? (request as Record<string, unknown>) : undefined;
    const remote = parseRemoteProjectKey(typeof body?.["project"] === "string" ? (body["project"] as string) : undefined);
    if (remote !== undefined) return this.forward(remote.machineId, channel, { ...body, project: remote.dir });
    // Addressed to a machine by id: browsing its folders, opening or making a project there (§8).
    if (typeof body?.["machine"] === "string" && body["machine"] !== this.fleet.identity().id) {
      const { machine, ...rest } = body;
      return this.forward(machine as string, channel, rest);
    }
    if (BY_REQUEST.has(channel) && typeof body?.["requestId"] === "string") {
      const owner = this.pending.get(body["requestId"] as string);
      if (owner !== undefined) return this.forward(owner.machineId, channel, body);
    }
    return undefined;
  }

  private async forward(machineId: string, channel: string, request: unknown): Promise<unknown> {
    const client = this.fleet.client(machineId);
    if (client === undefined) {
      if (QUEUEABLE.has(channel)) return this.enqueue(machineId, channel, request);
      throw new Error(`${this.fleet.labelOf(machineId)} is offline`);
    }
    return this.rewriteAnswer(machineId, channel, await client.invoke(channel, request));
  }

  /** An answer that names the machine's own directories, keyed for this one. */
  private rewriteAnswer(machineId: string, channel: string, answer: unknown): unknown {
    if (channel === "task:all" && Array.isArray(answer)) {
      return answer.map((row) => (row !== null && typeof row === "object" && typeof (row as { project?: unknown }).project === "string" ? { ...row, project: remoteProjectKey(machineId, (row as { project: string }).project) } : row));
    }
    return answer;
  }

  /** Ask every online machine the same thing, and put the answers together, keyed for this one. */
  async everyMachine(channel: string, request: unknown): Promise<unknown[]> {
    const answers = await Promise.all(
      this.fleet.peers().map(async (peer) => {
        const client = this.fleet.client(peer.id);
        if (client === undefined) return [];
        const got = await client.invoke(channel, request).catch(() => []);
        const rewritten = this.rewriteAnswer(peer.id, channel, got);
        return Array.isArray(rewritten) ? rewritten : [];
      }),
    );
    return answers.flat();
  }

  // --- what other machines are waiting on a person for ---------------------------------------------

  /** Other machines' pending requests of one kind, keyed for this one, for the inbox and the gates. */
  pendingOf(kind: "approval" | "question" | "interaction" | "userEvent"): Pending[] {
    return [...this.pending.values()].filter((e) => e.kind === kind).map((e) => e.request);
  }

  private remember(machineId: string, kind: "approval" | "question" | "interaction" | "userEvent", request: Pending): Pending {
    const keyed = typeof request.project === "string" ? { ...request, project: remoteProjectKey(machineId, request.project) } : request;
    this.pending.set(request.requestId, { machineId, kind, request: keyed });
    return keyed;
  }

  private async fetchPending(machineId: string): Promise<void> {
    const client = this.fleet.client(machineId);
    if (client === undefined) return;
    const lists: Array<["approval" | "question" | "interaction" | "userEvent", string]> = [
      ["approval", "approval:pending"],
      ["question", "question:pending"],
      ["interaction", "interaction:pending"],
      ["userEvent", "userEvent:pending"],
    ];
    for (const [kind, channel] of lists) {
      const got = (await client.invoke(channel).catch(() => [])) as Pending[];
      for (const request of got) if (parseRemoteProjectKey(request.project) === undefined) this.remember(machineId, kind, request);
    }
    this.options.publish({ type: "store:invalidate", scope: "tasks" });
  }

  // --- pushes from other machines ----------------------------------------------------------------------

  /** A push from another machine's engine, keyed for this one and published here — or dropped. */
  relay(machineId: string, message: PushMessage): void {
    if (MACHINE_LOCAL.has(message.type)) return;
    // Its own news only: what it relays of other machines — this one's included — is theirs.
    const about = (message as { project?: unknown }).project ?? (message as { pending?: { project?: unknown } }).pending?.project ?? (message as { request?: { project?: unknown } }).request?.project;
    if (typeof about === "string" && parseRemoteProjectKey(about) !== undefined) return;
    let out = message as PushMessage & Record<string, unknown>;
    const pending = (message as { pending?: Pending }).pending;
    if (pending !== undefined && typeof pending.requestId === "string") {
      const kind = message.type.split(":")[0] as "approval" | "question" | "interaction";
      out = { ...out, pending: this.remember(machineId, kind, pending) } as unknown as typeof out;
    }
    const request = (message as { request?: Pending }).request;
    if (message.type === "userEvent:requested" && request !== undefined) out = { ...out, request: this.remember(machineId, "userEvent", request) } as unknown as typeof out;
    if (message.type.endsWith(":resolved")) this.pending.delete(String((message as { requestId?: unknown }).requestId));
    if (typeof out["project"] === "string") out = { ...out, project: remoteProjectKey(machineId, out["project"] as string) };
    // The list the sidebar reads follows what the board does.
    if (message.type === "store:invalidate" || message.type === "run:finished") this.refresh(machineId);
    this.options.publish(out as PushMessage);
  }

  // --- the outbox ----------------------------------------------------------------------------------------

  private outboxFile(): string {
    return join(this.options.baseDir, "system", "fleet-outbox.json");
  }

  outbox(): OutboxItem[] {
    try {
      return JSON.parse(readFileSync(this.outboxFile(), "utf8")) as OutboxItem[];
    } catch {
      return [];
    }
  }

  private writeOutbox(items: OutboxItem[]): void {
    const file = this.outboxFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(items, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  private enqueue(machineId: string, channel: string, request: unknown): { queued: true; machine: string; outboxId: string } {
    const item: OutboxItem = { id: `o${Date.now().toString(36)}-${this.nextOutbox++}`, machineId, channel, request, at: Date.now() };
    this.writeOutbox([...this.outbox(), item]);
    const label = this.fleet.labelOf(machineId);
    this.options.log?.("info", `${channel} waits for ${label}, which is offline; it is delivered when ${label} reconnects`);
    this.options.publish({ type: "store:invalidate", scope: "tasks" });
    return { queued: true, machine: label, outboxId: item.id };
  }

  /** Take something back out of the outbox before it is delivered. */
  withdraw(outboxId: string): OutboxItem[] {
    const kept = this.outbox().filter((item) => item.id !== outboxId);
    this.writeOutbox(kept);
    this.options.publish({ type: "store:invalidate", scope: "tasks" });
    return kept;
  }

  /** Send a machine what waited for it, in the order it was given. */
  async deliver(machineId: string): Promise<void> {
    const client = this.fleet.client(machineId);
    if (client === undefined) return;
    for (const item of this.outbox().filter((i) => i.machineId === machineId)) {
      try {
        await client.invoke(item.channel, item.request);
        this.options.log?.("info", `delivered ${item.channel} to ${this.fleet.labelOf(machineId)}`);
      } catch (e) {
        // Answered elsewhere meanwhile, or no longer asked: said once, and not tried again.
        this.options.log?.("warn", `${item.channel} could not be delivered to ${this.fleet.labelOf(machineId)}: ${(e as Error).message}`);
      }
      this.writeOutbox(this.outbox().filter((i) => i.id !== item.id));
    }
    this.options.publish({ type: "store:invalidate", scope: "tasks" });
  }
}
