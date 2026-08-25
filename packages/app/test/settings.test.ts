/**
 * The settings, executor, secret and workflow-authoring surfaces of `AppService` (DESIGN §11.2).
 *
 * These are the app's first WRITE surfaces beyond task state — until now the renderer could start
 * and answer runs, but never change configuration or author a file. Two things therefore matter
 * more here than feature coverage:
 *
 *  - **a write must not be able to escape its root.** A state id arrives from the renderer, which
 *    is the untrusted half of the IPC boundary, and `../../..` is a perfectly good relative path.
 *  - **a write must not be able to brick the project.** Configuration is validated before it is
 *    written, because an unloadable `settings.json` would leave the app unable to open the project it
 *    was just configured with.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { defaultAppearance, type PushMessage } from "@jaira/shared";
import { AppService, type KeychainPort } from "../src/main/service";

let dir: string;
let baseDir: string;
let service: AppService;
let stored: Record<string, string>;
let pushes: PushMessage[];

/** An in-memory stand-in for Electron's `safeStorage` — the seam that keeps this headless. */
function fakeKeychain(available = true): KeychainPort {
  return {
    available: () => available,
    reason: available ? undefined : "no encrypted store here",
    get: (name) => stored[name],
    set: (name, value) => {
      stored[name] = value;
    },
    remove: (name) => {
      delete stored[name];
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-app-settings-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-app-base-"));
  stored = {};
  pushes = [];
  initProject(dir);
  service = new AppService({
    baseDir,
    watchWorkflows: false,
    keychain: fakeKeychain(),
    publish: (m) => pushes.push(m),
  });
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

describe("user settings", () => {
  it("defaults to the light theme, with no project open", () => {
    // Preferences belong to the person, not the checkout — the theme must apply on an empty window.
    expect(service.readSettings()).toEqual({ theme: "light", wrapJson: false, ui: { panes: {}, open: {}, modes: {}, shut: {}, seen: {} }, appearance: defaultAppearance(), projects: [] });
  });

  it("persists a change and reads it back", () => {
    expect(service.writeSettings({ theme: "dark" })).toMatchObject({ theme: "dark" });
    expect(service.readSettings().theme).toBe("dark");
    expect(existsSync(join(baseDir, "user-settings.json"))).toBe(true);
  });

  it("falls back to defaults rather than throwing on a corrupt file", () => {
    writeFileSync(join(baseDir, "user-settings.json"), "{ not json", "utf8");

    // A broken preferences file must never stop the app opening.
    expect(service.readSettings()).toEqual({ theme: "light", wrapJson: false, ui: { panes: {}, open: {}, modes: {}, shut: {}, seen: {} }, appearance: defaultAppearance(), projects: [] });
  });

  it("keeps the JSON editor's wrap preference, and defaults it off", () => {
    // A display preference like the theme: it belongs to the person, so it lives here rather than in
    // component state that resets on every file you open.
    expect(service.readSettings().wrapJson).toBe(false);
    expect(service.writeSettings({ wrapJson: true }).wrapJson).toBe(true);
    expect(service.readSettings().wrapJson).toBe(true);
    // And it does not disturb what was already saved.
    expect(service.readSettings().theme).toBe("light");
  });

  it("reads a settings file written before wrapJson existed", () => {
    writeFileSync(join(baseDir, "user-settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    expect(service.readSettings()).toEqual({ theme: "dark", wrapJson: false, ui: { panes: {}, open: {}, modes: {}, shut: {}, seen: {} }, appearance: defaultAppearance(), projects: [] });
  });

  it("reads a hand-edited project list without throwing any of it away", () => {
    writeFileSync(
      join(baseDir, "user-settings.json"),
      // A path that is not a string, an empty one, one with stray whitespace, and the same project
      // twice — which would be one project opened twice, and is a no-op anyway.
      JSON.stringify({ projects: [42, "", "  /work/one  ", "/work/two", "/work/two"] }),
      "utf8",
    );

    expect(service.readSettings().projects).toEqual(["/work/one", "/work/two"]);
  });

  /**
   * The window's layout — pane sizes, folds, collapsed branches (DESIGN §11.1).
   *
   * It rides in the preferences file for the reason the theme does: it is how the app looks to one
   * person on one machine, and it must never arrive through a pull request. What is tested here is
   * only the part main owns — that it round-trips, that it replaces rather than accumulates, and
   * that a file which has been hand-edited into nonsense still opens the app.
   */
  it("remembers the window layout, and writes it whole", () => {
    const ui = {
      panes: { "files.tree": 310 },
      open: { "files.editor": false },
      modes: { "files.editor": "full" },
      shut: { "files.folders": ["project:workflows"] },
      seen: { "t-1": 1_700_000_000_000 },
    };
    expect(service.writeSettings({ ui })).toMatchObject({ ui });
    expect(service.readSettings().ui).toEqual(ui);

    // Replaced, not merged: the renderer holds the live copy and sends all of it, which is what
    // makes forgetting a pane possible at all — a deep merge would leave every id ever stored.
    const later = { panes: { "tasks.panel": 420 }, open: {}, modes: {}, shut: {}, seen: {} };
    service.writeSettings({ ui: later });
    expect(service.readSettings().ui).toEqual(later);
  });

  it("keeps the layout out of the way of the other preferences", () => {
    service.writeSettings({ ui: { panes: { "files.tree": 310 }, open: {}, modes: {}, shut: {}, seen: {} } });
    expect(service.writeSettings({ theme: "dark" }).ui.panes["files.tree"]).toBe(310);
    expect(service.readSettings().theme).toBe("dark");
  });

  it("drops layout entries of the wrong shape rather than the whole layout", () => {
    writeFileSync(
      join(baseDir, "user-settings.json"),
      JSON.stringify({
        theme: "dark",
        ui: {
          // A size that is not a number, one that would swallow the window, and one that is fine.
          panes: { "files.tree": "wide", "files.inspector": 99999, "tasks.panel": 400 },
          open: { "files.editor": "yes", "settings.effective": true },
          // A list that is not one, and one that has grown a duplicate by hand.
          shut: { "tasks.projects": "everything", "files.folders": ["a", "a", "b"] },
          // A read mark that is not a time, one that is before the epoch, and one that is real.
          seen: { "t-bad": "yesterday", "t-negative": -5, "t-1": 1_700_000_000_000 },
        },
      }),
      "utf8",
    );

    // One unreadable id costs its own pane and nothing else: this document is a cache of gestures,
    // not something anyone authored, so a value whose meaning changed between versions must not
    // throw away the other forty.
    expect(service.readSettings().ui).toEqual({
      panes: { "files.inspector": 4000, "tasks.panel": 400 },
      open: { "settings.effective": true },
      modes: {},
      shut: { "files.folders": ["a", "b"] },
      seen: { "t-1": 1_700_000_000_000 },
    });
  });
});

describe("opening and creating projects", () => {
  it("sets up a directory that is not yet a project, and opens it", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "jaira-app-fresh-"));
    try {
      // The gap this closes: `open` refuses a directory with no `.jaira/`, and until `init` existed
      // the only ways to make one were the CLI and a startup argument — so a running app pointed at
      // a new checkout was stuck there.
      await expect(service.open(fresh)).rejects.toThrow(/not a JaiRA project/);

      await service.init(fresh);

      expect(existsSync(join(fresh, ".jaira", "workflows"))).toBe(true);
      expect(service.current()?.dir).toBe(fresh);
    } finally {
      await service.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("treats init on an existing project as an open, keeping its config", async () => {
    writeFileSync(join(dir, ".jaira", "settings.json"), JSON.stringify({ memo: { enabled: true } }), "utf8");

    await service.init(dir);

    expect(JSON.parse(readFileSync(join(dir, ".jaira", "settings.json"), "utf8"))).toEqual({ memo: { enabled: true } });
  });

  /**
   * "Is this a project?", asked before anything is done about it.
   *
   * The read the app needs to offer to SET UP a folder rather than refuse it. Matching on the text
   * of the error `open` throws would work until somebody rewords it, and would still not tell a
   * folder that has never been set up apart from one whose database will not open.
   */
  it("reports what a directory is without opening or creating anything", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "jaira-app-inspect-"));
    const gone = join(fresh, "nowhere");
    try {
      expect(service.inspect(dir)).toMatchObject({ dir, exists: true, project: true, open: false });
      expect(service.inspect(fresh)).toMatchObject({ exists: true, project: false, open: false });
      expect(service.inspect(gone)).toMatchObject({ exists: false, project: false, open: false });
      // The read is a read: a folder asked about is still not a project.
      expect(existsSync(join(fresh, ".jaira"))).toBe(false);

      await service.open(dir);
      expect(service.inspect(dir).open).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("answers null from the directory picker when there is no dialog to show", async () => {
    // The headless case. A service with no `chooseDirectory` port must not throw here: the renderer
    // treats null as "the user dismissed it", which is the right thing to do either way.
    expect(await service.chooseProject("open")).toBeNull();
  });

  it("passes the picker wording that matches what is about to happen", async () => {
    const seen: Array<{ title: string; buttonLabel: string }> = [];
    const picking = new AppService({
      baseDir,
      watchWorkflows: false,
      chooseDirectory: async (options) => {
        seen.push(options);
        return dir;
      },
    });

    expect(await picking.chooseProject("open")).toEqual({ dir });
    expect(await picking.chooseProject("init")).toEqual({ dir });

    // "Open" must not be the label on a dialog whose OK button writes a layout into the folder.
    expect(seen[0]?.buttonLabel).toBe("Open");
    expect(seen[1]?.buttonLabel).toBe("Set up here");
    await picking.close();
  });
});

/**
 * What the window had open, across a quit (SHELL.md §2.2, {@link JairaSettings.projects}).
 *
 * A window holds several projects and nothing evicts one, so opening a project is a statement that
 * outlives the session it was made in — and until this existed, quitting silently retracted it: the
 * app came back on an empty shell with no way to say which checkouts had been in it.
 */
describe("remembering the projects that were open", () => {
  it("records a project as it opens, in the order they were opened", async () => {
    const second = mkdtempSync(join(tmpdir(), "jaira-app-second-"));
    try {
      initProject(second);
      await service.open(dir);
      await service.open(second);

      expect(service.readSettings().projects).toEqual([dir, second]);

      // Re-opening one already open changes nothing — not its position, and not the file. The list
      // is the same shape as the open sessions, so what a restart reproduces is the window that was
      // quit rather than one re-sorted by whatever was clicked last.
      await service.open(dir);
      expect(service.readSettings().projects).toEqual([dir, second]);
    } finally {
      // Before the directory goes: an open project holds its database, and Windows will not unlink
      // a file that is still mapped.
      await service.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("re-opens them on the next start, in the order they were opened", async () => {
    const second = mkdtempSync(join(tmpdir(), "jaira-app-restore-"));
    try {
      initProject(second);
      await service.open(second);
      await service.open(dir);
      await service.close();

      // A second process against the same base root — which is exactly what the next launch is.
      const restarted = new AppService({ baseDir, watchWorkflows: false, keychain: fakeKeychain() });
      try {
        expect(await restarted.restore()).toEqual({ opened: [second, dir], forgotten: [] });
        // Last opened, so it is where the window stands.
        expect(restarted.current()?.dir).toBe(dir);
        expect(restarted.listProjects().map((p) => p.project)).toContain(second);
      } finally {
        await restarted.close();
      }
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("forgets a remembered directory that is no longer a project", async () => {
    const gone = mkdtempSync(join(tmpdir(), "jaira-app-gone-"));
    initProject(gone);
    await service.open(gone);
    await service.open(dir);
    await service.close();
    rmSync(gone, { recursive: true, force: true });

    const restarted = new AppService({ baseDir, watchWorkflows: false, keychain: fakeKeychain() });
    try {
      // Deleted on purpose, so it is dropped rather than retried — and retried forever, with an
      // error on the screen about a folder the person got rid of.
      expect(await restarted.restore()).toEqual({ opened: [dir], forgotten: [gone] });
      expect(restarted.readSettings().projects).toEqual([dir]);
    } finally {
      await restarted.close();
    }
  });

  it("keeps a project whose whole filesystem is missing, rather than forgetting a drive that is offline", async () => {
    // The distinction `existsSync` on the project alone cannot draw: an unmounted drive and a
    // deleted folder both answer "no". Asking the PARENT separates them — a project deleted out of a
    // directory that is still there is gone for good, and one on a volume that is not mounted this
    // morning will be back this afternoon.
    const offline = join("Z:", "not-mounted", "checkout");
    service.writeSettings({ projects: [offline] });

    expect(await service.restore()).toEqual({ opened: [], forgotten: [] });
    expect(service.readSettings().projects).toEqual([offline]);
  });

  it("leaves the rest of the preferences alone", async () => {
    service.writeSettings({ theme: "dark", ui: { panes: { "files.tree": 310 }, open: {}, modes: {}, shut: {}, seen: {} } });
    await service.open(dir);

    // The list is written by main while the renderer owns the layout — a project open must not cost
    // somebody the divider they dragged a moment ago.
    expect(service.readSettings()).toMatchObject({ theme: "dark", projects: [dir] });
    expect(service.readSettings().ui.panes["files.tree"]).toBe(310);
  });
});

describe("configuration", () => {
  it("reads both layers with NO project open, so the shared one is editable on an empty window", () => {
    // The shared root is machine-global and exists before any checkout — it is what somebody
    // configures FIRST. A read that needed a project made the Settings view claim there was nothing
    // to edit, for both layers.
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ memo: { enabled: true } }), "utf8");

    const view = service.readConfig();

    expect(service.current()).toBeNull();
    expect(view.base).toEqual({ memo: { enabled: true } });
    expect(view.project).toBeNull();
    // Empty, and that is how the UI knows to say "no project" for this layer rather than "no config".
    expect(view.projectFile).toBe("");
    expect(view.effective).toMatchObject({ memo: { enabled: true } });
  });

  it("writes and lists the shared layer with no project open", () => {
    service.writeConfig({ layer: "base", config: { agents: { claudeCli: { enabled: false } } } });

    expect(JSON.parse(readFileSync(join(baseDir, "settings.json"), "utf8"))).toMatchObject({
      agents: { claudeCli: { enabled: false } },
    });
    // Executors are answered from the base document too, so the pane is not empty either.
    expect(service.listExecutors().find((e) => e.name === "claude-cli")?.enabled).toBe(false);
  });

  it("still refuses to write the project layer with no project named", () => {
    // The layer switch became the crumb (SHELL.md §2.2): at the root there is no project layer to
    // edit, and Settings edits `base` only — which is the rule this case already stated.
    expect(() => service.writeConfig({ layer: "project", config: {} })).toThrow(/no project was named/);
  });
});

describe("configuration with a project", () => {
  beforeEach(async () => {
    await service.open(dir);
  });

  it("reports both layers and the merged result", () => {
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ memo: { enabled: true } }), "utf8");
    writeFileSync(join(dir, ".jaira", "settings.json"), JSON.stringify({ artifactDir: "from-project" }), "utf8");

    const view = service.readConfig();

    expect(view.base).toEqual({ memo: { enabled: true } });
    expect(view.project).toEqual({ artifactDir: "from-project" });
    // The question this pane exists to answer: what will actually run.
    expect(view.effective).toMatchObject({ memo: { enabled: true }, artifactDir: "from-project" });
  });

  it("writes the base layer, creating the shared root if needed", () => {
    service.writeConfig({ layer: "base", config: { memo: { enabled: true } } });

    expect(JSON.parse(readFileSync(join(baseDir, "settings.json"), "utf8"))).toEqual({ memo: { enabled: true } });
  });

  it("writes the project layer without copying the base's values into it", () => {
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ memo: { enabled: true } }), "utf8");

    service.writeConfig({ layer: "project", config: { artifactDir: "mine" } });

    // Only what was authored: saving the MERGED document would freeze today's base values into the
    // project and quietly sever it from future base changes.
    expect(JSON.parse(readFileSync(join(dir, ".jaira", "settings.json"), "utf8"))).toEqual({ artifactDir: "mine" });
  });

  it("refuses an invalid document and leaves the file untouched", () => {
    const before = readFileSync(join(dir, ".jaira", "settings.json"), "utf8");

    expect(() =>
      service.writeConfig({ layer: "project", config: { executors: { default: { prompt: { kind: "wizard" } } } } }),
    ).toThrow(/router, provider, agent/);
    expect(readFileSync(join(dir, ".jaira", "settings.json"), "utf8")).toBe(before);
  });

  it("validates the project layer AS MERGED, not on its own", () => {
    // A base that turns generic CLIs into a list and a project that adds a malformed entry: only
    // the merged document shows the problem, and the merged document is what a run reads.
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ agents: { genericCli: [{ command: "a" }] } }), "utf8");

    expect(() =>
      service.writeConfig({ layer: "project", config: { agents: { genericCli: [{ command: "" }] } } }),
    ).toThrow(/command must be a non-empty string/);
  });
});

