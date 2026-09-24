/**
 * The fourth configuration layer, `personal-settings.json` ("Just you"), and the one-shot move of the
 * look out of `user-settings.json` into it (2026-09-23).
 *
 * What is worth proving here: that the personal layer is read after the project and the shared root by
 * the same loader a run uses (and by the shared root opened as a project); that the move writes only
 * what differs from the default, cleaned the way the old reader cleaned it so the strict layer accepts
 * it; that what the personal layer already says wins; that everything else in the old file is kept;
 * and that it runs once.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaBasePaths, jairaPaths, parseConfig, type JairaBasePaths } from "@jaira/shared";
import { initProject, loadLayeredConfig, openSharedProject } from "../src/project";
import { migrateUserSettings } from "../src/userSettingsMigration";

let scratch: string;
let home: string;
let base: JairaBasePaths;

function write(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-personal-"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  base = jairaBasePaths(home);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the personal layer", () => {
  it("is read after the shared root and the project", () => {
    const projectDir = join(scratch, "project");
    const paths = initProject(projectDir, home);
    write(base.settingsFile, { memo: { enabled: true }, artifacts: { dir: "shared" }, appearance: { palette: "pastel", mode: "dark" } });
    write(paths.settingsFile, { artifacts: { dir: "project", inlineMaxBytes: 10 }, appearance: { palette: "zinc" } });
    write(base.personalSettingsFile, { artifacts: { dir: "mine" }, appearance: { mode: "system" } });

    const config = loadLayeredConfig(jairaPaths(projectDir, home));
    // Key by key: each layer wins what it states, and keeps what the weaker ones say about the rest.
    expect(config.artifacts.dir).toBe("mine");
    expect(config.artifacts.inlineMaxBytes).toBe(10);
    expect(config.memo.enabled).toBe(true);
    expect(config.appearance.palette).toBe("zinc");
    expect(config.appearance.mode).toBe("system");
  });

  it("is laid over the shared root opened as a project, which has no project layer between", () => {
    write(base.settingsFile, { memo: { enabled: true }, appearance: { palette: "pastel" } });
    write(base.personalSettingsFile, { appearance: { palette: "blueprint" } });
    const shared = openSharedProject({ baseDir: home });
    try {
      expect(shared.config.appearance.palette).toBe("blueprint");
      expect(shared.config.memo.enabled).toBe(true);
    } finally {
      shared.close();
    }
  });
});

describe("moving the look out of user-settings.json", () => {
  const OLD = {
    theme: "dark",
    ui: { panes: { "files.tree": 300 } },
    logging: { minLevel: "warn", overrides: [] },
    baseDir: "D:/elsewhere",
    // A size out of range, a family twice, a knob the JSON editor does not have, a renderer line that
    // says nothing and one that is not a key: what the old reader cleaned, the move cleans.
    appearance: { palette: "zinc", sizeApp: 900, appFamily: ["Inter", " Inter "], smoothing: false, laneColors: true },
    editors: { json: { wrap: true, minimap: true }, code: { tabSize: 4, wrap: false } },
    renderers: { "text/markdown:preview": { read: "source", off: [] }, "text/css:text": {}, bad: { read: "x" } },
    conversation: { sequentialBatches: "band" },
    filesHidden: ["drafts", " !system ", "drafts"],
  };

  it("writes only what differs from the default, cleaned so the strict layer accepts it", () => {
    write(base.userSettingsFile, OLD);

    const report = migrateUserSettings(base);

    expect(report?.removed.sort()).toEqual(["appearance", "conversation", "editors", "filesHidden", "renderers", "theme"]);
    const personal = readJson(base.personalSettingsFile);
    expect(personal).toEqual({
      appearance: {
        mode: "dark",
        palette: "zinc",
        appFamily: ["Inter"],
        sizeApp: 17,
        laneColors: true,
        editors: { json: { wrap: true }, code: { tabSize: 4 } },
        renderers: { "text/markdown:preview": { read: "source" } },
        conversation: { sequentialBatches: "band" },
      },
      files: { hidden: ["drafts", "!system"] },
    });
    // The layer it wrote is one a run can read.
    expect(parseConfig(personal).appearance.sizeApp).toBe(17);
    // Everything that was not the look stays exactly where it was.
    expect(readJson(base.userSettingsFile)).toEqual({ ui: OLD.ui, logging: OLD.logging, baseDir: OLD.baseDir });
  });

  it("keeps what the personal layer already says, and appends to its patterns", () => {
    write(base.userSettingsFile, OLD);
    write(base.personalSettingsFile, { appearance: { palette: "blueprint", editors: { json: { tabSize: 8 } } }, files: { hidden: ["scratch", "drafts"] } });

    migrateUserSettings(base);

    const personal = readJson(base.personalSettingsFile) as { appearance: Record<string, unknown>; files: { hidden: string[] } };
    expect(personal.appearance["palette"]).toBe("blueprint");
    expect(personal.appearance["editors"]).toEqual({ json: { wrap: true, tabSize: 8 }, code: { tabSize: 4 } });
    expect(personal.files.hidden).toEqual(["scratch", "drafts", "!system"]);
  });

  it("runs once: a second run finds nothing to move and touches nothing", () => {
    write(base.userSettingsFile, OLD);
    migrateUserSettings(base);
    const personal = readFileSync(base.personalSettingsFile, "utf8");
    const user = readFileSync(base.userSettingsFile, "utf8");

    expect(migrateUserSettings(base)).toBeUndefined();
    expect(readFileSync(base.personalSettingsFile, "utf8")).toBe(personal);
    expect(readFileSync(base.userSettingsFile, "utf8")).toBe(user);
  });

  it("takes a look that was all defaults out without writing a personal layer for it", () => {
    write(base.userSettingsFile, { theme: "light", ui: {}, editors: { json: { wrap: false } } });

    expect(migrateUserSettings(base)?.wrote).toEqual([]);
    expect(existsSync(base.personalSettingsFile)).toBe(false);
    expect(readJson(base.userSettingsFile)).toEqual({ ui: {} });
  });

  it("leaves both files alone when the personal layer cannot be read", () => {
    write(base.userSettingsFile, OLD);
    mkdirSync(dirname(base.personalSettingsFile), { recursive: true });
    writeFileSync(base.personalSettingsFile, "{ not json", "utf8");

    expect(migrateUserSettings(base)).toBeUndefined();
    expect(readJson(base.userSettingsFile)).toEqual(OLD);
  });

  it("has nothing to do without a preferences file", () => {
    expect(migrateUserSettings(base)).toBeUndefined();
    expect(existsSync(base.personalSettingsFile)).toBe(false);
  });
});
