/**
 * Remotes in a CLI run (decision 0004) — the same three things the app wires, for a run that has a
 * task to belong to.
 *
 *  - the five primitives (`remote_push`, `remote_open`, `remote_comment`, `remote_merge`,
 *    `remote_close`), with publishing (`functions.review_artifacts.publish`) asked AT THE TERMINAL when there is one and refused with
 *    a sentence when there is not;
 *  - `on_remote_event`, with a watcher that lives exactly as long as the run — a CLI run is a process
 *    that is alive while it waits, so it can hear the forge itself;
 *  - `review_artifacts.remote`: whatever answers the gate here (a script, or the terminal reviewer)
 *    is asked through the same two-door wrapper the app uses. A terminal cannot be answered from
 *    outside, so the forge is RACED against it, and a prompt the forge beat is withdrawn.
 *
 * Only the durable run gets any of this. `jaira run --workflows <dir>` and the other ad-hoc modes have
 * no task, so there is nowhere for a merge request to be remembered — the same reason they get no
 * file tools — and a workflow that reaches for a remote there fails as an unregistered function.
 */
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostFunction, type CapabilityRegistry, type FunctionInputs, type JsonValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import type { Project } from "@jaira/persistence";
import {
  Git,
  INTERACTIVE,
  PollingSource,
  REVIEW_ARTIFACTS,
  RemoteEventHub,
  RemoteWatcher,
  SecretResolver,
  forgeForHost,
  registerRemoteFunctions,
  reviewWithRemote,
  type Exec,
  type ForgeHttp,
  type PublishAnswer,
  type PublishRequest,
  type WatchTarget,
} from "@jaira/runtime";
import { FORGE_LABELS, changesetInputOf, mergeConfigDocuments, parseComponentConfig, parseConfig, resultOfSettlement, type Changeset } from "@jaira/shared";

export interface CliRemoteOptions {
  project: Project;
  taskId: string;
  taskTitle?: string;
  workspace: { root: string; isWorktree: boolean };
  exec: Exec;
  /** Whether a person is attached. Absent a terminal, the publish question is refused, not asked. */
  terminal?: { input: NodeJS.ReadableStream; output: { write(text: string): unknown } };
  /** A scripted run answers nothing at a terminal — and asks nothing there either. */
  scripted: boolean;
  http?: ForgeHttp;
  log: (message: string) => void;
}