describe("executors", () => {
  beforeEach(async () => {
    await service.open(dir);
  });

  it("lists the built-ins for a project that configures nothing", () => {
    expect(service.listExecutors().map((e) => e.name)).toEqual(["claude-code", "claude-cli", "codex-cli"]);
  });

  it("reflects a disabled executor as soon as config says so", () => {
    service.writeConfig({ layer: "project", config: { agents: { claudeCli: { enabled: false } } } });

    // Without a reopen: the settings screen writes and immediately re-reads this list, and a save
    // answered with the OLD inventory reads as a write that did not happen.
    expect(service.listExecutors().find((e) => e.name === "claude-cli")?.enabled).toBe(false);
  });

  it("lists an executor added from the settings screen, and its configured fields", () => {
    service.writeConfig({
      layer: "project",
      config: {
        agents: {
          codex: { command: "/opt/codex", sandbox: "read-only", credential: "OPENAI_API_KEY" },
          genericCli: [{ name: "opencode", command: "opencode" }],
        },
      },
    });

    const executors = service.listExecutors();

    expect(executors.map((e) => e.name)).toEqual(["claude-code", "claude-cli", "codex-cli", "opencode"]);
    expect(executors.find((e) => e.name === "codex-cli")).toMatchObject({
      command: "/opt/codex",
      sandbox: "read-only",
      credential: "OPENAI_API_KEY",
    });
  });

  it("probes without running an agent, and reports a disabled one as disabled", async () => {
    service.writeConfig({ layer: "project", config: { agents: { claudeCli: { enabled: false } } } });

    const results = await service.probeExecutors("claude-cli");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "claude-cli", status: "disabled" });
  });

  it("finds a credential named by a config write, without a reopen", async () => {
    // The two halves of "add a key" — naming the secret in config and storing its value — land in
    // one action in the UI, so a probe between them must see both.
    service.setSecret({ name: "ANTHROPIC_API_KEY", value: "sk-test", target: "keychain" });
    service.writeConfig({ layer: "project", config: { agents: { claudeCode: { credential: "ANTHROPIC_API_KEY" } } } });

    const [result] = await service.probeExecutors("claude-code");

    expect(result?.credential).toEqual({ source: "keychain" });
    expect(result?.credentialMissing).toBeUndefined();
  });

  it("refuses to probe an executor that does not exist", async () => {
    await expect(service.probeExecutors("nope")).rejects.toThrow(/unknown executor/);
  });
});

