/**
 * Installs that take more than one step: an agent npm installs, on a machine with no Node.js (or one
 * too old for it); a formula, on a machine with no Homebrew; a WinGet or Chocolatey package, on a
 * Windows with neither. Each way an agent is installed by needs
 * its installer, and where the installer is missing but can itself be installed, the way is still
 * offered — as a row for what is missing, whose ways each install it and then go on.
 *
 * The menu is a tree of {@link InstallChoice}s, one step a row: "Node.js" (its ways: fnm, nvm, mise,
 * Volta, Homebrew, WinGet …, each of them then npm), "Homebrew" (then `brew install`). A way that
 * needs its own installer first folds it in — "fnm" installs fnm, then Node.js by it — rather than
 * being a level of its own. A request names a path of keys; what runs is planned a step at a time,
 * each from what is on the machine when it starts, since the npm a step will use is not there before
 * the step that installs it. Node.js installed for an agent is made the default (a version manager's),
 * so the person's own shell has it too.
 */
import type { AgentInstallOutcome, InstallChoice, InstallMethod, InstallStepShown } from "@jaira/shared";
import { TOOL_PACKAGES, titleOf, type ToolPackage, type VersionManager } from "./catalog";
import { gatherInstallFacts, isVersionManager, type InstallFacts, type InstallLookup, type InstallTool } from "./locate";
import { installOriginOf } from "./origin";
import { INSTALL_VIA, installPlans, managerPlan, originPlan, type InstallPlan } from "./plan";
import { runPlan, sayTo, type InstallRunOptions } from "./run";
import { runVersion, versionSatisfies, versionWant } from "./version";

/** One step of an install: what it installs and by which way — planned only when it starts. */
export interface ChainStep {
  pkg: ToolPackage;
  /** What the step's package is called in a sentence: "Node.js", "Gemini CLI". */
  title: string;
  /** What it is looked for by: the agent's configured command, else the package's binary. */
  command: string;
  method: InstallMethod;
  /** The version it installs: `lts` for Node.js. */
  version?: string;
  /** A version manager's install made the default, so the person's own shell has it too. */
  makeDefault?: boolean;
  /** Brings the one already here up to date, the way it was installed, rather than installing another. */
  upgrade?: boolean;
  /** The oldest version that will do — looked at once the step has run, since a system's package may be older. */
  atLeast?: string;
}

/** A row of the menu as planned: its steps, and the choices for the step after. */
export interface ChainChoice {
  key: string;
  name: string;
  steps: ChainStep[];
  next?: ChainChoice[];
}

/** What the machine says beyond the package being installed: its installers, and Node.js. */
export interface ChainFacts {
  /** Every installer and version manager here (as Node.js's lookup asks for them), and where Node.js is. */
  machine: InstallFacts;
  /** The version the Node.js found says. */
  nodeVersion?: string;
}

const node = (): ToolPackage => TOOL_PACKAGES["node"]!;

/**
 * Node.js's version managers that can be installed from nothing, the recommended first. Not Volta,
 * unmaintained since 2025-11; not nvm-windows, which only an install of it already here is used through.
 */
const MANAGERS_TO_INSTALL: readonly VersionManager[] = ["fnm", "nvm", "mise"];

/** The installers each package's install puts here, for the steps after it. */
const PROVIDES: Readonly<Record<string, readonly InstallTool[]>> = {
  node: ["npm", "corepack"],
  homebrew: ["brew"],
  winget: ["winget"],
  chocolatey: ["choco"],
  fnm: ["fnm"],
  nvm: ["nvm"],
  volta: ["volta"],
  mise: ["mise"],
};

/** Look at what a multi-step install needs to know: the installers here, and Node.js with its version. */
export async function gatherChainFacts(lookup: InstallLookup): Promise<ChainFacts | undefined> {
  const machine = await gatherInstallFacts("node", node(), lookup);
  if (machine === undefined) return undefined;
  const found = machine.found;
  const nodeVersion = found !== undefined && !found.broken ? await runVersion(found.path, undefined, lookup) : undefined;
  return { machine, ...(nodeVersion !== undefined ? { nodeVersion } : {}) };
}

