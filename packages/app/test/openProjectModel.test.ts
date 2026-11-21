/** The Open dialog's words and choices (decision 0027), apart from its drawing. */
import { describe, expect, it } from "vitest";
import type { MachinesView, ProjectSummary, WorkspacePlan } from "@jaira/shared";
import {
  addLines,
  appendJobText,
  bringChoices,
  bringPlacesOf,
  folderChip,
  folderNote,
  forgeOfUrl,
  jobBlocks,
  machinePlacesOf,
  needWords,
  placeGroupsOf,
  planSentence,
  readinessWords,
  sourceForProject,
  sourceName,
  standingOf,
  standingWords,
  withRecentFolder,
  withStep,
  workspaceDirsOn,
  workspacesOfSource,
  type WorkspaceJob,
} from "../src/renderer/openProjectModel";
import { groupProjects } from "../src/renderer/workspaceGroups";
import { remoteProjectKey } from "@jaira/shared";

function plan(over: Partial<WorkspacePlan> = {}): WorkspacePlan {
  return {
    name: "atlas",
    dir: "/srv/work/atlas-1",
    projectsFolder: "/srv/work",
    taken: "atlas",
    setup: { from: "file", target: "default", steps: [], readiness: "ready" },
    bring: [".env*.local"],
    ...over,
  };
}

describe("a machine's status for a project", () => {
  it("says ready, what installs first, a password, or can't", () => {
    expect(readinessWords(plan())).toEqual({ text: "ready", tone: "ok" });
    expect(
      readinessWords(plan({ setup: { from: "file", target: "default", readiness: "installs", steps: [{ label: "Install node 22", status: "installs" }] } })),
    ).toEqual({ text: "installs node", tone: "accent" });
    expect(readinessWords(plan({ setup: { from: "found", target: "default", readiness: "password", steps: [] } }))?.tone).toBe("warn");
    expect(readinessWords(plan({ setup: { from: "found", target: "default", readiness: "cannot", steps: [] } }))?.text).toBe("can't");
    expect(readinessWords(undefined)).toBeUndefined();
  });

  it("says each setup step's need in a few words", () => {
    expect(needWords({ label: "Install node", status: "there", detail: "22.11.0" }).text).toBe("✓ 22.11.0 there");
    expect(needWords({ label: "Install pnpm", status: "installs" }).tone).toBe("accent");
    expect(needWords({ label: "x", status: "cannot", detail: "needs bash" }).text).toBe("can't: needs bash");
  });
});

describe("where it goes", () => {
  it("says why the folder is numbered", () => {
    expect(folderNote(plan())).toBe("atlas is taken there, so atlas-1");
    expect(folderNote(plan({ taken: undefined, dir: "/srv/work/atlas" }))).toBe("its projects folder, named after the project");
  });

  it("groups machines as the column draws them, this machine first", () => {
    const view = {
      self: { id: "me", label: "mac-air", os: "mac", form: "laptop", tags: [] },
      machines: [
        { id: "b", label: "build-02", os: "linux", form: "server", tags: [], state: "offline" },
        { id: "a", label: "build-01", os: "linux", form: "server", tags: [], state: "online" },
        { id: "w", label: "win-desk", os: "windows", form: "desktop", tags: [], state: "online" },
      ],
    } as unknown as MachinesView;
    expect(placeGroupsOf(view).map((g) => [g.title, g.machines.map((m) => m.label)])).toEqual([
      ["This machine", ["mac-air"]],
      ["Linux", ["build-01", "build-02"]],
      ["Windows", ["win-desk"]],
    ]);
  });
});

describe("how it gets there", () => {
  it("says the plan in a sentence", () => {
    expect(planSentence({ kind: "forge", host: "github.com", project: "org/atlas", url: "u", branch: "main", label: "org/atlas" }, "build-01", plan({ setup: { from: "file", target: "default", readiness: "ready", steps: [{ label: "pnpm install", status: "runs" }] } }))).toBe(
      "build-01 clones main from github.com, brings .env*.local, then sets it up.",
    );
    expect(planSentence({ kind: "machine", machine: "s", dir: "/x", label: "studio-mini" }, "build-01", plan({ bring: [], setup: { from: "none", target: "default", readiness: "ready", steps: [] } }))).toBe(
      "build-01 copies what git doesn't ignore from studio-mini.",
    );
  });
});

