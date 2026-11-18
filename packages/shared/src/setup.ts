/**
 * A project's setup file — `.jaira/setup.json`, or `.jaira/setup.yaml` — read as named TARGETS, and a
 * target planned for one machine as the flat list of things that machine has to do.
 *
 * ## What the file says
 *
 * `version` is the file's format (this code reads 1). Every other key is a target: a list of steps,
 * or `{ on, steps }` to keep the whole target to some machines. `default` is what a new workspace
 * runs; any other target runs when a step names it (`{ "target": "node" }`) or a workflow asks for
 * it as its environment.
 *
 * A step does exactly one thing, named by its one kind key:
 *
 * - `install` — a tool or a package, at an optional `version` (a version, or a file that holds one:
 *   `.nvmrc`, `.python-version`, `package.json` for its `packageManager`). The tool installer decides
 *   HOW on each machine, going through whatever installed it there before.
 * - `target` — runs another target of the file.
 * - `use` — hands over to something that already describes setup, with that thing's settings in
 *   their own fields: `{ "use": "github", "file": ".github/workflows/ci.yml", "job": "build",
 *   "through": "Build deps" }`. {@link USE_KINDS} lists what is understood and which fields each takes.
 * - `run` — a command, in the workspace (or `cwd` under it).
 * - `bring` — files git ignores (`.env*.local`), copied from a machine that has them.
 * - `first` — alternatives; the first one this machine can do is the one that runs.
 *
 * And any step may say `on` (machine tags — `macos`, `linux`, `windows`, `wsl`, an architecture, a
 * tag of the person's — or machine names; any one matching is enough), `when: "open"` (each time the
 * workspace opens, rather than once when it is made), `again` (files whose change after a pull runs
 * it again), `check` (a command that succeeds when the step is already done) and `optional` (its
 * failure does not stop what follows).
 *
 * ## `.local`
 *
 * `.jaira/setup.local.json` (or `.yaml`) sits beside it, uncommitted, for one machine: a target it
 * names REPLACES the committed one of that name, and a new name adds a target. Nothing finer — a
 * merge of step lists would need every step to have an identity, and a replaced target is easy to
 * read in one place.
 *
 * ## Failures are values
 *
 * As in `structured.ts`: a broken file is the moment a person most needs to be told where, so parsing
 * returns every problem with the path to it (`default[2].use`) rather than throwing at the first.
 */
import { parseStructured, type ParseSpot } from "./structured";

/** The format version this code reads and writes. */
export const SETUP_FORMAT_VERSION = 1;

/** The target a new workspace runs. */
export const DEFAULT_TARGET = "default";

/**
 * The target a workflow's task runs on its machine before it starts, when the workflow's root state
 * names none with its `setup` key (`environment` is already a state key, for operation defaults).
 */
export const ENVIRONMENT_TARGET = "environment";

/** Keys at the top of the file that are not targets. `$schema` lets an editor find the schema. */
const RESERVED_KEYS = new Set(["version", "$schema"]);

/** What a step may say besides what it does. */
export interface SetupStepCommon {
  /** Machine tags or names, any one of which lets the step run there. Absent: every machine. */
  on?: string[];
  /** `open`: each time the workspace opens. Absent: once, when the workspace is made. */
  when?: "open";
  /** Files, relative to the workspace, whose change after a pull runs the step again. */
  again?: string[];
  /** A command that succeeds when the step is already done; the step is skipped then. */
  check?: string;
  /** Its failure is reported and the setup goes on. */
  optional?: boolean;
}

export interface InstallStep extends SetupStepCommon {
  install: string;
  /** A version (`22`, `22.11`, `>=9`), or a file that holds one. Absent: any version. */
  version?: string;
}

export interface TargetStep extends SetupStepCommon {
  target: string;
}

export interface RunStep extends SetupStepCommon {
  run: string;
  /** A folder under the workspace to run it in. */
  cwd?: string;
  env?: Record<string, string>;
}