describe("secrets", () => {
  beforeEach(async () => {
    await service.open(dir);
  });

  it("reports the keychain as available when one is injected", () => {
    expect(service.secretCapabilities()).toEqual({ keychain: true });
  });

  it("explains the absence rather than silently offering fewer options", async () => {
    const without = new AppService({ baseDir, watchWorkflows: false, keychain: fakeKeychain(false) });
    try {
      expect(without.secretCapabilities()).toMatchObject({ keychain: false, keychainReason: "no encrypted store here" });
    } finally {
      // Constructing a service opens JaiRA's own project, so one that is not closed leaves a database
      // handle on the shared root — which Windows then refuses to unlink in the teardown.
      await without.close();
    }
  });

  it("stores a key in the keychain, and clears it with an empty value", () => {
    service.setSecret({ name: "MY_KEY", value: "secret", target: "keychain" });
    expect(stored["MY_KEY"]).toBe("secret");

    service.setSecret({ name: "MY_KEY", value: "", target: "keychain" });
    expect(stored["MY_KEY"]).toBeUndefined();
  });

  it("writes a .env.local entry without disturbing the rest of the file", () => {
    const file = join(baseDir, ".env.local");
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(file, "# my keys\nOTHER=keep-me\nMY_KEY=old\n", "utf8");

    service.setSecret({ name: "MY_KEY", value: "new", target: "base-env-local" });

    const text = readFileSync(file, "utf8");
    // The comment and the unrelated key survive: these files are hand-maintained.
    expect(text).toContain("# my keys");
    expect(text).toContain("OTHER=keep-me");
    expect(text).toContain('MY_KEY="new"');
    expect(text).not.toContain("MY_KEY=old");
  });

  it("refuses a name that is not usable as one", () => {
    expect(() => service.setSecret({ name: "not a name", value: "x", target: "base-env-local" })).toThrow(
      /not a usable secret name/,
    );
  });
});

