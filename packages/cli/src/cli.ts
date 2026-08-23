/**
 * The headless `jaira` CLI (DESIGN §14 phases 1–2): project init, ad-hoc
 * workflow runs, and the durable task lifecycle. This surface is the permanent
 * fastest debugging path (DESIGN §14 closing note); the Electron app layers on
 * the same @jaira/persistence primitives in phase 3.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadBundle, validateBundle, moduleHash as moduleHashOf } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/exec";
import { registerCliChangesetReviewer } from "./changesetReviewer";
import {
  beginTaskRun,
  boardView,
  browseWorkflows,
  cancelTask,
  createTask,
  finishTaskRun,
  initProject,
  lintErrors,
  openProject,
  prepareUserModules,
  userModules,
  ensureWorkspace,
  gitFor,
  historySize,
  pruneHistory,
  readWorkflowFiles,
  removeWorktree,
  runCauses,
  RunOwner,
  standaloneLoadOptions,
  workflowDigest,
  type Project,
  type WorkflowBrowser,
} from "@jaira/persistence";
import {
  defaultConfig,
  jairaBasePaths,
  jairaPaths,
  parseJsonText,
  WORKFLOW_DESCRIPTION_PATH,
  type BoardCard,
  type BoardView,
  type JairaConfig,
} from "@jaira/shared";
import {
  buildPromptExecutor,
  conformanceReportOf,
  conformanceWorkflowFiles,
  CONFORMANCE_ID,
  executeWorkflow,
  verdictOfFindings,
  artifactWiring,
  functionNamesOf,
  gateCapabilities,
  hostPathFor,
  persistEngineArtifacts,
  registerFileTools,
  registerSearchTools,
  registerWebTools,
  type ArtifactStore,
  type ExecObserver,
  defaultExecutorTree,
  modelRouterOptions,
  agentPromptRoutes,
  SecretResolver,
  newRegistry,
  NodeExec,
  parseFakeRules,
  parseInteractionScript,
  policyCanEscalate,
  promptSummarizer,
  enabledAdapters,
  enabledGenericAgents,
  registerAgentRuntimes,
  registerChangesetFunctions,
  UserEventHub,
  registerCommandFunction,
  registerGenericAgents,
  USER_APPROVE_CHANGESET,
  worktreeChangeset,
  changesetReviewFiles,
  changesetReviewLoopFiles,
  CHANGESET_REVIEW_ID,
  CHANGESET_REVIEW_LOOP_ID,
  withinWorkspace,
  registerTools,
  registerUserFunctions,
  prepareUserFunctions,
  samePathKey,
  ScriptedFunctions,
  sessionServicesFor,
  statusOfResult,
  type ConformanceFinding,
  type ConformanceReport,
  type FakeRule,
  type WorkflowExecResult,
} from "@jaira/runtime";

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
  jaira board [--level <stateId>] [--json] [--project <dir>]
  jaira worktree list [--project <dir>]
  jaira worktree remove <taskId> [--force] [--project <dir>]
  jaira changeset review [--task <taskId> | --dir <path>] [--base <rev>] [--loop]
            [--interactions <json|@file>] [--fake <json|@file>] [--project <dir>]
  jaira prune [--older-than <days>] [--keep-runs <n>] [--apply] [--project <dir>]
  jaira workflow list [--json] [--project <dir>]
  jaira workflow lint [--json] [--project <dir>]
  jaira functions list [--json] [--project <dir>]
  jaira functions approve <file>... [--project <dir>]
  jaira functions revoke <file>... [--project <dir>]
  jaira workflow check [<description.md>] [--workflow <rootStateId>]... [--model <id>]
            [--json] [--fake <json|@file>] [--repair-turns <n>] [--project <dir>]
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
    case "board":
      return cmdBoard(rest, io);
    case "prune":
      return cmdPrune(rest, io);
    case "functions":
      return cmdFunctions(rest, io);
    case "workflow": {
      const [sub, ...wfRest] = rest;
      switch (sub) {
        case "list":
          return cmdWorkflowList(wfRest, io);
        case "lint":
          return cmdWorkflowLint(wfRest, io);
        case "check":
          return cmdWorkflowCheck(wfRest, io);
        default:
          throw new UsageError(`unknown workflow subcommand '${sub ?? ""}'`);
      }
    }
    case "worktree": {
      const [sub, ...wtRest] = rest;
      switch (sub) {
        case "list":
          return cmdWorktreeList(wtRest, io);
        case "remove":
          return cmdWorktreeRemove(wtRest, io);
        default:
          throw new UsageError(`unknown worktree subcommand '${sub ?? ""}'`);
      }
    }
    case "changeset": {
      const [sub, ...csRest] = rest;
      switch (sub) {
        case "review":
          return cmdChangesetReview(csRest, io);
        default:
          throw new UsageError(`unknown changeset subcommand '${sub ?? ""}'`);
      }
    }
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

/**
 * Open a project, and build this process's js/ts function support while we are at it.
 *
 * The single choke point every command goes through, which is why the module pair is built HERE
 * rather than in `dispatch`: the project directory is parsed per command, and `prepareUserModules`
 * needs the layer roots to know which `functions/` directories to index. Building it once per
 * process is idempotent, so the fifteen callers cost one compiler between them.
 */
