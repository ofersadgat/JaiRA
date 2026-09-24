/**
 * `files:hiddenReport` and `files:whyHidden` — what each hidden-path rule does to a real checkout.
 *
 * The attribution rule itself is tested on paths in shared (`hiddenPaths.test.ts`); what is held down
 * here is the part that needs a disk and a service: that ONE walk of the project's checkout reports
 * every layer's rules with the layer that wrote them, that the preview rule is reported apart and
 * changes nothing else, that a budget that runs out says so, and that "why" answers from the same
 * rules the tree is drawn with.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { layeredHiddenRules } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { walkHiddenReport } from "../src/main/hiddenReport";

let dir: string;
let baseDir: string;
let service: AppService;

const touch = (rel: string): void => {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "x", "utf8");
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-hidden-report-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-hidden-base-"));
  const paths = initProject(dir, testHome());
  for (const rel of ["packages/app/dist/main.js", "packages/cli/dist/cli.js", "packages/app/src/a.ts", "node_modules/react/index.js", "drafts/one.md", "drafts/keep/two.md", ".env", "README.md"]) {
    touch(rel);
  }
  const doc = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as Record<string, unknown>;
  writeFileSync(paths.settingsFile, JSON.stringify({ ...doc, files: { hidden: ["drafts", "!drafts/keep"] } }, null, 2), "utf8");
  service = new AppService({ baseDir, watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

describe("files:hiddenReport", () => {
  it("walks the checkout once and gives every hidden path to the rule that decided it", async () => {
    const report = await service.hiddenReport({ project: dir });
    expect(report.root).toBe(dir);
    expect(report.capped).toBe(false);
    const of = (pattern: string) => report.rules.find((r) => r.pattern === pattern)!;
    expect(of("**/dist")).toMatchObject({ layer: "built in", hides: { files: 0, folders: 2 }, samples: ["packages/app/dist", "packages/cli/dist"] });
    expect(of("**/node_modules").hides).toEqual({ files: 0, folders: 1 });
    expect(of("**/.env").hides).toEqual({ files: 1, folders: 0 });
    expect(of(".jaira/system")).toMatchObject({ layer: "built in", hides: { files: 0, folders: 1 } });
    // The project's own rules, with its layer. `drafts` is one folder; `!drafts/keep` puts nothing
    // back, because the walk never goes inside a folder that is hidden.
    expect(of("drafts")).toMatchObject({ layer: "project", hides: { files: 0, folders: 1 } });
    expect(of("!drafts/keep")).toMatchObject({ layer: "project", hides: { files: 0, folders: 0 } });
    expect(report.extra).toBeUndefined();
  });

  it("previews a rule being typed, apart from the rest", async () => {
    const report = await service.hiddenReport({ project: dir, extra: "packages/*/src" });
    expect(report.extra).toMatchObject({ pattern: "packages/*/src", layer: "project", hides: { files: 0, folders: 1 }, samples: ["packages/app/src"] });
    expect(report.rules.some((r) => r.pattern === "packages/*/src")).toBe(false);
    // A `!` previews what it would put back.
    const back = await service.hiddenReport({ project: dir, extra: "!**/dist", layer: "base" });
    expect(back.extra).toMatchObject({ pattern: "!**/dist", layer: "base", hides: { files: 0, folders: 2 } });
  });

  it("says when its budget ran out, so the counts are at least", async () => {
    const rules = layeredHiddenRules({});
    const report = await walkHiddenReport(dir, rules, { maxEntries: 3 });
    expect(report.capped).toBe(true);
    const whole = await walkHiddenReport(dir, rules);
    expect(whole.capped).toBe(false);
  });
});

describe("files:whyHidden", () => {
  it("names the rule, its layer, and the folder that matched", () => {
    expect(service.whyHidden({ project: dir, path: "packages/cli/dist/cli.js" })).toEqual({
      hidden: true,
      rule: "**/dist",
      layer: "built in",
      via: "packages/cli/dist",
    });
    expect(service.whyHidden({ project: dir, path: "drafts/keep/two.md" })).toEqual({ hidden: true, rule: "drafts", layer: "project", via: "drafts" });
    expect(service.whyHidden({ project: dir, path: "packages/app/src/a.ts" })).toEqual({ hidden: false });
  });

  it("takes a full path inside the root, and refuses one outside it", () => {
    expect(service.whyHidden({ project: dir, path: join(dir, "node_modules", "react") })).toMatchObject({ hidden: true, rule: "**/node_modules", via: "node_modules" });
    expect(() => service.whyHidden({ project: dir, path: join(baseDir, "x") })).toThrow(/not inside/);
  });
});
