/**
 * The root that is not a checkout, and the line drawn inside it.
 *
 * `~/.jaira` used to hold authored things and no run state, on the argument that "runs belong to a
 * project and putting one machine's history behind every project would be a shared mutable pile with
 * no owner". The reasoning stands; the conclusion stopped following once JaiRA gained workflows of
 * its own. A description sync is a run, it belongs to nobody's checkout, and its alternatives were a
 * user's board — where it appears uninvited and takes a worktree — or nowhere, which is what it had,
 * and why a failed sync could not be read back.
 *
 * So the pile has an owner. It briefly had TWO — a second project in a subdirectory, so that
 * repointing the root could not carry a sync's history off with the library it was not about — and
 * that bought two databases inside one root, two boards, and a `system/` that meant two things. One
 * root, one project, and `system/` means only "what JaiRA writes for itself".
 *
 * What these tests defend is that the ownership is ENFORCED rather than asserted, that the shared
 * layout is the base's own rather than a project's nested inside it, and that nothing generated
 * lands beside the things a person authors.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedProject, type Project } from "../src/project";
import { createTask } from "../src/lifecycle";

let baseDir: string;
const open: Project[] = [];

/** Track everything opened, so a failing assertion cannot leave a database handle behind. */
function track(project: Project): Project {
  open.push(project);
  return project;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "jaira-roots-"));
});

afterEach(() => {
  for (const project of open.splice(0)) project.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("openSharedProject — the selected root, as a project", () => {
  it("puts everything it generates under system/, and nothing else there", () => {
    const shared = track(openSharedProject({ baseDir }));

    // Directly under the base, not under a `.jaira/` inside it: the base IS the layer, rather than a
    // checkout's override of one. `jairaPaths(baseDir)` would have looked for `~/.jaira/.jaira/…`.
    expect(shared.paths.projectDir).toBe(shared.paths.jairaDir);
    // The line. What a person authors is at the top; what JaiRA writes is one directory down, so a
    // root is a place someone can look at and recognize as theirs.
    expect(existsSync(join(baseDir, "workflows"))).toBe(true);
    expect(existsSync(join(baseDir, "functions"))).toBe(true);
    expect(existsSync(join(baseDir, "skills"))).toBe(true);
    expect(existsSync(join(baseDir, "system", "snapshots"))).toBe(true);
    expect(existsSync(join(baseDir, "system", "tasks"))).toBe(true);
    expect(existsSync(join(baseDir, "system", "jaira.db"))).toBe(true);
    // Where they used to be, and the assertion that says the move actually happened rather than
    // being duplicated.
    expect(existsSync(join(baseDir, "jaira.db"))).toBe(false);
    expect(existsSync(join(baseDir, "snapshots"))).toBe(false);
    expect(existsSync(join(baseDir, "tasks"))).toBe(false);
  });

  it("keeps the database out of a synced home directory", () => {
    // Plenty of people keep `~` in a dotfiles repository or a sync folder, and a database landing
    // there is one machine's run history replicated onto every other.
    track(openSharedProject({ baseDir }));
    const ignore = readFileSync(join(baseDir, ".gitignore"), "utf8");
    expect(ignore).toContain("system/jaira.db");
    expect(ignore).toContain("system/logs/");
    // The list NAMES WHAT STAYS OUT rather than hiding the directory (DESIGN §4.4): once a
    // concern's truth is a JSONL git can merge, there is nothing derived left to hide. Everything
    // below is meant to be committed now — snapshots and artifacts included. Read as PATTERNS
    // rather than as text, since the header mentions several of these names in prose.
    const patterns = ignore.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"));
    expect(patterns).not.toContain("system/tasks/");
    expect(patterns).not.toContain("system/sync.json");
    expect(patterns).not.toContain("system/snapshots/");
    expect(patterns).not.toContain("system/artifacts/");
    expect(patterns).not.toContain("system/");
  });

  it("searches only itself — there is no layer behind the layer", () => {
    const shared = track(openSharedProject({ baseDir }));
    expect(shared.paths.roots).toEqual([shared.paths.projectDir]);
  });

  it("says which kind of project it is, because the refusals below key off it", () => {
    expect(track(openSharedProject({ baseDir })).kind).toBe("shared");
  });

  it("reads its own config without laying it over itself", () => {
    // `loadLayeredConfig` merges `paths.base.settingsFile` under `paths.settingsFile`, and for this
    // layout those are the SAME file. Harmless only while merging a document over itself is
    // idempotent — which is a property of today's merge rules, not a guarantee.
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ artifacts: { dir: "shared-out" } }), "utf8");
    expect(track(openSharedProject({ baseDir })).config.artifacts.dir).toBe("shared-out");
  });

  it("round-trips a task, which is the whole point of it having a database", () => {
    const shared = track(openSharedProject({ baseDir }));
    const meta = createTask(shared, { title: "Run the shared plan", workflow: "plan" });

    expect(shared.tasks.read(meta.id).title).toBe("Run the shared plan");
    expect(shared.runtime.get(meta.id)?.status).toBe("queued");
  });

  it("holds JaiRA's own runs in the same database, because one root is one project", () => {
    // The split this replaced kept a description sync in a second database next door. Both kinds of
    // run are runs of the machine's own workflows against the machine's own root; one board.
    const shared = track(openSharedProject({ baseDir }));
    const mine = createTask(shared, { title: "mine", workflow: "plan" }).id;
    const sync = createTask(shared, { title: "sync", workflow: "workflow/sync/document" }).id;

    expect(shared.runtime.get(mine)?.status).toBe("queued");
    expect(shared.runtime.get(sync)?.status).toBe("queued");
  });

  it("refuses a task bound to a branch, which is how its runs stay out of worktrees", () => {
    // Enforced at creation rather than left to fail inside `ensureWorkspace` at start: a home
    // directory is not a git repository, and a refusal that arrives at run time is one nobody can act
    // on. This is the mechanical form of "a run here never takes a worktree".
    const shared = track(openSharedProject({ baseDir }));
    expect(() => createTask(shared, { title: "nope", workflow: "x", branch: "feature/x" })).toThrow(
      /cannot be bound to a branch/,
    );
  });

  it("is idempotent, so opening it twice in a row is not a repair", () => {
    const first = track(openSharedProject({ baseDir }));
    const id = createTask(first, { title: "one", workflow: "w" }).id;
    first.close();
    open.pop();

    expect(track(openSharedProject({ baseDir })).tasks.read(id).title).toBe("one");
  });
});