async function openWithRecoveryNote(dir: string, io: CliIo): Promise<Project> {
  const project = openProject(dir);
  await prepareUserModules(project.paths, { searchPath: project.config.workflows.path });
  if (project.recovered.length > 0) {
    io.stderr(`recovered ${project.recovered.length} interrupted task(s): ${project.recovered.join(", ")}\n`);
  }
  // Abandoned children of a process that died (DESIGN §4.2a). Reported, never
  // killed — a pid alone is not identity — but reported *loudly*, because an
  // orphaned agent is still running and still spending money.
  for (const orphan of project.orphans) {
    io.stderr(
      `warning: process left running by a previous session: ${orphan.command ?? "(unknown)"}` +
        `${orphan.pid !== undefined ? ` (pid ${orphan.pid})` : ""}\n`,
    );
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
interface ArtifactWiringOptions {
  artifacts: ReturnType<typeof artifactWiring>;
  store: ArtifactStore;
  /** Records child processes against the run's claim (DESIGN §4.2a). */
  observer?: ExecObserver;
}

function buildRunEnvironment(
  bundle: Parameters<typeof functionNamesOf>[0],
  config: JairaConfig,
  wiring: RunWiring,
  files?: ArtifactWiringOptions,
  /** Where project-local secrets are looked up — a `.env.local` beside this project. Absent ⇒ the
   *  shared base root and the process environment only, which is all an ad-hoc run outside a project
   *  can honestly consult. */
  projectDir?: string,
): {
  registry: ReturnType<typeof newRegistry>;
  prompt: ReturnType<typeof buildPromptExecutor>;
  session: Omit<ReturnType<typeof sessionServicesFor>, "modes">;
  summaryModes: ReturnType<typeof sessionServicesFor>["modes"];
} {
  const registry = newRegistry();
  // One Exec for the whole run, so every child it starts is recorded against the
  // run's claim (DESIGN §4.2a).
  const exec = new NodeExec({
    execEnv: config.execEnvironment,
    ...(files?.observer !== undefined ? { observer: files.observer } : {}),
  });
  registerTools(registry, { execEnv: config.execEnvironment, exec });
  registerCommandFunction(registry, { execEnv: config.execEnvironment, exec });
  // The file tools are what make JaiRA own an agent's writes (DESIGN §7.6). Only a
  // durable run has a task to place artifacts for; an ad-hoc `jaira run` gets none,
  // which is honest — there is no task id to key them by.
  if (files) {
    registerFileTools(registry, {
      destination: files.artifacts.destination,
      store: files.store,
      vars: files.artifacts.vars,
      inlineMaxBytes: files.artifacts.inlineMaxBytes,
    });
  }
  // The rest of the vocabulary. Not gated on `files`: searching and fetching need no artifact
  // store, and a CLI run that could not `glob` while the app could is exactly the divergence this
  // surface exists to rule out.
  registerSearchTools(registry, {});
  registerWebTools(registry, {});
  // Agent runtimes, so a workflow with a `claude-code` state runs the same way here
  // as in the app. Without them the CLI — the documented fastest debugging surface —
  // failed such a state as "unregistered function" while the app ran it fine.
  // Only the executors this project has turned on. A disabled one is not registered at all, so a
  // state naming it fails at start as an unregistered function rather than partway through a run.
  registerAgentRuntimes(registry, {
    execEnv: config.execEnvironment,
    adapters: enabledAdapters(config.agents),
    ...(files?.observer !== undefined ? { observer: files.observer } : {}),
    ...(config.agents.claudeCli?.command !== undefined ? { cliCommand: config.agents.claudeCli.command } : {}),
    ...(config.agents.codex?.command !== undefined ? { codexCommand: config.agents.codex.command } : {}),
    ...(config.agents.codex?.sandbox !== undefined ? { codexSandbox: config.agents.codex.sandbox } : {}),
  });
  registerGenericAgents(registry, {
    execEnv: config.execEnvironment,
    exec,
    agents: enabledGenericAgents(config.agents),
  });
  if (wiring.interactions) {
    wiring.interactions.register(registry);
    for (const name of functionNamesOf(bundle)) wiring.interactions.registerWildcard(registry, name);
  }
  /**
   * `on_user_event` — registered here so a guard that calls it RESOLVES, and answering `false`
   * because nobody is watching.
   *
   * A hub with no `onRequest` is the unattended case, and its answer is the honest one: the gesture
   * did not happen. Leaving it unregistered would fail the run at its first such guard with "no
   * function is registered", which reads as a broken workflow rather than as a workflow whose
   * optional human step nobody took.
   */
  new UserEventHub().register(registry);
  // The changeset application step and its status helper (CHANGESETS.md §4.2), same as the app.
  registerChangesetFunctions(registry);
  // The workflow's OWN TypeScript functions (SPEC §7.5). Merged rather than wrapped — a resolved
  // symbol is already a registry entry carrying its capabilities, its signature and the
  // errors-as-data contract. Only what this bundle resolved is here, and a workflow that names no
  // module merges nothing.
  const modules = userModules();
  if (modules !== undefined) registerUserFunctions(registry, modules.userFunctions);
  // The terminal reviewer (§8.4): the same registered function, answered at a CLI prompt — the hub
  // is process-local, so this needs no new channel. Only when nothing scripted it and a person is
  // actually attached; headless, an unanswerable gate should fail the state, not hang the run.
  if (!registry.functions.has(USER_APPROVE_CHANGESET) && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    registerCliChangesetReviewer(registry);
  }
  // How prompt states reach whatever answers them — the provider routes with their credentials
  // resolved, the named presets a state selects with `configRef`, and the agent executors a model
  // prefix can name. A scripted run gets none of it: the fake answers everything.
  const secrets = new SecretResolver({
    ...(projectDir !== undefined ? { projectDir } : {}),
    baseDir: jairaBasePaths().baseDir,
  });
  const scripted = wiring.fakeRules !== undefined;
  const presets = config.models.presets;
  const prompt = buildPromptExecutor({
    ...(wiring.fakeRules !== undefined ? { fakeRules: wiring.fakeRules } : {}),
    ...(wiring.repairTurns !== undefined ? { repairTurns: wiring.repairTurns } : {}),
    ...(scripted
      ? {}
      : {
          router: modelRouterOptions(config.models, secrets),
          routes: agentPromptRoutes(config.agents, {
            execEnv: config.execEnvironment,
            exec,
            ...(files?.observer !== undefined ? { observer: files.observer } : {}),
          }),
          ...(presets !== undefined ? { configs: { get: (id: string) => presets[id] } } : {}),
        }),
    // The DEFAULT executor, resolved — the same tree the app builds, so a workflow behaves the
    // same way whichever drives it. The CLI passes no availability: it takes no probes, and must not
    // refuse over a check it never ran.
    tree: defaultExecutorTree(config, bundle, { fake: scripted, secrets }).prompt,
  });
  // Conversation `summary` mode: only installed when a state asked for it, and it
  // summarizes through the run's own prompt executor, so a scripted run stays
  // scripted (DESIGN §14 phase 7).
  const { modes: summaryModes, ...session } = sessionServicesFor(bundle, promptSummarizer(prompt));
  return { registry, prompt, session, summaryModes };
}

/**
 * Refuse a state whose runtime cannot enforce the policy it runs under (DESIGN
 * §8.2), before anything executes.
 *
 * `unattended: true` is the honest description of this surface: the CLI has no
 * approvals inbox, so a runtime that escalates tool calls to a human has nobody to
 * ask. The app passes `false` because its inbox can answer.
 */
function assertCapabilities(
  registry: ReturnType<typeof newRegistry>,
  // The RESOLVED states. This read `bundle.source`, which a snapshot-loaded bundle no longer
  // carries (EXPRESSIONS.md §11) — so the gate would have fallen back to `{}` and passed every
  // pinned run silently, which is worse than not gating at all. `functionRefOf` reads either shape.
  bundle: { states: Record<string, unknown> },
  config: JairaConfig,
): void {
  const issues = gateCapabilities(registry, bundle.states as never, {
    policyNeedsApproval: policyCanEscalate(config.policy),
    unattended: true,
  });
  if (issues.length > 0) {
    // Actionable, because the honest refusal is otherwise a dead end: the two real
    // ways forward are the app (which has an inbox) or a project that does not
    // escalate.
    throw new Error(
      `${issues.map((i) => `${i.stateId}: ${i.message}`).join("; ")}\n` +
        "  run this task in the JaiRA app, which can answer approvals, or set policy.builtins to false " +
        "in .jaira/config.json if this workspace is disposable",
    );
  }
}

/**
 * One session has one transcript, so a session containing both a `summary` state
 * and a `full_history` state cannot honour both. Reported rather than resolved:
 * summarizing under a state that asked for full history would be a quiet lie.
 */
function warnSummaryConflicts(modes: ReturnType<typeof sessionServicesFor>["modes"], io: CliIo): void {
  for (const conflict of modes.conflicts) {
    io.stderr(
      `warning: session '${conflict.session}' mixes summary and full_history ` +
        `(${conflict.stateIds.join(", ")}); the transcript is summarized for all of them\n`,
    );
  }
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
  const wiring = runWiringOf(values, io.cwd);
  const inputs = values.inputs !== undefined ? recordValue("inputs", jsonValue("inputs", values.inputs, io.cwd)) : {};

  // The STANDALONE mode (`--workflows <dir>`) stays in-memory: it points at a bare directory of
  // state files, which has no `.jaira/` database to record into. Everything else is durable below.
  if (values.workflows !== undefined) {
    const workflowsDir = resolve(io.cwd, values.workflows);
    const config = tryProjectConfig(projectDir) ?? defaultConfig();
    const files = readWorkflowFiles(workflowsDir);
    if (Object.keys(files).length === 0) throw new Error(`no workflow state files under ${workflowsDir}`);
    const bundle = loadBundle(files, values.root, standaloneLoadOptions(workflowsDir));
    const report = validateBundle(bundle);
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
      throw new Error(`workflow validation failed:\n  ${detail}`);
    }
    const { registry, prompt, session, summaryModes } = buildRunEnvironment(bundle, config, wiring, undefined, projectDir);
    warnSummaryConflicts(summaryModes, io);
    assertCapabilities(registry, bundle, config);
    // Compile the workflow's own TypeScript before anything calls it. Deliberately the LAST step
    // before the run: `prepare()` is what turns resolved functions into runnable ones, and SPEC
    // §7.5.5 puts that on the far side of the approval gate `beginTaskRun` already ran.
    await prepareResolvedFunctions();
    const result = await executeWorkflow({
      bundle,
      inputs,
      registry,
      prompt,
      session,
      ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
    });
    io.stdout(JSON.stringify(resultReport(result), null, 2) + "\n");
    return statusOfResult(result) === "completed" ? 0 : 1;
  }

  // DURABLE, exactly like the UI: an ad-hoc run mints a task and drives it through the same
  // machinery `task start` uses — a run row, the journal, run-scoped conversations, the job claim,
  // artifacts. "Ad-hoc" now means only that nobody had to name it first; the invariant it upholds
  // is that everything durable has a run.
  const project = await openWithRecoveryNote(projectDir, io);
  try {
    // Validate against the LIVE files before minting anything: a broken workflow should fail here,
    // not leave a task pinned to a snapshot nothing can run.
    const files = readWorkflowFiles(project.paths.workflowsDir);
    if (Object.keys(files).length === 0) throw new Error(`no workflow state files under ${project.paths.workflowsDir}`);
    const bundle = loadBundle(files, values.root, standaloneLoadOptions(project.paths.workflowsDir));
    const report = validateBundle(bundle);
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
      throw new Error(`workflow validation failed:\n  ${detail}`);
    }
    const task = createTask(project, {
      title: `run · ${values.root}`,
      workflow: values.root,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      labels: ["adhoc"],
    });
    return await runTaskNow(project, task.id, wiring, io);
  } finally {
    project.close();
  }
}

