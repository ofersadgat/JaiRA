/**
 * Making a project's workspace on this machine (decision 0027): Open's "how it gets there" and Add a
 * workspace, run by the engine of the machine the workspace goes to — a window elsewhere names this
 * machine and `Federation.route` forwards the request here.
 *
 * In order: the folder is made (cloned from the forge with the connection's credentials, or copied
 * from the machine that has it, as it is), opened as a project, and set up — the project's setup file
 * (`.jaira/setup.json`, `.yaml`, with this machine's `.local` over it), or the setup its checkout
 * states when it has none — Bring taking the files git ignores from the machine that has them. The
 * window is told as it goes (`workspace:progress`) and at the end (`workspace:finished`). A setup step
 * that fails leaves the workspace made and open, with the failure said.
 *
 * The person's press on Go / Add, with the plan in front of them, is what lets a setup run on this
 * machine: its text's hash is kept per workspace (`system/setup-approvals.json` under this machine's
 * root), so the steps that run each time the workspace opens run only while the setup is the one
 * approved.
 *
 * The other half — answering the machine that copies FROM here — is {@link WorkspaceMaker.peerHandlers}:
 * pack a folder, hand it over in pieces, read the files git ignores, read a few files for a plan.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  DEFAULT_TARGET,
  ENVIRONMENT_TARGET,
  INFER_SETUP_FILES,
  SETUP_FILE_NAMES,
  SETUP_LOCAL_FILE_NAMES,
  inferSetup,
  jairaPaths,
  mergeSetupFiles,
  parseSetupText,
  planSetupTarget,
  setupFormatOf,
  setupMachineOf,
  workspaceFolderName,
  type ForgeBranch,
  type ForgeRepositoriesView,
  type ForgeRepositoryRow,
  type JairaIntegrationsConfig,
  type PlannedStep,
  type PushMessage,
  type SetupFile,
  type SetupMachine,
  type WorkspaceCheckout,
  type WorkspaceCreateRequest,
  type WorkspaceFinished,
  type WorkspacePlan,
  type WorkspacePlanRequest,
  type WorkspacePhase,
  type WorkspaceSource,
  type WorkspaceStepEvent,
} from "@jaira/shared";
import {
  NodeExec,
  checkoutState,
  cliGitCredentials,
  cloneRepository,
  containerPort,
  isWslEnv,
  machineEnvOf,
  collectIgnored,
  forgeAccess,
  forgeProvider,
  ForgeCliUnavailable,
  httpsAddressOf,
  sshAddressOf,
  sshLadder,
  needsOf,
  packCheckout,
  pushCredentials,
  readCheckoutFiles,
  readinessOf,
  runSetup,
  stepsFor,
  unpackCheckout,
  writeFiles,
  type CarriedFile,
  type CheckoutPack,
  type Exec,
  type ForgeAccess,
  type RemoteRoute,
  type RouteLadder,
  type ExecEnv,
  type ForgeHttp,
  type ForgeCliOptions,
  type SecretResolver,
  type SetupReadContext,
  type SetupRunContext,
  type SetupRunResult,
  type SetupToolPort,
} from "@jaira/runtime";

/** What the maker needs from the engine around it. */
export interface WorkspaceMakerHost {
  /** This machine's root (`<base>`), where the setup approvals are kept. */
  baseDir: string;
  selfId(): string;
  machine(): { label: string; os: "windows" | "mac" | "linux"; tags: string[]; projectsFolder: string };
  /** Where commands run on this machine, and whether that is WSL. A workspace's container is never the machine's: {@link machineEnvOf}. */
  execEnv(): ExecEnv;
  /** Where the commands of the workspace at `dir` run — its container, when its setup made one (decision 0027); undefined: the machine's. */
  execEnvOf?(dir: string): ExecEnv | undefined;
  /** A setup brought the workspace's container up: its commands run in `env` from now on, said in its settings on this machine. */
  recordEnv?(dir: string, env: ExecEnv): void | Promise<void>;
  /** Another machine's engine, to copy from or bring from; undefined while it is not linked. */
  peer(machineId: string): { invoke(channel: string, request: unknown): Promise<unknown> } | undefined;
  labelOf(machineId: string): string;
  integrations(): JairaIntegrationsConfig;
  secrets(): SecretResolver;
  forgeHttp?: ForgeHttp;
  /** A forge's own command line, for a connection no token is stored for (`ForgeOptions.cli`). */
  forgeCli?(): ForgeCliOptions | undefined;
  /** Every machine's workspaces of a project, by its repository identity: this machine's with `machineId` = selfId. */
  workspacesOf(identity: string): { machineId: string; dir: string }[];
  /** The repository identity of a folder on this machine. */
  identityOf(dir: string): string | undefined;
  /** Open the folder as a project (made one when it is not yet). */
  open(dir: string): Promise<unknown>;
  publish(message: PushMessage): void;
  /** The installer for commands that run in `env`; absent, the machine's. */
  tools(env?: ExecEnv): SetupToolPort;
  exec?: Exec;
}

