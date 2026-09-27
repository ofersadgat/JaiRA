/**
 * `jaira` and the engine (decision 0012 §5, and "A CLI command with no host").
 *
 * A command that touches the engine — `run`, `task …`, `board`, `prune` — goes through the host when
 * there is one: the desktop, `jaira serve`, or another command holding the claim. There is then ONE
 * engine writing a project's databases, and the window shows the command's run as it goes. With no
 * host the command runs in this process, as it always has, and holds the claim while it runs (ruled
 * 2026-09-26: "a"): a desktop started meanwhile connects here, and an engine is built in this process
 * only to answer it.
 *
 * Through a host, a run's approvals and an agent's questions come as pushes, answered at the terminal
 * like any client's — whichever client answers first wins, and the others hear `…:resolved`.
 */
import { spawn } from "node:child_process";
import {
  AppService,
  connectEngine,
  discoverEngine,
  hostEngine,
  pidAlive,
  resolveBaseDir,
  type EngineClient,
  type EngineClientInfo,
  type EngineHostInfo,
  type HostedEngine,
} from "@jaira/service";
import type { JsonValue } from "@declarative-ai/exec";
import type { McpBridgeHost } from "@jaira/runtime";
import type {
  BoardView,
  CreateTaskRequest,
  ModuleApproval,
  PendingApproval,
  PendingQuestion,
  PruneResult,
  PushMessage,
  TaskConnectRequest,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared";

declare const JAIRA_CLI_VERSION: string | undefined;

/** This command's version: the build's, or `dev` from source. Informational — the contract decides. */
export function cliVersion(): string {
  return typeof JAIRA_CLI_VERSION === "string" ? JAIRA_CLI_VERSION : "dev";
}

/** What a command needs from the terminal, as `cli.ts` passes it. */
export interface EngineIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  abortSignal?: AbortSignal;
  confirm?: (question: string) => Promise<boolean>;
  ask?: (question: string, signal?: AbortSignal) => Promise<string | undefined>;
}

/** How a run's approvals are answered through a host — `cli.ts`'s gate, as it applies here. */
export interface HostGate {
  /** `--approve deny` or `--non-interactive`: refuse each, now. */
  deny: boolean;
  /** `--approve-functions`: approve unapproved function files without asking. */
  approveFunctions: boolean;
  /** `--non-interactive`: never prompt. */
  nonInteractive: boolean;
}

function hostWords(host: EngineHostInfo): string {
  return host.kind === "desktop" ? `the JaiRA window (pid ${host.pid})` : host.kind === "server" ? `jaira serve (pid ${host.pid})` : `a jaira command (pid ${host.pid})`;
}

/**
 * Run a command through the engine's host, or in this process holding the claim.
 *
 * `bridgeHost` is lent to an engine built here for a client that connects meanwhile, so it runs its
 * agents on the same MCP bridge as the command.
 */
export async function withEngine<T>(
  command: string,
  viaHost: (client: EngineClient) => Promise<T>,
  inProcess: () => Promise<T>,
  options: { bridgeHost?: () => McpBridgeHost } = {},
): Promise<T> {
  const baseDir = resolveBaseDir(process.env["JAIRA_HOME"] || undefined);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const found = await discoverEngine({ baseDir });
    if (found.kind === "stuck") {
      throw new Error(
        `JaiRA process ${found.pid}${found.name !== undefined ? ` (${found.name})` : ""} holds the engine but does not answer at ${found.address}; ` +
          "end it, and run this again — a second engine is not started beside it",
      );
    }
    if (found.kind === "found") {
      const client = await connectEngine({ baseDir, client: `jaira ${command}`, version: cliVersion(), address: found.address }).catch(() => undefined);
      if (client === undefined) continue;
      if (client.limited) {
        client.close();
        throw new Error(
          `the engine runs JaiRA ${client.host.version} in ${hostWords(client.host)}, which speaks another contract than this jaira (${cliVersion()}); ` +
            (client.host.kind === "server" ? "stop it with `jaira server stop`, or use the jaira that came with it" : "use the jaira that came with it"),
        );
      }
      try {
        return await viaHost(client);
      } finally {
        client.close();
      }
    }
    let hosted: HostedEngine | undefined;
    try {
      hosted = await hostEngine({
        baseDir,
        kind: "cli",
        version: cliVersion(),
        service: (publish) =>
          new AppService({ baseDir, publish, ...(options.bridgeHost !== undefined ? { bridgeHost: options.bridgeHost() } : {}) }),
        stopRefusal: `jaira ${command} holds the engine while it runs, and ends by itself`,
      });
    } catch {
      // No pipe and no port here: the command runs anyway, as it did before there was a claim.
      return await inProcess();
    }
    if (hosted === undefined) continue; // claimed by someone else at the same moment: look again
    try {
      return await inProcess();
    } finally {
      await hosted.close();
    }
  }
  throw new Error("the engine's host could not be reached or claimed; try again");
}

