/**
 * The requests every host answers the same way (decision 0012 §1): one dispatch from a channel of the
 * IPC contract to the {@link AppService} method that answers it. The desktop's main process hands it to
 * Electron's IPC today; the local server's pipe is the next transport over the same table.
 *
 * What is not here is the HOST's own: a save dialog, a download and a clipboard bitmap are Electron's,
 * and the app's updater, its plugin downloads, its licence file and its `jaira` command belong to the
 * installed app — {@link HOST_CHANNELS}. A host answers those itself, and the two tables together cover
 * every channel (checked where they meet, in the desktop's `index.ts`).
 */
import { resolve } from "node:path";
import type { DetectSchemaRequest, InputSourcesRequest, IpcChannel, TaskAdoptRequest, TaskConnectRequest, TaskConnectUndoRequest, TaskMoveRequest } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import type { HealthItem, LogLevel } from "@jaira/shared";
import type { EngineHostInfo } from "./enginePipe";
import type { EngineClientInfo } from "./engineHost";
import type { AppService, CrashKind } from "./service";

/** A channel's handler: its request in, its answer (or a promise of it) out. */
export type Handler = (request: never) => unknown;

/** The channels a host answers itself — see the header. */
export const HOST_CHANNELS = [
  "shell:saveFile",
  "shell:download",
  "shell:copyImageAt",
  "shell:edit",
  "licenses:read",
  "update:state",
  "update:check",
  "update:download",
  "update:install",
  "update:dismiss",
  "plugin:list",
  "plugin:install",
  "plugin:remove",
  "cli:status",
  "cli:install",
  "engine:status",
] as const satisfies readonly IpcChannel[];

export type HostChannel = (typeof HOST_CHANNELS)[number];
export type ServiceChannel = Exclude<IpcChannel, HostChannel>;

/**
 * Every request the service answers, by channel — this machine's projects here, another machine's
 * forwarded to it (decision 0013 §7, `Federation.route`).
 */
export function serviceHandlers(service: AppService, options: { local?: boolean } = {}): Record<ServiceChannel, Handler> {
  const table = localHandlers(service);
  // Another machine asking: answered with THIS machine's workspaces only. Forwarding on would send its
  // own requests back to it, and two machines asking each other for everything would never stop.
  if (options.local === true) return table;
  const routed = {} as Record<ServiceChannel, Handler>;
  for (const [channel, handler] of Object.entries(table) as Array<[ServiceChannel, Handler]>) {
    routed[channel] = ((request: unknown) => service.federation.route(channel, request) ?? (handler as (request: unknown) => unknown)(request)) as Handler;
  }
  // Starting a task PLACES it, where its project has several workspaces (decision 0013 §5). Only a
  // request made here: one forwarded from another machine was placed there already.
  routed["task:start"] = ((request: Parameters<typeof service.startTask>[0]) =>
    service.federation.route("task:start", request) ?? service.placeAndStart(request)) as Handler;
  // The root's lists span every machine: each online one's, keyed for forwarding.
  routed["task:all"] = (async (request: unknown) => {
    const local = (await (table["task:all"] as (request: unknown) => unknown)(request)) as unknown[];
    const remote = await service.federation.everyMachine("task:all", request);
    return [...local, ...remote];
  }) as Handler;
  return routed;
}