describe("workflow authoring", () => {
  beforeEach(async () => {
    await service.open(dir);
  });

  it("reads a state that does not exist yet as empty, so it can be created", () => {
    const source = service.readWorkflow({ stateId: "new/state", layer: "project" });

    expect(source).toMatchObject({ stateId: "new/state", layer: "project", exists: false, text: "" });
  });

  it("writes a state into the project layer, creating directories", () => {
    service.writeWorkflow({ stateId: "deep/nested/state", layer: "project", text: '{"label":"hi"}' });

    const written = readFileSync(join(dir, ".jaira", "workflows", "deep", "nested", "state.json"), "utf8");
    expect(JSON.parse(written)).toEqual({ label: "hi" });
  });

  it("writes a state into the shared root", () => {
    service.writeWorkflow({ stateId: "shared/state", layer: "base", text: '{"label":"shared"}' });

    expect(JSON.parse(readFileSync(join(baseDir, "workflows", "shared", "state.json"), "utf8"))).toEqual({
      label: "shared",
    });
  });

  it("refuses text that is not JSON, rather than writing a file that breaks the browser", () => {
    expect(() => service.writeWorkflow({ stateId: "bad", layer: "project", text: "{ half-written" })).toThrow(
      /not valid JSON/,
    );
    expect(existsSync(join(dir, ".jaira", "workflows", "bad.json"))).toBe(false);
  });

  it("refuses a state id that escapes its root", () => {
    // The containment check the whole write surface rests on. Tested for both layers, because a
    // check that only guards one of them guards neither in practice.
    for (const layer of ["project", "base"] as const) {
      expect(() => service.readWorkflow({ stateId: "../../escape", layer })).toThrow(/does not name a state inside/);
      expect(() => service.writeWorkflow({ stateId: "../../escape", layer, text: "{}" })).toThrow(
        /does not name a state inside/,
      );
    }
    expect(existsSync(join(dir, "..", "escape.json"))).toBe(false);
  });

  it("refuses an absolute state id", () => {
    expect(() => service.readWorkflow({ stateId: "C:/Windows/System32/x", layer: "project" })).toThrow(
      /does not name a state inside/,
    );
  });
});

