/**
 * A workspace's container (decision 0027): made from an image, a Dockerfile or a Dev Container, with
 * the workspace mounted at the SAME path inside as outside, and kept up.
 *
 * The same path is the whole design. The machine's git, its file tools, JaiRA's own reads and every
 * path in a task's record stay right, because a file is where it was; only the commands JaiRA runs for
 * the workspace (its shell tool, a state's `run_command`, the setup's steps) cross over, through
 * `docker exec` (`exec.ts`'s `containerInvocation`). A task's worktree is outside the workspace, so
 * the folder worktrees go in is mounted the same way.
 *
 * - `use: docker` — `image`, or `file` (a Dockerfile, built as `jaira-<hash of the folder>`); then
 *   `docker run -d --name jaira-<hash> --init -v <dir>:<dir> -w <dir> <image> sleep infinity`. A
 *   container of that name already there is used again: started when stopped, made again only when
 *   it was made from another image.
 * - `use: devcontainer` with `in: container` — the Dev Containers CLI (`devcontainer up`) with the
 *   project's devcontainer.json laid over by {@link devcontainerOverrideOf}: the CLI makes the
 *   container and runs its features and lifecycle commands itself. Without the CLI, a
 *   devcontainer.json that names only an image is run as `use: docker` would run it, and the setup
 *   runner runs its lifecycle commands inside (`setupRun.ts`).
 *
 * Docker runs ON THE MACHINE: every command here is passed `execEnv: "windows"` (native), whatever
 * the Exec it is handed defaults to. Macs and Linux only (`containerRefusal`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { devcontainerOverrideOf } from "@jaira/shared";
import type { Exec } from "./exec";
import { containerRefusal, isContainerEnv, type ContainerExecEnv, type ExecEnv } from "./paths";
import type { SetupContainerPort, SetupToolPort } from "./setupRun";

/** Where a container's workspace is. */
export interface ContainerSpot {
  /** The workspace's folder: mounted at this same path inside, and where its commands start. */
  dir: string;
  /** Other folders a run reaches — the folder a project's task worktrees go in — mounted at their own paths too. */
  mounts?: readonly string[];
}

/** What bringing a container up runs with. */
export interface ContainerIo {
  /** Runs docker and the Dev Containers CLI — on the machine, whatever environment it defaults to. */
  exec: Exec;
  /** The commands and what they print, as they print it. */
  onOutput?: (text: string) => void;
  abortSignal?: AbortSignal;
  /** The host's platform (`process.platform`): containers run from a Mac or Linux. */
  platform?: string;
  /** Where the machine's programs run: a WSL machine cannot hold one. */
  machine?: ExecEnv;
  /** Make a folder a mount names, before docker does it as root — `mkdirSync`, unless a test says. */
  makeDir?: (path: string) => void;
}

/** What a step asks to be brought up. */
export type ContainerRequest =
  | {
      kind: "docker";
      /** The image; or */
      image?: string;
      /** a Dockerfile, from the workspace's root (its folder is the build context). */
      file?: string;
      /** Who commands run as inside (`docker exec -u`). */
      user?: string;
      /** Set on the container as it is made (a Dev Container's `containerEnv`). */
      env?: Record<string, string>;
      from?: "devcontainer" | "docker";
    }
  | {
      kind: "devcontainer";
      /** The devcontainer.json, from the workspace's root. */
      file: string;
      /** Its text, as the setup read it. */
      text: string;
      /** The Dev Containers CLI, where the tool installer found it. */
      cli: string;
    };

export type ContainerOutcome = { ok: true; env: ContainerExecEnv; made: boolean } | { ok: false; reason: string };

/** How long a build, a pull or a Dev Container's first make may take. */
const MAKE_TIMEOUT_MS = 60 * 60_000;
const LOOK_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 2 * 60_000;