function localHandlers(service: AppService): Record<ServiceChannel, Handler> {
  return {
    "project:open": ((request: { dir: string; remember?: boolean }) =>
      service.open(resolve(request.dir), request.remember === false ? { remember: false } : {})) as Handler,
    "project:init": ((request: { dir: string }) => service.init(resolve(request.dir))) as Handler,
    "project:choose": ((request: { mode?: "open" | "init" } | undefined) =>
      service.chooseProject(request?.mode ?? "open")) as Handler,
    "project:inspect": ((request: { dir: string }) => service.inspect(request.dir)) as Handler,
    "project:current": (() => service.current()) as Handler,
    "task:list": ((request: { project?: string } | undefined) => service.listTasks(request?.project)) as Handler,
    "task:detail": ((request: { taskId: string; project?: string }) => service.taskDetail(request.taskId, request.project)) as Handler,
    "task:create": ((request: Parameters<typeof service.createTask>[0]) => service.createTask(request)) as Handler,
    "task:start": ((request: Parameters<typeof service.startTask>[0]) => service.startTask(request)) as Handler,
    "task:cancel": ((request: { taskId: string; project?: string }) =>
      service.cancelTask(request.taskId, request.project)) as Handler,
    "task:rerun": ((request: Parameters<typeof service.rerunTask>[0]) => service.rerunTask(request)) as Handler,
    "task:resume": ((request: Parameters<typeof service.resumeTask>[0]) => service.resumeTask(request)) as Handler,
    "task:resumable": ((request: { taskId: string; project?: string }) =>
      service.resumable(request.taskId, request.project)) as Handler,
    "task:rewind": ((request: Parameters<typeof service.rewindTask>[0]) => service.rewindTask(request)) as Handler,
    "task:fork": ((request: Parameters<typeof service.forkTask>[0]) => service.forkTask(request)) as Handler,
    "task:delete": ((request: { taskId: string; project?: string }) =>
      service.deleteTask(request.taskId, request.project)) as Handler,
    "task:rename": ((request: Parameters<typeof service.renameTask>[0]) => service.renameTask(request)) as Handler,
    "board:view": ((request: { level?: string; project?: string } | undefined) => service.board(request ?? {})) as Handler,
    "board:roots": ((request: { project?: string } | undefined) => service.boardRoots(request ?? {})) as Handler,
    "files:tree": ((request: { project?: string } | undefined) => service.filesTree(request)) as Handler,
    "files:hiddenReport": ((request: Parameters<typeof service.hiddenReport>[0]) => service.hiddenReport(request)) as Handler,
    "files:whyHidden": ((request: Parameters<typeof service.whyHidden>[0]) => service.whyHidden(request)) as Handler,
    "state:view": ((request: { stateId: string; project?: string }) =>
      service.stateView(request.stateId, request.project)) as Handler,
    "state:slots": ((request: { stateIds: string[]; project?: string }) =>
      service.stateSlots(request.stateIds, request.project)) as Handler,
    "state:effective": ((request: Parameters<typeof service.effectiveState>[0]) =>
      service.effectiveState(request)) as Handler,
    "task:conversation": ((request: { taskId: string; project?: string }) => service.conversation(request.taskId, request.project)) as Handler,
    "task:system": (() => service.listSystemTasks()) as Handler,
    "project:list": (() => service.listProjects()) as Handler,
    "task:all": ((request: { workflows?: string[] } | undefined) => service.listAllTasks(request ?? {})) as Handler,
    "session:history": ((request: Parameters<typeof service.sessionHistory>[0]) => service.sessionHistory(request)) as Handler,
    "run:records": ((request: Parameters<typeof service.runRecords>[0]) => service.runRecords(request)) as Handler,
    "session:view": ((request: Parameters<typeof service.sessionView>[0]) => service.sessionView(request)) as Handler,
    "session:live": ((request: Parameters<typeof service.sessionLive>[0]) => service.sessionLive(request)) as Handler,
    "chat:plan": ((request: Parameters<typeof service.chatPlan>[0]) => service.chatPlan(request)) as Handler,
    "chat:startPlan": ((request: Parameters<typeof service.chatStartPlan>[0]) => service.chatStartPlan(request)) as Handler,
    "chat:send": ((request: Parameters<typeof service.sendChatMessage>[0]) => service.sendChatMessage(request)) as Handler,
    "chat:cancel": ((request: Parameters<typeof service.cancelChatTurn>[0]) => service.cancelChatTurn(request)) as Handler,
    "chat:thread": ((request: Parameters<typeof service.chatThread>[0]) => service.chatThread(request)) as Handler,
    "log:list": ((request: Parameters<typeof service.readLogs>[0]) => service.readLogs(request)) as Handler,
    "job:list": ((request: Parameters<typeof service.listJobs>[0]) => service.listJobs(request)) as Handler,
    "job:output": ((request: Parameters<typeof service.jobOutput>[0]) => service.jobOutput(request)) as Handler,
    "interaction:pending": (() => service.pendingInteractions()) as Handler,
    "interaction:submit": ((request: { requestId: string; value: never }) =>
      service.submitInteraction(request.requestId, request.value)) as Handler,
    "approval:pending": (() => service.pendingApprovals()) as Handler,
    "approval:submit": ((request: { requestId: string; decision: "allow" | "deny"; scope?: never; remember?: string[]; addTo?: "project" | "base" }) =>
      service.submitApproval(request.requestId, request.decision, request.scope, request.remember, request.addTo)) as Handler,
    "userEvent:pending": (() => service.pendingUserEvents()) as Handler,
    "userEvent:deliver": ((request: { requestId: string }) => service.deliverUserEvent(request.requestId)) as Handler,
    "task:move": ((request: TaskMoveRequest) => service.moveTask(request)) as Handler,
    "task:fastForward": ((request: Parameters<typeof service.fastForwardTask>[0]) => service.fastForwardTask(request)) as Handler,
    "task:skip": ((request: Parameters<typeof service.skipFastForward>[0]) => service.skipFastForward(request)) as Handler,
    "task:answerYourself": ((request: Parameters<typeof service.answerYourself>[0]) => service.answerYourself(request)) as Handler,
    "task:adopt": ((request: TaskAdoptRequest) => service.adoptTask(request)) as Handler,
    "task:connect": ((request: TaskConnectRequest) => service.connectTask(request)) as Handler,
    "task:connectUndo": ((request: TaskConnectUndoRequest) => service.undoConnect(request)) as Handler,
    "task:inputSources": ((request: InputSourcesRequest) => service.inputSources(request)) as Handler,
    "remote:status": ((request: { taskId: string; project?: string }) => service.remoteStatus(request.taskId, request.project)) as Handler,
    "remote:check": ((request: { taskId: string; project?: string }) => service.checkRemotes(request.taskId, request.project)) as Handler,
    "remote:reply": ((request: { taskId: string; key: string; thread: string; body: string; resolve?: boolean; project?: string }) => service.replyRemote(request)) as Handler,
    "question:pending": (() => service.pendingQuestions()) as Handler,
    "question:submit": ((request: { requestId: string; answers?: Record<string, string | string[]> }) =>
      service.submitQuestion(request.requestId, request.answers)) as Handler,
    "workflow:browse": ((request: { project?: string } | undefined) => service.browseWorkflows(request?.project)) as Handler,
    "functions:pending": ((request: { taskId: string; project?: string }) => service.functionsPending(request)) as Handler,
    "functions:approve": ((request: { files: string[]; project?: string }) => service.functionsApprove(request)) as Handler,
    "workflow:read": ((request: Parameters<typeof service.readWorkflow>[0]) => service.readWorkflow(request)) as Handler,
    "workflow:write": ((request: Parameters<typeof service.writeWorkflow>[0]) => service.writeWorkflow(request)) as Handler,
    "workflow:move": ((request: Parameters<typeof service.moveWorkflow>[0]) => service.moveWorkflow(request)) as Handler,
    "workflow:syncStatus": ((request: Parameters<typeof service.syncStatus>[0]) => service.syncStatus(request)) as Handler,
    "workflow:sync": ((request: Parameters<typeof service.runSync>[0]) => service.runSync(request)) as Handler,
    "workflow:syncCancel": (() => service.cancelSync()) as Handler,
    "workflow:delete": ((request: Parameters<typeof service.deleteWorkflow>[0]) =>
      service.deleteWorkflow(request)) as Handler,
    "schema:validate": ((request: Parameters<typeof service.validateSchema>[0]) =>
      service.validateSchema(request)) as Handler,
    "schema:check": ((request: Parameters<typeof service.checkValues>[0]) => service.checkValues(request)) as Handler,
    "schema:detect": ((request: DetectSchemaRequest) => service.detectSchema(request.text, request.path, request.format)) as Handler,
    "file:read": ((request: Parameters<typeof service.readFile>[0]) => service.readFile(request)) as Handler,
    "file:check": ((request: Parameters<typeof service.checkFile>[0]) => service.checkFile(request)) as Handler,
    "file:definition": ((request: Parameters<typeof service.defineFile>[0]) => service.defineFile(request)) as Handler,
    "file:references": ((request: Parameters<typeof service.referencesInFile>[0]) =>
      service.referencesInFile(request)) as Handler,
    "file:hover": ((request: Parameters<typeof service.hoverInFile>[0]) => service.hoverInFile(request)) as Handler,
    "file:source": ((request: Parameters<typeof service.sourceOfFile>[0]) =>
      service.sourceOfFile(request)) as Handler,
    "file:release": ((request: Parameters<typeof service.releaseFile>[0]) => service.releaseFile(request)) as Handler,
    "uri:read": ((request: Parameters<typeof service.readUri>[0]) => service.readUri(request)) as Handler,
    "artifact:serve": ((request: Parameters<typeof service.serveArtifact>[0]) => service.serveArtifact(request)) as Handler,
    "artifact:list": ((request: Parameters<typeof service.listArtifacts>[0]) => service.listArtifacts(request)) as Handler,
    "git:identity": ((request: Parameters<typeof service.gitIdentity>[0]) => service.gitIdentity(request)) as Handler,
    "file:find": ((request: Parameters<typeof service.findFiles>[0]) => service.findFiles(request)) as Handler,
    "changeset:review": ((request: Parameters<typeof service.reviewChanges>[0]) => service.reviewChanges(request)) as Handler,
    "task:changes": ((request: Parameters<typeof service.taskChanges>[0]) => service.taskChanges(request)) as Handler,
    "changeset:reviewSync": ((request: Parameters<typeof service.reviewSyncChangeset>[0]) =>
      service.reviewSyncChangeset(request)) as Handler,
    "file:write": ((request: Parameters<typeof service.writeFile>[0]) => service.writeFile(request)) as Handler,
    "permissionSet:save": ((request: Parameters<typeof service.savePermissionSet>[0]) => service.savePermissionSet(request)) as Handler,
    "permissionSets:read": ((request: Parameters<typeof service.readPermissionSetSettings>[0]) => service.readPermissionSetSettings(request)) as Handler,
    "permissionSets:judgeReadOnly": ((request: Parameters<typeof service.judgeReadOnly>[0]) => service.judgeReadOnly(request)) as Handler,
    "permissionSets:write": ((request: Parameters<typeof service.writePermissionSetSettings>[0]) => service.writePermissionSetSettings(request)) as Handler,
    "permissionSets:reset": ((request: Parameters<typeof service.resetPermissionSetSettings>[0]) => service.resetPermissionSetSettings(request)) as Handler,
    "events:status": ((request: Parameters<typeof service.readEventStatus>[0]) => service.readEventStatus(request)) as Handler,
    "notices:list": (() => service.notices()) as Handler,
    "file:create": ((request: Parameters<typeof service.createFile>[0]) => service.createFile(request)) as Handler,
    "file:rename": ((request: Parameters<typeof service.renameFile>[0]) => service.renameFile(request)) as Handler,
    "file:delete": ((request: Parameters<typeof service.deleteFile>[0]) => service.deleteFile(request)) as Handler,
    "shell:reveal": ((request: { file: string }) => service.revealFile(request)) as Handler,
    "history:size": ((request: { project?: string } | undefined) => service.historySize(request?.project)) as Handler,
    "history:prune": ((request: Parameters<typeof service.pruneHistory>[0]) =>
      service.pruneHistory(request)) as Handler,
    "settings:read": (() => service.readSettings()) as Handler,
    "settings:write": ((request: Parameters<typeof service.writeSettings>[0]) => service.writeSettings(request)) as Handler,
    "config:read": ((request: { project?: string } | undefined) => service.readConfig(request?.project)) as Handler,
    "config:write": ((request: Parameters<typeof service.writeConfig>[0]) => service.writeConfig(request)) as Handler,
    "executor:list": (() => service.listExecutors()) as Handler,
    "executor:probe": ((request: { name?: string } | undefined) => service.probeExecutors(request?.name)) as Handler,
    "model:probe": (() => service.probeModelRoutes()) as Handler,
    "model:probeLocal": ((request: { baseURL?: string } | undefined) => service.probeLocalServers(request ?? {})) as Handler,
    "mcp:detect": (() => service.detectMcpServers()) as Handler,
    "mcp:tools": ((request: { recheck?: boolean } | undefined) => service.mcpTools(request ?? {})) as Handler,
    "model:checkWeights": ((request: { weights?: Record<string, { modelPath: string }> } | undefined) => service.checkWeights(request ?? {})) as Handler,
    "availability:read": (() => service.readAvailability()) as Handler,
    "executor:signIn": ((request: { name: string }) => service.signInExecutor(request.name)) as Handler,
    "executor:cancelSignIn": ((request: { name: string }) => service.cancelSignIn(request.name)) as Handler,
    "executor:signOut": ((request: { name: string }) => service.signOutExecutor(request.name)) as Handler,
    "forge:signIn": ((request: { connection: string }) => service.signInForge(request.connection)) as Handler,
    "forge:cancelSignIn": ((request: { connection: string }) => service.cancelForgeSignIn(request.connection)) as Handler,
    "forge:signIns": (() => service.pendingForgeSignIns()) as Handler,
    "forge:signOut": ((request: { connection: string }) => service.signOutForge(request.connection)) as Handler,
    "availability:refresh": ((request: { recheck?: boolean } | undefined) => service.refreshAvailability(request ?? {})) as Handler,
    "model:parameters": ((request: Parameters<typeof service.modelParameters>[0]) => service.modelParameters(request)) as Handler,
    "catalog:status": (() => service.catalogStatus()) as Handler,
    "catalog:refresh": (() => service.refreshCatalogNow()) as Handler,
    "limits:read": (() => service.readLimits()) as Handler,
    "limits:refresh": ((request: { account: string }) => service.refreshLimits(request.account)) as Handler,
    "limits:watch": ((request: { watching: boolean }) => service.watchLimits(request.watching)) as Handler,
    "waiting:list": ((request: { project?: string; taskId?: string } | undefined) => service.listWaiting(request ?? {})) as Handler,
    "waiting:act": ((request: Parameters<typeof service.actOnWaiting>[0]) => service.actOnWaiting(request)) as Handler,
    "secret:capabilities": (() => service.secretCapabilities()) as Handler,
    "secret:set": ((request: Parameters<typeof service.setSecret>[0]) => service.setSecret(request)) as Handler,
    "update:busy": (() => service.activeWork()) as Handler,
    "health:list": (() => service.health.list()) as Handler,
    "health:dismiss": ((request: { id: string }) => {
      service.health.dismiss(request.id);
      return service.health.list();
    }) as Handler,
    "machines:view": (() => service.fleet.view()) as Handler,
    "machines:rename": ((request: { label: string }) => service.fleet.rename(request.label)) as Handler,
    "machines:tags": ((request: { tags: string[] }) => service.fleet.setTags(request.tags)) as Handler,
    "machines:reach": ((request: { on: boolean }) => service.fleet.setReachable(request.on === true)) as Handler,
    "machines:pairCode": (() => service.fleet.pairingCode()) as Handler,
    "machines:pairCancel": (() => service.fleet.cancelPairing()) as Handler,
    "machines:add": ((request: { address: string; code: string }) => service.fleet.add(request.address, request.code)) as Handler,
    "machines:forget": ((request: { id: string }) => service.fleet.forget(request.id)) as Handler,
    "placement:view": ((request: { project: string }) => service.placementView(request.project)) as Handler,
    "placement:setRules": ((request: { project: string; order: string[]; caps: Record<string, number> }) =>
      service.setPlacementRules(request.project, request.order, request.caps)) as Handler,
    "placement:queue": (() => service.queuedPlacements()) as Handler,
    "files:browse": ((request: { dir?: string } | undefined) => service.browseDirectory(request?.dir)) as Handler,
    "machines:outbox": (() => service.federation.outboxView()) as Handler,
    "machines:withdraw": ((request: { id: string }) => {
      service.federation.withdraw(request.id);
      return service.federation.outboxView();
    }) as Handler,
    "placement:runOn": ((request: { taskId: string; project: string; target: string }) => service.runQueuedOn(request.taskId, request.project, request.target)) as Handler,
    "health:dismissAll": (() => {
      service.health.dismissAll();
      return service.health.list();
    }) as Handler,
  };
}

