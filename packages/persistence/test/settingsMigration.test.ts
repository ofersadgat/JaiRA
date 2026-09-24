/**
 * The one-shot move of the project `policy` block (decision 0007, amended 2026-09-23), against a real
 * three-layer tree: what ships, the shared root, and a project.
 *
 * What is worth proving here: that a rule reaches every permission set of its layer — the layer's own file in
 * place, a lower layer's as an override that keeps following it — and is read back by the same loader
 * a run uses; that a line is never added where it would hand a set a shell it did not offer; that what
 * a line cannot say exactly is reported and never widened into an allow; that `smart`, the publish
 * mode, the quiet window and the built-ins land under `functions`; and that it runs once.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths, parsePermissionSet, setBuiltInDir, shellWithheld, type JairaPaths } from "@jaira/shared";
import { initProject, loadLayeredConfig, openProject } from "../src/project";
import { migrateSettingsLayers } from "../src/settingsMigration";
import { readPermissionSets } from "../src/permissionSets";

let scratch: string;
let paths: JairaPaths;
let builtIn: string;
let home: string;
let projectDir: string;

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return file;
}
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const resolved = (id: string): Record<string, unknown> | undefined => readPermissionSets(paths).find((choice) => choice.id === id)?.decl as Record<string, unknown> | undefined;
const projectSettings = (): Record<string, unknown> => readJson(paths.settingsFile);

const RULES = [
  { match: { program: "git", subcommand: "push" }, action: "deny", reason: "pushes go through review" },
  { match: { program: "npm", subcommand: "install" }, action: "allow" },
  { match: { program: "docker", anyFlag: ["--privileged", "--cap-add"] }, action: "require_approval" },
  { match: { program: "cat", argIncludes: "id_rsa" }, action: "deny" },
  { match: { program: "curl", argIncludes: "localhost" }, action: "allow" },
  { match: { subcommand: "push" }, action: "deny" },
];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-settings-migration-"));
  builtIn = join(scratch, "builtin");
  home = join(scratch, "home");
  projectDir = join(scratch, "project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(builtIn, { recursive: true });
  setBuiltInDir(builtIn);
  initProject(projectDir, home);
  paths = jairaPaths(projectDir, home, builtIn);
  write(builtIn, "permission-sets/chat/full.json", { read_file: "allow", bash: "allow", other: "allow" });
  write(builtIn, "permission-sets/chat/read-only.json", { read_file: "allow", bash: "deny", other: "deny" });
  write(builtIn, "permission-sets/chat_control/ask-first.json", { list_tasks: "ask", other: "deny" });
  write(paths.jairaDir, "permission-sets/feature/build.json", { read_file: "allow", bash: "ask", "git push": "allow" });
});

afterEach(() => {
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

/** The project layer with the whole old form in it. */
function oldProject(extra: Record<string, unknown> = {}): void {
  const starter = projectSettings();
  write(paths.jairaDir, "settings.json", {
    ...starter,
    smart: { model: "claude-haiku-4" },
    integrations: { review: { settleAfter: "30m" } },
    policy: { rules: RULES, builtins: false, remote: { publish: "allow" }, default: "require_approval", toolDefault: "deny" },
    ...extra,
  });
}