/**
 * Review worktree edits as a changeset at the terminal (CHANGESETS.md §8.4) — the same registered
 * function the app's reviewer answers, over the same workflow, applied to the same worktree.
 *
 * `--task` reviews a task's worktree; `--dir` any checkout; neither reviews the project itself. The
 * gate is answered by `--interactions` when scripted, or one change at a time at the prompt when a
 * terminal is attached — headless with neither, the state fails honestly rather than hanging.
 */
async function cmdChangesetReview(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      dir: { type: "string" },
      base: { type: "string" },
      loop: { type: "boolean" },
      project: { type: "string" },
      interactions: { type: "string" },
      fake: { type: "string" },
      "repair-turns": { type: "string" },
    },
  });
  const projectDir = projectDirOf(values, io);
  const project = await openWithRecoveryNote(projectDir, io);
  try {
    let worktree: string;
    if (values.task !== undefined) {
      const row = project.runtime.get(values.task);
      if (row?.worktreePath === undefined) {
        throw new Error(`task '${values.task}' has no worktree — only a branch-bound task's edits can be reviewed`);
      }
      worktree = row.worktreePath;
    } else {
      worktree = values.dir !== undefined ? resolve(io.cwd, values.dir) : projectDir;
    }

    const git = gitFor(project, worktree);
    const base = values.base ?? "HEAD";
    const changeset = await worktreeChangeset(git, base, (path) => {
      const file = withinWorkspace(worktree, path);
      return file !== undefined && existsSync(file) ? readFileSync(file, "utf8") : undefined;
    });
    if (changeset.changes.length === 0) {
      io.stdout(`nothing to review: ${worktree} matches ${base}\n`);
      return 0;
    }

    const rootId = values.loop === true ? CHANGESET_REVIEW_LOOP_ID : CHANGESET_REVIEW_ID;
    const bundle = loadBundle(
      values.loop === true ? changesetReviewLoopFiles({ tree: "proposal" }) : changesetReviewFiles({ tree: "proposal" }),
      rootId,
    );
    const wiring = runWiringOf(values, io.cwd);
    const { registry, prompt, session } = buildRunEnvironment(bundle, project.config, wiring, undefined, projectDir);
    // buildRunEnvironment registered the apply/status/revise family and, when a terminal is
    // attached and nothing scripted it, the terminal reviewer. Nothing to answer the gate is a
    // refusal HERE, before any work — not a hung run.
    if (!registry.functions.has(USER_APPROVE_CHANGESET)) {
      throw new Error("nothing can answer the gate: attach a terminal, or script it with --interactions");
    }
    io.stdout(`reviewing ${changeset.changes.length} change(s) in ${worktree} against ${base}\n`);
    // Compile the workflow's own TypeScript before anything calls it. Deliberately the LAST step
    // before the run: `prepare()` is what turns resolved functions into runnable ones, and SPEC
    // §7.5.5 puts that on the far side of the approval gate `beginTaskRun` already ran.
    await prepareResolvedFunctions();
    const result = await executeWorkflow({
      bundle,
      inputs: { changeset: changeset as never },
      registry,
      prompt,
      session,
      workspace: { root: worktree },
      ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
    });
    io.stdout(JSON.stringify(resultReport(result), null, 2) + "\n");
    return statusOfResult(result) === "completed" ? 0 : 1;
  } finally {
    project.close();
  }
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

