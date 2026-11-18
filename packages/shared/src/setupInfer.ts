/**
 * The setup JaiRA FINDS when a repository has no `.jaira/setup.json`: what its version files,
 * lockfiles, Dev Container and `.gitignore` already say, written as the `default` target a setup
 * file would hold. It is shown in Open's "how it gets there" as found, runs as it is, and Save
 * writes it out as the project's file.
 *
 * Only what the repository states is used — a lockfile names the package manager, a version file
 * names a version — so a guess never installs anything the project did not ask for.
 */
import { DEFAULT_TARGET, SETUP_FORMAT_VERSION, type SetupFile, type SetupStep } from "./setup";

/**
 * The files of a checkout this reads, by path from the workspace root: `true` where only being there
 * matters, the text where the content does (`package.json`, `.gitignore`, `.devcontainer/devcontainer.json`).
 */
export type CheckoutFiles = ReadonlyMap<string, string | true>;

/** The paths {@link inferSetup} wants read, so a caller on another machine can fetch only these. */
export const INFER_SETUP_FILES = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  "package.json",
  ".nvmrc",
  ".node-version",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  ".python-version",
  "Gemfile",
  ".ruby-version",
  "Cargo.toml",
  "rust-toolchain.toml",
  "go.mod",
  "mise.toml",
  ".tool-versions",
  ".gitignore",
] as const;

/** The setup a checkout's own files describe; undefined when they describe none. */
export function inferSetup(files: CheckoutFiles): SetupFile | undefined {
  const has = (path: string): boolean => files.has(path);
  const text = (path: string): string | undefined => {
    const v = files.get(path);
    return typeof v === "string" ? v : undefined;
  };
  const steps: SetupStep[] = [];

  if (has(".devcontainer/devcontainer.json") || has(".devcontainer.json")) {
    steps.push(has(".devcontainer/devcontainer.json") ? { use: "devcontainer", fields: {} } : { use: "devcontainer", fields: { file: ".devcontainer.json" } });
  } else {
    if (has("mise.toml")) steps.push({ use: "mise", fields: {} });
    else if (has(".tool-versions")) steps.push({ use: "asdf", fields: {} });
    const managed = has("mise.toml") || has(".tool-versions");

    if (has("package.json")) {
      const pkg = parseJson(text("package.json"));
      const engines = pkg && typeof pkg["engines"] === "object" && pkg["engines"] !== null ? (pkg["engines"] as Record<string, unknown>) : undefined;
      if (!managed) {
        const nodeVersion = has(".nvmrc") ? ".nvmrc" : has(".node-version") ? ".node-version" : typeof engines?.["node"] === "string" ? "package.json" : undefined;
        steps.push({ install: "node", ...(nodeVersion ? { version: nodeVersion } : {}) });
      }
      const declared = typeof pkg?.["packageManager"] === "string" ? (pkg["packageManager"] as string).split("@")[0] : undefined;
      const [pm, lock] = packageManagerOf(declared, has);
      if (pm !== "npm") steps.push({ install: pm, ...(declared === pm ? { version: "package.json" } : {}) });
      steps.push({ run: pm === "npm" && lock === "package-lock.json" ? "npm ci" : `${pm} install`, ...(lock ? { again: [lock] } : {}) });
    }

    if (has("pyproject.toml") || has("requirements.txt")) {
      if (!managed && has(".python-version")) steps.push({ install: "python", version: ".python-version" });
      if (has("uv.lock")) steps.push({ use: "uv", fields: {}, again: ["uv.lock"] });
      else if (has("poetry.lock")) steps.push({ use: "poetry", fields: {}, again: ["poetry.lock"] });
      else if (has("requirements.txt")) steps.push({ use: "venv", fields: {}, again: ["requirements.txt"] });
      else if (has("pyproject.toml")) steps.push({ use: "uv", fields: {} });
    }

    if (has("Gemfile")) {
      if (!managed && has(".ruby-version")) steps.push({ install: "ruby", version: ".ruby-version" });
      steps.push({ use: "bundler", fields: {}, again: ["Gemfile.lock"] });
    }

    if (has("Cargo.toml")) {
      if (!managed) steps.push({ install: "rust", ...(has("rust-toolchain.toml") ? { version: "rust-toolchain.toml" } : {}) });
      steps.push({ run: "cargo fetch", again: ["Cargo.lock"] });
    }

    if (has("go.mod")) {
      if (!managed) steps.push({ install: "go", version: "go.mod" });
      steps.push({ run: "go mod download", again: ["go.sum"] });
    }
  }

  const bring = bringPatterns(text(".gitignore"));
  if (bring.length > 0) steps.push({ bring });
  if (steps.length === 0) return undefined;
  return { version: SETUP_FORMAT_VERSION, targets: { [DEFAULT_TARGET]: { steps } } };
}

function packageManagerOf(declared: string | undefined, has: (path: string) => boolean): ["npm" | "pnpm" | "yarn" | "bun", string | undefined] {
  const locks: [("npm" | "pnpm" | "yarn" | "bun"), string][] = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
    ["npm", "package-lock.json"],
  ];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") {
    const lock = locks.find(([pm, file]) => pm === declared && has(file))?.[1];
    return [declared, lock];
  }
  const found = locks.find(([, file]) => has(file));
  return found ? [found[0], found[1]] : ["npm", undefined];
}

/**
 * The files git ignores that a new workspace usually needs: the `.env` files the `.gitignore` names,
 * which hold a project's local secrets and settings. Nothing else — build output and dependencies are
 * made again by the steps, not brought.
 */
export function bringPatterns(gitignore: string | undefined): string[] {
  if (!gitignore) return [];
  const out: string[] = [];
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const pattern = line.replace(/^\//, "");
    if (/^\.env([.*][^/]*)?$/.test(pattern) && !/\.(example|sample|template)$/.test(pattern) && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