export interface BringStep extends SetupStepCommon {
  /** Patterns of files git ignores, relative to the workspace. */
  bring: string[];
  /** The machine to bring them from. Absent: the one the code came from, else the one that changed them last. */
  from?: string;
}

export interface FirstStep extends SetupStepCommon {
  first: SetupStep[];
}

export interface UseStep extends SetupStepCommon {
  use: UseKind;
  /** The kind's own fields, checked against {@link USE_KINDS}. */
  fields: Record<string, string | string[]>;
}

export type SetupStep = InstallStep | TargetStep | RunStep | BringStep | FirstStep | UseStep;

export interface SetupTarget {
  /** Machine tags or names the whole target is kept to. */
  on?: string[];
  steps: SetupStep[];
}

export interface SetupFile {
  version: number;
  targets: Record<string, SetupTarget>;
}

/** One field a `use` kind takes: a single string, or a list of them. */
interface UseField {
  kind: "string" | "list";
  /** What it means, for the schema and for the person reading a refusal. */
  about: string;
  /** Allowed values, when there are only a few. */
  values?: readonly string[];
}

interface UseKindSpec {
  about: string;
  fields: Record<string, UseField>;
  /** The fields that must be present. */
  required?: readonly string[];
  /** The file it reads when `file` is not given. */
  defaultFile?: string;
}

const FILE = (about: string): UseField => ({ kind: "string", about });

/**
 * What `use` hands over to. A version manager or an environment tool reads its usual file unless
 * `file` names another; a CI kind takes one PART of a CI file, not a whole job.
 */
export const USE_KINDS = {
  devcontainer: {
    about: "A Dev Container: on the machine, its features become installs and its lifecycle commands become steps; in its container, the workspace's commands run inside it.",
    fields: {
      file: FILE("The devcontainer.json to read."),
      in: { kind: "string", about: "Where it runs: on the machine itself (the default), or inside its container on that machine (Mac and Linux), the workspace mounted at the same path.", values: ["machine", "container"] },
    },
    defaultFile: ".devcontainer/devcontainer.json",
  },
  github: {
    about: "Part of a GitHub Actions workflow job, or a composite action: setup actions become installs, run lines become steps.",
    fields: {
      file: FILE("A workflow file, or a composite action's folder (.github/actions/setup)."),
      job: FILE("The job, in a workflow file."),
      from: FILE("The first step to take, by name or id."),
      through: FILE("The last step to take, by name or id."),
      skip: { kind: "list", about: "Steps to leave out, by name or id." },
    },
    required: ["file"],
  },
  gitlab: {
    about: "Part of a GitLab CI job — a hidden one like .setup too: its before_script, script, or both.",
    fields: {
      file: FILE("The CI file."),
      job: FILE("The job, hidden or not."),
      part: { kind: "string", about: "Which of the job's scripts.", values: ["before_script", "script", "both"] },
    },
    required: ["job"],
    defaultFile: ".gitlab-ci.yml",
  },
  docker: {
    about: "A container on the machine (Mac and Linux), from an image or a Dockerfile, with the workspace mounted at the same path: the steps after it and the commands JaiRA runs for the workspace run inside it.",
    fields: { image: FILE("The image."), file: FILE("A Dockerfile to build it from (its folder is the build context).") },
  },
  compose: {
    about: "Services to start with Docker Compose.",
    fields: { file: FILE("The compose file."), services: { kind: "list", about: "The services; all of them when absent." } },
    defaultFile: "compose.yaml",
  },
  nvm: { about: "Node through nvm.", fields: { file: FILE("The file holding the version.") }, defaultFile: ".nvmrc" },
  fnm: { about: "Node through fnm.", fields: { file: FILE("The file holding the version.") }, defaultFile: ".node-version" },
  pyenv: { about: "Python through pyenv.", fields: { file: FILE("The file holding the version.") }, defaultFile: ".python-version" },
  rbenv: { about: "Ruby through rbenv.", fields: { file: FILE("The file holding the version.") }, defaultFile: ".ruby-version" },
  rustup: { about: "Rust through rustup.", fields: { file: FILE("The toolchain file.") }, defaultFile: "rust-toolchain.toml" },
  mise: { about: "Every tool mise's file lists.", fields: { file: FILE("The mise file.") }, defaultFile: "mise.toml" },
  asdf: { about: "Every tool asdf's file lists.", fields: { file: FILE("The tool-versions file.") }, defaultFile: ".tool-versions" },
  uv: { about: "A Python environment made by uv.", fields: { file: FILE("The project file.") }, defaultFile: "pyproject.toml" },
  poetry: { about: "A Python environment made by Poetry.", fields: { file: FILE("The project file.") }, defaultFile: "pyproject.toml" },
  venv: { about: "A Python venv with a requirements file installed.", fields: { file: FILE("The requirements file.") }, defaultFile: "requirements.txt" },
  conda: { about: "A conda environment.", fields: { file: FILE("The environment file.") }, defaultFile: "environment.yml" },
  bundler: { about: "Ruby gems through Bundler.", fields: { file: FILE("The Gemfile.") }, defaultFile: "Gemfile" },
  nix: { about: "A Nix development shell.", fields: { file: FILE("The flake or shell file.") }, defaultFile: "flake.nix" },
  devbox: { about: "A Devbox environment.", fields: { file: FILE("The devbox file.") }, defaultFile: "devbox.json" },
  shell: {
    about: "A script.",
    fields: { file: FILE("The script."), args: { kind: "list", about: "Its arguments." } },
    required: ["file"],
  },
  make: { about: "A make rule.", fields: { rule: FILE("The rule."), file: FILE("The makefile.") }, required: ["rule"] },
  just: { about: "A just recipe.", fields: { recipe: FILE("The recipe."), file: FILE("The justfile.") }, required: ["recipe"] },
  npm: { about: "A package.json script, through the project's package manager.", fields: { script: FILE("The script.") }, required: ["script"] },
} as const satisfies Record<string, UseKindSpec>;

