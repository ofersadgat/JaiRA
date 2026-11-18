/**
 * What a `use` step of the setup file comes to: the steps another tool's file already describes,
 * read out of that file — part of a GitHub Actions job or a composite action, part of a GitLab CI job,
 * a Dev Container's features and lifecycle commands, or the one or two commands a version manager,
 * an environment tool or a script runner stands for — and the version a file holds for `install`.
 *
 * Everything here is a pure reading of text the caller has already fetched: the runner reads the file
 * on the machine, hands it here, and runs what comes back.
 *
 * ## A CI file is reused a PART at a time
 *
 * A CI job sets up an environment and then does CI things with it — tests, uploads, deploys. Only the
 * first half is wanted, so a `github` step names the job and the steps `from`/`through`/`skip`, and a
 * `gitlab` step names a job (a hidden `.setup` one, usually) and which of its scripts. What a runner
 * outside CI cannot do is said, not guessed at:
 *
 * - `actions/checkout` of the repository itself is skipped — the code is already there. A checkout of
 *   ANOTHER repository becomes a clone beside the workspace, at its `path`.
 * - The setup actions JaiRA knows (`actions/setup-node` and its kin) become `install` steps.
 * - A `run:` becomes a `run`, in its `working-directory` translated from the CI's workspace to this one.
 * - Caches and artifact uploads are dropped as CI-only.
 * - A step that needs a `${{ … }}` expression filled — a secret, a matrix value — or an action JaiRA
 *   does not know, is listed as `cannot`: the person skips it or puts their own step after the part.
 */
import { parseDocument, isMap, isSeq, Scalar, type Document } from "yaml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { SetupProblem, UseStep } from "./setup";

/** A step another tool's file comes to. `from` names where it came from, for the plan and the log. */
export type DelegatedStep =
  | { install: string; version?: string; through?: string; from: string }
  | { run: string; cwd?: string; env?: Record<string, string>; when?: "open"; from: string }
  | { clone: string; ref?: string; path: string; from: string };

export interface DelegatedPart {
  steps: DelegatedStep[];
  /** Steps left out on purpose, and why — a cache, an upload, the code's own checkout, a `skip`. */
  skipped: { from: string; why: string }[];
  /** Steps that cannot run outside the CI or container they were written for, and why. */
  cannot: { from: string; why: string }[];
  /** The image the part was written to run in (a Dev Container's `image`). */
  image?: string;
  /** Values the part says it needs (a Dev Container's `secrets`, a job's secret references) — names only. */
  needs?: string[];
}

export type DelegateRead = { ok: true; part: DelegatedPart } | { ok: false; problems: SetupProblem[] };

function fail(path: string, message: string): DelegateRead {
  return { ok: false, problems: [{ path, message }] };
}

function emptyPart(): DelegatedPart {
  return { steps: [], skipped: [], cannot: [] };
}

const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g;

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------------------------

/** Setup actions and the tool each installs, with the input that carries its version. */
const GITHUB_SETUP_ACTIONS: Record<string, { tool: string; inputs: readonly string[]; files?: readonly string[] }> = {
  "actions/setup-node": { tool: "node", inputs: ["node-version"], files: ["node-version-file"] },
  "actions/setup-python": { tool: "python", inputs: ["python-version"], files: ["python-version-file"] },
  "actions/setup-go": { tool: "go", inputs: ["go-version"], files: ["go-version-file"] },
  "actions/setup-java": { tool: "java", inputs: ["java-version"], files: ["java-version-file"] },
  "actions/setup-dotnet": { tool: "dotnet", inputs: ["dotnet-version"], files: ["global-json-file"] },
  "pnpm/action-setup": { tool: "pnpm", inputs: ["version"] },
  "oven-sh/setup-bun": { tool: "bun", inputs: ["bun-version"], files: ["bun-version-file"] },
  "denoland/setup-deno": { tool: "deno", inputs: ["deno-version"] },
  "astral-sh/setup-uv": { tool: "uv", inputs: ["version"] },
  "ruby/setup-ruby": { tool: "ruby", inputs: ["ruby-version"] },
  "actions-rs/toolchain": { tool: "rust", inputs: ["toolchain"] },
  "dtolnay/rust-toolchain": { tool: "rust", inputs: ["toolchain"] },
  "hashicorp/setup-terraform": { tool: "terraform", inputs: ["terraform_version"] },
  "azure/setup-helm": { tool: "helm", inputs: ["version"] },
  "azure/setup-kubectl": { tool: "kubectl", inputs: ["version"] },
  "docker/setup-buildx-action": { tool: "docker", inputs: [] },
};

