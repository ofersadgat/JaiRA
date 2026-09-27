/**
 * Keeping a copy of the fleet's tasks here (decision 0013 §6).
 *
 * An engine that serves a window asks each paired machine, for each of its workspaces, what changed
 * since what it holds (`replica:pull`), and lays the answer over its copy in the one database — owned
 * there by the remote workspace's id — with the task files and snapshots under
 * `<base>/remote/<machine>/<workspace>/`, laid out as a workspace so the ordinary views read it. Big
 * strings arrive as hashes, and only the ones this database lacks are asked for (`replica:blobs`).
 *
 * When: as a machine comes online, shortly after its engine pushes anything (a run's news arrives in
 * bursts), and every minute besides. A machine that is offline keeps what was copied, which is what the
 * window reads until it is back (`Federation`'s offline reads).
 *
 * The owner's side is `replica.ts` in persistence, answered from its peer handlers.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  applyPage,
  dropReplicaWorkspace,
  hasSnapshot,
  missingBlobs,
  openDb,
  readBlobs,
  registerWorkspace,
  replicaKnown,
  writeSnapshot,
  type JairaDb,
  type ReplicaDirs,
  type ReplicaPage,
} from "@jaira/persistence";
import { jairaBasePaths, jairaPaths, remoteProjectKey } from "@jaira/shared";
import type { Fleet } from "./fleet";
import { MACHINE_LOCAL, type Federation } from "./federation";

export interface ReplicatorOptions {
  baseDir: string;
  /** Something changed in a machine's copy: the window's views of it are stale. */
  changed?: (machineId: string) => void;
  /** A workspace's copy was removed: a session reading it must let it go. */
  onDropped?: (machineId: string, dir: string) => void;
  log?: (level: "info" | "warn", message: string) => void;
  /** How often every online machine is asked, besides its pushes. */
  everyMs?: number;
}