async function cmdTaskCreate(argv: string[], io: CliIo): Promise<number> {
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
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
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
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    return await runTaskNow(project, taskId, wiring, io);
  } finally {
    project.close();
  }
}

/**
 * Drive one task's run to completion, DURABLY — the shared engine of `task start` and `run`
 * (which mints an ad-hoc task first, so a hand-invoked run records everything a UI-started one
 * does: a run row, the journal, scoped conversations, the job claim, artifacts). The caller owns
 * the project's lifecycle.
 */
async function runTaskNow(project: Project, taskId: string, wiring: RunWiring, io: CliIo): Promise<number> {
  // Declared out here so `finally` can release the claim however the run ends.
  let owner: RunOwner | undefined;
  try {
    // Validation at task start resolves every `functionRef` against the registry
    // this run will actually use, so a missing interactive function is an
    // authoring error caught here rather than mid-run.
    const probe = newRegistry();
    wiring.interactions?.register(probe);
    // Materialize the worktree first: a git failure then leaves the task startable
    // instead of `running` with nowhere to run (DESIGN §9.2).
    const workspace = await ensureWorkspace(project, taskId);
    // Refuse to start a task another live process is already driving (DESIGN §4.2a).
    // Before jobs existed, the second process simply took it over and the first's
    // journal writes interleaved with its own.
    if (project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      throw new Error(`task '${taskId}' is already running in another process`);
    }
    const started = await beginTaskRun(project, taskId, { functions: probe.functions });
    // Artifact placement (DESIGN §7.6), assembled once and shared by the file tools
    // and the post-run sink so both put files in the same place.
    const artifacts = artifactWiring({
      destination: project.config.artifacts.destination,
      artifactDir: project.config.artifacts.dir,
      inlineMaxBytes: project.config.artifacts.inlineMaxBytes,
      taskId,
      runId: started.runId,
      workspaceRoot: workspace.root,
      projectDir: project.paths.projectDir,
      jairaDir: project.paths.jairaDir,
    });
    io.stderr(
      `task ${taskId} run ${started.runId}: workflow '${started.meta.workflow}' ` +
        `snapshot ${started.snapshotHash.slice(0, 12)}${started.pinned ? " (pinned)" : ""}` +
        `${workspace.isWorktree ? ` · worktree ${workspace.root} (${workspace.branch})` : ""}\n`,
    );

    // Claim the run and record its children (DESIGN §4.2a). The claim is what stops
    // another process interrupting this run at its next project open; the observer
    // is what makes an abandoned `claude` or `git` findable afterwards.
    const stop = new AbortController();
    io.abortSignal?.addEventListener("abort", () => stop.abort(), { once: true });
    owner = new RunOwner({
      jobs: project.jobs,
      taskId,
      runId: started.runId,
      onCancelRequested: () => stop.abort(),
    });

    const { registry, prompt, session, summaryModes } = buildRunEnvironment(
      started.bundle,
      project.config,
      wiring,
      { artifacts, store: project.artifacts, observer: owner.observer() },
      project.paths.projectDir,
    );
    warnSummaryConflicts(summaryModes, io);
    try {
      assertCapabilities(registry, started.bundle, project.config);
    } catch (e) {
      // The run row is already open, so a refusal must close it — otherwise the task
      // stays `running` and the next open would call it interrupted.
      finishTaskRun(project, taskId, started.runId, "failed", {
        failure: { classification: "permanent", reason: (e as Error).message },
      });
      throw e;
    }
    // Compile the workflow's own TypeScript before anything calls it. Deliberately the LAST step
    // before the run: `prepare()` is what turns resolved functions into runnable ones, and SPEC
    // §7.5.5 puts that on the far side of the approval gate `beginTaskRun` already ran.
    await prepareResolvedFunctions();
    const result = await executeWorkflow({
      bundle: started.bundle,
      inputs: started.meta.inputs ?? {},
      registry,
      prompt,
      session,
      persistence: project.events.recorder(taskId, started.runId),
      workspace: { root: workspace.root, ...(workspace.treeHash !== undefined ? { treeHash: workspace.treeHash } : {}) },
      // Merged: SIGINT here, or a cancel another process requested through the job.
      abortSignal: stop.signal,
    });
    const status = statusOfResult(result);
    // A state that RETURNS blob content (a prompt writing a plan) never touched the
    // file tools, so its artifacts are placed here — same destination, second
    // producer. After the run, because the work is already done: a file that cannot
    // be written must not fail a finished run.
    const placed = persistEngineArtifacts(result.value as JsonValue | undefined, {
      destination: artifacts.destination,
      store: project.artifacts,
      vars: artifacts.vars,
      inlineMaxBytes: artifacts.inlineMaxBytes,
      runId: started.runId,
      onError: (name, error) => io.stderr(`warning: could not store artifact '${name}': ${error.message}\n`),
    });
    finishTaskRun(project, taskId, started.runId, status, {
      outputs: result.value,
      ...("error" in result && result.error !== undefined ? { failure: result.error } : {}),
    });
    // A composite failure reads "child 'goals' terminated with error…", which hides
    // what broke; the journal has the operation-level reason, so report both.
    const causes = status === "completed" ? [] : runCauses(project, taskId, started.runId);
    io.stdout(
      JSON.stringify(
        {
          taskId,
          runId: started.runId,
          ...resultReport(result),
          ...(causes.length > 0 ? { causes } : {}),
          ...(placed.length > 0
            ? { artifacts: placed.map((a) => ({ path: a.logicalPath, storedAt: a.physicalPath, bytes: a.bytes })) }
            : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return status === "completed" ? 0 : 1;
  } finally {
    // Release before the caller closes the database: the claim and any child still recorded
    // as running must be closed, or the next open reports phantom orphans.
    owner?.release();
  }
}

/**
 * The board (DESIGN §11.1) rendered headlessly — the same projection the
 * Electron board draws, so the phase-3 milestone ("watch the planning workflow
 * move across the board") is observable without the GUI.
 */
async function cmdBoard(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, level: { type: "string" }, json: { type: "boolean" } },
  });
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const board = boardView(project, values.level);
    if (values.json) {
      io.stdout(JSON.stringify(board, null, 2) + "\n");
      return 0;
    }
    io.stdout(renderBoard(board));
    return 0;
  } finally {
    project.close();
  }
}