/** The facts as they will be once these steps have run: what each installs, there by its bare name. */
function after(facts: InstallFacts, steps: readonly ChainStep[]): InstallFacts {
  const added = steps.flatMap((step) => PROVIDES[step.pkg.name ?? step.pkg.binary] ?? []);
  if (added.length === 0) return facts;
  const tools = { ...facts.tools };
  for (const tool of added) tools[tool] ??= tool;
  const has = facts.has;
  return { ...facts, tools, has: (path) => (added as readonly string[]).includes(path) || (has?.(path) ?? true) };
}

/** What one step runs, from these facts — undefined when its way cannot run here. */
export function planStep(step: ChainStep, facts: InstallFacts): InstallPlan | undefined {
  const want = versionWant(step.version);
  if (step.upgrade === true) {
    const origin = facts.found !== undefined ? installOriginOf(facts.found.real, step.pkg) : undefined;
    if (origin === undefined || origin.method !== step.method) return undefined;
    return isVersionManager(origin.method) ? managerPlan(origin.method, step.pkg, facts, want, step.makeDefault === true) : originPlan(step.pkg, facts, origin, want);
  }
  if (isVersionManager(step.method)) return managerPlan(step.method, step.pkg, facts, want, step.makeDefault === true);
  return installPlans(step.pkg, facts, want).find((one) => one.method === step.method);
}

/**
 * The installers a way needs that can themselves be installed first, by the package that is each:
 * Homebrew for a formula or cask, WinGet and Chocolatey on Windows.
 */
const PREREQUISITES: Partial<Record<InstallMethod, { pkg: string; tool: InstallTool }>> = {
  homebrew: { pkg: "homebrew", tool: "brew" },
  winget: { pkg: "winget", tool: "winget" },
  chocolatey: { pkg: "chocolatey", tool: "choco" },
};

/** The package that installs the installer this way needs, where it is missing here and the package names something for it. */
function prerequisiteOf(method: InstallMethod, pkg: ToolPackage, facts: InstallFacts): ToolPackage | undefined {
  const need = PREREQUISITES[method];
  if (need === undefined || facts.tools[need.tool] !== undefined) return undefined;
  const windows = facts.platform === "win32";
  const named =
    method === "homebrew" ? pkg.brew !== undefined && (pkg.brew.cask ? facts.platform === "darwin" : !windows) : method === "winget" ? windows && pkg.winget !== undefined : windows && pkg.choco !== undefined;
  return named ? TOOL_PACKAGES[need.pkg] : undefined;
}

/**
 * The first way a package installs from here, as its steps — for one folded into the step it serves:
 * its own installer's where that is here, else that installer installed first (fnm by WinGet, on a
 * Windows with no WinGet yet: WinGet, then fnm).
 */
function firstSteps(pkg: ToolPackage, facts: InstallFacts): ChainStep[] | undefined {
  const step = (method: InstallMethod): ChainStep => ({ pkg, title: titleOf(pkg), command: pkg.binary, method });
  const plan = installPlans(pkg, facts)[0];
  if (plan !== undefined) return [step(plan.method)];
  for (const method of pkg.order) {
    const prerequisite = prerequisiteOf(method, pkg, facts);
    const before = prerequisite !== undefined ? installPlans(prerequisite, facts)[0] : undefined;
    if (prerequisite === undefined || before === undefined) continue;
    const steps = [{ pkg: prerequisite, title: titleOf(prerequisite), command: prerequisite.binary, method: before.method }, step(method)];
    if (planStep(steps[1]!, after(facts, steps.slice(0, 1))) !== undefined) return steps;
  }
  return undefined;
}

