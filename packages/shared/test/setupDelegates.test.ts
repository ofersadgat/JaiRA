/**
 * `use` steps read out of the files they name: part of a GitHub job (this repository's own CI is the
 * fixture), a composite action, part of a GitLab job with `extends` and `!reference`, a Dev Container,
 * the one-line kinds, and versions read from version files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devcontainerOverrideOf, devcontainerPart, devcontainerShapeOf, githubPart, gitlabPart, isVersionFile, simpleUsePart, versionFromFile, type DelegateRead } from "../src/index";

const OWN_CI = readFileSync(join(__dirname, "../../../.github/workflows/ci.yml"), "utf8");

function part(read: DelegateRead) {
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  return read.part;
}

describe("part of a GitHub job", () => {
  it("takes this repository's build job through its sibling's build, as the setup it is", () => {
    const p = part(githubPart(OWN_CI, { fields: { job: "build", through: "Build declarative-ai" } }));
    expect(p.steps).toEqual([
      { clone: "ofersadgat/declarative-ai", ref: "main", path: "../declarative-ai", from: "Checkout declarative-ai sibling for file deps" },
      { install: "node", version: "22", from: "actions/setup-node@v4" },
      { run: "npm install", cwd: "../declarative-ai", from: "Install declarative-ai deps" },
      { run: "npm run build", cwd: "../declarative-ai", from: "Build declarative-ai" },
    ]);
    expect(p.skipped).toEqual([{ from: "Checkout JaiRA", why: "the code is already there" }]);
  });

  it("says which steps need what only CI has, and names the secrets", () => {
    const p = part(githubPart(OWN_CI, { fields: { job: "build", from: "Install JaiRA deps", through: "Install JaiRA deps" } }));
    expect(p.steps).toEqual([]);
    expect(p.cannot.map((c) => c.from)).toEqual(["Install JaiRA deps"]);
    expect(p.needs).toEqual(["CODEVIEW_TOKEN"]);
  });

  it("skips what it is told to and what only CI uses, and refuses an unknown step name", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    defaults: { run: { working-directory: web } }",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/cache@v4",
      "      - uses: pnpm/action-setup@v4",
      "        with: { version: 9 }",
      "      - id: deps",
      "        run: pnpm install",
      "      - name: Lint",
      "        run: pnpm lint",
      "      - uses: someone/custom@v1",
    ].join("\n");
    const p = part(githubPart(yaml, { fields: { skip: ["Lint"] } }));
    expect(p.steps).toEqual([
      { install: "pnpm", version: "9", from: "actions/setup-node".length ? "pnpm/action-setup@v4" : "" },
      { run: "pnpm install", cwd: "web", from: "deps" },
    ]);
    expect(p.skipped.map((s) => s.why)).toEqual(["the code is already there", "only means something inside CI", "skipped in the setup file"]);
    expect(p.cannot).toEqual([{ from: "someone/custom@v1", why: "JaiRA does not know the action someone/custom" }]);
    const bad = githubPart(yaml, { fields: { through: "Nope" } });
    expect(bad.ok).toBe(false);
  });

  it("reads a composite action, filling its inputs' defaults", () => {
    const action = [
      "name: setup",
      "inputs:",
      "  node: { default: '20' }",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - uses: actions/setup-node@v4",
      "      with: { node-version: '${{ inputs.node }}' }",
      "    - run: npm ci",
      "      shell: bash",
    ].join("\n");
    const p = part(githubPart(action, { fields: {} }, { action: true }));
    expect(p.steps).toEqual([
      { install: "node", version: "20", from: "actions/setup-node@v4" },
      { run: "npm ci", from: "npm ci" },
    ]);
  });
});

describe("part of a GitLab job", () => {
  const yaml = [
    "default:",
    "  image: node:22",
    "variables:",
    "  NODE_ENV: development",
    ".node:",
    "  before_script:",
    "    - corepack enable",
    ".setup:",
    "  extends: .node",
    "  before_script:",
    "    - !reference [.node, before_script]",
    "    - pnpm install",
    "build:",
    "  extends: .setup",
    "  script:",
    "    - pnpm build",
    "    - echo $CI_JOB_TOKEN",
  ].join("\n");

  it("takes a hidden job's before_script, with !reference and extends resolved", () => {
    const p = part(gitlabPart(yaml, { fields: { job: ".setup" } }));
    expect(p.steps.map((s) => ("run" in s ? s.run : ""))).toEqual(["corepack enable", "pnpm install"]);
    expect(p.image).toBe("node:22");
    expect("run" in p.steps[0]! && p.steps[0].env).toEqual({ NODE_ENV: "development" });
  });

  it("takes both scripts of a job that extends it, leaving out what needs a job token", () => {
    const p = part(gitlabPart(yaml, { fields: { job: "build", part: "both" } }));
    expect(p.steps.map((s) => ("run" in s ? s.run : ""))).toEqual(["corepack enable", "pnpm install", "pnpm build"]);
    expect(p.cannot.map((c) => c.from)).toEqual(["build.script[1]"]);
    expect(gitlabPart(yaml, { fields: { job: "nope" } }).ok).toBe(false);
  });
});

describe("a Dev Container on the machine itself", () => {
  it("turns features into installs and lifecycle commands into runs, keeping start commands for each open", () => {
    const json = `{
      // comments are allowed
      "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
      "features": {
        "ghcr.io/devcontainers/features/node:1": { "version": "22" },
        "ghcr.io/devcontainers/features/docker-in-docker:2": {},
        "ghcr.io/devcontainers/features/common-utils:2": {},
        "ghcr.io/someone/features/odd:1": {}
      },
      "postCreateCommand": "pnpm install",
      "postStartCommand": { "db": "docker compose up -d", "watch": ["pnpm", "dev --quiet"] },
      "secrets": { "DATABASE_URL": {}, "MAPS_API_KEY": {} },
    }`;
    const p = part(devcontainerPart(json));
    expect(p.steps).toEqual([
      { install: "node", version: "22", from: "features.node" },
      { install: "docker", from: "features.docker-in-docker" },
      { run: "pnpm install", from: "postCreateCommand" },
      { run: "docker compose up -d", when: "open", from: "postStartCommand.db" },
      { run: "pnpm 'dev --quiet'", when: "open", from: "postStartCommand.watch" },
    ]);
    expect(p.cannot.map((c) => c.from)).toEqual(["features.ghcr.io/someone/features/odd:1"]);
    expect(p.needs).toEqual(["DATABASE_URL", "MAPS_API_KEY"]);
    expect(p.image).toBe("mcr.microsoft.com/devcontainers/typescript-node:22");
  });
});

describe("the one-line kinds", () => {
  it("installs through the version manager named, with the version its file holds", () => {
    expect(part(simpleUsePart({ use: "nvm", fields: {} }, { fileText: "v22.11.0\n" })).steps).toEqual([
      { install: "node", version: "22.11.0", through: "nvm", from: "use nvm" },
    ]);
    expect(part(simpleUsePart({ use: "uv", fields: {} })).steps.map((s) => ("run" in s ? s.run : s))).toEqual([
      { install: "uv", from: "use uv" },
      "uv sync",
    ]);
  });

  it("runs scripts with the project's package manager and the right runner", () => {
    expect(part(simpleUsePart({ use: "npm", fields: { script: "setup" } }, { packageManager: "pnpm" })).steps).toEqual([{ run: "pnpm run setup", from: "use npm" }]);
    expect(part(simpleUsePart({ use: "shell", fields: { file: "scripts/setup.sh", args: ["--fast"] } })).steps).toEqual([
      { run: "bash scripts/setup.sh --fast", from: "use shell" },
    ]);
    expect(part(simpleUsePart({ use: "venv", fields: {} }, { os: "windows" })).steps.map((s) => ("run" in s ? s.run : "install"))).toEqual([
      "install",
      "python -m venv .venv",
      ".venv\\Scripts\\pip install -r requirements.txt",
    ]);
    // Not a reading of a file: the setup runner brings the container up (setupRun.ts).
    expect(simpleUsePart({ use: "docker", fields: { image: "node:22" } }).ok).toBe(false);
  });
});

describe("a Dev Container run as its container", () => {
  it("says how the container is made: an image, a Dockerfile, or a compose service, and who commands run as", () => {
    const image = devcontainerShapeOf('{ "image": "node:22", "remoteUser": "node", "containerEnv": { "A": "1", "B": "${localEnv:HOME}" } }');
    expect(image).toEqual({ ok: true, shape: { image: "node:22", builds: false, compose: false, user: "node", containerEnv: { A: "1" } } });
    const built = devcontainerShapeOf('{ "build": { "dockerfile": "Dockerfile" }, "containerUser": "dev" }');
    expect(built.ok && built.shape).toMatchObject({ builds: true, compose: false, user: "dev" });
    const composed = devcontainerShapeOf('{ "dockerComposeFile": "compose.yml", "service": "app" }');
    expect(composed.ok && composed.shape.compose).toBe(true);
    expect(devcontainerShapeOf("[1]").ok).toBe(false);
  });

  it("lays the workspace over at its own path, mounts the worktrees' folder too, and makes a Dockerfile's paths absolute", () => {
    const text = `{
      // a comment
      "build": { "dockerfile": "Dockerfile", "args": { "V": "1" } },
      "mounts": ["source=cache,target=/cache,type=volume"],
      "postCreateCommand": "pnpm install",
    }`;
    const override = devcontainerOverrideOf(text, { dir: "/w/app", configDir: "/w/app/.devcontainer", mounts: ["/w/.jaira-worktrees/app", "/w/app"] });
    expect(override).toEqual({
      build: { dockerfile: "/w/app/.devcontainer/Dockerfile", args: { V: "1" }, context: "/w/app/.devcontainer" },
      mounts: ["source=cache,target=/cache,type=volume", "source=/w/.jaira-worktrees/app,target=/w/.jaira-worktrees/app,type=bind"],
      postCreateCommand: "pnpm install",
      workspaceMount: "source=/w/app,target=/w/app,type=bind",
      workspaceFolder: "/w/app",
    });
    const legacy = devcontainerOverrideOf('{ "dockerFile": "../docker/Dockerfile", "context": ".." }', { dir: "/w/app", configDir: "/w/app/.devcontainer" });
    expect(legacy).toMatchObject({ dockerFile: "/w/app/docker/Dockerfile", context: "/w/app" });
    expect(legacy).not.toHaveProperty("mounts");
    expect(devcontainerOverrideOf("not json at all {", { dir: "/w", configDir: "/w" })).toBeUndefined();
  });
});

describe("a version from a version file", () => {
  it("reads each kind of file", () => {
    expect(isVersionFile(".nvmrc")).toBe(true);
    expect(isVersionFile("22.11")).toBe(false);
    expect(versionFromFile(".nvmrc", "# pinned\nv22.11.0\n", "node")).toBe("22.11.0");
    expect(versionFromFile("package.json", '{"packageManager":"pnpm@9.12.0+sha512.abc","engines":{"node":">=22"}}', "pnpm")).toBe("9.12.0");
    expect(versionFromFile("package.json", '{"engines":{"node":">=22"}}', "node")).toBe(">=22");
    expect(versionFromFile(".tool-versions", "nodejs 22.11.0\npython 3.12.1\n", "node")).toBe("22.11.0");
    expect(versionFromFile("rust-toolchain.toml", '[toolchain]\nchannel = "1.82.0"\n', "rust")).toBe("1.82.0");
    expect(versionFromFile("go.mod", "module x\n\ngo 1.22\n\ntoolchain go1.22.3\n", "go")).toBe("1.22.3");
  });
});