describe("where a new workspace of a project comes from", () => {
  it("is its forge when it has a remote, else a copy of one of its workspaces", () => {
    const members = [
      { project: "jaira-machine://peer/%2Fsrv%2Fatlas", machine: { id: "peer", label: "build-02", state: "online" } },
      { project: "/Users/sam/Code/atlas", machine: { id: "me", label: "mac-air", state: "online", self: true } },
    ] as unknown as ProjectSummary[];
    expect(sourceForProject(members, "https://github.com/org/atlas.git", "me")).toEqual({
      kind: "forge",
      host: "github.com",
      project: "org/atlas",
      url: "https://github.com/org/atlas.git",
      label: "github.com/org/atlas",
    });
    expect(sourceForProject(members, undefined, "me")).toEqual({ kind: "machine", machine: "me", dir: "/Users/sam/Code/atlas", label: "mac-air · atlas" });
    expect(sourceForProject([], undefined, "me")).toBeUndefined();
  });

  it("copies the workspace on another machine when this one has none, named by that machine and folder", () => {
    const members = [{ project: "jaira-machine://peer/%2Fsrv%2Fwork%2Fatlas", machine: { id: "peer", label: "build-02", state: "online" } }] as unknown as ProjectSummary[];
    const source = sourceForProject(members, undefined, "me");
    expect(source).toEqual({ kind: "machine", machine: "peer", dir: "/srv/work/atlas", label: "build-02 · atlas" });
    expect(sourceName(source!)).toBe("atlas");
    expect(sourceName({ kind: "forge", host: "github.com", project: "org/atlas", url: "https://github.com/org/atlas.git" })).toBe("atlas");
  });

  it("reads a remote in every form git writes one", () => {
    expect(forgeOfUrl("git@github.com:org/atlas.git")).toEqual({ host: "github.com", project: "org/atlas", httpsUrl: "https://github.com/org/atlas.git" });
    expect(forgeOfUrl("ssh://git@gitlab.example.com:2222/group/sub/x.git")?.project).toBe("group/sub/x");
    expect(forgeOfUrl("https://gitlab.com/group/x")?.httpsUrl).toBe("https://gitlab.com/group/x.git");
  });
});

describe("where Bring takes the files git ignores from", () => {
  const ID = "github.com/org/atlas";
  const projects = [
    { project: "/Users/sam/Code/atlas", identity: ID, machine: { id: "me", label: "mac-air", state: "online", self: true } },
    { project: "jaira-machine://peer/%2Fsrv%2Fatlas", identity: ID, machine: { id: "peer", label: "build-02", state: "online" } },
    { project: "jaira-machine://peer/%2Fsrv%2Fatlas-1", identity: ID, machine: { id: "peer", label: "build-02", state: "online" } },
    { project: "jaira-machine://box/%2Fhome%2Fx%2Fatlas", identity: ID, machine: { id: "box", label: "build-box", state: "online" } },
    { project: "/Users/sam/Code/notes", machine: { id: "me", label: "mac-air", state: "online", self: true } },
    { project: "/Users/sam/Code/other", identity: "github.com/org/other", machine: { id: "me", label: "mac-air", state: "online", self: true } },
  ] as unknown as ProjectSummary[];
  const forge = { kind: "forge", host: "github.com", project: "org/atlas", url: "https://github.com/org/atlas.git", label: "github.com/org/atlas" } as const;

  it("finds the project's workspaces as the engine does: by the repository, a folder with no remote alone", () => {
    expect(workspacesOfSource(projects, forge, "me").map((p) => p.project)).toHaveLength(4);
    expect(workspacesOfSource(projects, { kind: "machine", machine: "peer", dir: "/srv/atlas-1" }, "me")).toHaveLength(4);
    expect(workspacesOfSource(projects, { kind: "machine", machine: "me", dir: "/Users/sam/Code/notes" }, "me").map((p) => p.project)).toEqual(["/Users/sam/Code/notes"]);
    expect(workspacesOfSource(projects, { ...forge, url: "https://github.com/org/new.git" }, "me")).toEqual([]);
  });

  it("lists each machine that holds one once, in the project's order", () => {
    expect(bringPlacesOf(workspacesOfSource(projects, forge, "me"), "me")).toEqual([
      { machine: "me", label: "mac-air" },
      { machine: "peer", label: "build-02" },
      { machine: "box", label: "build-box" },
    ]);
  });

  it("takes them from a copy's own machine, else the target's own workspace, else the first that holds one", () => {
    const places = bringPlacesOf(workspacesOfSource(projects, forge, "me"), "me");
    const copy = { kind: "machine", machine: "peer", dir: "/srv/atlas", label: "build-02 · atlas" } as const;
    expect(bringChoices(copy, "me", places).map((p) => p.label)).toEqual(["build-02", "mac-air", "build-box"]);
    expect(bringChoices(forge, "box", places).map((p) => p.label)).toEqual(["build-box", "mac-air", "build-02"]);
    expect(bringChoices(forge, "fresh", places.slice(1)).map((p) => p.label)).toEqual(["build-02", "build-box"]);
    expect(bringChoices(forge, "me", [])).toEqual([]);
  });
});