/** The container (and a built image) a folder's workspace gets: `jaira-` and the first 8 of the folder's sha-256. */
export function containerNameFor(dir: string): string {
  return `jaira-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

function sayTo(io: ContainerIo): (text: string) => void {
  return (text) => {
    try {
      io.onOutput?.(text);
    } catch {
      // Somebody watching; the container comes up without them.
    }
  };
}

type Ran = { ok: true; stdout: string } | { ok: false; reason: string; stdout: string; stderr: string; missing?: boolean };

/** One program on the machine, its command said first and its output streamed when `loud`. */
async function run(io: ContainerIo, file: string, args: readonly string[], timeoutMs: number, loud = true): Promise<Ran> {
  const say = sayTo(io);
  if (loud) say(`$ ${[file, ...args].join(" ")}\n`);
  let result;
  try {
    result = await io.exec.run(file, args, {
      // Docker is the machine's: never through a container's own `docker exec`.
      execEnv: "windows",
      stdin: "",
      timeoutMs,
      ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
      ...(loud ? { onOutput: (_stream: "stdout" | "stderr", chunk: string) => say(chunk) } : {}),
    });
  } catch (error) {
    return { ok: false, reason: `${file} could not be started: ${error instanceof Error ? error.message : String(error)}`, stdout: "", stderr: "", missing: true };
  }
  if (result.aborted) return { ok: false, reason: "stopped", stdout: result.stdout, stderr: result.stderr };
  if (result.timedOut) return { ok: false, reason: `'${file} ${args[0] ?? ""}' took too long`, stdout: result.stdout, stderr: result.stderr };
  if (result.code !== 0) {
    const last = lastLine(result.stderr) ?? lastLine(result.stdout);
    return { ok: false, reason: `'${file} ${args[0] ?? ""}' exited ${String(result.code)}${last !== undefined ? `: ${last}` : ""}`, stdout: result.stdout, stderr: result.stderr };
  }
  return { ok: true, stdout: result.stdout };
}

function lastLine(text: string): string | undefined {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
}

/** Docker's absence, said as what to do about it. */
function dockerMissing(ran: Extract<Ran, { ok: false }>): string {
  if (ran.missing === true) return "Docker is not on this machine — install it (Docker Desktop on a Mac), or put { \"install\": \"docker\" } before this step.";
  if (/cannot connect to the docker daemon|is the docker daemon running|docker desktop is not running/i.test(`${ran.stderr}\n${ran.stdout}`))
    return "Docker is not running on this machine — start it (Docker Desktop on a Mac) and run the setup again.";
  return ran.reason;
}

/** A container, by name or id: running, stopped, or not there — and the image it was made from. */
export async function inspectContainer(
  name: string,
  io: ContainerIo,
): Promise<{ ok: true; state: "running" | "stopped" | "none"; image?: string; name?: string } | { ok: false; reason: string }> {
  const ran = await run(io, "docker", ["inspect", "--type", "container", "--format", "{{.State.Running}}\t{{.Config.Image}}\t{{.Name}}", name], LOOK_TIMEOUT_MS, false);
  if (!ran.ok) {
    if (/no such (object|container)/i.test(`${ran.stderr}\n${ran.stdout}`)) return { ok: true, state: "none" };
    return { ok: false, reason: dockerMissing(ran) };
  }
  const [running, image, named] = ran.stdout.trim().split("\t");
  return {
    ok: true,
    state: running === "true" ? "running" : "stopped",
    ...(image !== undefined && image.length > 0 ? { image } : {}),
    ...(named !== undefined && named.length > 0 ? { name: named.replace(/^\//, "") } : {}),
  };
}

/**
 * Keep a workspace's container up: start it when it is stopped (after a restart of the machine or of
 * Docker). Nothing to do for an environment that is not a container. A container that is gone is
 * said, not remade — making one is the setup's, which the person approved.
 */
export async function ensureContainer(env: ExecEnv, io: ContainerIo): Promise<{ ok: true; started: boolean } | { ok: false; reason: string }> {
  if (!isContainerEnv(env)) return { ok: true, started: false };
  const refused = containerRefusal(io.platform, io.machine);
  if (refused !== undefined) return { ok: false, reason: refused };
  const seen = await inspectContainer(env.container, io);
  if (!seen.ok) return seen;
  if (seen.state === "running") return { ok: true, started: false };
  if (seen.state === "none") return { ok: false, reason: `The container ${env.container} this workspace runs in is gone — run the project's setup again to make it.` };
  const started = await run(io, "docker", ["start", env.container], START_TIMEOUT_MS);
  return started.ok ? { ok: true, started: true } : { ok: false, reason: dockerMissing(started) };
}