/** Actions that only make sense inside CI. */
const GITHUB_CI_ONLY = /^(actions\/(cache|upload-artifact|download-artifact|github-script|labeler|stale)|codecov\/|coverallsapp\/)/;

interface GitHubOptions {
  /** A composite action (`action.yml`) rather than a workflow. */
  action?: boolean;
}

/** The steps of part of a GitHub Actions job (or of a composite action) as setup steps. */
export function githubPart(text: string, step: Pick<UseStep, "fields">, options: GitHubOptions = {}): DelegateRead {
  const doc = parseYaml(text);
  if ("problem" in doc) return fail("file", doc.problem);
  const root = rec(doc.value);
  if (!root) return fail("file", "The file is not a workflow or an action.");
  const fields = step.fields;
  let steps: unknown[];
  let defaultsCwd: string | undefined;
  let inputs: Record<string, string> = {};
  if (options.action || (rec(root["runs"]) && !root["jobs"])) {
    const runs = rec(root["runs"]);
    if (!runs || runs["using"] !== "composite" || !Array.isArray(runs["steps"]))
      return fail("file", "Only a composite action's steps can be reused; this action runs a program of its own.");
    steps = runs["steps"];
    for (const [name, input] of Object.entries(rec(root["inputs"]) ?? {})) {
      const value = str(rec(input)?.["default"]);
      if (value !== undefined) inputs[name] = value;
    }
  } else {
    const jobs = rec(root["jobs"]);
    if (!jobs) return fail("file", "The workflow has no jobs.");
    const jobName = str(fields["job"]);
    const names = Object.keys(jobs);
    const chosen = jobName ?? (names.length === 1 ? names[0] : undefined);
    if (!chosen) return fail("job", `Say which job: ${names.join(", ")}.`);
    const job = rec(jobs[chosen]);
    if (!job) return fail("job", `The workflow has no job "${chosen}"; it has ${names.join(", ")}.`);
    if (!Array.isArray(job["steps"])) return fail("job", `Job "${chosen}" has no steps of its own (it calls another workflow).`);
    steps = job["steps"];
    defaultsCwd = str(rec(rec(job["defaults"])?.["run"])?.["working-directory"]) ?? str(rec(rec(root["defaults"])?.["run"])?.["working-directory"]);
  }

  const labels = steps.map((raw, index) => {
    const one = rec(raw) ?? {};
    return str(one["name"]) ?? str(one["id"]) ?? str(one["uses"]) ?? (str(one["run"])?.split("\n")[0] ?? `step ${index + 1}`);
  });
  const indexOf = (ref: string | undefined, field: string): number | DelegateRead | undefined => {
    if (ref === undefined) return undefined;
    const at = steps.findIndex((raw, index) => {
      const one = rec(raw) ?? {};
      return one["id"] === ref || one["name"] === ref || labels[index] === ref;
    });
    return at >= 0 ? at : fail(field, `No step is named or numbered "${ref}"; the steps are ${labels.map((l) => `"${l}"`).join(", ")}.`);
  };
  const fromAt = indexOf(str(fields["from"]), "from");
  if (typeof fromAt === "object") return fromAt;
  const throughAt = indexOf(str(fields["through"]), "through");
  if (typeof throughAt === "object") return throughAt;
  const skip = new Set(Array.isArray(fields["skip"]) ? fields["skip"] : typeof fields["skip"] === "string" ? [fields["skip"]] : []);

  const part = emptyPart();
  // Where the CI put the repository itself, so its working directories can be read against this workspace.
  let selfPath: string | undefined;
  for (const raw of steps) {
    const one = rec(raw);
    if (!one) continue;
    const uses = str(one["uses"]);
    if (uses && actionName(uses) === "actions/checkout" && !str(rec(one["with"])?.["repository"])) {
      selfPath = str(rec(one["with"])?.["path"]);
      break;
    }
  }
  const relative = (ciPath: string | undefined): string | undefined => ciRelative(ciPath, selfPath);
  const needs = new Set<string>();

  steps.forEach((raw, index) => {
    if (fromAt !== undefined && index < fromAt) return;
    if (throughAt !== undefined && index > throughAt) return;
    const label = labels[index]!;
    const one = rec(raw);
    if (!one) return;
    if (skip.has(label) || (str(one["id"]) && skip.has(str(one["id"])!))) {
      part.skipped.push({ from: label, why: "skipped in the setup file" });
      return;
    }
    const uses = str(one["uses"]);
    const withs = rec(one["with"]) ?? {};
    const env = stringRecord(one["env"]);
    const exprs = [...collectExpressions(one["run"]), ...collectExpressions(env), ...collectExpressions(withs)]
      .map((expr) => fillInput(expr, inputs))
      .filter((expr): expr is string => expr !== null);
    for (const expr of exprs) {
      const secret = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
      if (secret) needs.add(secret[1]!);
    }
    if (uses) {
      const name = actionName(uses);
      if (name === "actions/checkout") {
        const repository = str(withs["repository"]);
        if (!repository) {
          part.skipped.push({ from: label, why: "the code is already there" });
          return;
        }
        const path = relative(str(withs["path"]) ?? repository.split("/").pop());
        part.steps.push({ clone: repository, ...(str(withs["ref"]) ? { ref: str(withs["ref"])! } : {}), path: path ?? repository.split("/").pop()!, from: label });
        return;
      }
      if (GITHUB_CI_ONLY.test(name)) {
        part.skipped.push({ from: label, why: "only means something inside CI" });
        return;
      }
      const setup = GITHUB_SETUP_ACTIONS[name];
      if (setup) {
        const version = setup.inputs.map((input) => str(withs[input])).find((v) => v !== undefined) ?? toolchainFromRef(name, uses);
        const versionFile = (setup.files ?? []).map((input) => str(withs[input])).find((v) => v !== undefined);
        const v = version !== undefined ? fillTemplate(version, inputs) : versionFile !== undefined ? relative(versionFile) : undefined;
        if (v === null) {
          part.cannot.push({ from: label, why: "its version comes from an expression only CI can fill" });
          return;
        }
        part.steps.push({ install: setup.tool, ...(v !== undefined ? { version: v } : {}), from: label });
        return;
      }
      if (uses.startsWith("./")) {
        part.cannot.push({ from: label, why: `it calls the local action ${uses}; reuse that with its own use step` });
        return;
      }
      part.cannot.push({ from: label, why: `JaiRA does not know the action ${name}` });
      return;
    }
    const run = str(one["run"]);
    if (run === undefined) return;
    const filled = fillTemplate(run, inputs);
    const filledEnv: Record<string, string> = {};
    let envOk = true;
    for (const [key, value] of Object.entries(env ?? {})) {
      const v = fillTemplate(value, inputs);
      if (v === null) envOk = false;
      else filledEnv[key] = v;
    }
    if (filled === null || !envOk) {
      part.cannot.push({ from: label, why: "it needs an expression only CI can fill (a secret, a matrix value)" });
      return;
    }
    const cwd = relative(str(one["working-directory"]) ?? defaultsCwd);
    part.steps.push({ run: filled, ...(cwd && cwd !== "." ? { cwd } : {}), ...(Object.keys(filledEnv).length ? { env: filledEnv } : {}), from: label });
  });
  if (needs.size > 0) part.needs = [...needs];
  return { ok: true, part };
}