/**
 * Availability: what can answer a prompt here, observed rather than assumed (DESIGN §8.3).
 *
 * The behaviour these defend is the one the settings screen was missing entirely. Every provider
 * rendered as enabled and every executor as fine, because nothing had ever looked — the only thing
 * that would look was a button, and pressing it changed one of the two halves. So a machine with no
 * API key and no `claude` installed showed four healthy providers and three healthy executors, and
 * the first run then failed with a message the screen had had every chance to give first.
 */
describe("availability", () => {
  beforeEach(async () => {
    await service.open(dir);
  });

  it("has looked at nothing until it is asked to, and says so rather than guessing", () => {
    // `checkedAt: 0` is load-bearing. "No check has run" and "everything is fine" are different
    // statements, and rendering the second for the first is the failure this surface prevents.
    expect(service.readAvailability()).toEqual({ routes: [], executors: [], checkedAt: 0 });
  });

  it("reports every route and every executor once a check has run", async () => {
    const snapshot = await service.refreshAvailability();

    expect(snapshot.routes.map((r) => r.name)).toEqual(["anthropic", "openai", "openrouter", "local", "embedded"]);
    expect(snapshot.executors.map((e) => e.name)).toEqual(["claude-code", "claude-cli", "codex-cli"]);
    expect(snapshot.checkedAt).toBeGreaterThan(0);
    // Read back without re-checking: this is what opening the settings screen does.
    expect(service.readAvailability()).toEqual(snapshot);
  });

  it("reports a provider with no key as unavailable, and says what would fix it", async () => {
    const { routes } = await service.refreshAvailability();
    const anthropic = routes.find((r) => r.name === "anthropic")!;

    // The base root is a temp dir with no `.env`, and `credential` names nothing, so the only
    // remaining source is the process environment. Whichever way that falls, the check must have
    // reached a conclusion — and an unavailable route must carry the way out of it.
    expect(["ok", "failed"]).toContain(anthropic.status);
    if (anthropic.status === "failed") expect(anthropic.fix).toContain("ANTHROPIC_API_KEY");
  });

  it("does not check a route the configuration turned off", async () => {
    service.writeConfig({ layer: "project", config: { models: { routes: { openrouter: { enabled: false } } } } });

    const { routes } = await service.refreshAvailability();

    expect(routes.find((r) => r.name === "openrouter")).toMatchObject({ status: "disabled" });
  });

  it("publishes an invalidate when a check lands, which is how the screen hears about it", async () => {
    pushes.length = 0;

    await service.refreshAvailability();

    expect(pushes.some((m) => m.type === "store:invalidate" && m.scope === "availability")).toBe(true);
  });

  it("answers a refresh asked for mid-pass with a LATER pass, not the one already running", async () => {
    // The bug this replaced a `toBe` assertion for. Joining looks like the same thing and is not: the
    // reason to ask again is that the inputs changed, and a pass that started before the change
    // cannot answer a question about what came after it.
    //
    // Which is what happened at every startup. The constructor probes before any project is open, so
    // the secret chain has no project `.env.local` and every remote route reports "no key". The
    // project then opens and kicks a refresh precisely because it brings its own config layer — and
    // that refresh joined the project-less pass and adopted its verdict. Settings opened showing
    // `anthropic` and `openrouter` as not working, and Recheck "fixed" it only because by then
    // nothing was in flight.
    pushes.length = 0;
    const [first, second] = await Promise.all([service.refreshAvailability(), service.refreshAvailability()]);

    expect(second).not.toBe(first);
    expect(second.checkedAt).toBeGreaterThanOrEqual(first.checkedAt);
    // And it is the newest one that is cached, so opening Settings reads the later answer.
    expect(service.readAvailability()).toBe(second);
  });

  it("still bounds a burst: many requests during one pass share ONE follow-up", async () => {
    // The property the old `toBe` was really defending, and it survives. Saving a URL and then a
    // credential a second apart must not open its own round of socket connects each — but the LAST
    // write's effect still has to be observed, which is why the answer is two passes rather than one.
    pushes.length = 0;
    await Promise.all([
      service.refreshAvailability(),
      service.refreshAvailability(),
      service.refreshAvailability(),
      service.refreshAvailability(),
    ]);

    // One invalidate per pass that actually ran.
    const passes = pushes.filter((m) => m.type === "store:invalidate" && m.scope === "availability").length;
    expect(passes).toBe(2);
  });

  it("re-arms, so a request during the FOLLOW-UP gets one of its own", async () => {
    pushes.length = 0;
    const first = service.refreshAvailability();
    const second = service.refreshAvailability();
    await first;
    // `second` is the follow-up and is now the one in flight; asking again must not join it either.
    const third = service.refreshAvailability();
    await Promise.all([second, third]);

    expect(await third).not.toBe(await second);
  });

  /**
   * The DEFAULT executor, resolved — which is a tree rather than a chosen model id.
   *
   * A model id could never be the answer: it cannot route, and the prompt router dispatches before a
   * leaf's defaults are applied, so a default naming an agent was invisible to the routing that had
   * to happen first.
   */
  it("resolves the default executor's tree from what actually works", async () => {
    const { tree, executors } = await service.refreshAvailability();

    expect(tree?.kind).toBe("operation");
    expect(tree?.prompt?.kind).toBe("router");
    const routes = Object.keys((tree?.prompt as { routes?: Record<string, unknown> }).routes ?? {});
    // An executor whose binary is missing is not a route: that is the difference between routing to
    // claude-cli and routing to claude-cli and then failing to start it.
    for (const executor of executors) {
      if (executor.status === "ok") expect(routes).toContain(executor.name);
      else expect(routes).not.toContain(executor.name);
    }
  });
});