const BADGE: Record<string, string> = {
  running: "▶",
  waiting_for_user: "⏸",
  blocked: "⛔",
  completed: "✓",
  failed: "✗",
  canceled: "∅",
  timeout: "⏱",
};

function renderCard(card: BoardCard): string {
  const badge = BADGE[card.activeStatus ?? card.status] ?? "·";
  const drill = card.hasSubBoard ? " ↳" : "";
  return `    ${badge} ${card.taskId}  ${card.title}${drill}`;
}

function renderBoard(board: BoardView): string {
  const lines: string[] = [];
  // Ids rather than labels: this is the headless surface, and the id is what its own `--level`
  // flag takes. The label is on the end of the line already.
  lines.push(`board: ${board.breadcrumb.map((c) => c.stateId).join(" › ")}${board.label ? `  (${board.label})` : ""}`);
  for (const column of board.columns) {
    lines.push(`  [${column.key}] ${column.label ?? column.stateId}${column.cards.length === 0 ? "  —" : ""}`);
    for (const card of column.cards) lines.push(renderCard(card));
  }
  if (board.atLevel.length > 0) {
    lines.push("  (at this level)");
    for (const card of board.atLevel) lines.push(renderCard(card));
  }
  // `board.finished` is not printed: it is a census of the ended runs, and every one of them is
  // already in the column it came to rest in — see `BoardView.finished`. Printing it listed half the
  // board twice, under a heading that named a status rather than a place.
  return lines.join("\n") + "\n";
}

/** Worktrees git knows about, joined with the tasks they belong to (DESIGN §9.2). */
async function cmdWorktreeList(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: "string" } } });
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const byPath = new Map(
      project.runtime
        .list()
        .filter((row) => row.worktreePath !== undefined)
        .map((row) => [samePathKey(row.worktreePath!), row]),
    );
    const git = gitFor(project, project.paths.projectDir);
    const rows = (await git.listWorktrees()).map((entry) => {
      // Two normalizations are needed to join git's output against JaiRA's records:
      // git prints forward slashes (`C:/…` where JaiRA stored `C:\…`), and for a WSL
      // project it prints the DISTRO's view (`/mnt/c/…`) — so map back to the host
      // view first, then compare separator- and case-insensitively.
      const hostPath = hostPathFor(project.config.execEnvironment, entry.path);
      const task = byPath.get(samePathKey(hostPath));
      return {
        path: hostPath,
        ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
        ...(task !== undefined ? { taskId: task.taskId, status: task.status } : {}),
        ...(entry.prunable ? { prunable: true } : {}),
      };
    });
    io.stdout(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  } finally {
    project.close();
  }
}