/** Every folder the container mounts: the workspace's, then the others, once each. */
function mountsOf(spot: ContainerSpot): string[] {
  return [...new Set([spot.dir, ...(spot.mounts ?? [])])];
}

function makeDirs(spot: ContainerSpot, io: ContainerIo): void {
  const make = io.makeDir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  for (const path of mountsOf(spot)) {
    try {
      make(path);
    } catch {
      // docker says so if it matters.
    }
  }
}

/**
 * `use: docker` (and a Dev Container that names only an image, without the CLI): the image pulled or
 * built, the container made — or the one of this folder's name used again.
 */
export async function dockerUp(spot: ContainerSpot, request: Extract<ContainerRequest, { kind: "docker" }>, io: ContainerIo): Promise<ContainerOutcome> {
  const refused = containerRefusal(io.platform, io.machine);
  if (refused !== undefined) return { ok: false, reason: refused };
  if (request.image === undefined && request.file === undefined) return { ok: false, reason: "use docker needs an image, or a file (a Dockerfile) to build one from." };
  const say = sayTo(io);
  const name = containerNameFor(spot.dir);
  const env: ContainerExecEnv = { container: name, ...(request.user !== undefined ? { user: request.user } : {}), from: request.from ?? "docker" };

  let image = request.image;
  if (request.file !== undefined) {
    const dockerfile = resolve(spot.dir, request.file);
    // Built every time: Docker's cache makes an unchanged one quick, and a changed one is what was asked for.
    const built = await run(io, "docker", ["build", "-t", name, "-f", dockerfile, dirname(dockerfile)], MAKE_TIMEOUT_MS);
    if (!built.ok) return { ok: false, reason: built.missing === true ? dockerMissing(built) : `building ${request.file}: ${dockerMissing(built)}` };
    image = name;
  }

  const seen = await inspectContainer(name, io);
  if (!seen.ok) return seen;
  let state = seen.state;
  if (state !== "none" && request.image !== undefined && seen.image !== undefined && seen.image !== request.image) {
    say(`${name} was made from ${seen.image}; making it again from ${request.image}.\n`);
    const removed = await run(io, "docker", ["rm", "-f", name], START_TIMEOUT_MS);
    if (!removed.ok) return { ok: false, reason: dockerMissing(removed) };
    state = "none";
  }
  if (state === "running") {
    say(`${name} is up.\n`);
    return { ok: true, env, made: false };
  }
  if (state === "stopped") {
    const started = await run(io, "docker", ["start", name], START_TIMEOUT_MS);
    return started.ok ? { ok: true, env, made: false } : { ok: false, reason: dockerMissing(started) };
  }

  makeDirs(spot, io);
  const args = [
    "run",
    "-d",
    "--name",
    name,
    // An init reaps what the workspace's commands leave behind, and passes a stop on to `sleep`.
    "--init",
    ...mountsOf(spot).flatMap((path) => ["-v", `${path}:${path}`]),
    "-w",
    spot.dir,
    ...Object.entries(request.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image!,
    "sleep",
    "infinity",
  ];
  const made = await run(io, "docker", args, MAKE_TIMEOUT_MS);
  return made.ok ? { ok: true, env, made: true } : { ok: false, reason: dockerMissing(made) };
}

/** What `devcontainer up` answered: its last line of JSON on stdout. */
export function parseDevcontainerUp(stdout: string): { outcome?: string; containerId?: string; remoteUser?: string; remoteWorkspaceFolder?: string; message?: string } | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value["outcome"] !== "string") continue;
      const text = (key: string): Record<string, string> => (typeof value[key] === "string" ? { [key]: value[key] as string } : {});
      return { ...text("outcome"), ...text("containerId"), ...text("remoteUser"), ...text("remoteWorkspaceFolder"), ...text("message") };
    } catch {
      // A log line that only looks like JSON.
    }
  }
  return undefined;
}