export class Replicator {
  private db: JairaDb | undefined;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly fleet: Fleet,
    private readonly federation: Federation,
    private readonly options: ReplicatorOptions,
  ) {
    fleet.onPeerState((machineId, online) => {
      if (online) this.schedule(machineId, 1_000);
    });
    fleet.onPeerPush((machineId, message) => {
      const push = message as { type?: string; taskId?: unknown; project?: unknown };
      if (MACHINE_LOCAL.has(push.type ?? "")) return;
      // News about one task is applied to that task at once — a turn streaming there reads here as
      // it goes; anything else asks the whole machine again, a little later.
      if (typeof push.taskId === "string" && typeof push.project === "string") this.soon(machineId, push.project, push.taskId);
      else this.schedule(machineId, 1_500);
    });
    this.timer = setInterval(() => {
      for (const peer of this.fleet.peers()) if (peer.state === "online") this.schedule(peer.id, 0);
    }, options.everyMs ?? 60_000);
    this.timer.unref?.();
  }

  /** Where a remote workspace's copy lives: a workspace directory whose id is the owner's. */
  replicaDir(machineId: string, workspace: string): string {
    return join(this.options.baseDir, "remote", machineId, workspace);
  }

  /** The remote workspace a machine's directory is, once a pull has learned it. */
  workspaceOf(machineId: string, dir: string): string | undefined {
    const row = this.database().prepare(`SELECT id FROM workspaces WHERE machine = ? AND dir = ?`).get(machineId, dir) as { id: string } | undefined;
    return row?.id;
  }

  /** Whether there is a copy of a machine's workspace to read. */
  hasReplica(machineId: string, dir: string): boolean {
    const workspace = this.workspaceOf(machineId, dir);
    return workspace !== undefined && existsSync(join(this.replicaDir(machineId, workspace), ".jaira"));
  }

  /** The bytes behind blob hashes, from the one database — what a machine copying this one's tasks lacks. */
  blobs(hashes: readonly string[]): Record<string, string> {
    return readBlobs(this.database(), hashes);
  }

  private database(): JairaDb {
    if (this.db === undefined) {
      const file = jairaBasePaths(this.options.baseDir).dbFile;
      mkdirSync(join(this.options.baseDir, "system"), { recursive: true });
      this.db = openDb(file);
    }
    return this.db;
  }

  /** The directories of a machine's workspaces this machine copies, by the person's choice. */
  private wanted(machineId: string): string[] {
    const choice = this.fleet.copying();
    if (choice.mode === "nothing") return [];
    const dirs = this.federation.projectsOf(machineId);
    if (choice.mode !== "chosen") return dirs;
    const chosen = new Set(choice.projects ?? []);
    return dirs.filter((dir) => chosen.has(remoteProjectKey(machineId, dir)));
  }

  /** Remove the copies of a machine's workspaces that are not in `wanted`. */
  private dropUnwanted(machineId: string, wanted: readonly string[]): void {
    const keep = new Set(wanted);
    const db = this.database();
    const held = db.prepare(`SELECT id, dir FROM workspaces WHERE machine = ?`).all(machineId) as Array<{ id: string; dir: string }>;
    for (const workspace of held) {
      if (keep.has(workspace.dir)) continue;
      const root = this.replicaDir(machineId, workspace.id);
      const paths = jairaPaths(root, this.options.baseDir);
      const dropped = dropReplicaWorkspace(db, workspace.id, { tasksDir: paths.tasksDir, snapshotsDir: paths.snapshotsDir });
      this.options.onDropped?.(machineId, workspace.dir);
      rmSync(root, { recursive: true, force: true });
      this.options.log?.("info", `removed the copy of ${workspace.dir} from ${this.fleet.labelOf(machineId)} (${dropped} task(s)): it is no longer copied`);
    }
  }

  /**
   * Apply the choice of what to copy now: every online machine is asked again, and every machine's
   * copies no longer wanted are removed — an offline one's too, which a pull would not reach.
   */
  async apply(): Promise<void> {
    for (const peer of this.fleet.peers()) {
      if (peer.state === "online") await this.pull(peer.id);
      else this.dropUnwanted(peer.id, this.wanted(peer.id));
    }
  }

  /** How much the copies take on disk, and of how many machines. */
  onDisk(): { bytes: number; machines: number; dir: string } {
    const dir = join(this.options.baseDir, "remote");
    let bytes = 0;
    const machines = new Set<string>();
    const walk = (path: string, machine: string | undefined): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child, machine ?? entry.name);
        else if (entry.isFile() && entry.name !== "projects.json") {
          try {
            bytes += statSync(child).size;
            if (machine !== undefined) machines.add(machine);
          } catch {
            // Gone meanwhile.
          }
        }
      }
    };
    walk(dir, undefined);
    // The rows are in the one database, and are the larger part: counted from the copies' own tables.
    const db = this.database();
    const rows = db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS n FROM state_machine_events
          WHERE task_id IN (SELECT o.task_id FROM task_owners o JOIN workspaces w ON w.id = o.workspace WHERE w.machine IS NOT NULL)`,
      )
      .get() as { n: number };
    const records = db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(result_json) + LENGTH(request_json)), 0) AS n FROM operation_records
          WHERE task_id IN (SELECT o.task_id FROM task_owners o JOIN workspaces w ON w.id = o.workspace WHERE w.machine IS NOT NULL)`,
      )
      .get() as { n: number };
    return { bytes: bytes + rows.n + records.n, machines: machines.size, dir };
  }

  /** Tasks a push named, by machine and directory, waiting for the next quick pull. */
  private readonly named = new Map<string, { machineId: string; dir: string; tasks: Set<string>; timer: ReturnType<typeof setTimeout> }>();

  /** Pull one task of one workspace within a quarter of a second — pushes about it arrive in bursts. */
  private soon(machineId: string, dir: string, taskId: string): void {
    if (this.closed || !this.wanted(machineId).includes(dir)) return;
    const key = `${machineId}\u0000${dir}`;
    const waiting = this.named.get(key);
    if (waiting !== undefined) {
      waiting.tasks.add(taskId);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.named.get(key);
      this.named.delete(key);
      if (entry === undefined || this.closed) return;
      // Behind a full pull of the same machine, not beside it: both lay rows over one copy.
      const before = this.running.get(machineId) ?? Promise.resolve();
      const run = before
        .then(() => this.pullWorkspace(machineId, dir, [...entry.tasks]))
        .catch((e: unknown) => this.options.log?.("warn", `could not copy ${dir} from ${this.fleet.labelOf(machineId)}: ${(e as Error).message}`));
      this.running.set(machineId, run.finally(() => {
        if (this.running.get(machineId) === run) this.running.delete(machineId);
      }) as Promise<void>);
    }, 250);
    timer.unref?.();
    this.named.set(key, { machineId, dir, tasks: new Set([taskId]), timer });
  }

  /** Ask a machine again, shortly: many pushes arrive together. */
  schedule(machineId: string, delayMs: number): void {
    if (this.closed || !this.fleet.replicating() || this.scheduled.has(machineId)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(machineId);
      void this.pull(machineId);
    }, delayMs);
    timer.unref?.();
    this.scheduled.set(machineId, timer);
  }

  /** Bring every workspace of one machine up to date. One pull per machine at a time. */
  pull(machineId: string): Promise<void> {
    const already = this.running.get(machineId);
    if (already !== undefined) return already;
    const run = (async () => {
      const wanted = this.wanted(machineId);
      // What is no longer wanted leaves the copies first: a project taken off the chosen list, or all
      // of them when nothing is copied.
      this.dropUnwanted(machineId, wanted);
      for (const dir of wanted) {
        if (this.closed) return;
        try {
          await this.pullWorkspace(machineId, dir);
        } catch (e) {
          this.options.log?.("warn", `could not copy ${dir} from ${this.fleet.labelOf(machineId)}: ${(e as Error).message}`);
        }
      }
    })().finally(() => this.running.delete(machineId));
    this.running.set(machineId, run);
    return run;
  }

  private async pullWorkspace(machineId: string, dir: string, only?: readonly string[]): Promise<void> {
    const db = this.database();
    let workspace = this.workspaceOf(machineId, dir);
    let changed = 0;
    for (;;) {
      const client = this.fleet.client(machineId);
      if (client === undefined || this.closed) return;
      const known = workspace !== undefined ? replicaKnown(db, workspace) : {};
      // Archived tasks come only when everything is copied; otherwise the owner leaves them out, and
      // one archived there leaves the copy here.
      const archived = this.fleet.copying().mode === "everything";
      const page = (await client.invoke("replica:pull", { project: dir, known, archived, ...(only !== undefined ? { only } : {}) })) as ReplicaPage;
      if (this.closed) return;
      workspace = page.workspace;
      registerWorkspace(db, workspace, dir, machineId);
      const dirs = this.layOut(machineId, workspace);
      const missing = missingBlobs(db, page);
      const blobs = missing.length > 0 ? ((await client.invoke("replica:blobs", { hashes: missing })) as Record<string, string>) : {};
      for (const hash of new Set(page.tasks.flatMap((t) => (t.snapshot !== undefined ? [t.snapshot] : [])))) {
        if (hasSnapshot(dirs, hash)) continue;
        writeSnapshot(dirs, hash, (await client.invoke("replica:snapshot", { project: dir, hash })) as Record<string, string>);
      }
      if (this.closed) return;
      changed += applyPage(db, page, blobs, dirs).length;
      if (!page.more) break;
    }
    if (changed > 0) {
      this.options.log?.("info", `copied ${changed} task(s) of ${dir} from ${this.fleet.labelOf(machineId)}`);
      this.options.changed?.(machineId);
    }
  }

  /** The copy's directory, made a workspace whose id is the owner's — what lets it be opened to read. */
  private layOut(machineId: string, workspace: string): ReplicaDirs {
    const paths = jairaPaths(this.replicaDir(machineId, workspace), this.options.baseDir);
    mkdirSync(paths.tasksDir, { recursive: true });
    mkdirSync(paths.snapshotsDir, { recursive: true });
    if (!existsSync(paths.workspaceIdFile)) writeFileSync(paths.workspaceIdFile, `${workspace}\n`, "utf8");
    if (!existsSync(paths.settingsFile)) writeFileSync(paths.settingsFile, "{}\n", "utf8");
    return { tasksDir: paths.tasksDir, snapshotsDir: paths.snapshotsDir };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    for (const entry of this.named.values()) clearTimeout(entry.timer);
    this.named.clear();
    this.db?.close();
    this.db = undefined;
  }
}