export type UseKind = keyof typeof USE_KINDS;

export function isUseKind(value: string): value is UseKind {
  return Object.prototype.hasOwnProperty.call(USE_KINDS, value);
}

/** The file a `use` step reads: its `file`, else its kind's usual one. */
export function useFileOf(step: UseStep): string | undefined {
  const file = step.fields["file"];
  if (typeof file === "string") return file;
  const spec: UseKindSpec = USE_KINDS[step.use];
  return spec.defaultFile;
}

/** Which kind of step this is. */
export type SetupStepKind = "install" | "target" | "use" | "run" | "bring" | "first";

export function stepKindOf(step: SetupStep): SetupStepKind {
  if ("install" in step) return "install";
  if ("target" in step) return "target";
  if ("use" in step) return "use";
  if ("run" in step) return "run";
  if ("bring" in step) return "bring";
  return "first";
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** One thing wrong with a file, and where. */
export interface SetupProblem {
  /** `default[2].use`, `node`, `(file)` — where in the document. */
  path: string;
  message: string;
  /** Where in the text, when the parser itself refused it. */
  spot?: ParseSpot;
}

export type SetupRead = { ok: true; file: SetupFile } | { ok: false; problems: SetupProblem[] };

export type SetupFormat = "json" | "yaml";

/** `setup.json` → json, `setup.yaml`/`.yml` → yaml. */
export function setupFormatOf(fileName: string): SetupFormat | undefined {
  if (/\.json$/i.test(fileName)) return "json";
  if (/\.ya?ml$/i.test(fileName)) return "yaml";
  return undefined;
}

/** The names the committed file and the machine's own may have, in the order they are looked for. */
export const SETUP_FILE_NAMES = ["setup.json", "setup.yaml", "setup.yml"] as const;
export const SETUP_LOCAL_FILE_NAMES = ["setup.local.json", "setup.local.yaml", "setup.local.yml"] as const;

/** Parse and check the text of a setup file. */
export function parseSetupText(text: string, format: SetupFormat): SetupRead {
  const parsed = parseStructured(text, format);
  if (!parsed.ok) return { ok: false, problems: [{ path: "(file)", message: parsed.message, ...(parsed.spot ? { spot: parsed.spot } : {}) }] };
  return readSetupValue(parsed.value);
}

const COMMON_KEYS = ["on", "when", "again", "check", "optional"] as const;
const KIND_KEYS = ["install", "target", "use", "run", "bring", "first"] as const;

/** Check an already-parsed value as a setup file. */
export function readSetupValue(value: unknown): SetupRead {
  const problems: SetupProblem[] = [];
  if (!isRecord(value)) return { ok: false, problems: [{ path: "(file)", message: "A setup file is an object of targets." }] };
  const version = value["version"];
  if (version === undefined) problems.push({ path: "version", message: `Say which format the file is in: "version": ${SETUP_FORMAT_VERSION}.` });
  else if (version !== SETUP_FORMAT_VERSION)
    problems.push({ path: "version", message: `This JaiRA reads version ${SETUP_FORMAT_VERSION} of the setup file, not ${JSON.stringify(version)}.` });

  const targets: Record<string, SetupTarget> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (RESERVED_KEYS.has(name)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      problems.push({ path: name, message: "A target's name is letters, digits, '.', '_' and '-', starting with a letter or digit." });
      continue;
    }
    const target = readTarget(raw, name, problems);
    if (target) targets[name] = target;
  }
  for (const [name, target] of Object.entries(targets)) checkTargetRefs(target.steps, name, targets, problems);
  for (const cycle of targetCycles(targets)) problems.push({ path: cycle[0]!, message: `These targets run each other in a circle: ${cycle.join(" → ")}.` });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, file: { version: SETUP_FORMAT_VERSION, targets } };
}