/** Ways to get something, as one row: the row is the one way when there is one, else it groups them. */
function groupOf(key: string, name: string, ways: readonly ChainChoice[]): ChainChoice | undefined {
  const only = ways.length === 1 ? ways[0]! : undefined;
  if (only !== undefined) return { key, name, steps: only.steps, ...(only.next !== undefined ? { next: only.next } : {}) };
  return ways.length > 0 ? { key, name, steps: [], next: [...ways] } : undefined;
}

/** A way to get a prerequisite, then what it was for. */
function wayThen(key: string, name: string, steps: ChainStep[], then: ChainChoice): ChainChoice {
  return { key, name, steps, next: [then] };
}

/**
 * The ways to get Node.js here, each then taking `then`: a version manager this machine keeps (its
 * install made the default), one that can be installed (fnm first, on every system: one program),
 * Homebrew's — installing Homebrew first where there is none — and Windows' and the Linux systems' own.
 * Node.js a manager installs is made the default and reaches the person's own terminals: fnm's env and
 * mise's activation go in their shell's profile, and on Windows fnm's default's folder on their PATH.
 * One too old is first brought up to date the way it was installed.
 */
function nodeWays(chain: ChainFacts, then: ChainChoice, atLeast: string | undefined): ChainChoice[] {
  const m = chain.machine;
  const pkg = node();
  const title = titleOf(pkg);
  const step = (method: InstallMethod, extra: Partial<ChainStep> = {}): ChainStep => ({ pkg, title, command: "node", method, version: "lts", makeDefault: true, ...(atLeast !== undefined ? { atLeast } : {}), ...extra });
  const ways: ChainChoice[] = [];
  const add = (key: string, name: string, steps: ChainStep[]): void => {
    if (!ways.some((one) => one.key === key)) ways.push(wayThen(key, name, steps, then));
  };
  const found = m.found !== undefined && !m.found.broken ? m.found : undefined;
  const origin = found !== undefined ? installOriginOf(found.real, pkg) : undefined;
  if (origin !== undefined && atLeast !== undefined) add(origin.method, `Update it (${INSTALL_VIA[origin.method]})`, [step(origin.method, { upgrade: true })]);
  for (const manager of pkg.managers ?? []) if (m.tools[manager] !== undefined) add(manager, INSTALL_VIA[manager], [step(manager)]);
  for (const manager of MANAGERS_TO_INSTALL) {
    const its = TOOL_PACKAGES[manager];
    if (m.tools[manager] !== undefined || its === undefined) continue;
    const first = firstSteps(its, m);
    if (first !== undefined) add(manager, INSTALL_VIA[manager], [...first, step(manager)]);
  }
  // A system's installer: the one here, or — Homebrew, WinGet, Chocolatey — installed first.
  for (const method of ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"] as const) {
    const prerequisite = prerequisiteOf(method, pkg, m);
    const first = prerequisite !== undefined ? firstSteps(prerequisite, m) : [];
    if (first !== undefined) add(method, INSTALL_VIA[method], [...first, step(method)]);
  }
  return ways;
}

/** The ways to get an installer here (Homebrew, WinGet, Chocolatey), each then taking `then`. */
function prerequisiteWays(pkg: ToolPackage, chain: ChainFacts, then: ChainChoice): ChainChoice[] {
  return installPlans(pkg, chain.machine).map((plan) => wayThen(plan.method, plan.via, [{ pkg, title: titleOf(pkg), command: pkg.binary, method: plan.method }], then));
}

/**
 * The install menu for a package that is not installed: each way its vendor offers, in their order —
 * the way itself where its installer is here, else a row for the installer it needs (Node.js for npm,
 * Homebrew for a formula or cask) whose ways each install that, then go on. npm with a Node.js older
 * than the package runs on is the same row: Node.js, brought up to date first.
 */