/** Ask, at the terminal, whether this task may publish — saying what will be sent and as whom. */
async function askAtTerminal(terminal: NonNullable<CliRemoteOptions["terminal"]>, request: PublishRequest): Promise<PublishAnswer> {
  const forge = FORGE_LABELS[request.provider];
  terminal.output.write(
    `\nPush this review to ${forge.name} and open a ${forge.request}?\n` +
      `  to                 ${request.to}\n` +
      `  branch             ${request.branch} → ${request.target}\n` +
      `  commits as         ${request.commitsAs}\n` +
      (request.openedBy !== undefined ? `  request opened by  ${request.openedBy} (the ${forge.name} connection's token)\n` : ""),
  );
  const rl = createInterface({ input: terminal.input, output: terminal.output as NodeJS.WritableStream });
  try {
    const answer = (await rl.question("  [y]es  [a]lways for this project  [N]o, review here only: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes" ? "once" : answer === "a" || answer === "always" ? "always" : "no";
  } finally {
    rl.close();
  }
}

/** "Always for this project": `functions.review_artifacts.publish = "allow"` in the project's own settings. */
function grantProject(project: Project, log: (message: string) => void): void {
  try {
    const file = project.paths.settingsFile;
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      // No settings file yet is an empty layer.
    }
    const functions = (doc["functions"] ??= {}) as Record<string, unknown>;
    functions["review_artifacts"] = { ...((functions["review_artifacts"] ?? {}) as object), publish: "allow" };
    // Validated as it will be read — merged over the base — before anything is written.
    let base: unknown;
    try {
      base = JSON.parse(readFileSync(project.paths.base.settingsFile, "utf8"));
    } catch {
      base = undefined;
    }
    parseConfig(mergeConfigDocuments(base, doc) ?? {});
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  } catch (e) {
    log(`could not record the publish grant: ${(e as Error).message}`);
  }
}

export function wireRemotes(registry: CapabilityRegistry<WorkflowMetrics>, options: CliRemoteOptions): { dispose(): void } {
  const { project, taskId, workspace, exec } = options;
  const config = project.config;
  const secrets = new SecretResolver({ projectDir: project.paths.projectDir, baseDir: project.paths.base.baseDir });
  const forgeOptions = { secrets, ...(options.http !== undefined ? { http: options.http } : {}) };

  // What each parked gate is deciding, and who to tell when the forge settles it.
  const gates = new Map<string, { changeset?: Changeset; options: string[]; settle: (value: JsonValue) => void }>();

  const forges = new Map<string, ReturnType<typeof forgeForHost>>();
  const target: WatchTarget = {
    key: "cli",
    handles: project.remotes,
    settleAfter: config.functions.review_artifacts.settleAfter,
    // One provider per host for the life of the run: it remembers what cost a request to learn.
    provider: (host) => {
      let provider = forges.get(host);
      if (provider === undefined) forges.set(host, (provider = forgeForHost(config.integrations, host, forgeOptions)));
      return provider;
    },
  };
  const source = new PollingSource({ targets: () => [target], onError: (connection, error) => options.log(`could not check ${connection}: ${error.message}`) });
  const events = new RemoteEventHub({ onWaiting: () => source.kick() });
  const watcher = new RemoteWatcher({
    targets: () => [target],
    sources: [source],
    subjectOf: (_target, row) => {
      const gate = row.requestId !== undefined ? gates.get(row.requestId) : undefined;
      return gate === undefined ? undefined : { ...(gate.changeset !== undefined ? { changeset: gate.changeset } : {}), options: gate.options };
    },
    onSettled: (event) => {
      const result = resultOfSettlement(event.settlement, event.handle) as unknown as JsonValue;
      const gate = event.requestId !== undefined ? gates.get(event.requestId) : undefined;
      if (gate !== undefined) gate.settle(result);
      else events.deliver(event.row.taskId, event.row.key, result, event.row.pushedHead);
    },
  });
  const running = watcher.start();

  events.register(registry, taskId, project.remotes);
  const terminal = options.scripted ? undefined : options.terminal;
  const primitives = registerRemoteFunctions(registry, {
    taskId,
    ...(options.taskTitle !== undefined ? { taskTitle: options.taskTitle } : {}),
    baseBranch: () => new Git({ exec, repoDir: project.paths.projectDir, execEnv: config.execEnvironment }).currentBranch(),
    workspaceRoot: workspace.root,
    scratchDir: join(project.paths.systemDir, "remote-worktrees"),
    handles: project.remotes,
    integrations: config.integrations,
    publish: config.functions.review_artifacts.publish,
    secrets,
    exec,
    execEnv: config.execEnvironment,
    ...(options.http !== undefined ? { http: options.http } : {}),
    ...(terminal !== undefined ? { confirmPublish: (request: PublishRequest) => askAtTerminal(terminal, request) } : {}),
    grantProject: () => grantProject(project, options.log),
  });

  // The gate's second door, around whatever answers the gate here.
  const answering = registry.functions.get(REVIEW_ARTIFACTS);
  if (answering !== undefined) {
    let parks = 0;
    registry.functions.set(
      REVIEW_ARTIFACTS,
      hostFunction(
        (inputs: FunctionInputs, ctx: unknown) =>
          reviewWithRemote(
            {
              taskId,
              ...(options.taskTitle !== undefined ? { taskTitle: options.taskTitle } : {}),
              handles: project.remotes,
              primitives,
              workspace,
              who: async () => (await new Git({ exec, repoDir: workspace.root, execEnv: config.execEnvironment }).identity()).name,
              onAwaiting: () => source.kick(),
              log: options.log,
              ask: (given, hooks) => {
                const requestId = `cli:${taskId}:${++parks}`;
                let optionsOf: string[] = [];
                try {
                  const parsed = parseComponentConfig(REVIEW_ARTIFACTS, given);
                  if (parsed.component === REVIEW_ARTIFACTS) optionsOf = (parsed.options ?? []).map((o) => o.value);
                } catch {
                  // An unreadable contract decides nothing at review level.
                }
                const changeset = changesetInputOf(given).changeset;
                gates.set(requestId, { ...(changeset !== undefined ? { changeset } : {}), options: optionsOf, settle: () => undefined });
                hooks.onParked(requestId);
                // The reviewer is handed the signal that withdraws its prompt if the forge answers first.
                return Promise.resolve(answering.impl(given as FunctionInputs, { ...(ctx as object), abortSignal: hooks.signal } as never)) as never;
              },
              forge: (_row, requestId) =>
                new Promise<JsonValue>((resolve) => {
                  const gate = gates.get(requestId);
                  if (gate !== undefined) gate.settle = resolve;
                }),
            },
            inputs,
            ctx,
          ),
        INTERACTIVE,
      ),
    );
  }

  return {
    dispose: () => {
      events.declineAll();
      running.dispose();
    },
  };
}