/** The setup a folder's own files give: the file (with this machine's `.local` over it), else what its checkout states. */
export interface ReadSetup {
  from: "file" | "found" | "none";
  file?: SetupFile;
  /** The setup file's text, for the approval hash. */
  text?: string;
  problems?: string[];
}

const PROGRESS_EVERY_MS = 100;
/** A pack is handed over this many characters at a time. */
const CHUNK = 4 * 1024 * 1024;
/** A pack not fetched within this long is dropped. */
const PACK_KEEP_MS = 10 * 60_000;

export class WorkspaceMaker {
  private readonly jobs = new Map<string, AbortController>();
  private readonly packs = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly host: WorkspaceMakerHost) {}

  private exec(): Exec {
    return this.host.exec ?? new NodeExec();
  }

  // --- forges ------------------------------------------------------------------------------------

  /**
   * Every signed-in forge connection's repositories, most recently changed first — signed in with a
   * token JaiRA holds, or through the forge's command line (`gh`, `glab`) where it holds none. One
   * neither way in is not listed, as Settings shows it under "Not connected".
   */
  async repositories(request: { search?: string } = {}): Promise<ForgeRepositoriesView> {
    const integrations = this.host.integrations();
    const options = this.forgeOptions();
    const connections: ForgeRepositoriesView["connections"] = [];
    const rows: ForgeRepositoryRow[] = [];
    await Promise.all(
      Object.entries(integrations.forges).map(async ([name, connection]) => {
        if (connection.enabled === false) return;
        const hit = connection.credential !== undefined ? options.secrets.lookup(connection.credential) : undefined;
        if (hit === undefined && options.cli === undefined) return;
        const base = { name, host: connection.host, provider: connection.provider };
        try {
          const provider = forgeProvider(connection, hit !== undefined ? hit.value : { cli: options.cli! }, options);
          const listed = (await provider.repositories?.(request.search !== undefined ? { search: request.search } : {})) ?? [];
          rows.push(...listed.map((repo) => ({ ...repo, host: connection.host, provider: connection.provider, connection: name })));
          connections.push(base);
        } catch (error) {
          // The command line is not there, or not signed in to this host: not a connection, as without a token.
          if (error instanceof ForgeCliUnavailable) return;
          connections.push({ ...base, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { repositories: rows, connections };
  }

  async branches(request: { host: string; project: string }): Promise<ForgeBranch[]> {
    return forgeAccess(this.host.integrations(), request.host, this.forgeOptions()).provider.branches(request.project);
  }

  private forgeOptions(): { secrets: SecretResolver; http?: ForgeHttp; cli?: ForgeCliOptions } {
    const cli = this.host.forgeCli?.();
    return { secrets: this.host.secrets(), ...(this.host.forgeHttp !== undefined ? { http: this.host.forgeHttp } : {}), ...(cli !== undefined ? { cli } : {}) };
  }

  // --- a folder here ------------------------------------------------------------------------------

  /** A folder's git state here — what copying it would bring. */
  inspect(request: { dir: string }): Promise<WorkspaceCheckout> {
    return checkoutState(request.dir, { exec: this.exec() });
  }

  // --- the plan ----------------------------------------------------------------------------------

  /** Where a workspace from `source` would go here, and what its setup would take, before anything happens. */
  async plan(request: WorkspacePlanRequest): Promise<WorkspacePlan> {
    const files = this.sourceReader(request.source);
    const name = request.name ?? this.nameOf(request.source);
    const { dir, taken, projectsFolder } = this.folderFor(name, request.folder);
    const setup = await this.readSetup(files.read, files.readMany);
    const target = request.target ?? DEFAULT_TARGET;
    const steps = this.planned(setup, target);
    const ctx: SetupReadContext & { tools: SetupToolPort } = { readFile: files.read, os: this.osTag(), tools: this.host.tools() };
    const needs = steps.ok ? await needsOf(steps.steps, ctx) : [];
    const problems = [...(files.unread !== undefined ? [files.unread] : []), ...(setup.problems ?? []), ...(steps.ok ? [] : steps.problems)];
    const checkout = request.source.kind === "machine" ? await this.checkoutOf(request.source).catch(() => undefined) : undefined;
    return {
      name,
      dir,
      projectsFolder,
      ...(taken !== undefined ? { taken } : {}),
      setup: { from: setup.from, target, steps: needs, readiness: readinessOf(needs), ...(problems.length > 0 ? { problems } : {}) },
      bring: steps.ok ? steps.steps.flatMap((step) => ("bring" in step ? step.bring : [])) : [],
      ...(checkout !== undefined ? { checkout } : {}),
    };
  }

  private planned(setup: ReadSetup, target: string): { ok: true; steps: PlannedStep[] } | { ok: false; problems: string[] } {
    if (setup.file === undefined) return { ok: true, steps: [] };
    if (setup.file.targets[target] === undefined && target === DEFAULT_TARGET) return { ok: true, steps: [] };
    const planned = planSetupTarget(setup.file, target, this.setupMachine());
    return planned.ok ? planned : { ok: false, problems: planned.problems.map((p) => `${p.path}: ${p.message}`) };
  }

  private setupMachine(): SetupMachine {
    const machine = this.host.machine();
    return setupMachineOf({ label: machine.label, os: machine.os, tags: machine.tags, arch: process.arch }, this.isWsl());
  }

  private isWsl(): boolean {
    return isWslEnv(machineEnvOf(this.host.execEnv()));
  }

  /**
   * Where a setup's commands run for the workspace at `dir`: its container when its setup made one, else
   * the machine's — and the port a container step brings one up through (decision 0027), with the
   * workspace and the folder its task worktrees go in mounted at their own paths.
   */
  private environmentFor(dir: string): Pick<SetupRunContext, "exec" | "execEnv" | "tools" | "container"> {
    const machine = machineEnvOf(this.host.execEnv());
    const execEnv = this.host.execEnvOf?.(dir) ?? machine;
    return {
      // Each command says where it runs (`execEnv`); what spawns it is the machine's.
      exec: this.host.exec ?? new NodeExec({ execEnv: machine }),
      execEnv,
      tools: this.host.tools(execEnv),
      container: containerPort({
        dir,
        mounts: [jairaPaths(dir, this.host.baseDir).worktreesDir],
        exec: this.exec(),
        machine,
        record: (env) => this.host.recordEnv?.(dir, env),
        tools: (env) => this.host.tools(env),
      }),
    };
  }

  private osTag(): "mac" | "linux" | "windows" | "wsl" {
    return this.setupMachine().tags[0] as "mac" | "linux" | "windows" | "wsl";
  }

  private nameOf(source: WorkspaceSource): string {
    if (source.kind === "forge") return source.project.split("/").pop() ?? source.project;
    return basename(source.dir.replace(/[\\/]+$/, "")) || "project";
  }

  /** The folder a new workspace goes in here: the person's, or the projects folder and the name, numbered when taken. */
  folderFor(name: string, chosen?: string): { dir: string; taken?: string; projectsFolder: string } {
    const projectsFolder = this.host.machine().projectsFolder;
    if (chosen !== undefined && chosen.trim() !== "") return { dir: resolve(chosen), projectsFolder };
    const others = new Set<string>();
    const folderName = workspaceFolderName(name, (candidate) => {
      const dir = join(projectsFolder, candidate);
      const taken = existsSync(dir) || others.has(dir);
      return taken;
    });
    const first = workspaceFolderName(name, () => false);
    return { dir: join(projectsFolder, folderName), projectsFolder, ...(folderName !== first ? { taken: first } : {}) };
  }

  /** The files of the source, read lazily: from the forge before cloning, or from the machine that has the folder. */
  private sourceReader(source: WorkspaceSource): {
    read: (path: string) => Promise<string | undefined>;
    readMany: (paths: readonly string[]) => Promise<Map<string, string | true>>;
    /** Why the source's files cannot be read before it is fetched, when they cannot. */
    unread?: string;
  } {
    const cache = new Map<string, Promise<string | undefined>>();
    let fetchOne: (path: string) => Promise<string | undefined>;
    let unread: string | undefined;
    if (source.kind === "forge") {
      // No connection serves the host: a public repository still clones, and its setup is read after.
      let provider: ReturnType<typeof forgeAccess>["provider"] | undefined;
      try {
        provider = forgeAccess(this.host.integrations(), source.host, this.forgeOptions()).provider;
      } catch (error) {
        unread = `${error instanceof Error ? error.message : String(error)}; the setup is read once it is cloned`;
      }
      fetchOne = (path) => provider?.fileText?.(source.project, path, source.branch) ?? Promise.resolve(undefined);
    } else if (source.machine === this.host.selfId()) {
      fetchOne = (path) => readFile(join(source.dir, ...path.split("/")), "utf8").catch(() => undefined);
    } else {
      fetchOne = async (path) => {
        const got = (await this.peerOf(source.machine).invoke("workspace:files", { dir: source.dir, paths: [path] })) as Record<string, string | true>;
        const value = got[path];
        return typeof value === "string" ? value : value === true ? "" : undefined;
      };
    }
    const read = (path: string): Promise<string | undefined> => {
      let hit = cache.get(path);
      if (hit === undefined) {
        hit = fetchOne(path).catch(() => undefined);
        cache.set(path, hit);
      }
      return hit;
    };
    const readMany = async (paths: readonly string[]): Promise<Map<string, string | true>> => {
      if (source.kind === "machine" && source.machine !== this.host.selfId()) {
        const got = (await this.peerOf(source.machine).invoke("workspace:files", { dir: source.dir, paths })) as Record<string, string | true>;
        return new Map(Object.entries(got));
      }
      const out = new Map<string, string | true>();
      await Promise.all(
        paths.map(async (path) => {
          const text = await read(path);
          if (text !== undefined) out.set(path, text);
        }),
      );
      return out;
    };
    return { read, readMany, ...(unread !== undefined ? { unread } : {}) };
  }

  /** A folder's setup: its file (with this machine's `.local` over it), else what its checkout states. */
  async readSetup(read: (path: string) => Promise<string | undefined>, readMany: (paths: readonly string[]) => Promise<Map<string, string | true>>): Promise<ReadSetup> {
    const committed = await firstFile(read, SETUP_FILE_NAMES);
    const local = await firstFile(read, SETUP_LOCAL_FILE_NAMES);
    const problems: string[] = [];
    // One file each: setup.json and setup.yaml both there would be two answers to one question.
    for (const [names, found] of [
      [SETUP_FILE_NAMES, committed],
      [SETUP_LOCAL_FILE_NAMES, local],
    ] as const) {
      if (found === undefined) continue;
      for (const other of names) {
        if (other !== found.name && (await read(`.jaira/${other}`)) !== undefined) problems.push(`.jaira/${found.name} and .jaira/${other} are both there; keep one.`);
      }
    }
    const parse = (found: { name: string; text: string } | undefined): SetupFile | undefined => {
      if (found === undefined) return undefined;
      const parsed = parseSetupText(found.text, setupFormatOf(found.name) ?? "json");
      if (!parsed.ok) {
        problems.push(...parsed.problems.map((p) => `${found.name} ${p.path}: ${p.message}`));
        return undefined;
      }
      return parsed.file;
    };
    const file = mergeSetupFiles(parse(committed), parse(local));
    if (file !== undefined || problems.length > 0) {
      const text = `${committed?.text ?? ""}\n${local?.text ?? ""}`;
      return { from: "file", ...(file !== undefined ? { file } : {}), text, ...(problems.length > 0 ? { problems } : {}) };
    }
    const found = inferSetup(await readMany([...INFER_SETUP_FILES]));
    return found !== undefined ? { from: "found", file: found, text: JSON.stringify(found) } : { from: "none" };
  }

  private async checkoutOf(source: Extract<WorkspaceSource, { kind: "machine" }>): Promise<WorkspaceCheckout> {
    if (source.machine === this.host.selfId()) return this.inspect({ dir: source.dir });
    return (await this.peerOf(source.machine).invoke("workspace:inspect", { dir: source.dir })) as WorkspaceCheckout;
  }

  private peerOf(machineId: string): { invoke(channel: string, request: unknown): Promise<unknown> } {
    const peer = this.host.peer(machineId);
    if (peer === undefined) throw new Error(`${this.host.labelOf(machineId)} is offline`);
    return peer;
  }

  // --- making it ---------------------------------------------------------------------------------

  /** Start making a workspace here; the window follows it by its job id. */
  create(request: WorkspaceCreateRequest): { jobId: string } {
    const jobId = randomUUID();
    const abort = new AbortController();
    this.jobs.set(jobId, abort);
    void this.make(jobId, request, abort.signal).finally(() => this.jobs.delete(jobId));
    return { jobId };
  }

  cancel(request: { jobId: string }): void {
    this.jobs.get(request.jobId)?.abort();
  }

  private async make(jobId: string, request: WorkspaceCreateRequest, signal: AbortSignal): Promise<void> {
    const machine = this.host.selfId();
    const out = this.output(jobId);
    const finish = (finished: Omit<WorkspaceFinished, "jobId" | "machine">): void => {
      out.end();
      this.host.publish({ type: "workspace:finished", jobId, machine, ...finished });
    };
    const name = request.name ?? this.nameOf(request.source);
    const { dir } = this.folderFor(name, request.folder);
    const exec = this.exec();
    try {
      out.phase("fetch");
      if (request.source.kind === "forge") {
        await cloneRepository(
          { url: request.source.url, dir, ...(request.source.branch !== undefined ? { branch: request.source.branch } : {}) },
          { exec, onOutput: out.say, abortSignal: signal, ...(await this.credentialsFor(request.source.url, request.source.host)) },
        );
      } else {
        const pack = await this.fetchPack(request.source, out.say);
        out.say(`Copying ${request.source.dir} from ${this.host.labelOf(request.source.machine)}: ${describePack(pack)}\n`);
        await unpackCheckout(pack, dir, {
          exec,
          onOutput: out.say,
          abortSignal: signal,
          ...(await this.credentialsFor(pack.state.remote)),
          routes: (remote) => this.routesFor(remote, pack, out.say, signal),
        });
      }
      out.phase("open");
      await this.host.open(dir);
      if (request.skipSetup === true) return finish({ ok: true, dir });
      out.phase("setup");
      const setup = await this.setUp(dir, request, out, signal);
      finish({ ok: true, dir, ...(setup !== undefined ? { setup } : {}) });
    } catch (error) {
      finish({ ok: false, dir, reason: signal.aborted ? "Stopped." : error instanceof Error ? error.message : String(error) });
    }
  }

  /** Run the new workspace's setup here, and keep its approval. */
  private async setUp(dir: string, request: WorkspaceCreateRequest, out: JobOutput, signal: AbortSignal): Promise<WorkspaceFinished["setup"] | undefined> {
    const read = (path: string): Promise<string | undefined> => readFile(join(dir, ...path.split("/")), "utf8").catch(() => undefined);
    const readMany = async (paths: readonly string[]): Promise<Map<string, string | true>> =>
      new Map(Object.entries(await readCheckoutFiles(dir, paths, () => true)));
    const setup = await this.readSetup(read, readMany);
    if (setup.from === "none") {
      out.say("Nothing to set up: the project has no setup file and its checkout names no tools.\n");
      return undefined;
    }
    const planned = this.planned(setup, request.target ?? DEFAULT_TARGET);
    if (!planned.ok) return { ok: false, steps: [], reason: planned.problems.join(" ") };
    this.approve(dir, setup.text ?? "");
    const identity = this.host.identityOf(dir);
    const result: SetupRunResult = await runSetup(planned.steps, {
      dir,
      ...this.environmentFor(dir),
      os: this.osTag(),
      readFile: read,
      bring: (step) => this.bring(dir, step, request.bringFrom, request.source, identity, out.say),
      clone: (step) => this.cloneBeside(dir, step, out, signal),
      onOutput: out.say,
      onStep: (event) => out.step(event),
      abortSignal: signal,
    });
    return { ok: result.ok, steps: result.steps, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
  }

  /** Bring files git ignores into `dir` from the machine that has them. */
  private async bring(
    dir: string,
    step: { patterns: string[]; from?: string },
    bringFrom: string | undefined,
    source: WorkspaceSource | undefined,
    identity: string | undefined,
    say: (text: string) => void,
  ): Promise<number> {
    const from = this.bringSource(step.from ?? bringFrom, source, identity, dir);
    if (from === undefined) {
      say("No other workspace of this project to bring files from.\n");
      return 0;
    }
    const files: CarriedFile[] =
      from.machineId === this.host.selfId()
        ? await collectIgnored(from.dir, step.patterns, { exec: this.exec() })
        : ((await this.peerOf(from.machineId).invoke("workspace:ignored", { dir: from.dir, patterns: step.patterns })) as CarriedFile[]);
    await writeFiles(dir, files);
    say(`Brought ${files.map((f) => f.path).join(", ") || "nothing"} from ${this.host.labelOf(from.machineId)}.\n`);
    return files.length;
  }

  /**
   * Where Bring takes files from: the machine named — the copy's own folder when it is the copy's
   * machine, else that machine's workspace of the project — else the copy's source, else another
   * workspace of the project, this machine's first.
   */
  private bringSource(named: string | undefined, source: WorkspaceSource | undefined, identity: string | undefined, dir: string): { machineId: string; dir: string } | undefined {
    const workspaces = identity !== undefined ? this.host.workspacesOf(identity).filter((w) => !(w.machineId === this.host.selfId() && samePath(w.dir, dir))) : [];
    if (named !== undefined) {
      // The window names the machine it showed; for a copy's machine it showed the folder copied.
      if (source?.kind === "machine" && (source.machine === named || this.host.labelOf(source.machine) === named)) return { machineId: source.machine, dir: source.dir };
      const match = workspaces.find((w) => w.machineId === named || this.host.labelOf(w.machineId) === named);
      if (match !== undefined) return match;
    }
    if (source?.kind === "machine") return { machineId: source.machine, dir: source.dir };
    return workspaces.find((w) => w.machineId === this.host.selfId()) ?? workspaces[0];
  }

  /** A CI part's second checkout: another repository cloned beside (or inside) the workspace. */
  private async cloneBeside(dir: string, step: { repository: string; ref?: string; path: string }, out: JobOutput, signal: AbortSignal): Promise<void> {
    const host = /^[\w.-]+\.[a-z]{2,}\//i.test(step.repository) ? step.repository.split("/")[0]! : "github.com";
    const project = host === step.repository.split("/")[0] ? step.repository.split("/").slice(1).join("/") : step.repository;
    const url = `https://${host}/${project}.git`;
    const target = resolve(dir, step.path);
    if (existsSync(target)) {
      out.say(`${target} is already there; leaving it as it is.\n`);
      return;
    }
    // A public repository clones without a connection.
    await cloneRepository({ url, dir: target, ...(step.ref !== undefined ? { branch: step.ref } : {}) }, { exec: this.exec(), onOutput: out.say, abortSignal: signal, ...(await this.credentialsFor(url, host)) });
  }

  private async fetchPack(source: Extract<WorkspaceSource, { kind: "machine" }>, say: (text: string) => void): Promise<CheckoutPack> {
    if (source.machine === this.host.selfId()) return packCheckout(source.dir, { exec: this.exec() });
    const peer = this.peerOf(source.machine);
    say(`Packing ${source.dir} on ${this.host.labelOf(source.machine)}…\n`);
    const { id, size } = (await peer.invoke("workspace:pack", { dir: source.dir })) as { id: string; size: number };
    let text = "";
    while (text.length < size) {
      const { data } = (await peer.invoke("workspace:packChunk", { id, offset: text.length })) as { data: string };
      if (data.length === 0) break;
      text += data;
      say(`  ${Math.round((text.length / size) * 100)}%\n`);
    }
    return JSON.parse(text) as CheckoutPack;
  }

  /** The forge credentials for a copy's remote, when a connection serves its host. */
  /**
   * Git's sign-in for an https `remote` from this machine's connection for its host: the token, or —
   * with none — the forge's command line as git's credential helper, as whoever it is signed in as.
   */
  private credentialsFor(remote: string | undefined, host?: string): Promise<{ env?: Record<string, string> }> {
    return Promise.resolve(this.access(remote, host)?.credentials ?? {});
  }

  private access(remote: string | undefined, host?: string): { name: string; credentials: { env: Record<string, string> } } | undefined {
    if (remote === undefined || !/^https?:/i.test(remote)) return undefined;
    try {
      const access = forgeAccess(this.host.integrations(), host ?? new URL(remote).host, this.forgeOptions());
      const env = access.token !== undefined ? pushCredentials(access, remote) : cliGitCredentials(access.connection.provider, remote);
      return { name: access.name, credentials: { env } };
    } catch {
      // A repository the connections do not serve, or a public one: git asks nothing of it here.
      return undefined;
    }
  }

  /**
   * The ways to a copy's remote after the source's own address fails here. An ssh address stays ssh
   * while any way to it is left (`sshLadder`: the host key the source trusts, the keys ssh did not offer,
   * a key added to the account through this machine's connection); https is the last.
   */
  private routesFor(remote: string, pack: CheckoutPack, say: (text: string) => void, signal: AbortSignal): RouteLadder {
    const address = sshAddressOf(remote);
    const access = address !== undefined ? this.accessFor(address.host) : undefined;
    const provider = access?.provider;
    const connection = access === undefined ? undefined : `the ${access.name} connection${access.via === "cli" ? ` (${access.connection.provider === "github" ? "gh" : "glab"})` : ""}`;
    const ssh = sshLadder(remote, {
      exec: this.exec(),
      home: process.env["HOME"] ?? homedir(),
      say,
      vouched: async () => [...(pack.hostKeys ?? []), ...((await provider?.sshHostKeys?.().catch(() => [])) ?? [])],
      ...(provider?.addSshKey !== undefined && access?.connection.makeSshKey !== false ? { addKey: (title: string, key: string) => provider.addSshKey!(title, key) } : {}),
      ...(access?.connection.makeSshKey === false ? { noKeyBecause: `The ${access.name} connection is set not to make ssh keys (Settings → Connections → Forges), so none was made.` } : {}),
      keyTitle: `JaiRA on ${this.host.labelOf(this.host.selfId())}`,
      ...(connection !== undefined ? { connection } : {}),
      abortSignal: signal,
    });
    let sshDone = ssh === undefined;
    let httpsTried = false;
    return {
      next: async (failure) => {
        if (!sshDone) {
          const found = await ssh!.next(failure);
          if (found !== undefined) return found;
          sshDone = true;
        }
        if (httpsTried) return undefined;
        httpsTried = true;
        return this.httpsRoute(remote);
      },
    };
  }

  /** This machine's way in to a forge host, or undefined where no connection serves it. */
  private accessFor(host: string): ForgeAccess | undefined {
    try {
      return forgeAccess(this.host.integrations(), host, this.forgeOptions());
    } catch {
      return undefined;
    }
  }

  /**
   * A copy's way to its source's remote when the address the source uses fails here: an ssh address
   * works on the source with its keys and the hosts it trusts, which this machine may not have. Its
   * https address, signed in through this machine's connection for the host. None where the address is
   * not ssh, or no connection here serves the host: git would be left to sign in on its own, and on
   * Windows its credential manager opens a window from a job nobody is watching.
   */
  private httpsRoute(remote: string): Promise<RemoteRoute | undefined> {
    const url = httpsAddressOf(remote);
    if (url === undefined) return Promise.resolve(undefined);
    const access = this.access(url);
    if (access === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ url, ...access.credentials, how: `through the ${access.name} connection` });
  }

  // --- a task's environment ------------------------------------------------------------------------

  /**
   * Before a task starts here: the setup target its workflow names (or the file's `environment`
   * target) run in the task's folder — a step whose `check` passes is skipped, so a ready machine
   * takes moments. Only a setup the person approved on this machine runs; a setup that changed since
   * waits for them.
   */
  async runEnvironment(request: {
    projectDir: string;
    runIn: string;
    target?: string;
    onOutput?: (text: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<{ target?: string; outcome: "none" | "unapproved" | "ran"; result?: SetupRunResult }> {
    const read = (path: string): Promise<string | undefined> => readFile(join(request.projectDir, ...path.split("/")), "utf8").catch(() => undefined);
    const committed = await firstFile(read, SETUP_FILE_NAMES);
    if (committed === undefined) {
      if (request.target !== undefined) throw new Error(`The workflow asks for the setup target "${request.target}", and the project has no .jaira/setup.json.`);
      return { outcome: "none" };
    }
    const setup = await this.readSetup(read, async () => new Map());
    const file = setup.file;
    if (file === undefined) throw new Error(`The project's setup file has problems: ${(setup.problems ?? []).join(" ")}`);
    const target = request.target ?? (file.targets[ENVIRONMENT_TARGET] !== undefined ? ENVIRONMENT_TARGET : undefined);
    if (target === undefined) return { outcome: "none" };
    if (file.targets[target] === undefined) throw new Error(`The workflow asks for the setup target "${target}", and .jaira/setup has no such target.`);
    if (!this.approved(request.projectDir, setup.text ?? "")) return { target, outcome: "unapproved" };
    const planned = this.planned(setup, target);
    if (!planned.ok) throw new Error(planned.problems.join(" "));
    const say = request.onOutput ?? (() => undefined);
    const identity = this.host.identityOf(request.projectDir);
    const runRead = (path: string): Promise<string | undefined> => readFile(join(request.runIn, ...path.split("/")), "utf8").catch(() => undefined);
    const result = await runSetup(planned.steps, {
      dir: request.runIn,
      ...this.environmentFor(request.projectDir),
      os: this.osTag(),
      readFile: runRead,
      bring: (step) => this.bring(request.runIn, step, undefined, undefined, identity, say),
      clone: (step) => this.cloneBeside(request.runIn, step, { say, phase: () => undefined, step: () => undefined, end: () => undefined }, request.abortSignal ?? new AbortController().signal),
      onOutput: say,
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
    });
    return { target, outcome: "ran", result };
  }

  /**
   * The steps a workspace's setup runs at a moment other than its making (decision 0027): `open` —
   * each time the workspace opens (its `when: "open"` steps, and the start commands of what a `use`
   * step hands over to, like a Dev Container's `postStartCommand`); `again` — after its checkout moved
   * (a pull, a merge, a checkout), the steps whose `again` names a file in `changed`. The setup is the
   * project's file, else the one found in its checkout; only one approved on this machine runs.
   */
  async runPhase(request: {
    dir: string;
    phase: "open" | "again";
    changed?: readonly string[];
    onOutput?: (text: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<{ outcome: "none" | "unapproved" | "ran"; steps?: number; result?: SetupRunResult }> {
    const read = (path: string): Promise<string | undefined> => readFile(join(request.dir, ...path.split("/")), "utf8").catch(() => undefined);
    const readMany = async (paths: readonly string[]): Promise<Map<string, string | true>> =>
      new Map(Object.entries(await readCheckoutFiles(request.dir, paths, () => true)));
    const setup = await this.readSetup(read, readMany);
    if (setup.file === undefined) return { outcome: "none" };
    const planned = this.planned(setup, DEFAULT_TARGET);
    if (!planned.ok) return { outcome: "none" };
    const due = stepsFor(planned.steps, request.phase, request.changed ?? []);
    // A `use` step is due on open only for what it starts each time; with none of those, nothing is.
    if (due.length === 0) return { outcome: "none" };
    if (!this.approved(request.dir, setup.text ?? "")) return { outcome: "unapproved", steps: due.length };
    const say = request.onOutput ?? (() => undefined);
    const identity = this.host.identityOf(request.dir);
    const result = await runSetup(
      planned.steps,
      {
        dir: request.dir,
        ...this.environmentFor(request.dir),
        os: this.osTag(),
        readFile: read,
        bring: (step) => this.bring(request.dir, step, undefined, undefined, identity, say),
        clone: (step) => this.cloneBeside(request.dir, step, { say, phase: () => undefined, step: () => undefined, end: () => undefined }, request.abortSignal ?? new AbortController().signal),
        onOutput: say,
        ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
      },
      request.phase,
      request.changed ?? [],
    );
    return { outcome: "ran", steps: result.steps.length, result };
  }

  /** Approve the setup at `dir` as it is now (the person pressed Run setup with it in front of them). */
  async approveCurrent(dir: string): Promise<void> {
    const read = (path: string): Promise<string | undefined> => readFile(join(dir, ...path.split("/")), "utf8").catch(() => undefined);
    const setup = await this.readSetup(read, async () => new Map());
    this.approve(dir, setup.text ?? "");
  }

  // --- the approval ------------------------------------------------------------------------------

  private approvalsFile(): string {
    return join(this.host.baseDir, "system", "setup-approvals.json");
  }

  /** Whether the setup at `dir` is the one the person approved on this machine. */
  approved(dir: string, text: string): boolean {
    return this.approvals()[dir] === hashOf(text);
  }

  private approve(dir: string, text: string): void {
    const all = { ...this.approvals(), [dir]: hashOf(text) };
    const file = this.approvalsFile();
    mkdirSync(join(this.host.baseDir, "system"), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  private approvals(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.approvalsFile(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  // --- progress ----------------------------------------------------------------------------------

  private output(jobId: string): JobOutput {
    const machine = this.host.selfId();
    let held = "";
    let phase: WorkspacePhase = "fetch";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (): void => {
      timer = undefined;
      if (held.length === 0) return;
      const text = held;
      held = "";
      this.host.publish({ type: "workspace:progress", jobId, machine, phase, text });
    };
    return {
      say: (text) => {
        held += text;
        timer ??= setTimeout(send, PROGRESS_EVERY_MS);
      },
      phase: (next) => {
        if (timer !== undefined) clearTimeout(timer);
        send();
        phase = next;
        this.host.publish({ type: "workspace:progress", jobId, machine, phase });
      },
      step: (event) => {
        if (timer !== undefined) clearTimeout(timer);
        send();
        this.host.publish({ type: "workspace:progress", jobId, machine, phase, step: event });
      },
      end: () => {
        if (timer !== undefined) clearTimeout(timer);
        send();
      },
    };
  }

  // --- answering the machine that copies from here --------------------------------------------------

  peerHandlers(): Record<string, (request: never) => unknown> {
    return {
      "workspace:pack": (async (request: { dir: string }) => {
        const pack = await packCheckout(request.dir, { exec: this.exec() });
        const text = JSON.stringify(pack);
        const id = randomUUID();
        const timer = setTimeout(() => this.packs.delete(id), PACK_KEEP_MS);
        timer.unref?.();
        this.packs.set(id, { text, timer });
        return { id, size: text.length };
      }) as (request: never) => unknown,
      "workspace:packChunk": ((request: { id: string; offset: number }) => {
        const pack = this.packs.get(request.id);
        if (pack === undefined) throw new Error("That pack is gone; start the copy again.");
        const data = pack.text.slice(request.offset, request.offset + CHUNK);
        if (request.offset + CHUNK >= pack.text.length) {
          clearTimeout(pack.timer);
          this.packs.delete(request.id);
        }
        return { data };
      }) as (request: never) => unknown,
      "workspace:ignored": ((request: { dir: string; patterns: string[] }) =>
        collectIgnored(request.dir, (request.patterns ?? []).slice(0, 64), { exec: this.exec() })) as (request: never) => unknown,
      "workspace:files": ((request: { dir: string; paths: string[] }) =>
        readCheckoutFiles(request.dir, (request.paths ?? []).slice(0, 128), () => true)) as (request: never) => unknown,
      "workspace:inspect": ((request: { dir: string }) => this.inspect(request)) as (request: never) => unknown,
    };
  }
}

interface JobOutput {
  say(text: string): void;
  phase(phase: "fetch" | "open" | "setup"): void;
  step(event: WorkspaceStepEvent): void;
  end(): void;
}

async function firstFile(read: (path: string) => Promise<string | undefined>, names: readonly string[]): Promise<{ name: string; text: string } | undefined> {
  for (const name of names) {
    const text = await read(`.jaira/${name}`);
    if (text !== undefined) return { name, text };
  }
  return undefined;
}

function describePack(pack: CheckoutPack): string {
  const s = pack.state;
  const parts = [s.branch !== undefined ? `branch ${s.branch}` : "a detached HEAD"];
  if (s.ahead > 0) parts.push(`${s.ahead} commit${s.ahead === 1 ? "" : "s"} not pushed`);
  if (s.changed > 0) parts.push(`${s.changed} changed file${s.changed === 1 ? "" : "s"}`);
  if (s.untracked > 0) parts.push(`${s.untracked} new file${s.untracked === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (isAbsolute(p) ? resolve(p) : p).replace(/[\\/]+$/, "").split(/[\\/]/).join(sep);
  return norm(a) === norm(b);
}