export function installChoicesOf(pkg: ToolPackage, title: string, command: string, facts: InstallFacts, chain: ChainFacts): ChainChoice[] {
  const direct = installPlans(pkg, facts);
  const step = (method: InstallMethod): ChainStep => ({ pkg, title, command, method });
  const minimum = pkg.npm?.node;
  const nodeOld = minimum !== undefined && chain.nodeVersion !== undefined && !versionSatisfies(chain.nodeVersion, minimum);
  const choices: ChainChoice[] = [];
  for (const method of pkg.order) {
    const plan = direct.find((one) => one.method === method);
    if (method === "npm" && pkg.npm !== undefined && (plan === undefined || nodeOld) && facts.platform === chain.machine.platform) {
      const then: ChainChoice = { key: "npm", name: INSTALL_VIA.npm, steps: [step("npm")] };
      const name = nodeOld ? `Node.js ${minimumWords(minimum!)}` : "Node.js";
      const group = groupOf("npm", name, nodeWays(chain, then, minimum));
      if (group !== undefined) choices.push(group);
      continue;
    }
    if (plan !== undefined) {
      choices.push({ key: method, name: plan.via, steps: [step(method)] });
      continue;
    }
    // Its installer missing, but one that can be installed: Homebrew, WinGet, Chocolatey — then the way.
    const prerequisite = facts.platform === chain.machine.platform ? prerequisiteOf(method, pkg, facts) : undefined;
    if (prerequisite !== undefined) {
      const then: ChainChoice = { key: method, name: INSTALL_VIA[method], steps: [step(method)] };
      const group = groupOf(method, INSTALL_VIA[method], prerequisiteWays(prerequisite, chain, then));
      if (group !== undefined) choices.push(group);
    }
  }
  return choices;
}

/** `>=20` as words: "20 or newer". */
function minimumWords(range: string): string {
  const at = /^>=\s*v?(\d+(?:\.\d+)*)$/.exec(range.trim());
  return at !== null ? `${at[1]} or newer` : range;
}

/**
 * The menu less what cannot run here: a row whose step could not be planned — as the steps before it
 * on the way to it will have left the machine — is left out, and a row whose next step has no way
 * left goes with them. What is shown and what a path is resolved against are the same tree.
 */
export function runnableChoices(choices: readonly ChainChoice[], factsOf: (step: ChainStep) => InstallFacts, before: readonly ChainStep[] = []): ChainChoice[] {
  const kept: ChainChoice[] = [];
  for (const choice of choices) {
    const prior = [...before];
    let runs = true;
    for (const step of choice.steps) {
      if (planStep(step, after(factsOf(step), prior)) === undefined) {
        runs = false;
        break;
      }
      prior.push(step);
    }
    if (!runs) continue;
    const next = choice.next !== undefined ? runnableChoices(choice.next, factsOf, prior) : undefined;
    if (next !== undefined && next.length === 0) continue;
    kept.push({ ...choice, ...(next !== undefined ? { next } : {}) });
  }
  return kept;
}

/** The menu as the person is shown it: each step's command as it will be once the steps before it on the way to it have run. */
export function shownChoices(choices: readonly ChainChoice[], factsOf: (step: ChainStep) => InstallFacts, before: readonly ChainStep[] = []): InstallChoice[] {
  return runnableChoices(choices, factsOf, before).map((choice) => {
    const prior = [...before];
    const steps: InstallStepShown[] = choice.steps.map((step) => {
      const plan = planStep(step, after(factsOf(step), prior))!;
      prior.push(step);
      return { title: step.title, via: plan.via, display: plan.display, ...(plan.elevated === true ? { elevated: true } : {}) };
    });
    return { key: choice.key, name: choice.name, steps, ...(choice.next !== undefined ? { next: shownChoices(choice.next, factsOf, prior) } : {}) };
  });
}

/**
 * The steps a path of keys names: the row its first key names, then at each `next` the one its next
 * key names — past the path, the first, the recommended. Undefined when a key names no row (the
 * machine changed since the menu was drawn).
 */
