/**
 * Running a project's setup on this machine, and saying beforehand what running it would take.
 *
 * The plan comes from `@jaira/shared`'s `planSetupTarget` — the setup file's target opened for this
 * machine. Each step runs in order, its output streamed; a step with a `check` that already succeeds
 * is skipped; a failing step stops what follows unless it is `optional`. A `use` step is read out of
 * the file it names (`setupDelegates.ts`) and its steps run in its place.
 *
 * Three moments run a plan, each a different part of it:
 * - `create` — the workspace was just made: every step.
 * - `open` — the workspace is opened again: the `when: "open"` steps (and the start commands a `use`
 *   step's file marks so, like a Dev Container's `postStartCommand`).
 * - `again` — a pull changed files: the steps whose `again` names one of them.
 *
 * What it takes from the machine are ports — the tool installer, Bring, a clone, a container — so the
 * engine wires them and a test can stand in for them.
 *
 * A container step (`use: docker`, or `use: devcontainer` with `in: container`) brings the workspace's
 * container up through the container port, which says so in the workspace's own settings on this
 * machine; the steps after it run inside — `run` lines through `docker exec`, `install` through the
 * installer as it works inside a Linux machine (`container.ts`).
 */
import {
  devcontainerPart,
  devcontainerShapeOf,
  githubPart,
  gitlabPart,
  isVersionFile,
  simpleUsePart,
  useFileOf,
  versionFromFile,
  type DelegateRead,
  type DelegatedStep,
  type PlannedStep,
  type SetupReadiness,
  type SetupStepNeed,
  type UseStep,
} from "@jaira/shared";
import type { ContainerOutcome, ContainerRequest } from "./container";
import type { Exec } from "./exec";
import { containerRefusal, interpreterFor, machineEnvOf, type ContainerExecEnv, type ExecEnv } from "./paths";
import { patternTest } from "./workspaceMake";

/** What a tool request comes to on this machine, as the installer answers it. */
export interface ToolRequestLike {
  tool: string;
  version?: string;
  through?: string;
}

export interface ToolCheckLike {
  known: boolean;
  satisfied: boolean;
  found?: { path: string; version?: string };
  plan?: { method: string; display: string; needsPassword?: boolean };
}

export type ToolEnsureLike =
  | { ok: true; already: boolean; version?: string; path?: string; onPath?: boolean }
  | { ok: false; reason: string; needsPassword?: boolean; command?: string };

/** The tool installer, as the setup uses it (`@jaira/runtime`'s `checkTool` / `ensureTool`). */
export interface SetupToolPort {
  check(request: ToolRequestLike): Promise<ToolCheckLike>;
  ensure(request: ToolRequestLike, onOutput: (text: string) => void): Promise<ToolEnsureLike>;
}

/**
 * Bringing a workspace's container up, as the setup uses it — `@jaira/runtime`'s `containerPort` over
 * docker and the Dev Containers CLI on this machine.
 */
export interface SetupContainerPort {
  /** Make the container a step names, or start the one made before; where the workspace's commands run after it. */
  up(request: ContainerRequest, io: { onOutput: (text: string) => void; abortSignal?: AbortSignal }): Promise<ContainerOutcome>;
  /** The workspace's commands run in `env` from now on: said in its own settings on this machine. */
  use(env: ContainerExecEnv): void | Promise<void>;
  /** The installer for commands that run in `env` — the machine's, or the container's once it is up. */
  tools(env: ExecEnv): SetupToolPort;
}

export type SetupPhase = "create" | "open" | "again";

