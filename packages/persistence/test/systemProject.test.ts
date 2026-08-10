/**
 * The two projects that are not a checkout, and the difference between them.
 *
 * `~/.jaira` used to hold authored things and no run state, on the argument that "runs belong to a
 * project and putting one machine's history behind every project would be a shared mutable pile with
 * no owner". The reasoning stands; the conclusion stopped following once JaiRA gained workflows of
 * its own. A description sync is a run, it belongs to nobody's checkout, and its alternatives were a
 * user's board — where it appears uninvited and takes a worktree — or nowhere, which is what it had,
 * and why a failed sync could not be read back.
 *
 * So the pile has an owner. Then it turned out to need TWO, because two kinds of run were being put
 * in one place and they have different LIFETIMES:
 *
 *  - {@link openSharedProject} is the SELECTED root as a project. It holds runs of the workflows that
 *    live in it, and repointing the root leaves them behind — correct, because they were that
 *    library's history and a different root is a different library.
 *  - {@link openSystemProject} is JaiRA's OWN, in a fixed directory. A description sync is about the
 *    installation, so its history has to survive exactly that switch.
 *
 * What these tests defend is that the ownership is ENFORCED rather than asserted, that the shared
 * layout is the base's own rather than a project's nested inside it, and that the two do not share a
 * database.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedProject, openSystemProject, type Project } from "../src/project";
import { createTask } from "../src/lifecycle";

let baseDir: string;
let systemDir: string;
const open: Project[] = [];

/** Track everything opened, so a failing assertion cannot leave a database handle behind. */
function track(project: Project): Project {
  open.push(project);
  return project;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "jaira-roots-"));
  systemDir = join(baseDir, "..", `${baseDir.split(/[/\\]/).pop()}-system`);
});

afterEach(() => {
  for (const project of open.splice(0)) project.close();
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(systemDir, { recursive: true, force: true });
});

describe("openSharedProject — the selected root, as a project", () => {
  it("creates the run-state layout beside the authored one", () => {
    const shared = track(openSharedProject({ baseDir }));

    // Directly under the base, not under a `.jaira/` inside it: the base IS the layer, rather than a
    // checkout's override of one. `jairaPaths(baseDir)` would have looked for `~/.jaira/.jaira/…`.
    expect(existsSync(join(baseDir, "jaira.db"))).toBe(true);
    expect(existsSync(join(baseDir, "snapshots"))).toBe(true);
    expect(existsSync(join(baseDir, "tasks"))).toBe(true);
    expect(existsSync(join(baseDir, "workflows"))).toBe(true);
    expect(shared.paths.projectDir).toBe(shared.paths.jairaDir);
  });

  it("keeps the database out of a synced home directory", () => {
    // Plenty of people keep `~` in a dotfiles repository or a sync folder, and a database landing
    // there is one machine's run history replicated onto every other.
    track(openSharedProject({ baseDir }));
    expect(existsSync(join(baseDir, ".gitignore"))).toBe(true);
  });

  it("searches only itself — there is no layer behind the layer", () => {
    const shared = track(openSharedProject({ baseDir }));
    expect(shared.paths.roots).toEqual([shared.paths.projectDir]);
  });

  it("says which kind of project it is, because the refusals below key off it", () => {
    expect(track(openSharedProject({ baseDir })).kind).toBe("shared");
  });

  it("reads its own config without laying it over itself", () => {
    // `loadLayeredConfig` merges `paths.base.configFile` under `paths.configFile`, and for this
    // layout those are the SAME file. Harmless only while merging a document over itself is
    // idempotent — which is a property of today's merge rules, not a guarantee.
    writeFileSync(join(baseDir, "config.json"), JSON.stringify({ artifacts: { dir: "shared-out" } }), "utf8");
    expect(track(openSharedProject({ baseDir })).config.artifacts.dir).toBe("shared-out");
  });

  it("round-trips a task, which is the whole point of it having a database", () => {
    const shared = track(openSharedProject({ baseDir }));
    const meta = createTask(shared, { title: "Run the shared plan", workflow: "plan" });

    expect(shared.tasks.read(meta.id).title).toBe("Run the shared plan");
    expect(shared.runtime.get(meta.id)?.status).toBe("queued");
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

describe("openSystemProject — JaiRA's own, which a root switch must not move", () => {
  it("lives in its own directory, not in the root", () => {
    // The whole point. Were it the root, repointing the root would leave a description sync's
    // history behind with the library it was not about.
    const system = track(openSystemProject({ baseDir, systemDir }));
    expect(system.paths.projectDir).toBe(join(systemDir));
    expect(existsSync(join(systemDir, "jaira.db"))).toBe(true);
  });

  it("does not share a database with the shared project", () => {
    // Two piles, two owners. A task created in one is not listed by the other, which is what keeps a
    // sync's bookkeeping off the board showing a person's own shared runs.
    const shared = track(openSharedProject({ baseDir }));
    const system = track(openSystemProject({ baseDir, systemDir }));

    const mine = createTask(shared, { title: "mine", workflow: "plan" }).id;
    const jairas = createTask(system, { title: "sync", workflow: "workflow/sync/document" }).id;

    expect(shared.runtime.get(mine)?.status).toBe("queued");
    expect(shared.runtime.get(jairas)).toBeUndefined();
    expect(system.runtime.get(jairas)?.status).toBe("queued");
    expect(system.runtime.get(mine)).toBeUndefined();
  });

  it("borrows the SHARED root's configuration, having none of its own", () => {
    // Its directory holds a database and nothing else. A sync still has to call the model the
    // installation is configured with, so reading configuration out of the bare directory — and
    // silently getting defaults — would be the quiet kind of wrong.
    writeFileSync(join(baseDir, "config.json"), JSON.stringify({ artifacts: { dir: "shared-out" } }), "utf8");
    expect(track(openSystemProject({ baseDir, systemDir })).config.artifacts.dir).toBe("shared-out");
  });

  it("says which kind it is, and refuses a branch for the same reason the shared one does", () => {
    const system = track(openSystemProject({ baseDir, systemDir }));
    expect(system.kind).toBe("system");
    expect(() => createTask(system, { title: "nope", workflow: "x", branch: "feature/x" })).toThrow(
      /cannot be bound to a branch/,
    );
  });
});