describe("migrateSettingsLayers", () => {
  it("moves smart, the publish mode, the quiet window and the built-ins under functions, and deletes the old blocks", () => {
    oldProject();
    const [report] = migrateSettingsLayers(paths);
    expect(report?.layer).toBe("project");
    const doc = projectSettings();
    expect(doc).not.toHaveProperty("policy");
    expect(doc).not.toHaveProperty("smart");
    expect(doc).not.toHaveProperty("integrations");
    expect(doc["functions"]).toEqual({
      smart: { model: "claude-haiku-4" },
      review_artifacts: { settleAfter: "30m", publish: "allow" },
      bash: { builtins: false },
    });
    // What was in the starter file is still there.
    expect(doc["storage"]).toBeDefined();
    // And the layers parse as the new form, which is the whole point.
    expect(loadLayeredConfig(paths).functions.bash.builtins).toBe(false);
  });

  it("writes every rule into every set of the layer that offers a shell — a shipped one as an override that keeps following it", () => {
    oldProject();
    migrateSettingsLayers(paths);
    const override = readJson(join(paths.jairaDir, "permission-sets/chat/full.json"));
    expect(override).toEqual({
      $ref: "$SYSTEM/permission-sets/chat/full",
      bash: "ask",
      "git push": "deny",
      "npm install": "allow",
      "docker --privileged": "ask",
      "docker --cap-add": "ask",
      cat: "deny",
    });
    // Read back by the loader a run uses: the shipped lines and the rules' lines, one map.
    expect(resolved("chat/full")).toMatchObject({ read_file: "allow", other: "allow", "git push": "deny", bash: "ask" });
    // Nothing is ever written into what ships.
    expect(readJson(join(builtIn, "permission-sets/chat/full.json"))).toEqual({ read_file: "allow", bash: "allow", other: "allow" });
  });

  it("keeps a line the set already names, and says when the set is now looser than the policy was", () => {
    oldProject();
    const [report] = migrateSettingsLayers(paths);
    const own = readJson(join(paths.jairaDir, "permission-sets/feature/build.json"));
    expect(own["git push"]).toBe("allow");
    expect(own).toMatchObject({ "npm install": "allow", "docker --privileged": "ask", cat: "deny", bash: "ask" });
    // No `other` of its own, so it takes the policy's toolDefault.
    expect(own["other"]).toBe("deny");
    expect(report!.lines.some((line) => line.startsWith(`feature/build already holds "git push": "allow", which is kept`) && line.includes("LOOSER"))).toBe(true);
  });

  it("never hands a set a shell it did not offer: a withheld shell takes only denials, a set with no shell takes nothing", () => {
    oldProject();
    const [report] = migrateSettingsLayers(paths);
    const readOnly = readJson(join(paths.jairaDir, "permission-sets/chat/read-only.json"));
    expect(readOnly).toEqual({ $ref: "$SYSTEM/permission-sets/chat/read-only", "git push": "deny", cat: "deny" });
    expect(shellWithheld(parsePermissionSet(resolved("chat/read-only")).permissionSet)).toBe(true);
    expect(existsSync(join(paths.jairaDir, "permission-sets/chat_control/ask-first.json"))).toBe(false);
    expect(report!.lines).toContain(`chat/read-only withholds its shell ("bash": "deny"), so 3 line(s) that allow or ask were not written — they would have handed it a shell.`);
    expect(report!.lines.some((line) => line.startsWith("chat_control/ask-first offers no shell"))).toBe(true);
  });

  it("reports what a line cannot say exactly — widening only a refusal or a question, never an allow", () => {
    oldProject();
    const [report] = migrateSettingsLayers(paths);
    const lines = report!.lines.join("\n");
    expect(lines).toMatch(/rule 4 .* required 'id_rsa' in an argument, which a line cannot say — written for every 'cat' instead, which refuses more than the rule did/);
    expect(lines).toMatch(/rule 5 .* cannot be a permission set line — a line cannot require 'localhost' in an argument, and allowing every 'curl' would allow more than the rule did; left out/);
    expect(lines).toMatch(/rule 6 .* cannot be a permission set line — a command line starts with the program/);
    expect(lines).toMatch(/rule 3's anyFlag is 2 lines, one per flag: "docker --privileged", "docker --cap-add"/);
    expect(lines).toMatch(/policy\.default was "require_approval"/);
    expect(lines).toMatch(/chat\/full's "bash" line goes from "allow" to "ask"/);
    expect(resolved("chat/full")).not.toHaveProperty("curl");
    // The report is kept beside a copy of every file changed in place.
    expect(readFileSync(join(report!.keptAt!, "report.txt"), "utf8")).toContain("rule 5");
    expect(readJson(join(report!.keptAt!, "originals", "settings.json"))).toHaveProperty("policy");
    expect(readJson(join(report!.keptAt!, "originals", "permission-sets/feature/build.json"))).toEqual({ read_file: "allow", bash: "ask", "git push": "allow" });
  });

  it("says where first-match-wins and most-specific-wins part, and where a rule reached past the floor", () => {
    const starter = projectSettings();
    write(paths.jairaDir, "settings.json", {
      ...starter,
      policy: {
        rules: [
          { match: { program: "git", subcommand: "push" }, action: "allow" },
          { match: { program: "git", subcommand: "push", flags: ["--tags"] }, action: "deny" },
        ],
      },
    });
    const [report] = migrateSettingsLayers(paths);
    const lines = report!.lines.join("\n");
    expect(lines).toMatch(/rule 2 \(deny\) was never reached, because rule 1 \(allow\) matched first; as lines the more specific one decides, so 'git push --tags' is now refused/);
    expect(lines).toMatch(/rule 1 used to allow git push --force, git push -f, git push --force-with-lease, git push --mirror ahead of the built-in floor/);
    expect(readJson(join(paths.jairaDir, "permission-sets/chat/full.json"))).toMatchObject({ "git push": "allow", "git push --tags": "deny" });
  });

  it("migrates the shared root too, and a project's override follows the shared root's", () => {
    write(home, "settings.json", { smart: { prompt: "be brief" }, policy: { rules: [{ match: { program: "terraform" }, action: "deny" }] } });
    oldProject();
    const reports = migrateSettingsLayers(paths);
    expect(reports.map((r) => r.layer)).toEqual(["base", "project"]);
    expect(readJson(paths.base.settingsFile)).toEqual({ functions: { smart: { prompt: "be brief" } } });
    expect(readJson(join(home, "permission-sets/chat/full.json"))).toEqual({ $ref: "$SYSTEM/permission-sets/chat/full", terraform: "deny" });
    expect(readJson(join(paths.jairaDir, "permission-sets/chat/full.json"))["$ref"]).toBe("$BASE/permission-sets/chat/full");
    expect(resolved("chat/full")).toMatchObject({ terraform: "deny", "git push": "deny" });
    expect(reports[1]!.lines.some((line) => line.startsWith("Both the shared root and this project had policy.rules."))).toBe(true);
    expect(loadLayeredConfig(paths).functions.smart).toEqual({ model: "claude-haiku-4", prompt: "be brief" });
  });

  it("is idempotent, and writes nothing when there is nothing to move", () => {
    const before = projectSettings();
    expect(migrateSettingsLayers(paths)).toEqual([]);
    expect(projectSettings()).toEqual(before);
    expect(existsSync(join(paths.systemDir, "logs"))).toBe(false);

    oldProject();
    migrateSettingsLayers(paths);
    const files = ["settings.json", "permission-sets/chat/full.json", "permission-sets/chat/read-only.json", "permission-sets/feature/build.json"].map((f) => join(paths.jairaDir, f));
    const once = files.map((f) => readFileSync(f, "utf8"));
    expect(migrateSettingsLayers(paths)).toEqual([]);
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(once);
    expect(readdirSync(join(paths.systemDir, "logs")).filter((d) => d.startsWith("settings-migration-"))).toHaveLength(1);
  });

  it("says what it would do on a dry run, and writes nothing", () => {
    oldProject();
    const before = readFileSync(paths.settingsFile, "utf8");
    const [report] = migrateSettingsLayers(paths, { dryRun: true });
    expect(report!.keptAt).toBeUndefined();
    expect(report!.written).toEqual(expect.arrayContaining([paths.settingsFile, join(paths.jairaDir, "permission-sets", "chat/full.json")]));
    expect(report!.lines.some((line) => line.startsWith("chat/full: would write"))).toBe(true);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(before);
    expect(existsSync(join(paths.jairaDir, "permission-sets/chat/full.json"))).toBe(false);
  });

  it("drops an empty policy block without touching a permission set", () => {
    write(paths.jairaDir, "settings.json", { ...projectSettings(), policy: {} });
    const [report] = migrateSettingsLayers(paths);
    expect(projectSettings()).not.toHaveProperty("policy");
    expect(projectSettings()).not.toHaveProperty("functions");
    expect(report!.lines).toEqual(["The old blocks said nothing, and were removed."]);
    expect(existsSync(join(paths.jairaDir, "permission-sets/chat"))).toBe(false);
  });

  it("runs when a project is opened, before its configuration is read", () => {
    oldProject();
    const project = openProject(projectDir, { baseDir: home, builtInDir: builtIn });
    try {
      expect(project.config.functions).toEqual({
        smart: { model: "claude-haiku-4" },
        review_artifacts: { publish: "allow", settleAfter: "30m" },
        bash: { builtins: false },
      });
      expect(projectSettings()).not.toHaveProperty("policy");
    } finally {
      project.close();
    }
  });
});