function readTarget(raw: unknown, path: string, problems: SetupProblem[]): SetupTarget | undefined {
  if (Array.isArray(raw)) return { steps: readSteps(raw, path, problems) };
  if (isRecord(raw)) {
    for (const key of Object.keys(raw))
      if (key !== "on" && key !== "steps") problems.push({ path: `${path}.${key}`, message: 'A target is a list of steps, or { "on": [...], "steps": [...] }.' });
    const steps = raw["steps"];
    if (!Array.isArray(steps)) {
      problems.push({ path: `${path}.steps`, message: "A target needs its steps." });
      return undefined;
    }
    const on = readStringList(raw["on"], `${path}.on`, problems);
    return { ...(on ? { on } : {}), steps: readSteps(steps, `${path}.steps`, problems) };
  }
  problems.push({ path, message: 'A target is a list of steps, or { "on": [...], "steps": [...] }.' });
  return undefined;
}

/** Where each step that was read stood in the document, for problems found after reading (an unknown target). */
const stepPaths = new WeakMap<SetupStep, string>();

function readSteps(raw: unknown[], path: string, problems: SetupProblem[]): SetupStep[] {
  const steps: SetupStep[] = [];
  raw.forEach((one, index) => {
    const step = readStep(one, `${path}[${index}]`, problems);
    if (step) {
      stepPaths.set(step, `${path}[${index}]`);
      steps.push(step);
    }
  });
  return steps;
}

