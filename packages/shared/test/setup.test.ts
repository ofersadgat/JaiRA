/**
 * The setup file: reading it (JSON and YAML, every problem with its path), the machine's own `.local`
 * over the committed one, and a target planned for one machine — `target` steps opened, `on` kept,
 * `first` decided.
 */
import { describe, expect, it } from "vitest";
import {
  mergeSetupFiles,
  onFits,
  parseSetupText,
  planSetupTarget,
  readSetupValue,
  setupFormatOf,
  setupMachineOf,
  setupOsTag,
  stepKindOf,
  useFileOf,
  type SetupFile,
  type SetupMachine,
  type UseStep,
} from "../src/index";

const ATLAS = {
  version: 1,
  default: [
    { target: "node" },
    { install: "vips" },
    { run: "brew bundle", on: ["macos"] },
    { bring: ".env*.local" },
    { run: "pnpm install", again: ["pnpm-lock.yaml"] },
  ],
  node: [
    { install: "node", version: ".nvmrc" },
    { install: "pnpm", version: "package.json" },
  ],
  environment: [{ first: [{ use: "compose", file: "compose.dev.yml", when: "open" }, { install: "postgres", version: 16 }] }],
  gpu: { on: ["cuda"], steps: [{ install: "cuda", version: "12.4" }] },
};

function read(value: unknown): SetupFile {
  const result = readSetupValue(value);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.file;
}

const LINUX: SetupMachine = { name: "build-01", tags: ["linux", "x64", "ci"] };
const MAC: SetupMachine = { name: "mac-air", tags: ["mac", "arm64"] };