/** `actions/setup-node@v4` → `actions/setup-node`; `dtolnay/rust-toolchain@stable` keeps its ref for the toolchain. */
function actionName(uses: string): string {
  return uses.split("@")[0]!.toLowerCase();
}

function toolchainFromRef(name: string, uses: string): string | undefined {
  if (name !== "dtolnay/rust-toolchain") return undefined;
  const ref = uses.split("@")[1];
  return ref && !/^v?\d/.test(ref) ? ref : undefined;
}

/**
 * A CI path against this workspace. The CI's workspace holds the repository at `selfPath` (or is the
 * repository when there is none); anything else in it sits BESIDE the repository here.
 */
function ciRelative(ciPath: string | undefined, selfPath: string | undefined): string | undefined {
  if (ciPath === undefined) return undefined;
  const clean = ciPath.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!selfPath) return clean === "" ? "." : clean;
  const self = selfPath.replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean === self) return ".";
  if (clean.startsWith(`${self}/`)) return clean.slice(self.length + 1);
  return `../${clean}`;
}

function collectExpressions(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") for (const m of v.matchAll(EXPRESSION)) out.push(m[1]!);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (rec(v)) Object.values(v as object).forEach(visit);
  };
  visit(value);
  return out;
}

/** An expression a composite action's input default can fill, else null when only CI could. */
function fillInput(expr: string, inputs: Record<string, string>): string | null {
  const input = /^inputs\.([A-Za-z0-9_-]+)$/.exec(expr);
  if (input) return input[1]! in inputs ? null : expr;
  return expr;
}