function readStep(raw: unknown, path: string, problems: SetupProblem[]): SetupStep | undefined {
  if (!isRecord(raw)) {
    problems.push({ path, message: "A step is an object: { \"run\": \"...\" }, { \"install\": \"node\" }, …" });
    return undefined;
  }
  const kinds = KIND_KEYS.filter((key) => key in raw);
  if (kinds.length === 0) {
    problems.push({ path, message: `A step says what it does with one of ${KIND_KEYS.join(", ")}.` });
    return undefined;
  }
  // `use` owns every other key as its fields, so a field named like a kind (make's old "target") is not a second kind.
  const kind = kinds.includes("use") ? "use" : kinds[0]!;
  if (kind !== "use" && kinds.length > 1) {
    problems.push({ path, message: `A step does one thing; this one says ${kinds.join(" and ")}.` });
    return undefined;
  }
  const common = readCommon(raw, path, problems);
  const own = (allowed: readonly string[]): void => {
    for (const key of Object.keys(raw))
      if (!allowed.includes(key) && !(COMMON_KEYS as readonly string[]).includes(key))
        problems.push({ path: `${path}.${key}`, message: `A ${kind} step has no "${key}".` });
  };
  switch (kind) {
    case "install": {
      own(["install", "version"]);
      const install = readString(raw["install"], `${path}.install`, problems);
      const version = raw["version"] === undefined ? undefined : readVersion(raw["version"], `${path}.version`, problems);
      return install === undefined ? undefined : { ...common, install, ...(version !== undefined ? { version } : {}) };
    }
    case "target": {
      own(["target"]);
      const target = readString(raw["target"], `${path}.target`, problems);
      return target === undefined ? undefined : { ...common, target };
    }
    case "run": {
      own(["run", "cwd", "env"]);
      const run = readString(raw["run"], `${path}.run`, problems);
      const cwd = raw["cwd"] === undefined ? undefined : readString(raw["cwd"], `${path}.cwd`, problems);
      const env = raw["env"] === undefined ? undefined : readEnv(raw["env"], `${path}.env`, problems);
      return run === undefined ? undefined : { ...common, run, ...(cwd !== undefined ? { cwd } : {}), ...(env ? { env } : {}) };
    }
    case "bring": {
      own(["bring", "from"]);
      const bring = typeof raw["bring"] === "string" ? [raw["bring"]] : readStringList(raw["bring"], `${path}.bring`, problems);
      const from = raw["from"] === undefined ? undefined : readString(raw["from"], `${path}.from`, problems);
      if (bring && bring.length === 0) problems.push({ path: `${path}.bring`, message: "Say which files to bring." });
      return bring === undefined || bring.length === 0 ? undefined : { ...common, bring, ...(from !== undefined ? { from } : {}) };
    }
    case "first": {
      own(["first"]);
      const first = raw["first"];
      if (!Array.isArray(first) || first.length === 0) {
        problems.push({ path: `${path}.first`, message: "first takes a list of alternatives." });
        return undefined;
      }
      return { ...common, first: readSteps(first, `${path}.first`, problems) };
    }
    case "use":
      return readUse(raw, path, common, problems);
  }
}

function readUse(raw: Record<string, unknown>, path: string, common: SetupStepCommon, problems: SetupProblem[]): UseStep | undefined {
  const use = raw["use"];
  if (typeof use !== "string" || !isUseKind(use)) {
    problems.push({ path: `${path}.use`, message: `use takes one of ${Object.keys(USE_KINDS).join(", ")}.` });
    return undefined;
  }
  const spec: UseKindSpec = USE_KINDS[use];
  const fields: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "use" || (COMMON_KEYS as readonly string[]).includes(key)) continue;
    const field = spec.fields[key];
    if (!field) {
      const known = Object.keys(spec.fields);
      problems.push({ path: `${path}.${key}`, message: `use "${use}" has no "${key}"${known.length ? `; it takes ${known.join(", ")}` : ""}.` });
      continue;
    }
    if (field.kind === "list") {
      const list = typeof value === "string" ? [value] : readStringList(value, `${path}.${key}`, problems);
      if (list) fields[key] = list;
      continue;
    }
    const text = readString(value, `${path}.${key}`, problems);
    if (text === undefined) continue;
    if (field.values && !field.values.includes(text)) {
      problems.push({ path: `${path}.${key}`, message: `"${key}" is one of ${field.values.join(", ")}.` });
      continue;
    }
    fields[key] = text;
  }
  for (const key of spec.required ?? []) if (!(key in raw)) problems.push({ path: `${path}.${key}`, message: `use "${use}" needs "${key}".` });
  return { ...common, use, fields };
}

