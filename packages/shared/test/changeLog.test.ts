/**
 * What a task changed, grouped as the tool menu groups tools (the Changes tab, 2026-09-26): files by
 * their own record of an edit, a command's file changes without counts, git steps and merge requests,
 * and everything else as a line of its group.
 */
import { describe, expect, it } from "vitest";
import { changeCountOf, changeLogOf, ownChangesOf, requestOfId, type ChangeCall, type ChangeCallPart } from "../src/changeLog";

const ROOT = "C:/work/repo";
const t = (s: number): number => Date.parse("2026-09-26T14:00:00Z") + s * 1000;
const title = (name: string): string => (name === "mcp__linear__update_issue" ? "Update issue" : name);
const part = (text: string, fields: Partial<ChangeCallPart> = {}): ChangeCallPart => ({ text, paths: [], change: true, ...fields });

const edit: ChangeCall = {
  id: "e1",
  name: "Edit",
  standard: "edit",
  category: "files",
  args: { file_path: `${ROOT}/src/styles.css`, old_string: "a", new_string: "b" },
  data: { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" .nav {", "-  overflow: visible;", "+  overflow-y: auto;", "+  min-height: 0;"] }] },
  at: t(1),
  change: true,
};
const create: ChangeCall = {
  id: "w1",
  name: "Write",
  standard: "write_file",
  category: "files",
  args: { file_path: `${ROOT}/test/scroll.test.ts`, content: "one\ntwo\nthree\n" },
  data: { type: "create" },
  at: t(2),
  change: true,
};
const shell = (id: string, command: string, parts: ChangeCallPart[], s: number, text?: string, description?: string): ChangeCall => ({
  id,
  name: "Bash",
  standard: "bash",
  category: "execution",
  args: { command, ...(description !== undefined ? { description } : {}) },
  ...(text !== undefined ? { text } : {}),
  parts,
  at: t(s),
  change: parts.some((p) => p.change),
});

describe("files", () => {
  it("reads counts and hunks from the edit's own record, and a created file from what it wrote", () => {
    const log = changeLogOf([edit, create], { root: ROOT, title });
    expect(log.files.map((f) => [f.path, f.action, f.added, f.removed])).toEqual([
      ["src/styles.css", "modify", 2, 1],
      ["test/scroll.test.ts", "create", 3, 0],
    ]);
    expect(log.files[0]!.hunks[0]!.header).toBe("@@ -3,2 +3,3 @@");
  });

  it("says a command changed a file without counting it: rm deletes, mv renames and keeps both names", () => {
    const log = changeLogOf(
      [
        shell("r1", "rm src/shim.ts && mv notes.md docs/notes.md", [part("rm src/shim.ts", { program: "rm", tool: "write_file", paths: ["src/shim.ts"] }), part("mv notes.md docs/notes.md", { program: "mv", tool: "write_file", paths: ["notes.md", "docs/notes.md"] })], 3),
      ],
      { root: ROOT, title },
    );
    expect(log.files.map((f) => ({ path: f.path, action: f.action, from: f.from, command: f.command, added: f.added }))).toEqual([
      { path: "docs/notes.md", action: "rename", from: "notes.md", command: "mv", added: undefined },
      { path: "src/shim.ts", action: "delete", from: undefined, command: "rm", added: undefined },
    ]);
    // Nothing else changed: the parts were files, not commands of their own.
    expect(log.execution).toEqual([]);
  });

  it("drops a file made and deleted in the same task, and carries a renamed file's edits to its new name", () => {
    const log = changeLogOf(
      [
        create,
        shell("r2", "rm test/scroll.test.ts", [part("rm test/scroll.test.ts", { program: "rm", tool: "write_file", paths: ["test/scroll.test.ts"] })], 4),
        edit,
        shell("m1", "git mv src/styles.css src/app.css", [part("git mv src/styles.css src/app.css", { program: "git", subcommand: "mv", paths: ["src/styles.css", "src/app.css"] })], 5),
      ],
      { root: ROOT, title },
    );
    expect(log.files.map((f) => [f.path, f.action, f.from, f.added])).toEqual([["src/app.css", "rename", "src/styles.css", 2]]);
  });
});

