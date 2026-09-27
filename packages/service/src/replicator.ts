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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPage,
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
import { jairaBasePaths, jairaPaths } from "@jaira/shared";
import type { Fleet } from "./fleet";
import { MACHINE_LOCAL, type Federation } from "./federation";

export interface ReplicatorOptions {
  baseDir: string;
  /** Something changed in a machine's copy: the window's views of it are stale. */
  changed?: (machineId: string) => void;
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
      if (!MACHINE_LOCAL.has((message as { type?: string }).type ?? "")) this.schedule(machineId, 1_500);
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
      for (const dir of this.federation.projectsOf(machineId)) {
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

  private async pullWorkspace(machineId: string, dir: string): Promise<void> {
    const db = this.database();
    let workspace = this.workspaceOf(machineId, dir);
    let changed = 0;
    for (;;) {
      const client = this.fleet.client(machineId);
      if (client === undefined || this.closed) return;
      const known = workspace !== undefined ? replicaKnown(db, workspace) : {};
      const page = (await client.invoke("replica:pull", { project: dir, known })) as ReplicaPage;
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
    this.db?.close();
    this.db = undefined;
  }
}