function readCommon(raw: Record<string, unknown>, path: string, problems: SetupProblem[]): SetupStepCommon {
  const common: SetupStepCommon = {};
  const on = readStringList(raw["on"], `${path}.on`, problems);
  if (on) common.on = on;
  if (raw["when"] !== undefined) {
    if (raw["when"] === "open") common.when = "open";
    else problems.push({ path: `${path}.when`, message: 'when is "open" (each time the workspace opens), or left out (once, when it is made).' });
  }
  const again = typeof raw["again"] === "string" ? [raw["again"]] : readStringList(raw["again"], `${path}.again`, problems);
  if (again) common.again = again;
  if (raw["check"] !== undefined) {
    const check = readString(raw["check"], `${path}.check`, problems);
    if (check !== undefined) common.check = check;
  }
  if (raw["optional"] !== undefined) {
    if (typeof raw["optional"] === "boolean") {
      if (raw["optional"]) common.optional = true;
    } else problems.push({ path: `${path}.optional`, message: "optional is true or false." });
  }
  return common;
}

function readString(value: unknown, path: string, problems: SetupProblem[]): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  problems.push({ path, message: "This should be some text." });
  return undefined;
}

/** A version may be written as a number in YAML or JSON (`22`); it is kept as the text it was. */
function readVersion(value: unknown, path: string, problems: SetupProblem[]): string | undefined {
  if (typeof value === "number") return String(value);
  return readString(value, path, problems);
}

function readStringList(value: unknown, path: string, problems: SetupProblem[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((one) => typeof one === "string")) return value as string[];
  problems.push({ path, message: "This should be a list of text." });
  return undefined;
}

function readEnv(value: unknown, path: string, problems: SetupProblem[]): Record<string, string> | undefined {
  if (isRecord(value) && Object.values(value).every((one) => typeof one === "string")) return value as Record<string, string>;
  problems.push({ path, message: "env is an object of names to text." });
  return undefined;
}

function checkTargetRefs(steps: SetupStep[], path: string, targets: Record<string, SetupTarget>, problems: SetupProblem[]): void {
  steps.forEach((step, index) => {
    const at = stepPaths.get(step) ?? `${path}[${index}]`;
    if ("target" in step && !(step.target in targets)) problems.push({ path: `${at}.target`, message: `There is no target "${step.target}" in the file.` });
    if ("first" in step) checkTargetRefs(step.first, `${at}.first`, targets, problems);
  });
}

/** Targets that end up running themselves, each cycle once. */
function targetCycles(targets: Record<string, SetupTarget>): string[][] {
  const named = (steps: SetupStep[]): string[] =>
    steps.flatMap((step) => ("target" in step ? [step.target] : "first" in step ? named(step.first) : []));
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const walk = (name: string, trail: string[]): void => {
    const at = trail.indexOf(name);
    if (at >= 0) {
      const cycle = [...trail.slice(at), name];
      const key = [...cycle.slice(0, -1)].sort().join(",");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    const target = targets[name];
    if (!target) return;
    for (const next of named(target.steps)) walk(next, [...trail, name]);
  };
  for (const name of Object.keys(targets)) walk(name, []);
  return cycles;
}

/** The machine's own file over the committed one: a target it names replaces that target; a new one is added. */
export function mergeSetupFiles(committed: SetupFile | undefined, local: SetupFile | undefined): SetupFile | undefined {
  if (!committed) return local;
  if (!local) return committed;
  return { version: committed.version, targets: { ...committed.targets, ...local.targets } };
}

// ---------------------------------------------------------------------------------------------
// Planning a target for one machine
// ---------------------------------------------------------------------------------------------

/** What a step's `on` is matched against. */
export interface SetupMachine {
  /** The machine's name, as `on` may name it. */
  name: string;
  /** Its tags, the operating system's among them (`mac`, `linux`, `windows`, or `wsl` where commands run in WSL). */
  tags: readonly string[];
}

/** A step that does something, as it will run on one machine, and which targets led to it. */
export type PlannedStep = Exclude<SetupStep, TargetStep | FirstStep> & {
  /** The targets this step came through, outermost first: `["default", "node"]`. */
  via: string[];
};

export type SetupPlan = { ok: true; steps: PlannedStep[] } | { ok: false; problems: SetupProblem[] };

export interface PlanOptions {
  /**
   * Whether this machine can do a run of steps — what picks a `first` alternative. The planner
   * itself only knows `on`; what is installed, and what can be installed, is the caller's to say.
   * Absent: every alternative whose `on` fits can be done.
   */
  canDo?: (steps: PlannedStep[]) => boolean;
}

/** Other names a person may write for an operating-system tag; the machine's own tag is the value. */
const OS_ALIASES: Record<string, string> = { macos: "mac", darwin: "mac", osx: "mac", win: "windows", win32: "windows" };

function tagKey(tag: string): string {
  const lower = tag.toLowerCase();
  return OS_ALIASES[lower] ?? lower;
}

/** Whether `on` lets a step run on this machine. Tags and names are compared without case, and `macos` is `mac`. */
export function onFits(on: readonly string[] | undefined, machine: SetupMachine): boolean {
  if (!on || on.length === 0) return true;
  const mine = new Set([machine.name.toLowerCase(), ...machine.tags.map(tagKey)]);
  return on.some((one) => mine.has(one.toLowerCase()) || mine.has(tagKey(one)));
}

/** The steps `target` comes to on `machine`, every `target` step opened and every `first` decided. */
export function planSetupTarget(file: SetupFile, target: string, machine: SetupMachine, options: PlanOptions = {}): SetupPlan {
  const problems: SetupProblem[] = [];
  const root = file.targets[target];
  if (!root) return { ok: false, problems: [{ path: target, message: `There is no target "${target}" in the file.` }] };
  if (!onFits(root.on, machine)) return { ok: true, steps: [] };
  const steps = expand(root.steps, [target], target, file, machine, options, problems);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, steps };
}