export function stepsOf(choices: readonly ChainChoice[], path: readonly string[]): ChainStep[] | undefined {
  const steps: ChainStep[] = [];
  let level: readonly ChainChoice[] | undefined = choices;
  for (let i = 0; level !== undefined && level.length > 0; i++) {
    const key = path[i];
    const one: ChainChoice | undefined = key !== undefined ? level.find((choice) => choice.key === key) : level[0];
    if (one === undefined) return undefined;
    steps.push(...one.steps);
    level = one.next;
  }
  return steps;
}

/** What a multi-step install looks at: the package itself, and what its steps need. */
export interface ChainRunHooks {
  /** How a step's package is looked for — {@link gatherInstallFacts} unless a caller needs more. */
  facts?: (step: Pick<ChainStep, "pkg" | "command">) => Promise<InstallFacts | undefined>;
}

/**
 * Install a package by the path chosen through its menu, a step at a time: each planned from what is
 * on the machine when it starts — the npm Node.js has just put under fnm, the brew just installed —
 * run with its output streamed after a line naming the step, and the next only once it has worked.
 * Answers when the last installer exits, with where the package's binary is now.
 */
export async function runChoice(pkg: ToolPackage, title: string, command: string, path: readonly string[], options: InstallRunOptions, hooks: ChainRunHooks = {}): Promise<AgentInstallOutcome> {
  // The machine as each step finds it: looked at again after a step, whose installer may have added to
  // the PATH where only a new terminal sees it (WinGet's portable packages, Chocolatey, fnm's default).
  let lookup: InstallRunOptions = options;
  const look = hooks.facts ?? ((step: Pick<ChainStep, "pkg" | "command">) => gatherInstallFacts(step.command, step.pkg, lookup));
  const facts = await look({ pkg, command });
  const chain = await gatherChainFacts(options);
  if (facts === undefined || chain === undefined) return { ok: false, reason: `could not look for '${command}' where it runs` };
  const factsOf = (step: ChainStep): InstallFacts => (step.pkg === pkg ? facts : chain.machine);
  const steps = stepsOf(runnableChoices(installChoicesOf(pkg, title, command, facts, chain), factsOf), path);
  if (steps === undefined || steps.length === 0) return { ok: false, reason: `that way to install ${title} is not offered here any more — check again` };
  const say = sayTo(options.onOutput);
  for (const [i, step] of steps.entries()) {
    const label = steps.length > 1 ? `step ${i + 1} of ${steps.length}, ${step.title}` : undefined;
    const now = await look(step);
    const plan = now !== undefined ? planStep(step, now) : undefined;
    if (plan === undefined) {
      const why = i > 0 ? ` after ${steps[i - 1]!.title} was installed` : "";
      return { ok: false, reason: `${INSTALL_VIA[step.method]} could not be found to install ${step.title}${why} — check again, or install it by hand` };
    }
    if (i > 0 && options.onCommand === undefined) say("\n");
    const ran = await runPlan(plan, lookup, "install", label !== undefined ? `Step ${i + 1} of ${steps.length}: ${step.title} (${INSTALL_VIA[step.method]})` : undefined);
    if (!ran.ok) return { ok: false, reason: label !== undefined ? `${label}: ${ran.reason}` : ran.reason };
    if (options.refresh !== undefined) lookup = { ...lookup, deps: await options.refresh() };
    if (step.atLeast !== undefined) {
      const got = (await look(step))?.found;
      const version = got !== undefined && !got.broken ? await runVersion(got.path, step.pkg.version, lookup) : undefined;
      if (version !== undefined && !versionSatisfies(version, step.atLeast)) {
        return { ok: false, reason: `${plan.via} installed ${step.title} ${version}, older than ${title} runs on (${minimumWords(step.atLeast)}) — choose another way` };
      }
    }
  }
  const done = await look({ pkg, command });
  const found = done?.found;
  return found !== undefined && !found.broken ? { ok: true, path: found.path, onPath: found.onPath } : { ok: true };
}