describe("git", () => {
  const commit = shell(
    "g1",
    'git add -A && git commit -m "settings: scroll"',
    [part("git add -A", { program: "git", subcommand: "add" }), part('git commit -m "settings: scroll"', { program: "git", subcommand: "commit" })],
    10,
    "[fix/scroll 3f2a1c9] settings: scroll\n 2 files changed",
  );
  const push = shell("g2", "git push -u origin fix/scroll", [part("git push -u origin fix/scroll", { program: "git", subcommand: "push" })], 11, "To gitlab.com:me/repo.git\n * [new branch]      fix/scroll -> fix/scroll");
  const status = shell("g0", "git status", [part("git status", { program: "git", subcommand: "status", change: false })], 9);
  const open: ChangeCall = {
    id: "g3",
    name: "mcp__dai__open_merge_request",
    standard: "open_merge_request",
    category: "git",
    args: { title: "Settings: the sidebar scrolls" },
    text: JSON.stringify({ merge_request: { number: 482, url: "https://gitlab.com/me/repo/-/merge_requests/482", branch: "fix/scroll", target: "main" } }),
    at: t(12),
    change: true,
  };
  const comment: ChangeCall = { id: "g4", name: "mcp__dai__git_comment", standard: "git_comment", category: "git", args: { number: 482, body: "x", path: "src/styles.css", line: 3 }, at: t(13), change: true, by: { kind: "subtask", name: "Review", taskId: "t-rev" } };

  it("makes a ladder of the steps, and a banner of each merge request with its link", () => {
    const log = changeLogOf([status, commit, push, open, comment, { ...edit, at: t(14) }], { root: ROOT, title });
    expect(log.git.steps.map((s) => [s.kind, s.subject])).toEqual([
      ["stage", undefined],
      ["commit", "3f2a1c9"],
      ["push", "fix/scroll"],
      ["open", "!482"],
      ["comment", "!482"],
    ]);
    expect(log.git.steps[1]!.detail).toBe("settings: scroll");
    expect(log.git.requests).toEqual([
      { number: 482, state: "open", title: "Settings: the sidebar scrolls", url: "https://gitlab.com/me/repo/-/merge_requests/482", branch: "fix/scroll", target: "main" },
    ]);
    expect(log.git.steps[4]!.url).toBe("https://gitlab.com/me/repo/-/merge_requests/482");
    // An edit after the commit is not in it.
    expect(log.git.uncommitted).toEqual(["src/styles.css"]);
  });

  it("leaves out what subtasks and subagents did, when asked", () => {
    const log = changeLogOf([commit, open, comment], { root: ROOT, title });
    expect(changeCountOf(log)).toBe(4);
    expect(ownChangesOf(log).git.steps.map((s) => s.kind)).toEqual(["stage", "commit", "open"]);
  });
});

describe("a request this task did not open", () => {
  it("is known by the id its tool answers with, and named by what the Git tools read about it", () => {
    const listed: ChangeCall = { id: "l1", name: "mcp__dai__list_merge_requests", standard: "list_merge_requests", category: "git", args: {}, text: JSON.stringify({ merge_requests: [{ number: 6, title: "ObjectQuery engine fixes", branch: "task/00", target: "master" }] }), at: t(1), change: false };
    const closed: ChangeCall = { id: "c1", name: "mcp__dai__close_merge_request", standard: "close_merge_request", category: "git", args: { number: 6 }, text: JSON.stringify({ ok: true, merge_request: "gitlab.com/mistlabs/mist-server!6", closed: true }), at: t(2), change: true };
    const log = changeLogOf([listed, closed], { root: ROOT, title });
    expect(log.git.requests).toEqual([{ number: 6, url: "https://gitlab.com/mistlabs/mist-server/-/merge_requests/6", state: "closed", title: "ObjectQuery engine fixes", branch: "task/00", target: "master" }]);
    expect(log.git.steps).toEqual([{ call: "c1", at: t(2), kind: "close", subject: "!6", request: 6, url: "https://gitlab.com/mistlabs/mist-server/-/merge_requests/6" }]);
  });

  it("reads a GitHub pull request's id as its page too", () => {
    expect(requestOfId("github.com/me/repo#12")).toEqual({ number: 12, url: "https://github.com/me/repo/pull/12" });
  });
});

describe("the other groups", () => {
  it("puts a command that changed something besides files and git under Execution, in its own words", () => {
    const log = changeLogOf([shell("x1", "npm install --save-dev @testing-library/dom", [part("npm install --save-dev @testing-library/dom", { program: "npm", subcommand: "install" })], 1, undefined, "Install the DOM testing library")], { root: ROOT, title });
    expect(log.execution).toEqual([{ call: "x1", said: "Install the DOM testing library", command: "npm install --save-dev @testing-library/dom", at: t(1) }]);
  });

  it("links an MCP change to the page its result names, and a task change to the state it started", () => {
    const issue: ChangeCall = { id: "m1", name: "mcp__linear__update_issue", category: "mcp", args: { id: "JAI-412", state: "In Review" }, text: JSON.stringify({ issue: { identifier: "JAI-412", url: "https://linear.app/x/issue/JAI-412" } }), at: t(2), change: true };
    const started: ChangeCall = { id: "s1", name: "start_task", standard: "start_task", category: "tasks", args: { state: "review" }, text: JSON.stringify({ ok: true, task: "t-1", key: "review", state: "review", status: "started" }), at: t(3), change: true };
    const log = changeLogOf([issue, started], { root: ROOT, title });
    expect(log.mcp).toEqual([{ call: "m1", said: "Update issue", subject: "JAI-412", url: "https://linear.app/x/issue/JAI-412", at: t(2) }]);
    expect(log.tasks).toEqual([{ call: "s1", said: "Started", subject: "review", open: { taskId: "t-1", stateId: "review" }, detail: "started", at: t(3) }]);
  });

  it("leaves out what did not change anything", () => {
    const read: ChangeCall = { id: "r", name: "Read", standard: "read_file", category: "files", args: { file_path: `${ROOT}/a.ts` }, change: false };
    expect(changeCountOf(changeLogOf([read], { root: ROOT, title }))).toBe(0);
  });
});