function expand(
  steps: SetupStep[],
  via: string[],
  path: string,
  file: SetupFile,
  machine: SetupMachine,
  options: PlanOptions,
  problems: SetupProblem[],
): PlannedStep[] {
  const out: PlannedStep[] = [];
  steps.forEach((step, index) => {
    const at = `${path}[${index}]`;
    if (!onFits(step.on, machine)) return;
    if ("target" in step) {
      const next = file.targets[step.target];
      if (!next) {
        problems.push({ path: `${at}.target`, message: `There is no target "${step.target}" in the file.` });
        return;
      }
      if (via.includes(step.target)) {
        problems.push({ path: `${at}.target`, message: `${[...via, step.target].join(" → ")} runs itself.` });
        return;
      }
      if (!onFits(next.on, machine)) return;
      out.push(...inherit(expand(next.steps, [...via, step.target], step.target, file, machine, options, problems), step));
      return;
    }
    if ("first" in step) {
      for (const [n, alternative] of step.first.entries()) {
        if (!onFits(alternative.on, machine)) continue;
        const scratch: SetupProblem[] = [];
        const planned = expand([alternative], via, `${at}.first[${n}]`, file, machine, options, scratch);
        if (scratch.length > 0) {
          problems.push(...scratch);
          return;
        }
        if (options.canDo && !options.canDo(planned)) continue;
        out.push(...inherit(planned, step));
        return;
      }
      if (!step.optional)
        problems.push({ path: `${at}.first`, message: `Nothing in this first can be done on ${machine.name}.` });
      return;
    }
    out.push({ ...step, via: [...via] } as PlannedStep);
  });
  return out;
}

/** A `target` or `first` step's own `when`, `again` and `optional` pass to the steps it opens into. */
function inherit(steps: PlannedStep[], from: SetupStepCommon): PlannedStep[] {
  return steps.map((step) => ({
    ...step,
    ...(from.when && !step.when ? { when: from.when } : {}),
    ...(from.again && !step.again ? { again: from.again } : {}),
    ...(from.optional && !step.optional ? { optional: true } : {}),
  }));
}

/**
 * The operating-system tag a setup step matches, from where its commands run: the machine's own OS
 * tag (`mac`, `linux`, `windows`), except that a Windows machine whose commands run in WSL is `wsl` —
 * its own tag, matching neither `windows` nor `linux`; `["linux", "wsl"]` says either.
 */