describe("a workspace being made", () => {
  it("folds steps in by index and keeps the end of what it printed", () => {
    let job: WorkspaceJob = { jobId: "j", machine: "m", label: "atlas on build-01", phase: "setup", steps: [], text: "", request: { source: { kind: "machine", machine: "m", dir: "/x" } } };
    job = withStep(job, { index: 1, label: "b", status: "running" });
    job = withStep(job, { index: 0, label: "a", status: "done" });
    job = withStep(job, { index: 1, label: "b", status: "failed", detail: "exited 1" });
    expect(job.steps.map((s) => `${s.label}:${s.status}`)).toEqual(["a:done", "b:failed"]);
    job = appendJobText(job, "x".repeat(70_000));
    expect(job.text.length).toBe(60_000);
  });
});

describe("Add's card, in four lines", () => {
  const forge = { kind: "forge", host: "gitlab.com", project: "mistlabs/atlas", url: "https://gitlab.com/mistlabs/atlas.git", label: "gitlab.com/mistlabs/atlas" } as const;
  const steps = [
    { label: "Install node 22", status: "installs" },
    { label: "Bring .env*.local", status: "brings" },
    { label: "pnpm install", status: "runs" },
    { label: "pnpm db:migrate", status: "runs" },
    { label: "pnpm seed", status: "runs" },
  ] as const;

  it("names the forge, the project and its branch; the machine and its folder, numbered when taken", () => {
    const lines = addLines({ ...forge, branch: "main" }, "build-01", plan(), undefined);
    expect(lines.project).toEqual({ mark: "gitlab", place: "gitlab.com", name: "mistlabs/atlas", branch: "main" });
    expect(lines.where).toEqual({ machine: "build-01", dir: "/srv/work/atlas-1", note: "atlas is taken there, so atlas-1" });
    expect(addLines({ ...forge, host: "github.com" }, "x", plan({ taken: undefined }), undefined).project).toMatchObject({ mark: "github", branch: "default branch" });
    expect(addLines({ ...forge, host: "git.example.com" }, "x", plan(), undefined).project.mark).toBe("git");
    expect(addLines(forge, "x", plan({ taken: undefined }), undefined).where.note).toBeUndefined();
  });

  it("names a copy by the machine and folder it comes from, and the branch it is on", () => {
    const copy = { kind: "machine", machine: "m-studio", dir: "/Users/me/src/atlas", label: "studio-mini · /Users/me/src/atlas" } as const;
    const lines = addLines(copy, "build-01", plan({ checkout: { branch: "feature/x", head: "abc1234", ahead: 1, changed: 0, untracked: 0 } }), bringChoices(copy, "build-01", [])[0]);
    expect(lines.project).toEqual({ mark: "machine", place: "studio-mini", name: "atlas", branch: "feature/x" });
    expect(lines.bring.text).toBe(".env*.local from studio-mini");
  });

  it("says what is brought, and the first steps that run then, with how many more", () => {
    const lines = addLines(forge, "build-01", plan({ setup: { from: "file", target: "default", readiness: "installs", steps: [...steps] } }), { machine: "m-studio", label: "studio-mini" });
    expect(lines.bring).toEqual({ text: ".env*.local from studio-mini", patterns: [".env*.local"] });
    expect(addLines(forge, "build-01", plan(), undefined).bring.text).toBe(".env*.local: no other workspace of it to bring them from");
    expect(lines.then).toEqual({ text: "Install node 22 · pnpm install · 2 more", tone: "accent", count: 4 });
    const bare = addLines(forge, "build-01", plan({ bring: [] }), undefined);
    expect(bare.bring).toEqual({ text: "nothing git ignores", patterns: [] });
    expect(bare.then).toEqual({ text: "nothing to set up", tone: "dim", count: 0 });
  });
});