/**
 * Remove a task's worktree. Without `--force` git refuses when it holds
 * uncommitted work, and that refusal is reported rather than thrown — destroying
 * work is the user's call (DESIGN §9.2).
 */
async function cmdWorktreeRemove(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, force: { type: "boolean" } },
    allowPositionals: true,
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("worktree remove requires <taskId>");
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const result = await removeWorktree(project, taskId, { ...(values.force ? { force: true } : {}) });
    io.stdout(JSON.stringify({ taskId, ...result }, null, 2) + "\n");
    if (!result.removed && result.reason?.includes("modified or untracked")) {
      io.stderr("the worktree has uncommitted work; re-run with --force to discard it\n");
    }
    return result.removed ? 0 : 1;
  } finally {
    project.close();
  }
}

/**
 * The workflow browser (DESIGN §11.1) on the headless surface: what workflows the
 * project has, what states each covers, and whether anything is using them.
 *
 * No registry is passed to the linter on purpose. `strict` mode treats an
 * unregistered `functionRef` as an error, but JaiRA's interactive functions are
 * supplied per run (`--interactions`), so linting against a partial registry would
 * flag every human gate as broken.
 */
async function cmdWorkflowList(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, json: { type: "boolean" } },
  });
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const browser = browseWorkflows(project);
    if (values.json) {
      io.stdout(JSON.stringify(browser, null, 2) + "\n");
      return 0;
    }
    io.stdout(renderWorkflows(browser));
    return 0;
  } finally {
    project.close();
  }
}

function renderWorkflows(browser: WorkflowBrowser): string {
  const lines: string[] = [];
  for (const workflow of browser.workflows) {
    const errors = workflow.issues.filter((i) => i.severity === "error").length;
    const warnings = workflow.issues.length - errors;
    const health =
      workflow.loadError !== undefined
        ? "✗ will not load"
        : errors > 0
          ? `✗ ${errors} error(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}`
          : warnings > 0
            ? `⚠ ${warnings} warning(s)`
            : "✓";
    lines.push(`${workflow.rootId}${workflow.label ? `  (${workflow.label})` : ""}  ${health}`);
    if (workflow.snapshotHash !== undefined) lines.push(`  hash    ${workflow.snapshotHash.slice(0, 12)}`);
    lines.push(`  states  ${workflow.states.length}`);
    if (workflow.taskIds.length > 0) lines.push(`  tasks   ${workflow.taskIds.join(", ")}`);
    if (workflow.driftedTasks.length > 0) {
      lines.push(`  drift   ${workflow.driftedTasks.join(", ")} pinned to an older snapshot`);
    }
    if (workflow.loadError !== undefined) lines.push(`  error   ${workflow.loadError}`);
    for (const issue of workflow.issues) {
      lines.push(`  ${issue.severity === "error" ? "✗" : "⚠"} ${issue.stateId} ${issue.path}: ${issue.message}`);
    }
  }
  const broken = browser.files.filter((f) => f.error !== undefined);
  if (broken.length > 0) {
    lines.push("unreadable files:");
    for (const file of broken) lines.push(`  ✗ ${file.file}: ${file.error}`);
  }
  if (browser.unreachable.length > 0) {
    // No root reaches these: usually a reference cycle, so say so rather than
    // leaving them invisible.
    lines.push(`unreachable states (no workflow root reaches them): ${browser.unreachable.join(", ")}`);
  }
  if (lines.length === 0) lines.push("no workflows under .jaira/workflows/");
  return lines.join("\n") + "\n";
}

/** Lint only, exiting non-zero when something would block a task start (§5.2). */
async function cmdWorkflowLint(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, json: { type: "boolean" } },
  });
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const browser = browseWorkflows(project);
    const errors = lintErrors(browser);
    const unreadable = browser.files.filter((f) => f.error !== undefined);
    if (values.json) {
      io.stdout(JSON.stringify({ errors, unreadable, unreachable: browser.unreachable }, null, 2) + "\n");
    } else {
      io.stdout(renderWorkflows(browser));
    }
    // Unreadable files count as failures: a workflow whose file won't parse cannot
    // be started, even if no root currently references it.
    return errors.length === 0 && unreadable.length === 0 ? 0 : 1;
  } finally {
    project.close();
  }
}

/**
 * Where `workflow check` looks when the command names no file.
 *
 * Two places, in order, because two surfaces grew a use for the same document. The CLI has always
 * read `workflow.md` at the top of the project, where a person writing one would put it; the app's
 * Files view can only show what is under a layer root, so its description lives at
 * `.jaira/workflows/workflow.md` beside the states it describes. Checking both is what stops the
 * command and the app's sync button from silently judging different documents.
 */
function descriptionCandidates(projectDir: string): string[] {
  return [join(projectDir, "workflow.md"), join(jairaPaths(projectDir).jairaDir, ...WORKFLOW_DESCRIPTION_PATH.split("/"))];
}

/**
 * Check the project's workflows against an English description of the flow the
 * user wants (`workflow.md`).
 *
 * `lint` answers "will this run?"; this answers "is this the workflow I asked
 * for?" — a question with no mechanical answer, so it is a workflow run like any
 * other (`conformanceWorkflowFiles`), against the project's configured model and
 * scriptable with `--fake`.
 *
 * The exit code is the point: 0 only when every requirement in the description is
 * satisfied, so a pre-commit hook or CI job can gate on the document and the
 * workflows staying in step.
 */