/**
 * What one engine host's PEERS ask of it over the pipe (decision 0012 §3): the desktop's main process
 * when another process hosts the engine, and `jaira server status|stop`. Never the renderer's — these
 * are not IPC channels, and a client admitted with another contract may still ask them (`limited`).
 *
 * The desktop's main process uses the engine for more than the window's requests: it logs its own
 * launch and crashes, keeps the updater's and plugins' items on the health board, asks what a quit
 * would cut, and serves artifacts to its frames. In-process those are method calls; as a client they
 * are these.
 */
export interface EngineControl {
  /** This host and who is connected to it. */
  info(): { host: EngineHostInfo; clients: EngineClientInfo[] };
  /** Stop hosting: a server drains and exits; a desktop or a CLI command refuses. */
  stop(): Promise<{ stopping: true }>;
}

/** An error as the pipe carries it, back into one whose stack the log keeps. */
function errorOf(raw: { message: string; name?: string; stack?: string }): Error {
  const error = new Error(raw.message);
  if (raw.name !== undefined) error.name = raw.name;
  if (raw.stack !== undefined) error.stack = raw.stack;
  return error;
}

export function enginePeerHandlers(service: AppService, control: EngineControl): Record<string, Handler> {
  return {
    "engine:info": (() => control.info()) as Handler,
    "engine:stop": (() => control.stop()) as Handler,
    "engine:recordApp": ((request: { level: LogLevel; message: string; detail?: JsonValue; raised?: string }) =>
      service.recordApp(request.level, request.message, request.detail, request.raised)) as Handler,
    "engine:recordCrash": ((request: { kind: CrashKind; error: { message: string; name?: string; stack?: string } }) =>
      service.recordCrash(request.kind, errorOf(request.error))) as Handler,
    "engine:recordWarning": ((request: { error: { message: string; name?: string; stack?: string } }) => service.recordWarning(errorOf(request.error))) as Handler,
    "engine:recordIpcFailure": ((request: { channel: string; error: { message: string; name?: string; stack?: string } }) =>
      service.recordIpcFailure(request.channel, errorOf(request.error))) as Handler,
    "engine:healthSet": ((request: Omit<HealthItem, "since">) => service.health.set(request)) as Handler,
    "engine:healthClear": ((request: { id: string }) => service.health.clear(request.id)) as Handler,
    "engine:activeWork": (() => service.activeWork()) as Handler,
    "engine:suspendForUpdate": (() => service.suspendForUpdate()) as Handler,
    "engine:probeExecutors": (() => service.probeExecutors()) as Handler,
    "engine:kickRemotes": (() => service.kickRemotes()) as Handler,
    "engine:kickRepoWatch": (() => service.kickRepoWatch()) as Handler,
    "engine:servedArtifact": ((request: { token: string }) => service.servedArtifact(request.token) ?? null) as Handler,
    "engine:restore": (() => service.restore()) as Handler,
  };
}