describe("a job's output as its log draws it", () => {
  it("starts a block at each command line, keeping what was said before the first and the progress redrawn", () => {
    const text = "Packing /src on mac…\n\r  9%\r  100%\nCopying /src\n$ git clone --branch x git@h:o/r.git C:\\Code\\r\nCloning into 'C:\\Code\\r'...\nfatal: no\nTrying again.\n$ git clone https://h/o/r.git C:\\Code\\r\n";
    expect(jobBlocks(text)).toEqual([
      { text: "Packing /src on mac…\n\r  9%\r  100%\nCopying /src\n" },
      { command: "git clone --branch x git@h:o/r.git C:\\Code\\r", text: "Cloning into 'C:\\Code\\r'...\nfatal: no\nTrying again.\n" },
      { command: "git clone https://h/o/r.git C:\\Code\\r", text: "" },
    ]);
    expect(jobBlocks("")).toEqual([]);
    expect(jobBlocks("$ a\r\n$ b")).toEqual([{ command: "a", text: "" }, { command: "b", text: "" }]);
  });
});

describe("where a chosen project stands among the person's (the person, 2026-11-21)", () => {
  const ID = "gitlab.com/mistlabs/jaira";
  const self = { id: "m-desk", label: "desk", state: "online" as const, self: true as const };
  const mac = { id: "m-mac", label: "mac-mini", state: "online" as const };
  const ws = (project: string, machine: ProjectSummary["machine"], identity?: string): ProjectSummary => ({
    project,
    label: project.split(/[\\/]/).pop()!,
    kind: "user",
    tasks: 0,
    running: 0,
    statuses: {},
    waiting: 0,
    ended: [],
    ...(identity !== undefined ? { identity } : {}),
    machine,
  });
  const groups = groupProjects(
    [ws("/Users/ofer/Code/jaira", self, ID), ws(remoteProjectKey("m-mac", "/srv/jaira"), mac, ID), ws("/Users/ofer/Code/notes", self), ws("/Users/ofer/Code/mist", self, "gitlab.com/mistlabs/mist")],
    true,
  );
  const jaira = groups.find((g) => g.identity === ID)!;
  const notes = groups.find((g) => g.label === "notes")!;
  const folder = (machine: string, dir: string, identity?: string) => ({ kind: "machine" as const, machine, dir, label: `x · ${dir}`, ...(identity !== undefined ? { identity } : {}) });
  const forge = (project: string) => ({ kind: "forge" as const, host: "gitlab.com", project, url: `https://gitlab.com/${project}.git`, label: project });

  it("Open: a folder or repository of a project the person has joins it; one already open is that workspace; anything else is new", () => {
    expect(standingOf(folder("m-desk", "/Users/ofer/src/jaira-2", ID), groups, "m-desk")).toMatchObject({ kind: "joins", group: { key: jaira.key } });
    expect(standingOf(forge("mistlabs/jaira"), groups, "m-desk")).toMatchObject({ kind: "joins", group: { key: jaira.key } });
    expect(standingOf(folder("m-mac", "/srv/jaira/", ID), groups, "m-desk")).toMatchObject({ kind: "workspace", group: { key: jaira.key } });
    expect(standingOf(folder("m-desk", "/Users/ofer/src/other", "github.com/x/other"), groups, "m-desk")).toEqual({ kind: "new" });
    expect(standingOf(folder("m-desk", "/Users/ofer/src/scratch"), groups, "m-desk")).toEqual({ kind: "new" });
  });

  it("Add: a folder of the project not yet open joins it; one of its workspaces is copied; anything else is refused, saying why", () => {
    expect(standingOf(folder("m-mac", "/home/ofer/jaira", ID), groups, "m-desk", jaira)).toMatchObject({ kind: "joins" });
    expect(standingOf(forge("mistlabs/jaira"), groups, "m-desk", jaira)).toMatchObject({ kind: "joins" });
    expect(standingOf(folder("m-desk", "/Users/ofer/Code/jaira", ID), groups, "m-desk", jaira)).toMatchObject({ kind: "workspace" });
    expect(standingOf(folder("m-desk", "/Users/ofer/Code/mist", "gitlab.com/mistlabs/mist"), groups, "m-desk", jaira)).toEqual({ kind: "other", reason: "mist is a workspace of mist, not jaira." });
    // No remote: nothing says what it is, so Add asks (the person, 2026-11-21).
    expect(standingOf(folder("m-desk", "/tmp/scratch"), groups, "m-desk", jaira)).toEqual({ kind: "unconnected", group: jaira, name: "scratch" });
    expect(standingOf(folder("m-desk", "/tmp/fork", "github.com/someone/jaira"), groups, "m-desk", jaira)).toEqual({ kind: "other", reason: "fork is github.com/someone/jaira, not jaira (gitlab.com/mistlabs/jaira)." });
    expect(standingOf(forge("mistlabs/mist"), groups, "m-desk", jaira)).toMatchObject({ kind: "other" });
    // A project with no remote: only its own workspaces are it.
    expect(standingOf(folder("m-desk", "/Users/ofer/Code/notes"), groups, "m-desk", notes)).toMatchObject({ kind: "workspace" });
    expect(standingOf(folder("m-desk", "/tmp/notes-2"), groups, "m-desk", notes)).toMatchObject({ kind: "other" });
  });

  it("says a join where it is, and nothing for what Add always did", () => {
    const here = folder("m-desk", "/Users/ofer/src/jaira-2", ID);
    expect(standingWords({ kind: "joins", group: jaira }, here, false, true)).toEqual({
      text: "The same repository as jaira: it becomes another of its workspaces, where it is. Nothing is copied.",
      tone: "ok",
    });
    expect(standingWords({ kind: "joins", group: jaira }, here, true, false)?.text).toBe("The same repository as jaira: the copy becomes another of its workspaces.");
    expect(standingWords({ kind: "joins", group: jaira }, forge("mistlabs/jaira"), false, false)?.text).toBe("jaira's repository: the clone becomes another of its workspaces.");
    expect(standingWords({ kind: "joins", group: jaira }, forge("mistlabs/jaira"), true, false)).toBeUndefined();
    expect(standingWords({ kind: "workspace", group: jaira }, here, true, false)).toBeUndefined();
    expect(standingWords({ kind: "workspace", group: jaira }, here, false, true)?.text).toBe("Already a workspace of jaira: opening it goes to it.");
    expect(standingWords({ kind: "other", reason: "no." }, here, true, false)).toEqual({ text: "no.", tone: "bad" });
    expect(standingWords({ kind: "new" }, here, false, true)).toBeUndefined();
  });

  it("says a folder with no remote is asked about where it is, and is not copied", () => {
    const scratch = folder("m-desk", "/tmp/scratch");
    expect(standingWords({ kind: "unconnected", group: jaira, name: "scratch" }, scratch, true, true)).toEqual({
      text: "scratch has no git remote, so nothing says it is jaira (gitlab.com/mistlabs/jaira). Adding it asks whether to connect it to that remote or to add it without git.",
      tone: "plain",
    });
    expect(standingWords({ kind: "unconnected", group: jaira, name: "scratch" }, scratch, true, false)?.tone).toBe("bad");
  });

  it("lists a machine's places: its projects folder, the folders holding workspaces, recent ones, home, roots", () => {
    expect(workspaceDirsOn(groups, "m-desk", "m-desk")).toEqual(["/Users/ofer/Code/jaira", "/Users/ofer/Code/notes", "/Users/ofer/Code/mist"]);
    expect(workspaceDirsOn(groups, "m-mac", "m-desk")).toEqual(["/srv/jaira"]);
    expect(
      machinePlacesOf({
        projectsFolder: "/Users/ofer/Projects",
        workspaces: ["/Users/ofer/Code/jaira", "/Users/ofer/Code/notes", "/Users/ofer/work/atlas", "/Users/ofer/Projects/x"],
        recent: ["/Users/ofer/Desktop", "/Users/ofer/Code/"],
        roots: ["/Users/ofer", "/"],
      }),
    ).toEqual([
      { kind: "projects", label: "Projects", dir: "/Users/ofer/Projects", note: "projects" },
      { kind: "workspaces", label: "Code", dir: "/Users/ofer/Code", note: "2 workspaces" },
      { kind: "workspaces", label: "work", dir: "/Users/ofer/work", note: "1 workspace" },
      { kind: "recent", label: "Desktop", dir: "/Users/ofer/Desktop", note: "recent" },
      { kind: "home", label: "Home", dir: "/Users/ofer" },
      { kind: "root", label: "/", dir: "/" },
    ]);
    expect(machinePlacesOf({ roots: ["C:\\Users\\o", "C:\\", "D:\\"], workspaces: ["C:\\src\\atlas"] }).map((p) => [p.kind, p.label, p.dir])).toEqual([
      ["workspaces", "src", "C:\\src"],
      ["home", "Home", "C:\\Users\\o"],
      ["root", "C:\\", "C:\\"],
      ["root", "D:\\", "D:\\"],
    ]);
    expect(machinePlacesOf({})).toEqual([]);
  });

  it("keeps the newest six folders chosen on a machine, each once", () => {
    let recent = withRecentFolder(undefined, "m", "/a");
    recent = withRecentFolder(recent, "m", "/b");
    recent = withRecentFolder(recent, "m", "/a/");
    expect(recent).toEqual({ m: ["/a/", "/b"] });
    for (const d of ["/1", "/2", "/3", "/4", "/5", "/6"]) recent = withRecentFolder(recent, "m", d);
    expect(recent["m"]).toEqual(["/6", "/5", "/4", "/3", "/2", "/1"]);
    expect(withRecentFolder(recent, "n", "/x")["m"]).toHaveLength(6);
  });

  it("chips a folder with the project it is open in, or would join", () => {
    expect(folderChip({ path: "/srv/jaira", project: true, git: true, identity: ID }, "m-mac", groups, "m-desk")).toBe("jaira · open");
    expect(folderChip({ path: "/srv/jaira-2", project: false, git: true, identity: ID }, "m-mac", groups, "m-desk")).toBe("jaira");
    expect(folderChip({ path: "/srv/other", project: false, git: true }, "m-mac", groups, "m-desk")).toBe("git");
    expect(folderChip({ path: "/srv/x", project: true, git: false }, "m-mac", groups, "m-desk")).toBe("JaiRA project");
    const root = groupProjects([{ ...ws("/Users/ofer/.jaira", self), kind: "shared", label: "~/.jaira" }], true);
    expect(folderChip({ path: "/Users/ofer/.jaira", project: true, git: false }, "m-desk", root, "m-desk")).toBe("open");
  });
});