describe("reading a setup file", () => {
  it("reads targets, steps and use fields, keeping a numeric version as text", () => {
    const file = read(ATLAS);
    expect(Object.keys(file.targets)).toEqual(["default", "node", "environment", "gpu"]);
    expect(file.targets["default"]!.steps.map(stepKindOf)).toEqual(["target", "install", "run", "bring", "run"]);
    expect(file.targets["default"]!.steps[3]).toEqual({ bring: [".env*.local"] });
    const first = file.targets["environment"]!.steps[0]!;
    expect("first" in first && first.first[0]).toEqual({ use: "compose", fields: { file: "compose.dev.yml" }, when: "open" });
    expect("first" in first && first.first[1]).toEqual({ install: "postgres", version: "16" });
    expect(file.targets["gpu"]!.on).toEqual(["cuda"]);
  });

  it("reads the same file written as YAML", () => {
    const yaml = [
      "version: 1",
      "default:",
      "  - target: node",
      "  - run: pnpm install",
      "    again: [pnpm-lock.yaml]",
      "node:",
      "  - install: node",
      "    version: .nvmrc",
    ].join("\n");
    const result = parseSetupText(yaml, "yaml");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.targets["node"]!.steps).toEqual([{ install: "node", version: ".nvmrc" }]);
  });

  it("accepts comments in the JSON form and says where the text is broken", () => {
    expect(parseSetupText('{ "version": 1, // ok\n "default": [] }', "json").ok).toBe(true);
    const broken = parseSetupText('{ "version": 1, "default": [ }', "json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.problems[0]!.path).toBe("(file)");
  });

  it("names every problem with its path", () => {
    const result = readSetupValue({
      version: 2,
      default: [{ run: "x", install: "y" }, { use: "githb" }, { use: "github", job: "build" }, { target: "nope" }, { run: "x", when: "later" }],
      "bad name": [],
      odd: { on: ["linux"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.problems.map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining(["version", "default[0]", "default[1].use", "default[2].file", "default[3].target", "default[4].when", "bad name", "odd.steps"]),
    );
  });

  it("refuses a field a use kind does not take, and a value outside its choices", () => {
    const result = readSetupValue({ version: 1, default: [{ use: "devcontainer", in: "cloud" }, { use: "nvm", job: "x" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.path)).toEqual(["default[0].in", "default[1].job"]);
  });

  it("lets a use kind's own fields share a name with nothing else", () => {
    const file = read({ version: 1, default: [{ use: "make", rule: "setup" }, { use: "github", file: "ci.yml", job: "build", skip: "Deploy" }] });
    expect(file.targets["default"]!.steps).toEqual([
      { use: "make", fields: { rule: "setup" } },
      { use: "github", fields: { file: "ci.yml", job: "build", skip: ["Deploy"] } },
    ]);
  });

  it("finds targets that run each other in a circle", () => {
    const result = readSetupValue({ version: 1, a: [{ target: "b" }], b: [{ first: [{ target: "a" }] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.message.includes("circle"))).toBe(true);
  });

  it("knows a file's format by its name and a use step's file by its kind", () => {
    expect(setupFormatOf("setup.json")).toBe("json");
    expect(setupFormatOf("setup.local.yml")).toBe("yaml");
    expect(setupFormatOf("setup.toml")).toBeUndefined();
    const nvm: UseStep = { use: "nvm", fields: {} };
    expect(useFileOf(nvm)).toBe(".nvmrc");
    expect(useFileOf({ use: "nvm", fields: { file: ".node-version" } })).toBe(".node-version");
  });
});

describe("the machine's own file", () => {
  it("replaces a target it names and adds the ones it does not", () => {
    const committed = read(ATLAS);
    const local = read({ version: 1, environment: [{ run: "pg_ctl start", when: "open" }], mine: [{ run: "echo hi" }] });
    const merged = mergeSetupFiles(committed, local)!;
    expect(merged.targets["environment"]!.steps).toEqual([{ run: "pg_ctl start", when: "open" }]);
    expect(merged.targets["mine"]).toBeDefined();
    expect(merged.targets["default"]).toEqual(committed.targets["default"]);
    expect(mergeSetupFiles(undefined, local)).toBe(local);
    expect(mergeSetupFiles(committed, undefined)).toBe(committed);
  });
});

describe("planning a target for a machine", () => {
  it("opens target steps, keeps on, and remembers which targets a step came through", () => {
    const file = read(ATLAS);
    const linux = planSetupTarget(file, "default", LINUX);
    expect(linux.ok && linux.steps.map((s) => [stepKindOf(s), s.via.join(">")])).toEqual([
      ["install", "default>node"],
      ["install", "default>node"],
      ["install", "default"],
      ["bring", "default"],
      ["run", "default"],
    ]);
    const mac = planSetupTarget(file, "default", MAC);
    expect(mac.ok && mac.steps.some((s) => "run" in s && s.run === "brew bundle")).toBe(true);
  });

  it("matches on by tag or by machine name, without case", () => {
    expect(onFits(["LINUX"], LINUX)).toBe(true);
    expect(onFits(["build-01"], LINUX)).toBe(true);
    expect(onFits(["macos", "wsl"], LINUX)).toBe(false);
    expect(onFits(undefined, LINUX)).toBe(true);
  });

  it("keeps a whole target to its machines", () => {
    const file = read(ATLAS);
    expect(planSetupTarget(file, "gpu", LINUX)).toEqual({ ok: true, steps: [] });
    const gpu = planSetupTarget(file, "gpu", { name: "gpu-box", tags: ["linux", "cuda"] });
    expect(gpu.ok && gpu.steps.length).toBe(1);
  });

  it("takes the first alternative the machine can do, and passes a first step's when on", () => {
    const file = read(ATLAS);
    const withDocker = planSetupTarget(file, "environment", LINUX, { canDo: () => true });
    expect(withDocker.ok && withDocker.steps).toEqual([{ use: "compose", fields: { file: "compose.dev.yml" }, when: "open", via: ["environment"] }]);
    const noDocker = planSetupTarget(file, "environment", LINUX, { canDo: (steps) => !steps.some((s) => "use" in s && s.use === "compose") });
    expect(noDocker.ok && noDocker.steps).toEqual([{ install: "postgres", version: "16", via: ["environment"] }]);
  });

  it("says so when nothing in a first can be done, unless the step is optional", () => {
    const file = read({ version: 1, default: [{ first: [{ run: "a", on: ["windows"] }] }], soft: [{ first: [{ run: "a", on: ["windows"] }], optional: true }] });
    const hard = planSetupTarget(file, "default", LINUX);
    expect(hard.ok).toBe(false);
    expect(planSetupTarget(file, "soft", LINUX)).toEqual({ ok: true, steps: [] });
    expect(planSetupTarget(file, "missing", LINUX).ok).toBe(false);
  });

  it("tags where commands run: WSL is its own, not linux and not windows; macos is mac", () => {
    expect(setupOsTag("mac")).toBe("mac");
    expect(setupOsTag("linux")).toBe("linux");
    expect(setupOsTag("windows")).toBe("windows");
    expect(setupOsTag("windows", true)).toBe("wsl");
    const wsl = setupMachineOf({ label: "win-desk", os: "windows", tags: ["gpu"], arch: "x64" }, true);
    expect(wsl).toEqual({ name: "win-desk", tags: ["wsl", "x64", "gpu"] });
    expect(onFits(["linux"], wsl)).toBe(false);
    expect(onFits(["linux", "wsl"], wsl)).toBe(true);
    expect(onFits(["macos"], MAC)).toBe(true);
  });
});