export function setupOsTag(os: "windows" | "mac" | "linux", wsl = false): "mac" | "linux" | "windows" | "wsl" {
  if (os === "windows") return wsl ? "wsl" : "windows";
  return os;
}

/** The tags a machine's setup steps are matched against: its OS tag (as {@link setupOsTag}), its architecture, and its person's tags. */
export function setupMachineOf(machine: { label: string; os: "windows" | "mac" | "linux"; tags: readonly string[]; arch?: string }, wsl = false): SetupMachine {
  const tags = [setupOsTag(machine.os, wsl), ...(machine.arch ? [machine.arch] : []), ...machine.tags];
  return { name: machine.label, tags: [...new Set(tags)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// The schema an editor holds the file to
// ---------------------------------------------------------------------------------------------

/** The setup file as JSON Schema (draft-07), for the editor's checking and completion. */
export function setupSchema(): Record<string, unknown> {
  const text = { type: "string" };
  const list = { type: "array", items: text };
  const textOrList = { oneOf: [text, list] };
  const common = {
    on: { ...list, description: "machine tags (mac, linux, windows, wsl, an architecture, your own) or machine names; any one fits" },
    when: { const: "open", description: "each time the workspace opens; left out: once, when it is made" },
    again: { ...textOrList, description: "files whose change after a pull runs this step again" },
    check: { ...text, description: "a command that succeeds when this step is already done" },
    optional: { type: "boolean", description: "its failure does not stop what follows" },
  };
  const step = (kind: string, own: Record<string, unknown>, required: string[], description: string): Record<string, unknown> => ({
    type: "object",
    description,
    properties: { ...own, ...common },
    required: [kind, ...required],
    additionalProperties: false,
  });
  const uses = Object.entries(USE_KINDS).map(([kind, spec]) => {
    const fields: Record<string, unknown> = {};
    for (const [name, field] of Object.entries((spec as UseKindSpec).fields)) {
      fields[name] = field.kind === "list" ? { ...textOrList, description: field.about } : { ...text, ...(field.values ? { enum: [...field.values] } : {}), description: field.about };
    }
    return step("use", { use: { const: kind, description: (spec as UseKindSpec).about }, ...fields }, [...((spec as UseKindSpec).required ?? [])], (spec as UseKindSpec).about);
  });
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Project setup",
    description: "How a workspace of this project is set up on a machine: named targets of steps (decision 0027).",
    type: "object",
    properties: {
      $schema: text,
      version: { const: SETUP_FORMAT_VERSION, description: "the file's format" },
    },
    required: ["version"],
    additionalProperties: { $ref: "#/definitions/target" },
    definitions: {
      target: {
        description: "a list of steps, or { on, steps } to keep the whole target to some machines",
        oneOf: [
          { type: "array", items: { $ref: "#/definitions/step" } },
          { type: "object", properties: { on: common.on, steps: { type: "array", items: { $ref: "#/definitions/step" } } }, required: ["steps"], additionalProperties: false },
        ],
      },
      step: {
        oneOf: [
          step("install", { install: { ...text, description: "a tool or a package" }, version: { oneOf: [text, { type: "number" }], description: "a version, or a file that holds one (.nvmrc, package.json)" } }, [], "install a tool or a package"),
          step("target", { target: { ...text, description: "another target of this file" } }, [], "run another target"),
          step("run", { run: text, cwd: { ...text, description: "a folder under the workspace" }, env: { type: "object", additionalProperties: text } }, [], "run a command in the workspace"),
          step("bring", { bring: { ...textOrList, description: "patterns of files git ignores" }, from: { ...text, description: "the machine to bring them from" } }, [], "copy files git ignores from a machine that has them"),
          step("first", { first: { type: "array", minItems: 1, items: { $ref: "#/definitions/step" } } }, [], "the first alternative this machine can do"),
          ...uses,
        ],
      },
    },
  };
}
