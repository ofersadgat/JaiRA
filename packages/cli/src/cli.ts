/**
 * The headless `jaira` CLI (DESIGN §14 phases 1–2): project init, ad-hoc
 * workflow runs, and the durable task lifecycle. This surface is the permanent
 * fastest debugging path (DESIGN §14 closing note); the Electron app layers on
 * the same @jaira/persistence primitives in phase 3.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadBundle, validateBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/exec";
import {
  beginTaskRun,
  cancelTask,
  createTask,
  finishTaskRun,
  initProject,
  openProject,
  readWorkflowFiles,
  type Project,
} from "@jaira/persistence";
import { defaultConfig, parseJsonText, type JairaConfig } from "@jaira/shared";
import { parseFakeRules, type FakeRule } from "./fakeExecutor";
import { parseInteractionScript, ScriptedFunctions } from "./scriptedFunctions";
import {
  buildPromptExecutor,
  executeWorkflow,
  functionNamesOf,
  modelDefaults,
  newRegistry,
  statusOfResult,
  type WorkflowExecResult,
} from "./wiring";

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** External cancellation (SIGINT in main.ts). */
  abortSignal?: AbortSignal;
}

class UsageError extends Error {}

const USAGE = `usage:
  jaira init [--project <dir>]
  jaira run --root <stateId> [--project <dir>] [--workflows <dir>] [--inputs <json|@file>]
            [--interactions <json|@file>] [--fake <json|@file>] [--repair-turns <n>]
  jaira task create --title <t> --workflow <rootStateId> [--description <s>] [--label <l>]...
            [--inputs <json|@file>] [--branch <b>] [--project <dir>]
  jaira task start <taskId> [--interactions <json|@file>] [--fake <json|@file>]
            [--repair-turns <n>] [--project <dir>]
  jaira task list [--project <dir>]
  jaira task status <taskId> [--events <n>] [--project <dir>]
  jaira task cancel <taskId> [--project <dir>]
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return cmdInit(rest, io);
    case "run":
      return cmdRun(rest, io);
    case "task": {
      const [sub, ...taskRest] = rest;
      switch (sub) {
        case "create":
          return cmdTaskCreate(taskRest, io);
        case "start":
          return cmdTaskStart(taskRest, io);
        case "list":
          return cmdTaskList(taskRest, io);
        case "status":
          return cmdTaskStatus(taskRest, io);
        case "cancel":
          return cmdTaskCancel(taskRest, io);
        default:
          throw new UsageError(`unknown task subcommand '${sub ?? ""}'`);
      }
    }
    case undefined:
    case "help":
    case "--help":
      io.stdout(USAGE);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

// --- Shared helpers ----------------------------------------------------------

/** Parse a `<json|@file>` option value. */
function jsonValue(label: string, value: string, cwd: string): unknown {
  const text = value.startsWith("@") ? readFileSync(resolve(cwd, value.slice(1)), "utf8") : value;
  return parseJsonText(text, `--${label}`);
}

/** A parsed `--inputs`-style object. Parsed JSON is `JsonValue` by construction. */
function recordValue(label: string, raw: unknown): Record<string, JsonValue> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`--${label} must be a JSON object`);
  }
  return raw as Record<string, JsonValue>;
}

function projectDirOf(values: { project?: string }, io: CliIo): string {
  return resolve(io.cwd, values.project ?? ".");
}

function openWithRecoveryNote(dir: string, io: CliIo): Project {
  const project = openProject(dir);
  if (project.recovered.length > 0) {
    io.stderr(`recovered ${project.recovered.length} interrupted task(s): ${project.recovered.join(", ")}\n`);
  }
  return project;
}

interface RunWiring {
  fakeRules?: FakeRule[];
  interactions?: ScriptedFunctions;
  repairTurns?: number;
}

function runWiringOf(
  values: { fake?: string; interactions?: string; "repair-turns"?: string },
  cwd: string,
): RunWiring {
  const wiring: RunWiring = {};
  if (values.fake !== undefined) {
    wiring.fakeRules = parseFakeRules(jsonValue("fake", values.fake, cwd));
  }
  if (values.interactions !== undefined) {
    wiring.interactions = new ScriptedFunctions(
      parseInteractionScript(jsonValue("interactions", values.interactions, cwd)),
    );
  }
  if (values["repair-turns"] !== undefined) {
    const n = Number(values["repair-turns"]);
    if (!Number.isInteger(n) || n < 0) throw new UsageError("--repair-turns must be a non-negative integer");
    wiring.repairTurns = n;
  }
  return wiring;
}

/**
 * Assemble the registry + prompt executor for one run. Interactive functions the
 * bundle references are registered from the `--interactions` script; an
 * unscripted one is simply absent, and the engine fails that state if it is ever
 * reached (states that are never entered never need their function).
 */
function buildRunEnvironment(
  bundle: Parameters<typeof functionNamesOf>[0],
  config: JairaConfig,
  wiring: RunWiring,
): { registry: ReturnType<typeof newRegistry>; prompt: ReturnType<typeof buildPromptExecutor> } {
  const registry = newRegistry();
  if (wiring.interactions) {
    wiring.interactions.register(registry);
    for (const name of functionNamesOf(bundle)) wiring.interactions.registerWildcard(registry, name);
  }
  const prompt = buildPromptExecutor({
    ...(wiring.fakeRules !== undefined ? { fakeRules: wiring.fakeRules } : {}),
    ...(wiring.repairTurns !== undefined ? { repairTurns: wiring.repairTurns } : {}),
    defaults: modelDefaults(config, bundle, { fake: wiring.fakeRules !== undefined }),
  });
  return { registry, prompt };
}

function resultReport(result: WorkflowExecResult): Record<string, unknown> {
  const failure = "error" in result ? result.error : undefined;
  return {
    status: statusOfResult(result),
    ...(result.value !== undefined ? { outputs: result.value } : {}),
    ...(failure !== undefined ? { failure } : {}),
    metrics: result.metrics,
  };
}

// --- Commands ----------------------------------------------------------------

function cmdInit(argv: string[], io: CliIo): number {
  const { values } = parseArgs({ args: argv, options: { project: { type: "string" } } });
  const paths = initProject(projectDirOf(values, io));
  io.stdout(`initialized JaiRA project at ${paths.jairaDir}\n`);
  return 0;
}

async function cmdRun(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      project: { type: "string" },
      workflows: { type: "string" },
      inputs: { type: "string" },
      interactions: { type: "string" },
      fake: { type: "string" },
      "repair-turns": { type: "string" },
    },
  });
  if (values.root === undefined) throw new UsageError("run requires --root <stateId>");
  const projectDir = projectDirOf(values, io);

  // Ad-hoc runs read live workflows (no snapshot, no task) — the phase-1
  // debugging surface. Durable runs go through `jaira task …`.
  let config: JairaConfig;
  let workflowsDir: string;
  if (values.workflows !== undefined) {
    workflowsDir = resolve(io.cwd, values.workflows);
    config = tryProjectConfig(projectDir) ?? defaultConfig();
  } else {
    const project = openWithRecoveryNote(projectDir, io);
    config = project.config;
    workflowsDir = project.paths.workflowsDir;
    project.close();
  }

  const files = readWorkflowFiles(workflowsDir);
  if (Object.keys(files).length === 0) throw new Error(`no workflow state files under ${workflowsDir}`);
  const bundle = loadBundle(files, values.root);
  const report = validateBundle(bundle);
  if (report.errors.length > 0) {
    const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
    throw new Error(`workflow validation failed:\n  ${detail}`);
  }

  const wiring = runWiringOf(values, io.cwd);
  const inputs = values.inputs !== undefined ? recordValue("inputs", jsonValue("inputs", values.inputs, io.cwd)) : {};
  const { registry, prompt } = buildRunEnvironment(bundle, config, wiring);
  const result = await executeWorkflow({
    bundle,
    inputs,
    registry,
    prompt,
    ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
  });
  io.stdout(JSON.stringify(resultReport(result), null, 2) + "\n");
  return statusOfResult(result) === "completed" ? 0 : 1;
}

function tryProjectConfig(projectDir: string): JairaConfig | undefined {
  try {
    const project = openProject(projectDir);
    const config = project.config;
    project.close();
    return config;
  } catch {
    return undefined;
  }
}

function cmdTaskCreate(argv: string[], io: CliIo): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      title: { type: "string" },
      workflow: { type: "string" },
      description: { type: "string" },
      label: { type: "string", multiple: true },
      inputs: { type: "string" },
      branch: { type: "string" },
      project: { type: "string" },
    },
  });
  if (values.title === undefined) throw new UsageError("task create requires --title");
  if (values.workflow === undefined) throw new UsageError("task create requires --workflow <rootStateId>");
  const project = openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const meta = createTask(project, {
      title: values.title,
      workflow: values.workflow,
      description: values.description,
      labels: values.label,
      inputs:
        values.inputs !== undefined
          ? recordValue("inputs", jsonValue("inputs", values.inputs, io.cwd))
          : undefined,
      branch: values.branch,
    });
    io.stdout(JSON.stringify({ taskId: meta.id, status: "queued" }, null, 2) + "\n");
    return 0;
  } finally {
    project.close();
  }
}

async function cmdTaskStart(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      interactions: { type: "string" },
      fake: { type: "string" },
      "repair-turns": { type: "string" },
      project: { type: "string" },
    },
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("task start requires a task id");
  const wiring = runWiringOf(values, io.cwd);
  const project = openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    // Validation at task start resolves every `functionRef` against the registry
    // this run will actually use, so a missing interactive function is an
    // authoring error caught here rather than mid-run.
    const probe = newRegistry();
    wiring.interactions?.register(probe);
    const started = beginTaskRun(project, taskId, { functions: probe.functions });
    io.stderr(
      `task ${taskId} run ${started.runId}: workflow '${started.meta.workflow}' ` +
        `snapshot ${started.snapshotHash.slice(0, 12)}${started.pinned ? " (pinned)" : ""}\n`,
    );
    const { registry, prompt } = buildRunEnvironment(started.bundle, project.config, wiring);
    const result = await executeWorkflow({
      bundle: started.bundle,
      inputs: started.meta.inputs ?? {},
      registry,
      prompt,
      persistence: project.events.recorder(taskId, started.runId),
      ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
    });
    const status = statusOfResult(result);
    finishTaskRun(project, taskId, started.runId, status, {
      outputs: result.value,
      ...("error" in result && result.error !== undefined ? { failure: result.error } : {}),
    });
    io.stdout(JSON.stringify({ taskId, runId: started.runId, ...resultReport(result) }, null, 2) + "\n");
    return status === "completed" ? 0 : 1;
  } finally {
    project.close();
  }
}

function cmdTaskList(argv: string[], io: CliIo): number {
  const { values } = parseArgs({ args: argv, options: { project: { type: "string" } } });
  const project = openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const rows = project.runtime.list().map((row) => {
      const meta = project.tasks.tryRead(row.taskId);
      return {
        taskId: row.taskId,
        status: row.status,
        title: meta?.title ?? "(missing task file)",
        workflow: meta?.workflow,
        ...(row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : {}),
      };
    });
    io.stdout(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  } finally {
    project.close();
  }
}

function cmdTaskStatus(argv: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "string" }, events: { type: "string" } },
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("task status requires a task id");
  const project = openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const runtime = project.runtime.get(taskId);
    if (!runtime) throw new Error(`unknown task '${taskId}'`);
    const meta = project.tasks.tryRead(taskId);
    const runs = project.runtime.listRuns(taskId).map((run) => ({
      runId: run.id,
      outcome: run.outcome ?? "running",
      startedAt: new Date(run.startedAt).toISOString(),
      ...(run.endedAt !== undefined ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
      ...(run.outputsJson !== undefined ? { outputs: JSON.parse(run.outputsJson) as unknown } : {}),
      ...(run.failureJson !== undefined ? { failure: JSON.parse(run.failureJson) as unknown } : {}),
    }));
    const eventLimit = values.events !== undefined ? Number(values.events) : 0;
    const allEvents = eventLimit > 0 ? project.events.list(taskId) : [];
    const events = allEvents.slice(-eventLimit).map((e) => ({ seq: e.seq, runId: e.runId, ...e.event }));
    io.stdout(
      JSON.stringify(
        {
          taskId,
          status: runtime.status,
          title: meta?.title,
          workflow: meta?.workflow,
          ...(runtime.snapshotHash !== undefined ? { snapshotHash: runtime.snapshotHash } : {}),
          runs,
          ...(eventLimit > 0 ? { events } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } finally {
    project.close();
  }
}

function cmdTaskCancel(argv: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "string" } },
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("task cancel requires a task id");
  const project = openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    cancelTask(project, taskId);
    io.stdout(JSON.stringify({ taskId, status: "canceled" }, null, 2) + "\n");
    return 0;
  } finally {
    project.close();
  }
}