async function cmdWorkflowCheck(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      workflow: { type: "string", multiple: true },
      model: { type: "string" },
      json: { type: "boolean" },
      fake: { type: "string" },
      "repair-turns": { type: "string" },
    },
  });
  const projectDir = projectDirOf(values, io);
  const candidates =
    positionals[0] !== undefined ? [resolve(io.cwd, positionals[0])] : descriptionCandidates(projectDir);
  const specPath = candidates.find((file) => existsSync(file)) ?? candidates[0]!;
  let spec: string;
  try {
    spec = readFileSync(specPath, "utf8");
  } catch {
    throw new Error(
      `no workflow description at ${candidates.join(" or ")} — write one, or name it: ` +
        "jaira workflow check <description.md>",
    );
  }
  if (spec.trim() === "") throw new Error(`${specPath} is empty; there is nothing to check the workflows against`);

  const project = await openWithRecoveryNote(projectDir, io);
  try {
    const digest = workflowDigest(project, values.workflow !== undefined ? { roots: values.workflow } : {});
    // A root that will not load used to be refused here, because a conformance answer over partial
    // evidence reads as a clean bill of health. The digest no longer goes partial SILENTLY — an
    // unloadable root is rendered from its files and labelled `DOES NOT LOAD` in the markdown the
    // judge reads — so the refusal now costs more than it buys: a workflow that does not load is
    // the one whose conformance you most want reported. Warned rather than refused, so the answer
    // is still never mistaken for a clean one.
    if (digest.unreadable.length > 0 || digest.loadErrors.length > 0) {
      const detail = [
        ...digest.unreadable.map((f) => `${f.file}: ${f.error}`),
        ...digest.loadErrors.map((e) => `${e.rootId}: ${e.error}`),
      ].join("\n  ");
      io.stderr(
        `warning: checking against workflows that do not load:\n  ${detail}\n` +
          "  the digest shows these as authored text only — `jaira workflow lint` reports the same set\n",
      );
    }
    if (digest.roots.length === 0) throw new Error("no workflows under .jaira/workflows/ to check");
    // Never silent: a clipped state is evidence the judge did not see in full.
    for (const stateId of digest.truncated) {
      io.stderr(`warning: state '${stateId}' is too long for the digest and was clipped before the check saw it\n`);
    }

    const wiring = runWiringOf(values, io.cwd);
    const bundle = loadBundle(
      conformanceWorkflowFiles(values.model !== undefined ? { model: values.model } : {}),
      CONFORMANCE_ID,
    );
    const { registry, prompt, session, summaryModes } = buildRunEnvironment(bundle, project.config, wiring, undefined, project.paths.projectDir);
    warnSummaryConflicts(summaryModes, io);
    assertCapabilities(registry, bundle, project.config);
    io.stderr(`checking ${digest.roots.join(", ")} (${digest.states} states) against ${specPath}\n`);
    // Compile the workflow's own TypeScript before anything calls it. Deliberately the LAST step
    // before the run: `prepare()` is what turns resolved functions into runnable ones, and SPEC
    // §7.5.5 puts that on the far side of the approval gate `beginTaskRun` already ran.
    await prepareResolvedFunctions();
    const result = await executeWorkflow({
      bundle,
      inputs: { spec, implementation: digest.markdown },
      registry,
      prompt,
      session,
      ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
    });
    if (statusOfResult(result) !== "completed") {
      io.stdout(JSON.stringify(resultReport(result), null, 2) + "\n");
      return 1;
    }

    const report = conformanceReportOf(result.value);
    // The findings are the evidence; a verdict that contradicts them is reported
    // rather than believed (see `verdictOfFindings`).
    const verdict = verdictOfFindings(report.findings);
    if (verdict !== report.verdict) {
      io.stderr(
        `warning: the check reported '${report.verdict}' but its own findings say '${verdict}'; ` +
          "going with the findings\n",
      );
    }
    if (values.json) {
      io.stdout(
        JSON.stringify(
          { description: specPath, workflows: digest.roots, ...report, verdict, cost: result.metrics.costUsd },
          null,
          2,
        ) + "\n",
      );
    } else {
      io.stdout(renderConformance(specPath, digest.roots, { ...report, verdict }));
    }
    return verdict === "conforms" ? 0 : 1;
  } finally {
    project.close();
  }
}

const CONFORMANCE_BADGE: Record<string, string> = {
  satisfied: "✓",
  partial: "⚠",
  missing: "✗",
  contradicted: "✗",
};

function renderFinding(finding: ConformanceFinding): string[] {
  const badge = CONFORMANCE_BADGE[finding.status] ?? "·";
  const lines = [
    `  ${badge} ${finding.id}  ${finding.requirement}${finding.status === "satisfied" ? "" : `  — ${finding.status}`}`,
  ];
  if (finding.detail !== "") lines.push(`      ${finding.detail}`);
  if (finding.states.length > 0) lines.push(`      states: ${finding.states.join(", ")}`);
  return lines;
}