// --- the simple commands -------------------------------------------------------------------------------

/** Stand at a project in the engine without adding it to the window's remembered list. */
async function openIn(client: EngineClient, dir: string): Promise<string> {
  const opened = (await client.invoke("project:open", { dir, remember: false })) as { dir: string };
  return opened.dir;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function hostTaskList(client: EngineClient, dir: string, io: EngineIo): Promise<number> {
  const project = await openIn(client, dir);
  const tasks = (await client.invoke("task:list", { project })) as TaskSummary[];
  io.stdout(
    json(
      tasks.map((t) => ({ taskId: t.taskId, status: t.status, title: t.title, workflow: t.workflow, ...(t.snapshotHash !== undefined ? { snapshotHash: t.snapshotHash } : {}) })),
    ),
  );
  return 0;
}

function runsOf(detail: TaskDetail): unknown[] {
  return detail.runs.map((r) => ({
    outcome: r.outcome,
    startedAt: new Date(r.startedAt).toISOString(),
    ...(r.endedAt !== undefined ? { endedAt: new Date(r.endedAt).toISOString() } : {}),
    ...(r.outputs !== undefined ? { outputs: r.outputs } : {}),
    ...(r.failure !== undefined ? { failure: r.failure } : {}),
  }));
}

export async function hostTaskStatus(client: EngineClient, dir: string, taskId: string, io: EngineIo): Promise<number> {
  const project = await openIn(client, dir);
  const detail = (await client.invoke("task:detail", { taskId, project })) as TaskDetail;
  io.stdout(
    json({
      taskId,
      status: detail.status,
      title: detail.title,
      workflow: detail.workflow,
      ...(detail.snapshotHash !== undefined ? { snapshotHash: detail.snapshotHash } : {}),
      runs: runsOf(detail).slice(-1),
    }),
  );
  return 0;
}

export async function hostTaskCreate(client: EngineClient, dir: string, request: CreateTaskRequest, io: EngineIo): Promise<number> {
  const project = await openIn(client, dir);
  const task = (await client.invoke("task:create", { ...request, project })) as TaskSummary;
  io.stdout(json({ taskId: task.taskId, status: "queued" }));
  return 0;
}

export async function hostTaskCancel(client: EngineClient, dir: string, taskId: string, io: EngineIo): Promise<number> {
  const project = await openIn(client, dir);
  await client.invoke("task:cancel", { taskId, project });
  io.stdout(json({ taskId, status: "canceled" }));
  return 0;
}

export async function hostBoard(client: EngineClient, dir: string, level: string | undefined, io: EngineIo, render: (board: BoardView) => string, asJson: boolean): Promise<number> {
  const project = await openIn(client, dir);
  const board = (await client.invoke("board:view", { project, ...(level !== undefined ? { level } : {}) })) as BoardView;
  io.stdout(asJson ? json(board) : render(board));
  return 0;
}

export async function hostPrune(client: EngineClient, dir: string, days: number, apply: boolean, io: EngineIo): Promise<number> {
  const project = await openIn(client, dir);
  const result = (await client.invoke("history:prune", { project, olderThanDays: days, apply })) as PruneResult & { remaining: unknown };
  io.stdout(
    json({
      ...(result.dryRun ? { dryRun: true } : {}),
      tasksPruned: result.tasks.length,
      events: result.events,
      commands: result.commands,
      tasks: result.tasks,
      skipped: result.skippedTasks,
      remaining: result.remaining,
    }),
  );
  if (result.dryRun) io.stderr("nothing was deleted — re-run with --apply to prune\n");
  return 0;
}

// --- runs ----------------------------------------------------------------------------------------------

/** Scripted wiring a run through the host carries: the same shapes `task:start` takes. */
export interface HostRunWiring {
  fake?: JsonValue;
  interactions?: Record<string, JsonValue[]>;
}

/** The files a start was refused over, approved the way `cli.ts` approves them — or false. */
export type ApproveFiles = (pending: readonly ModuleApproval[]) => Promise<boolean>;

/**
 * Start a task in the engine and follow it to its end: its approvals and questions answered here as
 * they come, its report printed when it finishes. Ctrl-C cancels the run.
 */
export async function hostRunTask(
  client: EngineClient,
  dir: string,
  taskId: string,
  wiring: HostRunWiring,
  gate: HostGate,
  io: EngineIo,
  approveFiles: ApproveFiles,
  start: (project: string) => Promise<unknown> = (project) => client.invoke("task:start", { taskId, project, ...wiring }),
): Promise<number> {
  const project = await openIn(client, dir);
  const follow = followRun(client, taskId, gate, io);
  try {
    try {
      await start(project);
    } catch (e) {
      // Refused over unapproved js/ts function files: ask (or approve, or refuse) as `task start` does in-process.
      const pending = (await client.invoke("functions:pending", { taskId, project }).catch(() => [])) as ModuleApproval[];
      if (pending.length === 0) throw e;
      if (!(await approveFiles(pending))) throw e;
      await client.invoke("functions:approve", { files: pending.map((p) => p.file), project });
      io.stderr(`approved ${pending.length} function file(s): ${pending.map((p) => p.file).join(", ")}\n`);
      await start(project);
    }
    io.stderr(`task ${taskId}: running in ${hostWords(client.host)}\n`);
    const onAbort = (): void => void client.invoke("task:cancel", { taskId, project }).catch(() => undefined);
    io.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let status: "completed" | "failed" | "canceled";
    try {
      status = await follow.finished;
    } finally {
      io.abortSignal?.removeEventListener("abort", onAbort);
    }
    const detail = (await client.invoke("task:detail", { taskId, project })) as TaskDetail;
    const last = detail.runs[detail.runs.length - 1];
    io.stdout(
      json({
        taskId,
        status,
        ...(last?.outputs !== undefined ? { outputs: last.outputs } : {}),
        ...(last?.failure !== undefined ? { failure: last.failure } : {}),
      }),
    );
    return status === "completed" ? 0 : 1;
  } finally {
    follow.stop();
  }
}

/** The move a connect ends in, through the host: it is taken there, and followed here like a start. */
export async function hostTaskMove(
  client: EngineClient,
  dir: string,
  request: TaskConnectRequest,
  wiring: HostRunWiring,
  gate: HostGate,
  io: EngineIo,
  approveFiles: ApproveFiles,
): Promise<number> {
  const project = await openIn(client, dir);
  if (request.dryRun === true) {
    io.stdout(json(await client.invoke("task:connect", { ...request, project })));
    return 0;
  }
  let result: { ok: boolean; taskId?: string; refusal?: { message: string } } | undefined;
  const code = await hostRunTask(client, dir, request.taskId, wiring, gate, io, approveFiles, async () => {
    result = (await client.invoke("task:connect", { ...request, project, ...(wiring.interactions !== undefined ? { interactions: wiring.interactions } : {}) })) as typeof result;
    if (result?.ok !== true) throw new Error(`refused: ${result?.refusal?.message ?? "the move was refused"}`);
    return result;
  }).catch((e: unknown) => {
    if (result !== undefined && result.ok !== true) {
      io.stdout(json(result));
      io.stderr(`${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  });
  return code;
}

/**
 * Hear a task's run: its end, and what it asks on the way. A request another client answers first is
 * dropped from the terminal (`…:resolved`); the prompt it was waiting on is abandoned.
 */
function followRun(client: EngineClient, taskId: string, gate: HostGate, io: EngineIo): { finished: Promise<"completed" | "failed" | "canceled">; stop(): void } {
  const prompts = new Map<string, AbortController>();
  let queue: Promise<void> = Promise.resolve();
  let settle!: (status: "completed" | "failed" | "canceled") => void;
  let fail!: (error: Error) => void;
  const finished = new Promise<"completed" | "failed" | "canceled">((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // One question at a time on one terminal.
  const later = (requestId: string, ask: (signal: AbortSignal) => Promise<void>): void => {
    const controller = new AbortController();
    prompts.set(requestId, controller);
    queue = queue.then(async () => {
      if (controller.signal.aborted) return;
      try {
        await ask(controller.signal);
      } catch (e) {
        io.stderr(`warning: could not answer ${requestId}: ${(e as Error).message}\n`);
      } finally {
        prompts.delete(requestId);
      }
    });
  };
  const onPush = (message: PushMessage): void => {
    switch (message.type) {
      case "run:finished":
        if (message.taskId === taskId) settle(message.status);
        return;
      case "approval:requested":
        if (message.pending.taskId === taskId) later(message.pending.requestId, (signal) => answerApproval(client, message.pending, gate, io, signal));
        return;
      case "question:requested":
        if (message.pending.taskId === taskId) later(message.pending.requestId, (signal) => answerQuestion(client, message.pending, gate, io, signal));
        return;
      case "interaction:requested":
        if (message.pending.taskId === taskId) io.stderr(`waiting: task ${taskId} asks for an answer that only the JaiRA window can give (${message.pending.requestId})\n`);
        return;
      case "approval:resolved":
      case "question:resolved":
      case "interaction:resolved":
        prompts.get(message.requestId)?.abort();
        return;
      default:
        return;
    }
  };
  const off = client.onPush(onPush);
  const offClose = client.onClose(() => fail(new Error("the engine went away before the run finished; it resumes where the engine next runs")));
  return {
    finished,
    stop: () => {
      off();
      offClose();
      for (const controller of prompts.values()) controller.abort();
    },
  };
}

async function answerApproval(client: EngineClient, pending: PendingApproval, gate: HostGate, io: EngineIo, signal: AbortSignal): Promise<void> {
  const what = pending.command ?? JSON.stringify(pending.input);
  if (gate.deny) {
    io.stderr(`refused: ${pending.tool} ${what}${pending.reason !== undefined ? ` (${pending.reason})` : ""}\n`);
    await client.invoke("approval:submit", { requestId: pending.requestId, decision: "deny" });
    return;
  }
  if (gate.nonInteractive || io.ask === undefined) {
    io.stderr(`waiting: ${pending.tool} ${what} needs an answer in the JaiRA window\n`);
    return;
  }
  const line = await io.ask(`\n${pending.tool}: ${what}${pending.reason !== undefined ? `\n  ${pending.reason}` : ""}\nallow? [y/N] `, signal);
  if (signal.aborted) {
    io.stderr("  (answered elsewhere)\n");
    return;
  }
  const decision = line !== undefined && /^y(es)?$/i.test(line.trim()) ? "allow" : "deny";
  await client.invoke("approval:submit", { requestId: pending.requestId, decision });
}

async function answerQuestion(client: EngineClient, pending: PendingQuestion, gate: HostGate, io: EngineIo, signal: AbortSignal): Promise<void> {
  if (gate.nonInteractive || io.ask === undefined) {
    io.stderr(`waiting: the agent asks ${pending.questions.length} question(s), to be answered in the JaiRA window\n`);
    return;
  }
  const answers: Record<string, string | string[]> = {};
  for (const question of pending.questions) {
    const options = question.options ?? [];
    const listed = options.map((o, i) => `  ${i + 1}. ${o.label}${o.description !== undefined ? ` — ${o.description}` : ""}`).join("\n");
    const line = await io.ask(`\n${question.question}\n${listed}${listed !== "" ? "\n" : ""}answer (a number, or your own words; empty to let the agent decide): `, signal);
    if (signal.aborted) {
      io.stderr("  (answered elsewhere)\n");
      return;
    }
    const text = (line ?? "").trim();
    if (text === "") continue;
    const index = Number(text);
    answers[question.question] = Number.isInteger(index) && index >= 1 && index <= options.length ? options[index - 1]!.label : text;
  }
  await client.invoke("question:submit", { requestId: pending.requestId, ...(Object.keys(answers).length > 0 ? { answers } : {}) });
}

// --- jaira serve / jaira server ------------------------------------------------------------------------

/** The installed app's command runs on its Electron in Node mode; that Electron can be a windowless main. */
function installedElectron(): boolean {
  return process.versions["electron"] !== undefined;
}

/**
 * `jaira serve [--detach]`: host the engine until stopped.
 *
 * The installed app's command starts the app's own Electron as a windowless main (`--serve`), which
 * has the keychain; the npm command hosts it right here, on Node, without one (decision 0012 §6).
 * `--detach` leaves it running and returns once it answers.
 */
export async function serveCommand(options: { detach: boolean; home?: string }, io: EngineIo, bridgeHost: () => McpBridgeHost): Promise<number> {
  const baseDir = resolveBaseDir(process.env["JAIRA_HOME"] || undefined);
  const found = await discoverEngine({ baseDir });
  if (found.kind === "found") {
    io.stderr(`error: ${hostWords(found.host)} already hosts the engine for ${baseDir}\n`);
    return 3;
  }
  if (found.kind === "stuck") {
    io.stderr(`error: JaiRA process ${found.pid} holds the engine but does not answer; end it first\n`);
    return 3;
  }
  const home = process.env["JAIRA_HOME"] ? ["--home", process.env["JAIRA_HOME"]] : [];
  if (installedElectron() || options.detach) {
    const env = { ...process.env };
    delete env["ELECTRON_RUN_AS_NODE"];
    const [command, args] = installedElectron() ? [process.execPath, ["--serve", ...home]] : [process.execPath, [process.argv[1]!, "serve", ...home]];
    if (!options.detach) {
      // In the foreground, with its output here; Ctrl-C reaches it too, and it drains before it goes.
      const child = spawn(command, args, { stdio: "inherit", env, windowsHide: true });
      return await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
    }
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const up = await discoverEngine({ baseDir });
      if (up.kind === "found") {
        io.stdout(json({ serving: true, pid: up.host.pid, version: up.host.version, pipe: up.host.pipe }));
        return 0;
      }
    }
    io.stderr("error: the server did not answer within 30 seconds\n");
    return 1;
  }
  // The npm command: host it in this process.
  let stopped!: () => void;
  const done = new Promise<void>((resolve) => (stopped = resolve));
  let hosted: HostedEngine | undefined;
  const stop = async (): Promise<void> => {
    io.stderr("stopping: draining runs and closing the databases\n");
    await hosted?.close();
    stopped();
  };
  hosted = await hostEngine({
    baseDir,
    kind: "server",
    version: cliVersion(),
    eager: true,
    service: (publish) => new AppService({ baseDir, publish, bridgeHost: bridgeHost(), probeOnStart: true, refreshCatalog: true }),
    stop,
    log: (_level, message) => io.stderr(`${message}\n`),
  });
  if (hosted === undefined) {
    io.stderr("error: another process claimed the engine at the same moment\n");
    return 3;
  }
  io.stderr(`serving the engine for ${baseDir} (pid ${process.pid}); no keychain on plain Node — secrets come from .env files\n`);
  const onSignal = (): void => void stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await hosted.engine().restore().catch((e: unknown) => io.stderr(`warning: could not re-open the remembered projects: ${(e as Error).message}\n`));
  await done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return 0;
}

/** `jaira server status [--json]` and `jaira server stop`. */
export async function serverCommand(sub: string | undefined, io: EngineIo): Promise<number> {
  const baseDir = resolveBaseDir(process.env["JAIRA_HOME"] || undefined);
  const found = await discoverEngine({ baseDir, listOthers: sub !== "stop" });
  if (found.kind === "stuck") {
    io.stdout(json({ running: false, stuck: { pid: found.pid, ...(found.name !== undefined ? { name: found.name } : {}), address: found.address } }));
    return 2;
  }
  if (found.kind === "none") {
    if (sub === "stop") io.stderr("nothing hosts the engine\n");
    else {
      const others = (found.others ?? []).map((p) => ({ pid: p.pid, name: p.name }));
      io.stdout(json({ running: false, baseDir, ...(others.length > 0 ? { others } : {}) }));
    }
    return 1;
  }
  const client = await connectEngine({ baseDir, client: `jaira server ${sub ?? "status"}`, version: cliVersion(), address: found.address });
  try {
    if (sub === "stop") {
      await client.invoke("engine:stop");
      const deadline = Date.now() + 120_000;
      while (pidAlive(found.host.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      io.stdout(json({ stopped: !pidAlive(found.host.pid), pid: found.host.pid }));
      return pidAlive(found.host.pid) ? 1 : 0;
    }
    const info = (await client.invoke("engine:info")) as { host: EngineHostInfo; clients: EngineClientInfo[] };
    io.stdout(
      json({
        running: true,
        via: found.via,
        host: { kind: info.host.kind, pid: info.host.pid, version: info.host.version, since: new Date(info.host.startedAt).toISOString(), address: info.host.port !== undefined ? `127.0.0.1:${info.host.port}` : info.host.pipe },
        // This command is one of them; the others are who else uses the engine.
        clients: info.clients.filter((c) => c.pid !== process.pid).map((c) => ({ name: c.name, ...(c.pid !== undefined ? { pid: c.pid } : {}), version: c.version })),
        ...(client.limited ? { note: `it speaks another contract than this jaira (${cliVersion()})` } : {}),
      }),
    );
    return 0;
  } finally {
    client.close();
  }
}
