/**
 * Running an install: the command first, as the person would type it, then what the installer prints
 * as it prints it — and its own last words when it fails. Only a way the lookups offered is run: a
 * request names a way, never a command.
 */
import type { AgentInstallOutcome, InstallMethod } from "@jaira/shared";
import type { ToolPackage } from "./catalog";
import { appleStubTarget, gatherInstallFacts, inGuest, type InstallFacts, type InstallLookup } from "./locate";
import { INSTALL_VIA, planOf, type InstallPlan } from "./plan";

export interface InstallRunOptions extends InstallLookup {
  abortSignal?: AbortSignal;
  /**
   * What the install prints, as it prints it: the command first (`$ brew install gh`), then the
   * installer's stdout and stderr as they come, interleaved, untouched — escapes and carriage returns
   * included, for whoever draws it to make sense of. Settings → Connections shows it under the row.
   */
  onOutput?: (text: string) => void;
}

/** Long enough for a download on a slow line; an installer that waits on a question fails sooner (stdin is closed). */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** What a caller of {@link runInstall} adds to it. */
export interface InstallRunHooks {
  /** How the machine is looked at, before and after — {@link gatherInstallFacts} unless a package needs more. */
  facts?: () => Promise<InstallFacts | undefined>;
  /** Called once the installer exited 0, before the binary is looked for again; its answer is the outcome. */
  afterRun?: (chosen: InstallPlan, result: { stdout: string; stderr: string }) => Promise<AgentInstallOutcome | undefined>;
}

/** Tell whoever is watching; a watcher that throws is nobody's problem but its own. */
export function sayTo(onOutput: ((text: string) => void) | undefined): (text: string) => void {
  return (text) => {
    try {
      onOutput?.(text);
    } catch {
      // Somebody watching; the install goes on without them.
    }
  };
}

/** How one installer's run came out. */
export type PlanRun = { ok: true; stdout: string; stderr: string } | { ok: false; reason: string; stdout?: string; stderr?: string };

/**
 * Run one plan, with stdin closed (an installer that stops to ask fails with its question rather than
 * waiting forever), its output streamed to `onOutput` after the command it runs. `verb` names what
 * a cancel cancelled.
 */
export async function runPlan(chosen: InstallPlan, options: InstallRunOptions, verb: "install" | "update"): Promise<PlanRun> {
  const say = sayTo(options.onOutput);
  say(`$ ${chosen.display}\n`);
  // Passed into WSL or a container it would be this machine's; there, its own PATH is the right one.
  const env = inGuest(options) ? undefined : withTerminal(chosen.env, options.deps);
  let result;
  try {
    result = await options.exec.run(chosen.file, chosen.args, {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
      stdin: "",
      ...(options.onOutput !== undefined ? { onOutput: (_stream: "stdout" | "stderr", chunk: string) => say(chunk) } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `'${chosen.display}' could not be started: ${(e as Error).message}` };
  }
  if (result.aborted) return { ok: false, reason: `the ${verb} was cancelled` };
  if (result.timedOut) return { ok: false, reason: `'${chosen.display}' did not finish in time` };
  if (result.code !== 0) {
    // The installer's own last words: "already installed", "permission denied" and a network error are
    // different problems, and the last line is where each says which.
    const said = lastLine(`${result.stdout}\n${result.stderr}`, result.stderr);
    return { ok: false, reason: `'${chosen.display}' exited ${result.code}${said ? `: ${said}` : ""}`, stdout: result.stdout, stderr: result.stderr };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The install or update of one package, by the way named (none: the update, a broken one reinstalled).
 * Only a way the facts offer is run. Answers when the installer exits, with where the binary is now.
 */
export async function runInstall(pkg: ToolPackage, command: string, method: InstallMethod | undefined, options: InstallRunOptions, hooks: InstallRunHooks = {}): Promise<AgentInstallOutcome> {
  const look = hooks.facts ?? (() => gatherInstallFacts(command, pkg, options));
  const facts = await look();
  if (facts === undefined) return { ok: false, reason: `could not look for '${command}' where it runs` };
  const plans = planOf(pkg, facts);
  const chosen = method === undefined ? plans.update : plans.install.find((one) => one.method === method);
  if (chosen === undefined) {
    return {
      ok: false,
      reason:
        method === undefined
          ? `'${command}' was not installed in a way JaiRA can update — update it the way you installed it`
          : `${INSTALL_VIA[method]} cannot install ${pkg.binary} here`,
    };
  }
  const ran = await runPlan(chosen, options, method === undefined ? "update" : "install");
  if (!ran.ok) return { ok: false, reason: ran.reason };
  const waited = hooks.afterRun !== undefined ? await hooks.afterRun(chosen, ran) : undefined;
  if (waited !== undefined) return waited;
  const after = await look();
  const now = after?.found;
  return now !== undefined && !now.broken ? { ok: true, path: now.path, onPath: now.onPath } : { ok: true };
}

/**
 * An installer's environment with what the person's own terminal has that this app has not: the
 * variables its profile sets (`NVM_DIR`, `FNM_DIR` — so a version manager works in the person's folders,
 * not its defaults) and, after this app's, the folders on its PATH. On Windows the PATH is left: a
 * program found off it is run by its path.
 */
function withTerminal(env: Record<string, string> | undefined, deps: InstallLookup["deps"]): Record<string, string> | undefined {
  const shell = deps.shell;
  if (shell === undefined) return env;
  const merged: Record<string, string> = { ...shell.vars, ...(env ?? {}) };
  if (deps.platform !== "win32" && shell.pathDirs.length > 0) {
    const base = (env?.["PATH"] ?? process.env["PATH"] ?? "").split(":").filter((dir) => dir.length > 0);
    merged["PATH"] = [...base, ...shell.pathDirs.filter((dir) => !base.includes(dir))].join(":");
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The last line that says something — stderr's, when there is one, since that is where an error goes. */
export function lastLine(all: string, stderr: string): string {
  const pick = (text: string): string | undefined =>
    text
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop();
  return pick(stderr) ?? pick(all) ?? "";
}

/** How long Apple's installer is waited on: it downloads a few hundred megabytes. */
const APPLE_TOOLS_WAIT_MS = 60 * 60_000;
const APPLE_TOOLS_POLL_MS = 3_000;

export interface AppleWait {
  pollMs?: number;
  maxMs?: number;
}

/**
 * Wait on Apple's Command Line Tools installer, which `xcode-select --install` only asks for — it runs
 * in a window of its own — until the program behind the placeholder is there, on Cancel, or after an
 * hour. Undefined when the machine could not be looked at.
 */
export async function waitForAppleInstall(pkg: ToolPackage, command: string, options: InstallRunOptions, wait: AppleWait = {}): Promise<AgentInstallOutcome | undefined> {
  // Nothing more is printed while Apple's window works: say what is being waited on.
  sayTo(options.onOutput)(`Apple's installer runs in a window of its own — waiting until ${command} is there…\n`);
  const facts = await gatherInstallFacts(command, pkg, options);
  if (facts === undefined) return undefined;
  const deadline = Date.now() + (wait.maxMs ?? APPLE_TOOLS_WAIT_MS);
  while ((await appleStubTarget(pkg, command, options.exec, facts)) === undefined) {
    if (options.abortSignal?.aborted === true) return { ok: false, reason: "the install was cancelled" };
    if (Date.now() > deadline) return { ok: false, reason: "Apple's installer did not finish within an hour — press Re-check once it has" };
    await pause(wait.pollMs ?? APPLE_TOOLS_POLL_MS, options.abortSignal);
  }
  return { ok: true, path: `/usr/bin/${command}`, onPath: true };
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