/** Fill `${{ inputs.x }}` from defaults; null when anything else is left that only CI can fill. */
function fillTemplate(text: string, inputs: Record<string, string>): string | null {
  let unfillable = false;
  const out = text.replace(EXPRESSION, (whole, expr: string) => {
    const input = /^inputs\.([A-Za-z0-9_-]+)$/.exec(expr);
    if (input && input[1]! in inputs) return inputs[input[1]!]!;
    unfillable = true;
    return whole;
  });
  return unfillable ? null : out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(r)) {
    const s = str(v);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// GitLab CI
// ---------------------------------------------------------------------------------------------

/** A `!reference [job, key]` before it is resolved. */
class Reference {
  constructor(readonly path: string[]) {}
}

/** The scripts of a GitLab CI job (hidden ones too), with `extends`, `default:` and `!reference` resolved. */
export function gitlabPart(text: string, step: Pick<UseStep, "fields">): DelegateRead {
  const doc = parseYaml(text, true);
  if ("problem" in doc) return fail("file", doc.problem);
  const root = rec(doc.value);
  if (!root) return fail("file", "The file is not a GitLab CI file.");
  const jobName = str(step.fields["job"]);
  if (!jobName) return fail("job", "Say which job.");
  if (!rec(root[jobName])) {
    const jobs = Object.keys(root).filter((key) => rec(root[key]) && (rec(root[key])!["script"] !== undefined || key.startsWith(".")));
    return fail("job", `The file has no job "${jobName}"; it has ${jobs.join(", ")}.`);
  }
  const resolved = resolveJob(root, jobName, new Set());
  if ("problem" in resolved) return fail("job", resolved.problem);
  const job = resolved.job;
  const defaults = rec(root["default"]) ?? {};
  const part = emptyPart();
  const which = str(step.fields["part"]) ?? "before_script";
  const scripts: [string, unknown][] = [];
  if (which === "before_script" || which === "both") scripts.push(["before_script", job["before_script"] ?? defaults["before_script"]]);
  if (which === "script" || which === "both") scripts.push(["script", job["script"]]);
  const env = { ...stringRecord(root["variables"]), ...stringRecord(job["variables"]) };
  for (const [key, value] of scripts) {
    const lines = flattenScript(value, root);
    if ("problem" in lines) return fail(key, lines.problem);
    if (lines.lines.length === 0) {
      part.skipped.push({ from: `${jobName}.${key}`, why: "it is empty" });
      continue;
    }
    lines.lines.forEach((line, index) => {
      const from = `${jobName}.${key}[${index}]`;
      if (/\$\{?CI_JOB_TOKEN\b|\$\{?CI_REGISTRY_PASSWORD\b/.test(line)) {
        part.cannot.push({ from, why: "it uses a token only a CI job has" });
        return;
      }
      part.steps.push({ run: line, ...(Object.keys(env).length ? { env } : {}), from });
    });
  }
  const image = str(job["image"]) ?? str(rec(job["image"])?.["name"]) ?? str(defaults["image"]) ?? str(rec(defaults["image"])?.["name"]);
  if (image) part.image = image;
  return { ok: true, part };
}

function resolveJob(root: Record<string, unknown>, name: string, seen: Set<string>): { job: Record<string, unknown> } | { problem: string } {
  if (seen.has(name)) return { problem: `${[...seen, name].join(" → ")} extend each other in a circle.` };
  const job = rec(root[name]);
  if (!job) return { problem: `There is no job "${name}" to extend.` };
  const parents = typeof job["extends"] === "string" ? [job["extends"]] : Array.isArray(job["extends"]) ? job["extends"].filter((p): p is string => typeof p === "string") : [];
  let merged: Record<string, unknown> = {};
  for (const parent of parents) {
    const resolved = resolveJob(root, parent, new Set([...seen, name]));
    if ("problem" in resolved) return resolved;
    merged = deepMerge(merged, resolved.job);
  }
  const own = { ...job };
  delete own["extends"];
  return { job: deepMerge(merged, own) };
}

/** GitLab's `extends` merges maps key by key, and replaces everything else. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const a = rec(out[key]);
    const b = rec(value);
    out[key] = a && b ? deepMerge(a, b) : value;
  }
  return out;
}

function flattenScript(value: unknown, root: Record<string, unknown>, depth = 0): { lines: string[] } | { problem: string } {
  if (depth > 10) return { problem: "Its !reference tags go too deep." };
  if (value === undefined || value === null) return { lines: [] };
  if (typeof value === "string") return { lines: [value] };
  if (value instanceof Reference) {
    let at: unknown = root;
    for (const key of value.path) at = rec(at)?.[key];
    if (at === undefined) return { problem: `!reference [${value.path.join(", ")}] names nothing in the file.` };
    return flattenScript(at, root, depth + 1);
  }
  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const one of value) {
      const inner = flattenScript(one, root, depth + 1);
      if ("problem" in inner) return inner;
      lines.push(...inner.lines);
    }
    return { lines };
  }
  return { problem: "A script is a line or a list of lines." };
}

// ---------------------------------------------------------------------------------------------
// Dev Containers
// ---------------------------------------------------------------------------------------------

/** Dev Container features JaiRA can install on the machine itself, by the tool each one is. */
const DEVCONTAINER_FEATURES: Record<string, string> = {
  node: "node",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  ruby: "ruby",
  dotnet: "dotnet",
  php: "php",
  "docker-in-docker": "docker",
  "docker-outside-of-docker": "docker",
  "github-cli": "gh",
  "aws-cli": "aws",
  "azure-cli": "az",
  "kubectl-helm-minikube": "kubectl",
  terraform: "terraform",
  "common-utils": "",
  git: "git",
};

/** The lifecycle commands, in the order a Dev Container runs them, and whether each runs once or each open. */
const LIFECYCLE: readonly [string, "once" | "open"][] = [
  ["initializeCommand", "once"],
  ["onCreateCommand", "once"],
  ["updateContentCommand", "once"],
  ["postCreateCommand", "once"],
  ["postStartCommand", "open"],
  ["postAttachCommand", "open"],
];

/** A Dev Container on the machine itself: features become installs, lifecycle commands become runs. */
export function devcontainerPart(text: string): DelegateRead {
  let value: unknown;
  try {
    value = parseJsonc(text, [], { allowTrailingComma: true });
  } catch (error) {
    return fail("file", error instanceof Error ? error.message : String(error));
  }
  const root = rec(value);
  if (!root) return fail("file", "The file is not a devcontainer.json.");
  const part = emptyPart();
  for (const [id, options] of Object.entries(rec(root["features"]) ?? {})) {
    const short = id.replace(/:[^/:]*$/, "").split("/").pop()!;
    const tool = DEVCONTAINER_FEATURES[short];
    if (tool === undefined) {
      part.cannot.push({ from: `features.${id}`, why: "JaiRA does not know how to put this feature on a machine" });
      continue;
    }
    if (tool === "") {
      part.skipped.push({ from: `features.${id}`, why: "it sets up the container itself" });
      continue;
    }
    const version = typeof options === "string" ? options : str(rec(options)?.["version"]);
    part.steps.push({ install: tool, ...(version && version !== "latest" && version !== "lts" ? { version } : {}), from: `features.${short}` });
  }
  const env = { ...stringRecord(root["containerEnv"]), ...stringRecord(root["remoteEnv"]) };
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => !/\$\{(containerEnv|localEnv|containerWorkspaceFolder)/.test(v)));
  for (const [key, when] of LIFECYCLE) {
    const command = root[key];
    if (command === undefined) continue;
    const runs = lifecycleRuns(command);
    runs.forEach(({ run, name }) =>
      part.steps.push({ run, ...(when === "open" ? { when: "open" as const } : {}), ...(Object.keys(clean).length ? { env: clean } : {}), from: name ? `${key}.${name}` : key }),
    );
  }
  const secrets = Object.keys(rec(root["secrets"]) ?? {});
  if (secrets.length > 0) part.needs = secrets;
  const image = str(root["image"]);
  if (image) part.image = image;
  return { ok: true, part };
}

// ---------------------------------------------------------------------------------------------
// A Dev Container run as a container (`in: container`)
// ---------------------------------------------------------------------------------------------

/** What a devcontainer.json says about the container itself, for running a workspace inside it. */
export interface DevcontainerShape {
  /** The image it runs, when it names one. */
  image?: string;
  /** It builds its image from a Dockerfile (`build.dockerfile`, or the older `dockerFile`). */
  builds: boolean;
  /** It is one service of a compose file (`dockerComposeFile`). */
  compose: boolean;
  /** Who commands run as inside: `remoteUser`, else `containerUser`. */
  user?: string;
  /** `containerEnv`: set on the container when it is made. */
  containerEnv: Record<string, string>;
}

/** A devcontainer.json read strictly — a container made from half a file is worse than none. */
function parseDevcontainer(text: string): Record<string, unknown> | string {
  const errors: ParseError[] = [];
  let value: unknown;
  try {
    value = parseJsonc(text, errors, { allowTrailingComma: true });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (errors.length > 0) return `The file is not JSON a Dev Container reads (at character ${errors[0]!.offset}).`;
  return rec(value) ?? "The file is not a devcontainer.json.";
}

/** How a devcontainer.json makes its container: an image, a Dockerfile, or a compose service. */
export function devcontainerShapeOf(text: string): { ok: true; shape: DevcontainerShape } | { ok: false; problems: SetupProblem[] } {
  const root = parseDevcontainer(text);
  if (typeof root === "string") return { ok: false, problems: [{ path: "file", message: root }] };
  const image = str(root["image"]);
  const user = str(root["remoteUser"]) ?? str(root["containerUser"]);
  const containerEnv = Object.fromEntries(Object.entries(stringRecord(root["containerEnv"]) ?? {}).filter(([, v]) => !/\$\{/.test(v)));
  return {
    ok: true,
    shape: {
      ...(image ? { image } : {}),
      builds: rec(root["build"])?.["dockerfile"] !== undefined || root["dockerFile"] !== undefined,
      compose: root["dockerComposeFile"] !== undefined,
      ...(user ? { user } : {}),
      containerEnv,
    },
  };
}

/** `rel` from `base`, both POSIX (a container runs on a Mac or Linux), `.` and `..` settled; an absolute `rel` as it is. */
function posixFrom(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const parts = base.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 1) parts.pop();
  }
  return parts.join("/") || "/";
}

/** A bind mount as a devcontainer.json's `mounts` and `workspaceMount` spell one: the same path inside as outside. */
export function samePathMount(path: string): string {
  return `source=${path},target=${path},type=bind`;
}

/**
 * The devcontainer.json the Dev Containers CLI is handed (`--override-config`) to run a workspace
 * inside its container: the project's own, with the workspace mounted at the SAME path inside as
 * outside (`workspaceMount`, `workspaceFolder`) — so the machine's git, file tools and paths stay
 * right, and only commands cross over — the other folders a run reaches (a task's worktree) mounted
 * the same way (`mounts`), and its relative paths (a Dockerfile, a build context) made absolute from
 * the file's own folder, since the override is read from elsewhere. Undefined for text that is not a
 * devcontainer.json.
 */
export function devcontainerOverrideOf(text: string, where: { dir: string; configDir: string; mounts?: readonly string[] }): Record<string, unknown> | undefined {
  const root = parseDevcontainer(text);
  if (typeof root === "string") return undefined;
  const out: Record<string, unknown> = { ...root, workspaceMount: samePathMount(where.dir), workspaceFolder: where.dir };
  const build = rec(root["build"]);
  if (build !== undefined) {
    const dockerfile = str(build["dockerfile"]);
    out["build"] = {
      ...build,
      ...(dockerfile !== undefined ? { dockerfile: posixFrom(where.configDir, dockerfile) } : {}),
      context: posixFrom(where.configDir, str(build["context"]) ?? "."),
    };
  }
  const legacy = str(root["dockerFile"]);
  if (legacy !== undefined) {
    out["dockerFile"] = posixFrom(where.configDir, legacy);
    out["context"] = posixFrom(where.configDir, str(root["context"]) ?? ".");
  }
  const extra = (where.mounts ?? []).filter((path) => path !== where.dir).map(samePathMount);
  if (extra.length > 0) out["mounts"] = [...(Array.isArray(root["mounts"]) ? root["mounts"] : []), ...extra];
  return out;
}

/** A lifecycle command is a shell line, an argv list, or an object of named commands that run side by side. */
function lifecycleRuns(command: unknown): { run: string; name?: string }[] {
  if (typeof command === "string") return [{ run: command }];
  if (Array.isArray(command)) return [{ run: command.map((arg) => shellQuote(String(arg))).join(" ") }];
  const named = rec(command);
  if (!named) return [];
  return Object.entries(named).flatMap(([name, one]) => lifecycleRuns(one).map((r) => ({ ...r, name })));
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------------------------
// The one-line kinds
// ---------------------------------------------------------------------------------------------

/** What a machine's checkout says, for the kinds that need it. */
export interface UseFacts {
  /** The project's package manager: from `packageManager`, else from the lockfile present. */
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** The text of the kind's file, where its version or channel is read from it. */
  fileText?: string;
  /** Where its commands run: venv's paths differ on Windows. */
  os?: "mac" | "linux" | "windows" | "wsl";
}

/** The steps a version manager, an environment tool or a script runner stands for. */
export function simpleUsePart(step: UseStep, facts: UseFacts = {}): DelegateRead {
  const f = step.fields;
  const file = str(f["file"]);
  const from = `use ${step.use}`;
  const part = emptyPart();
  const versionOf = (fileName: string, tool: string): string | undefined =>
    facts.fileText !== undefined ? versionFromFile(fileName, facts.fileText, tool) : undefined;
  const add = (s: DelegatedStep): void => {
    part.steps.push(s);
  };
  switch (step.use) {
    case "nvm":
    case "fnm": {
      const v = versionOf(file ?? (step.use === "nvm" ? ".nvmrc" : ".node-version"), "node");
      add({ install: "node", ...(v ? { version: v } : {}), through: step.use, from });
      break;
    }
    case "pyenv": {
      const v = versionOf(file ?? ".python-version", "python");
      add({ install: "python", ...(v ? { version: v } : {}), through: "pyenv", from });
      break;
    }
    case "rbenv": {
      const v = versionOf(file ?? ".ruby-version", "ruby");
      add({ install: "ruby", ...(v ? { version: v } : {}), through: "rbenv", from });
      break;
    }
    case "rustup": {
      const v = versionOf(file ?? "rust-toolchain.toml", "rust");
      add({ install: "rust", ...(v ? { version: v } : {}), through: "rustup", from });
      break;
    }
    case "mise":
      add({ install: "mise", from });
      add({ run: "mise install", from });
      break;
    case "asdf":
      add({ install: "asdf", from });
      add({ run: "asdf install", from });
      break;
    case "uv":
      add({ install: "uv", from });
      add({ run: "uv sync", from });
      break;
    case "poetry":
      add({ install: "poetry", from });
      add({ run: "poetry install", from });
      break;
    case "venv": {
      const req = file ?? "requirements.txt";
      const pip = facts.os === "windows" ? ".venv\\Scripts\\pip" : ".venv/bin/pip";
      add({ install: "python", from });
      add({ run: facts.os === "windows" ? "python -m venv .venv" : "python3 -m venv .venv", from });
      add({ run: `${pip} install -r ${shellQuote(req)}`, from });
      break;
    }
    case "conda":
      add({ install: "conda", from });
      add({ run: `conda env update --file ${shellQuote(file ?? "environment.yml")}`, from });
      break;
    case "bundler":
      add({ install: "ruby", from });
      add({ run: file ? `BUNDLE_GEMFILE=${shellQuote(file)} bundle install` : "bundle install", from });
      break;
    case "nix":
      add({ install: "nix", from });
      add({ run: "nix develop --command true", from });
      break;
    case "devbox":
      add({ install: "devbox", from });
      add({ run: "devbox install", from });
      break;
    case "compose": {
      const services = Array.isArray(f["services"]) ? f["services"] : [];
      add({ install: "docker", from });
      add({ run: ["docker compose", ...(file ? ["-f", shellQuote(file)] : []), "up -d", ...services.map(shellQuote)].join(" "), when: "open", from });
      break;
    }
    case "shell": {
      const script = file!;
      const args = (Array.isArray(f["args"]) ? f["args"] : []).map(shellQuote).join(" ");
      const runner = /\.ps1$/i.test(script) ? "pwsh -File" : /\.(cmd|bat)$/i.test(script) ? "cmd /c" : /\.sh$/i.test(script) ? "bash" : "sh";
      add({ run: `${runner} ${shellQuote(script)}${args ? ` ${args}` : ""}`, from });
      break;
    }
    case "make":
      add({ run: `make${file ? ` -f ${shellQuote(file)}` : ""} ${shellQuote(str(f["rule"])!)}`, from });
      break;
    case "just":
      add({ install: "just", from });
      add({ run: `just${file ? ` --justfile ${shellQuote(file)}` : ""} ${shellQuote(str(f["recipe"])!)}`, from });
      break;
    case "npm": {
      const pm = facts.packageManager ?? "npm";
      add({ run: `${pm} run ${shellQuote(str(f["script"])!)}`, from });
      break;
    }
    case "docker":
      // Not a reading of a file: the runner brings the container up and runs what follows inside it.
      return fail("use", 'use "docker" brings a container up; the setup runner does that (setupRun.ts), not a reading of a file.');
    default:
      return fail("use", `use "${step.use}" is read from its own file, not here.`);
  }
  return { ok: true, part };
}

// ---------------------------------------------------------------------------------------------
// A version, from a file that holds one
// ---------------------------------------------------------------------------------------------

/** Files `install`'s `version` may name instead of a version. */
export function isVersionFile(version: string): boolean {
  return /(^|\/)(\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|package\.json|rust-toolchain(\.toml)?|go\.mod|\.java-version|\.terraform-version)$/.test(version);
}

/** The version `text` (the content of `fileName`) holds for `tool`, if it holds one. */
export function versionFromFile(fileName: string, text: string, tool: string): string | undefined {
  const base = fileName.split("/").pop()!;
  const firstLine = (): string | undefined => text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).find((l) => l.length > 0);
  switch (base) {
    case ".nvmrc":
    case ".node-version":
    case ".python-version":
    case ".ruby-version":
    case ".java-version":
    case ".terraform-version":
    case "rust-toolchain":
      return firstLine()?.replace(/^v(?=\d)/, "");
    case ".tool-versions": {
      const aliases: Record<string, string[]> = { node: ["nodejs", "node"], python: ["python"], ruby: ["ruby"], go: ["golang", "go"], rust: ["rust"] };
      for (const line of text.split(/\r?\n/)) {
        const [name, version] = line.replace(/#.*$/, "").trim().split(/\s+/);
        if (name && version && (aliases[tool] ?? [tool]).includes(name)) return version;
      }
      return undefined;
    }
    case "rust-toolchain.toml":
      return /^\s*channel\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    case "go.mod":
      return /^toolchain\s+go(\S+)/m.exec(text)?.[1] ?? /^go\s+(\S+)/m.exec(text)?.[1];
    case "package.json": {
      let json: Record<string, unknown> | undefined;
      try {
        json = rec(JSON.parse(text));
      } catch {
        return undefined;
      }
      if (!json) return undefined;
      const pm = str(json["packageManager"]);
      if (pm) {
        const [name, version] = pm.split("@");
        if (name === tool && version) return version.split("+")[0];
      }
      return str(rec(json["engines"])?.[tool]);
    }
    default:
      return firstLine();
  }
}

// ---------------------------------------------------------------------------------------------

function parseYaml(text: string, gitlab = false): { value: unknown } | { problem: string } {
  let doc: Document;
  try {
    doc = parseDocument(text, {
      customTags: gitlab
        ? [
            {
              tag: "!reference",
              collection: "seq",
              resolve(seq: unknown) {
                const items = isSeq(seq) ? seq.items.map((item) => (item instanceof Scalar ? String(item.value) : String(item))) : [];
                return new Reference(items);
              },
            },
          ]
        : [],
    });
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  if (doc.errors.length > 0) return { problem: doc.errors[0]!.message };
  const value = doc.toJS({ maxAliasCount: 1000 }) as unknown;
  return isMap(doc.contents) || rec(value) ? { value } : { problem: "The file is empty or not a map." };
}