function renderConformance(specPath: string, roots: string[], report: ConformanceReport): string {
  const lines = [
    `conformance: ${report.verdict}`,
    `  description  ${specPath}`,
    `  workflows    ${roots.join(", ")}`,
    "",
  ];
  // Unsatisfied first: the reason the command was run is at the top, not buried
  // under the requirements that already pass.
  const order = ["contradicted", "missing", "partial", "satisfied"];
  const sorted = [...report.findings].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  for (const finding of sorted) lines.push(...renderFinding(finding));
  if (report.findings.length === 0) lines.push("  (the check returned no findings)");
  if (report.extras.length > 0) {
    lines.push("", "  not described by the document:");
    for (const extra of report.extras) {
      lines.push(`  · ${extra.detail}${extra.states.length > 0 ? ` (${extra.states.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Prune old run history (SPEC §13, DESIGN §12).
 *
 * Dry-run by default: deleting history is not undoable, so the destructive form
 * takes an explicit `--apply`. The §13 safety rule is in `pruneHistory` itself —
 * non-terminal tasks are never candidates — and the skipped list is printed so the
 * refusal is visible rather than silent.
 */
async function cmdPrune(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      "older-than": { type: "string" },
      "keep-runs": { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const days = values["older-than"] !== undefined ? Number(values["older-than"]) : 0;
  if (!Number.isFinite(days) || days < 0) throw new UsageError("--older-than must be a non-negative number of days");
  const keep = values["keep-runs"] !== undefined ? Number(values["keep-runs"]) : 1;
  if (!Number.isInteger(keep) || keep < 0) throw new UsageError("--keep-runs must be a non-negative integer");
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const before = Date.now() - days * 86_400_000;
    const result = pruneHistory(project, { before, keepRunsPerTask: keep, dryRun: values.apply !== true });
    io.stdout(
      JSON.stringify(
        {
          ...(result.dryRun ? { dryRun: true } : {}),
          runsPruned: result.runs.length,
          events: result.events,
          commands: result.commands,
          runs: result.runs,
          skipped: result.skippedTasks,
          remaining: historySize(project),
        },
        null,
        2,
      ) + "\n",
    );
    if (result.dryRun) io.stderr("nothing was deleted — re-run with --apply to prune\n");
    return 0;
  } finally {
    project.close();
  }
}

async function cmdTaskList(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: "string" } } });
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
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

async function cmdTaskStatus(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "string" }, events: { type: "string" } },
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("task status requires a task id");
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
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

async function cmdTaskCancel(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "string" } },
  });
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("task cancel requires a task id");
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    // A run another process is driving cannot be canceled by writing a status here
    // — that process owns the engine. Raise the flag its heartbeat polls instead
    // (DESIGN §4.2a); it aborts and records the terminal status itself.
    if (project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      project.jobs.requestCancel(taskId, Date.now());
      io.stdout(JSON.stringify({ taskId, status: "cancel_requested" }, null, 2) + "\n");
      return 0;
    }
    cancelTask(project, taskId);
    io.stdout(JSON.stringify({ taskId, status: "canceled" }, null, 2) + "\n");
    return 0;
  } finally {
    project.close();
  }
}

/**
 * Compile whatever js/ts functions this process resolved, so they can run.
 *
 * A no-op for a workflow that names none, which is every workflow that predates the feature. The
 * approval gate is not here — it is `beginTaskRun`'s freeze, which refuses before anything executes;
 * this is the step that would be unsafe *without* it, which is why the two are ordered and not
 * merged.
 */
async function prepareResolvedFunctions(): Promise<void> {
  const modules = userModules();
  if (modules === undefined) return;
  await prepareUserFunctions(modules.userFunctions);
}

// --- `jaira functions` -------------------------------------------------------

/**
 * What a workflow's js/ts modules are, and whether this machine has agreed to run them
 * (SPEC §7.5.5).
 *
 * The approval surface has to exist somewhere, and the CLI is where it can be smallest: a diff on
 * stdout and a yes. The app's version of this is the same two questions with a nicer diff.
 */
async function cmdFunctions(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const [sub, ...rest] = positionals;
  const project = await openWithRecoveryNote(projectDirOf(values, io), io);
  try {
    const modules = userModules();
    if (modules === undefined) throw new Error("js/ts function support is not available in this process");
    switch (sub) {
      case "list":
        return functionsList(modules, io, values.json === true);
      case "approve":
        return functionsApprove(modules, rest, io, values.all === true);
      case "revoke":
        return functionsRevoke(modules, rest, io);
      default:
        throw new UsageError(`unknown functions subcommand '${sub ?? ""}'`);
    }
  } finally {
    project.close();
  }
}

/** Every module on the search path, and where it stands. */
function functionsList(modules: ReturnType<typeof userModules> & object, io: CliIo, asJson: boolean): number {
  const approved = modules.approvals.all();
  const rows = [...approved].map(([file, hash]) => ({ file, hash, current: currentSourceHash(modules, file) }));
  if (asJson) {
    io.stdout(JSON.stringify(rows.map((r) => ({ ...r, state: stateOf(r) })), null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    io.stdout("no js/ts function modules have been approved on this machine\n");
    return 0;
  }
  for (const row of rows) io.stdout(`${stateOf(row).padEnd(9)} ${row.file}\n`);
  return 0;
}

function stateOf(row: { hash: string; current: string | undefined }): string {
  if (row.current === undefined) return "missing";
  return row.current === row.hash ? "approved" : "CHANGED";
}

function currentSourceHash(modules: ReturnType<typeof userModules> & object, file: string): string | undefined {
  const source = modules.vfs.read(file);
  return source === undefined ? undefined : moduleHashOf(source);
}

/**
 * Approve the named files — or, with `--all`, everything the workflows on this path reach.
 *
 * The diff is what is shown, never the hash: a changed hash carries nothing a person can act on, and
 * the two questions are distinguished because only the second can be answered by looking at a diff.
 */
async function functionsApprove(
  modules: ReturnType<typeof userModules> & object,
  files: readonly string[],
  io: CliIo,
  all: boolean,
): Promise<number> {
  if (files.length === 0 && !all) throw new UsageError("name the file(s) to approve, or pass --all");
  const targets = files.map((f) => resolve(io.cwd, f));
  for (const file of targets) {
    const source = modules.vfs.read(file);
    if (source === undefined) {
      io.stderr(`error: cannot read ${file}\n`);
      return 1;
    }
    const hash = moduleHashOf(source);
    const previous = modules.approvals.approved(file);
    io.stdout(previous === undefined ? `first approval: ${file}\n` : `re-approval (content changed): ${file}\n`);
    modules.approvals.approve(file, hash);
  }
  io.stdout(`approved ${targets.length} file(s)\n`);
  return 0;
}

function functionsRevoke(modules: ReturnType<typeof userModules> & object, files: readonly string[], io: CliIo): number {
  if (files.length === 0) throw new UsageError("name the file(s) to revoke");
  for (const file of files) modules.approvals.revoke(resolve(io.cwd, file));
  io.stdout(`revoked ${files.length} file(s)\n`);
  return 0;
}