/**
 * `use: devcontainer` with `in: container`, through the Dev Containers CLI: `devcontainer up` with the
 * project's devcontainer.json laid over — the workspace at its own path inside, the worktrees' folder
 * beside it — read from a file of its own, removed after. The CLI makes the container (or finds the one
 * it made before, by its labels) and runs the features and lifecycle commands; none of them is run
 * again here.
 */
export async function devcontainerUp(spot: ContainerSpot, request: Extract<ContainerRequest, { kind: "devcontainer" }>, io: ContainerIo): Promise<ContainerOutcome> {
  const refused = containerRefusal(io.platform, io.machine);
  if (refused !== undefined) return { ok: false, reason: refused };
  const configFile = resolve(spot.dir, request.file);
  const override = devcontainerOverrideOf(request.text, { dir: spot.dir, configDir: dirname(configFile), ...(spot.mounts !== undefined ? { mounts: spot.mounts } : {}) });
  if (override === undefined) return { ok: false, reason: `${request.file} is not a devcontainer.json.` };
  makeDirs(spot, io);
  const folder = mkdtempSync(join(tmpdir(), "jaira-devcontainer-"));
  try {
    const overrideFile = join(folder, "devcontainer.json");
    writeFileSync(overrideFile, `${JSON.stringify(override, null, 2)}\n`);
    const ran = await run(io, request.cli, ["up", "--workspace-folder", spot.dir, "--config", configFile, "--override-config", overrideFile], MAKE_TIMEOUT_MS);
    const said = parseDevcontainerUp(ran.stdout);
    if (said?.outcome !== "success" || said.containerId === undefined) {
      const why = said?.message ?? (ran.ok ? "it said nothing JaiRA could read" : ran.reason);
      return { ok: false, reason: `devcontainer up did not make the container: ${why}` };
    }
    if (said.remoteWorkspaceFolder !== undefined && said.remoteWorkspaceFolder !== spot.dir)
      return { ok: false, reason: `the Dev Container put the workspace at ${said.remoteWorkspaceFolder}, not at its own path ${spot.dir}, which the machine's tools need.` };
    // Its name reads better than an id in Settings, and names the same container for as long as it is there.
    const seen = await inspectContainer(said.containerId, io);
    const name = seen.ok && seen.name !== undefined ? seen.name : said.containerId;
    return { ok: true, env: { container: name, ...(said.remoteUser !== undefined ? { user: said.remoteUser } : {}), from: "devcontainer" }, made: true };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The setup's container port over a workspace on this machine: {@link dockerUp} and
 * {@link devcontainerUp} for `up`, and the engine's own ways of saying where the workspace's commands
 * run (`record`, its settings on this machine) and of installing there (`tools`).
 */
export function containerPort(
  options: ContainerSpot &
    Omit<ContainerIo, "onOutput" | "abortSignal"> & {
      record(env: ContainerExecEnv): void | Promise<void>;
      tools(env: ExecEnv): SetupToolPort;
    },
): SetupContainerPort {
  const spot: ContainerSpot = { dir: options.dir, ...(options.mounts !== undefined ? { mounts: options.mounts } : {}) };
  const ioOf = (io: { onOutput: (text: string) => void; abortSignal?: AbortSignal }): ContainerIo => ({
    exec: options.exec,
    onOutput: io.onOutput,
    ...(io.abortSignal !== undefined ? { abortSignal: io.abortSignal } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.machine !== undefined ? { machine: options.machine } : {}),
    ...(options.makeDir !== undefined ? { makeDir: options.makeDir } : {}),
  });
  return {
    up: (request, io) => (request.kind === "docker" ? dockerUp(spot, request, ioOf(io)) : devcontainerUp(spot, request, ioOf(io))),
    use: (env) => options.record(env),
    tools: (env) => options.tools(env),
  };
}