export interface SetupStepEvent {
  index: number;
  label: string;
  status: "running" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface SetupStepResult {
  label: string;
  status: "done" | "skipped" | "failed";
  detail?: string;
}

export interface SetupRunResult {
  ok: boolean;
  steps: SetupStepResult[];
  /** Why it stopped, when it did. */
  reason?: string;
}

/** What reading a plan needs: its files. */
export interface SetupReadContext {
  /** A file of the checkout by its path from the root, or undefined when it is not there. */
  readFile(path: string): Promise<string | undefined>;
  /** Where its commands run, for the few kinds that differ (a venv's paths). */
  os: "mac" | "linux" | "windows" | "wsl";
}

export interface SetupRunContext extends SetupReadContext {
  /** The workspace's root on this machine. */
  dir: string;
  exec: Exec;
  execEnv: ExecEnv;
  platform?: string;
  tools: SetupToolPort;
  /** Copy files git ignores into the workspace from the machine that has them; the number brought. */
  bring(request: { patterns: string[]; from?: string }): Promise<number>;
  /** Clone another repository beside or inside the workspace (a CI part's second checkout). */
  clone(request: { repository: string; ref?: string; path: string }): Promise<void>;
  /**
   * The workspace's container, for a container step; absent, such a step fails saying why. Once one is
   * up, `execEnv` and `tools` are the container's for the steps that follow.
   */
  container?: SetupContainerPort;
  onOutput(text: string): void;
  onStep?(event: SetupStepEvent): void;
  abortSignal?: AbortSignal;
  /** Laid over every command's environment. */
  env?: Record<string, string>;
  /** Folders put first on the PATH of every command (filled as tools off the PATH are installed). */
  pathFirst?: string[];
}

/** How a step reads in a plan or a log. */
export function setupStepLabel(step: PlannedStep | DelegatedStep): string {
  if ("install" in step) return `Install ${step.install}${step.version !== undefined ? ` ${step.version}` : ""}`;
  if ("run" in step) return step.run.split("\n")[0]!;
  if ("bring" in step) return `Bring ${step.bring.join(", ")}`;
  if ("clone" in step) return `Clone ${step.clone} into ${step.path}`;
  const file = useFileOf(step) ?? (typeof step.fields["image"] === "string" ? step.fields["image"] : undefined);
  const job = typeof step.fields["job"] === "string" ? `#${step.fields["job"]}` : "";
  const inside = step.use === "devcontainer" && step.fields["in"] === "container" ? ", in its container" : "";
  return `Use ${step.use}${file !== undefined ? ` (${file}${job}${inside})` : ""}`;
}

/** Which of a plan's steps a moment runs. */
export function stepsFor(steps: readonly PlannedStep[], phase: SetupPhase, changed: readonly string[] = []): PlannedStep[] {
  if (phase === "create") return [...steps];
  if (phase === "open") return steps.filter((step) => step.when === "open" || "use" in step);
  return steps.filter((step) => (step.again ?? []).some((pattern) => changed.some(patternTest(pattern))));
}

/** A step that brings the workspace's container up: `use: docker`, or `use: devcontainer` with `in: container`. */
export function isContainerStep(step: PlannedStep | UseStep): boolean {
  return "use" in step && (step.use === "docker" || (step.use === "devcontainer" && step.fields["in"] === "container"));
}

/** A Dev Container from a compose file mounts the workspace where its compose file says: not at its own path. */
const COMPOSE_IN_CONTAINER =
  "a Dev Container made from a compose file mounts the workspace where the compose file says, and JaiRA needs it at its own path — run it on the machine (leave out in: container), or name an image or a Dockerfile.";

const NEEDS_CLI =
  'it builds its container from a Dockerfile, which takes the Dev Containers CLI — put { "install": "devcontainer" } before this step.';

function fieldOf(step: UseStep, name: string): string | undefined {
  const value = step.fields[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The steps a `use` step comes to, read from its file. */
export async function delegatedOf(step: UseStep, ctx: SetupReadContext): Promise<DelegateRead> {
  const file = useFileOf(step);
  switch (step.use) {
    case "github": {
      const path = file!;
      const text = (await ctx.readFile(path)) ?? (await ctx.readFile(`${path.replace(/\/$/, "")}/action.yml`)) ?? (await ctx.readFile(`${path.replace(/\/$/, "")}/action.yaml`));
      if (text === undefined) return { ok: false, problems: [{ path: "file", message: `${path} is not in the checkout.` }] };
      return githubPart(text, step, { action: !/\.ya?ml$/.test(path) || /(^|\/)action\.ya?ml$/.test(path) });
    }
    case "gitlab": {
      const text = await ctx.readFile(file ?? ".gitlab-ci.yml");
      if (text === undefined) return { ok: false, problems: [{ path: "file", message: `${file ?? ".gitlab-ci.yml"} is not in the checkout.` }] };
      return gitlabPart(text, step);
    }
    case "devcontainer": {
      // In its container or on the machine, its features and lifecycle commands are what it comes to;
      // a container step brings the container up first (`runContainerStep`).
      const text = await ctx.readFile(file ?? ".devcontainer/devcontainer.json");
      if (text === undefined) return { ok: false, problems: [{ path: "file", message: `${file ?? ".devcontainer/devcontainer.json"} is not in the checkout.` }] };
      return devcontainerPart(text);
    }
    default: {
      const fileText = file !== undefined ? await ctx.readFile(file) : undefined;
      const packageManager = step.use === "npm" ? await packageManagerIn(ctx) : undefined;
      return simpleUsePart(step, { ...(fileText !== undefined ? { fileText } : {}), ...(packageManager ? { packageManager } : {}), os: ctx.os });
    }
  }
}

async function packageManagerIn(ctx: SetupReadContext): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const pkg = await ctx.readFile("package.json");
  const declared = pkg ? /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(pkg)?.[1] : undefined;
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") return declared;
  if ((await ctx.readFile("pnpm-lock.yaml")) !== undefined) return "pnpm";
  if ((await ctx.readFile("yarn.lock")) !== undefined) return "yarn";
  if ((await ctx.readFile("bun.lock")) !== undefined) return "bun";
  return "npm";
}

/** An `install` step's version, read from the file it names when it names one. */
export async function versionWanted(step: { install: string; version?: string }, ctx: SetupReadContext): Promise<string | undefined> {
  if (step.version === undefined) return undefined;
  if (!isVersionFile(step.version)) return step.version;
  const text = await ctx.readFile(step.version);
  return text === undefined ? undefined : versionFromFile(step.version, text, step.install);
}

// ---------------------------------------------------------------------------------------------
// Before running: what it would take
// ---------------------------------------------------------------------------------------------

export function readinessOf(needs: readonly SetupStepNeed[]): SetupReadiness {
  if (needs.some((n) => n.status === "cannot")) return "cannot";
  if (needs.some((n) => n.status === "password")) return "password";
  if (needs.some((n) => n.status === "installs")) return "installs";
  return "ready";
}

/** Say, step by step, what running `steps` would take here — looking only, never installing or running. */
export async function needsOf(steps: readonly PlannedStep[], ctx: SetupReadContext & { tools: Pick<SetupToolPort, "check"> }): Promise<SetupStepNeed[]> {
  const out: SetupStepNeed[] = [];
  // Tools an earlier step installs: a container step after `install: docker` is not refused for want of it.
  const installing = new Set<string>();
  const tool = async (req: ToolRequestLike, label: string, source: string | undefined): Promise<void> => {
    const check = await ctx.tools.check(req);
    const base = { label, ...(source !== undefined ? { source } : {}) };
    if (check.satisfied) out.push({ ...base, status: "there", ...(check.found?.version ? { detail: check.found.version } : {}) });
    else if (!check.known && check.found === undefined) out.push({ ...base, status: "cannot", detail: `JaiRA does not know how to install ${req.tool}` });
    else if (check.plan?.needsPassword === true) out.push({ ...base, status: "password", detail: check.plan.display });
    else if (check.plan !== undefined) out.push({ ...base, status: "installs", detail: check.plan.display });
    else out.push({ ...base, status: "cannot", detail: `nothing on this machine installs ${req.tool}${req.version ? ` ${req.version}` : ""}` });
  };
  for (const step of steps) {
    if ("install" in step) {
      installing.add(step.install.trim().toLowerCase());
      const version = await versionWanted(step, ctx);
      await tool({ tool: step.install, ...(version !== undefined ? { version } : {}) }, setupStepLabel({ ...step, ...(version !== undefined ? { version } : {}) }), step.version !== undefined && isVersionFile(step.version) ? step.version : undefined);
    } else if ("run" in step) out.push({ label: setupStepLabel(step), status: "runs" });
    else if ("bring" in step) out.push({ label: setupStepLabel(step), status: "brings" });
    else if (isContainerStep(step)) out.push(await containerNeed(step, ctx, installing));
    else {
      const read = await delegatedOf(step, ctx);
      const source = `${useFileOf(step) ?? step.use}`;
      if (!read.ok) {
        out.push({ label: setupStepLabel(step), status: "cannot", detail: read.problems[0]!.message, source });
        continue;
      }
      for (const inner of read.part.steps) {
        const innerSource = `${source} · ${inner.from}`;
        if ("install" in inner)
          await tool({ tool: inner.install, ...(inner.version !== undefined ? { version: inner.version } : {}), ...(inner.through ? { through: inner.through } : {}) }, setupStepLabel(inner), innerSource);
        else out.push({ label: setupStepLabel(inner), status: "runs", source: innerSource });
      }
      for (const c of read.part.cannot) out.push({ label: c.from, status: "cannot", detail: c.why, source });
    }
  }
  return out;
}

/**
 * What a container step would take: a Mac or Linux machine, Docker, and — for a Dev Container that
 * builds its image — the Dev Containers CLI. Runs, when they are there (or an earlier step installs
 * them); what runs inside cannot be looked at before the container is.
 */
async function containerNeed(step: UseStep & { via: string[] }, ctx: SetupReadContext & { tools: Pick<SetupToolPort, "check"> }, installing: ReadonlySet<string>): Promise<SetupStepNeed> {
  const label = setupStepLabel(step);
  const source = useFileOf(step) ?? `use ${step.use}`;
  const cannot = (detail: string): SetupStepNeed => ({ label, status: "cannot", detail, source });
  const refused = ctx.os === "windows" ? containerRefusal("win32") : ctx.os === "wsl" ? containerRefusal("linux", { wsl: "wsl" }) : undefined;
  if (refused !== undefined) return cannot(refused);
  let detail: string;
  if (step.use === "docker") {
    const image = fieldOf(step, "image");
    const file = fieldOf(step, "file");
    if (image === undefined && file === undefined) return cannot("use docker needs an image, or a file (a Dockerfile) to build one from.");
    detail = file !== undefined ? `builds ${file} and runs the workspace inside` : `runs the workspace inside ${image}`;
  } else {
    const path = useFileOf(step)!;
    const text = await ctx.readFile(path);
    if (text === undefined) return cannot(`${path} is not in the checkout.`);
    const read = devcontainerShapeOf(text);
    if (!read.ok) return cannot(read.problems[0]!.message);
    if (read.shape.compose) return cannot(COMPOSE_IN_CONTAINER);
    const cli = installing.has("devcontainer") || (await ctx.tools.check({ tool: "devcontainer" })).satisfied;
    if (!cli && (read.shape.builds || read.shape.image === undefined)) return cannot(NEEDS_CLI);
    detail = cli ? "devcontainer up: the workspace runs in its container, its features and lifecycle commands inside" : `runs the workspace inside ${read.shape.image}, its lifecycle commands inside`;
  }
  if (!installing.has("docker") && !installing.has("docker-desktop") && !(await ctx.tools.check({ tool: "docker" })).satisfied)
    return cannot('Docker is not on this machine — install it (Docker Desktop on a Mac), or put { "install": "docker" } before this step.');
  return { label, status: "runs", detail, source };
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/** Run the steps of `phase`, in order, on this machine. */
export async function runSetup(steps: readonly PlannedStep[], ctx: SetupRunContext, phase: SetupPhase = "create", changed: readonly string[] = []): Promise<SetupRunResult> {
  const chosen = stepsFor(steps, phase, changed);
  // A tool found or installed where the PATH does not reach (an nvm version, a keg-only formula): its
  // folder goes first on the PATH of the commands that follow it.
  ctx = { ...ctx, pathFirst: [...(ctx.pathFirst ?? [])] };
  const results: SetupStepResult[] = [];
  for (const [index, step] of chosen.entries()) {
    const label = setupStepLabel(step);
    if (ctx.abortSignal?.aborted === true) return { ok: false, steps: results, reason: "Stopped." };
    ctx.onStep?.({ index, label, status: "running" });
    ctx.onOutput(`\n▸ ${label}\n`);
    let outcome: SetupStepResult;
    try {
      if (step.check !== undefined && (await shell(step.check, ctx, undefined, undefined, true)).ok) {
        outcome = { label, status: "skipped", detail: "already done" };
      } else {
        outcome = await runOne(step, label, ctx, phase);
      }
    } catch (error) {
      outcome = { label, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    results.push(outcome);
    ctx.onStep?.({ index, label, status: outcome.status, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) });
    if (outcome.status === "failed" && step.optional !== true) return { ok: false, steps: results, reason: `${label}: ${outcome.detail ?? "failed"}` };
    if (outcome.status === "failed") ctx.onOutput(`(optional — going on)\n`);
  }
  return { ok: true, steps: results };
}

async function runOne(step: PlannedStep, label: string, ctx: SetupRunContext, phase: SetupPhase): Promise<SetupStepResult> {
  if ("install" in step) {
    const version = await versionWanted(step, ctx);
    if (step.version !== undefined && isVersionFile(step.version) && version === undefined) ctx.onOutput(`${step.version} holds no version for ${step.install}; installing any.\n`);
    return ensure({ tool: step.install, ...(version !== undefined ? { version } : {}) }, label, ctx);
  }
  if ("run" in step) {
    const result = await shell(step.run, ctx, step.cwd, step.env);
    return result.ok ? { label, status: "done" } : { label, status: "failed", detail: result.reason };
  }
  if ("bring" in step) {
    const count = await ctx.bring({ patterns: step.bring, ...(step.from !== undefined ? { from: step.from } : {}) });
    return { label, status: "done", detail: count === 0 ? "nothing matched" : `${count} file${count === 1 ? "" : "s"}` };
  }
  if (isContainerStep(step)) return runContainerStep(step, label, ctx, phase);
  const read = await delegatedOf(step, ctx);
  if (!read.ok) return { label, status: "failed", detail: read.problems.map((p) => p.message).join(" ") };
  for (const skip of read.part.skipped) ctx.onOutput(`  skipped ${skip.from} — ${skip.why}\n`);
  for (const no of read.part.cannot) ctx.onOutput(`  cannot run ${no.from} here — ${no.why}\n`);
  const failed = await runParts(read.part.steps, step, ctx, phase);
  return failed !== undefined ? { label, status: "failed", detail: failed } : { label, status: "done" };
}

/** What a `use` step came to, in order — on opening, only what starts each time. Why the first that failed did, or undefined. */
async function runParts(steps: readonly DelegatedStep[], step: PlannedStep, ctx: SetupRunContext, phase: SetupPhase): Promise<string | undefined> {
  for (const inner of steps) {
    if (phase === "open" && !("run" in inner && inner.when === "open") && step.when !== "open") continue;
    const innerLabel = setupStepLabel(inner);
    ctx.onOutput(`  ▸ ${innerLabel}\n`);
    let r: SetupStepResult;
    if ("install" in inner) r = await ensure({ tool: inner.install, ...(inner.version !== undefined ? { version: inner.version } : {}), ...(inner.through ? { through: inner.through } : {}) }, innerLabel, ctx);
    else if ("clone" in inner) {
      await ctx.clone({ repository: inner.clone, ...(inner.ref !== undefined ? { ref: inner.ref } : {}), path: inner.path });
      r = { label: innerLabel, status: "done" };
    } else {
      const result = await shell(inner.run, ctx, inner.cwd, inner.env);
      r = result.ok ? { label: innerLabel, status: "done" } : { label: innerLabel, status: "failed", detail: result.reason };
    }
    if (r.status === "failed") return `${innerLabel}: ${r.detail ?? "failed"}`;
  }
  return undefined;
}

/**
 * A container step: the workspace's container brought up (made, or started again), the workspace's
 * settings on this machine told so, and every step after it run inside — `ctx` is the run's own, so
 * its environment and installer change for what follows.
 *
 * A Dev Container goes through the Dev Containers CLI when the machine has it, which makes the
 * container and runs the features and lifecycle commands itself. Without it, one that names only an
 * image is made as `use: docker` makes one, its `initializeCommand` run on the machine before and the
 * rest of what it comes to (features as installs, lifecycle commands as runs) run inside after.
 */
async function runContainerStep(step: UseStep & { via: string[] }, label: string, ctx: SetupRunContext, phase: SetupPhase): Promise<SetupStepResult> {
  const failed = (detail: string): SetupStepResult => ({ label, status: "failed", detail });
  const port = ctx.container;
  if (port === undefined) return failed("nothing here can bring a container up for this workspace.");
  const io = { onOutput: ctx.onOutput, ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}) };
  // The machine's own, whichever environment the steps before this one ran in.
  const machine = machineEnvOf(ctx.execEnv);
  let up: ContainerOutcome;
  let inside: DelegatedStep[] = [];
  if (step.use === "docker") {
    const image = fieldOf(step, "image");
    const file = fieldOf(step, "file");
    up = await port.up({ kind: "docker", ...(image !== undefined ? { image } : {}), ...(file !== undefined ? { file } : {}) }, io);
  } else {
    const path = useFileOf(step)!;
    const text = await ctx.readFile(path);
    if (text === undefined) return failed(`${path} is not in the checkout.`);
    const read = devcontainerShapeOf(text);
    if (!read.ok) return failed(read.problems.map((p) => p.message).join(" "));
    if (read.shape.compose) return failed(COMPOSE_IN_CONTAINER);
    const cli = await port.tools(machine).check({ tool: "devcontainer" });
    if (cli.satisfied && cli.found !== undefined) {
      up = await port.up({ kind: "devcontainer", file: path, text, cli: cli.found.path }, io);
    } else if (read.shape.image !== undefined && !read.shape.builds) {
      const part = devcontainerPart(text);
      if (!part.ok) return failed(part.problems.map((p) => p.message).join(" "));
      for (const skip of part.part.skipped) ctx.onOutput(`  skipped ${skip.from} — ${skip.why}\n`);
      const before = part.part.steps.filter((one) => one.from.startsWith("initializeCommand"));
      inside = part.part.steps.filter((one) => !one.from.startsWith("initializeCommand"));
      // `initializeCommand` is the machine's, before the container is made.
      if (phase === "create") {
        const onMachine: SetupRunContext = { ...ctx, execEnv: machine, tools: port.tools(machine) };
        const wrong = await runParts(before, step, onMachine, phase);
        if (wrong !== undefined) return failed(wrong);
      }
      ctx.onOutput("  the Dev Containers CLI is not on this machine: the container is made with docker, its lifecycle commands run inside\n");
      up = await port.up({ kind: "docker", image: read.shape.image, ...(read.shape.user !== undefined ? { user: read.shape.user } : {}), env: read.shape.containerEnv, from: "devcontainer" }, io);
    } else return failed(NEEDS_CLI);
  }
  if (!up.ok) return failed(up.reason);
  await port.use(up.env);
  ctx.execEnv = up.env;
  ctx.tools = port.tools(up.env);
  ctx.os = "linux";
  ctx.onOutput(`  the workspace's commands run in ${up.env.container} from here on\n`);
  const wrong = await runParts(inside, step, ctx, phase);
  if (wrong !== undefined) return failed(wrong);
  return { label, status: "done", detail: `in ${up.env.container}` };
}

async function ensure(request: ToolRequestLike, label: string, ctx: SetupRunContext): Promise<SetupStepResult> {
  const result = await ctx.tools.ensure(request, ctx.onOutput);
  if (result.ok) {
    if (result.onPath === false && result.path !== undefined) {
      const folder = result.path.replace(/[\\/][^\\/]*$/, "");
      if (folder !== "" && !(ctx.pathFirst ?? []).includes(folder)) ctx.pathFirst?.push(folder);
    }
    return { label, status: result.already ? "skipped" : "done", ...(result.already ? { detail: "already there" } : {}) };
  }
  // The installer's reason already says what to run where, when a password is needed there.
  return { label, status: "failed", detail: result.reason };
}

/** One command line in the workspace, through the shell of where it runs (the machine's, WSL's, its container's), its output streamed. */
async function shell(
  line: string,
  ctx: SetupRunContext,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  quiet = false,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [command, ...prefix] = interpreterFor(ctx.execEnv, ctx.platform);
  const where = cwd === undefined || cwd === "." ? ctx.dir : joinUnder(ctx.dir, cwd);
  if (!quiet) ctx.onOutput(`$ ${line}\n`);
  const pathFirst = ctx.pathFirst ?? [];
  // Natively only: inside WSL or a workspace's container a PATH from here would be this machine's, and
  // in a container (`docker exec -e PATH`) it would replace the image's own.
  const sep = (ctx.platform ?? process.platform) === "win32" && typeof ctx.execEnv !== "object" ? ";" : ":";
  const path: Record<string, string> =
    pathFirst.length > 0 && typeof ctx.execEnv !== "object" ? { PATH: [...pathFirst, process.env["PATH"] ?? ""].filter((p) => p !== "").join(sep) } : {};
  // Windows PowerShell 5.1 writes what `>` redirects as UTF-16: `echo made > made.txt` made a file no
  // other tool reads as "made". Redirection follows Out-File's default, set to UTF-8 for the step — an
  // argument of its own before the line, which `-Command` joins to it, so the line is the step's as written.
  const utf8 = command.toLowerCase().startsWith("powershell") ? ["$PSDefaultParameterValues['Out-File:Encoding']='utf8';"] : [];
  const result = await ctx.exec.run(command, [...prefix, ...utf8, line], {
    cwd: where,
    env: { ...(ctx.env ?? {}), ...path, ...(env ?? {}) },
    execEnv: ctx.execEnv,
    stdin: "",
    ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
    ...(quiet ? {} : { onOutput: (_stream: "stdout" | "stderr", chunk: string) => ctx.onOutput(chunk) }),
  });
  if (result.aborted) return { ok: false, reason: "stopped" };
  if (result.timedOut) return { ok: false, reason: "took too long" };
  if (result.code !== 0) {
    const last = (result.stderr || result.stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).pop();
    return { ok: false, reason: `exited ${String(result.code)}${last !== undefined ? `: ${last}` : ""}` };
  }
  return { ok: true };
}

/** A folder relative to the workspace — a CI part's `../sibling` included — on this machine's separators. */
function joinUnder(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const parts = root.split(/[\\/]/);
  for (const part of rel.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join(sep);
}
