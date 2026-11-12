/**
 * A browse's lint is kept while nothing it read has changed (workflows.ts `keptLint`).
 *
 * What matters is that a kept lint is never stale: an edit, a new file, a fragment a nearer layer now
 * supplies — each is read again. A file changed in the last two seconds may change again without its
 * time moving, so a lint that read one is not kept at all; these tests set every file's time back
 * (`settle`) to see a lint kept.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, type Project } from "../src/project";
import { browseWorkflows, forgetKeptLints } from "../src/workflows";

let dir: string;
let baseDir: string;
let project: Project;

/** These files, and every file and folder under these folders, dated `secondsAgo` back — older than a lint keeps. */
function settle(secondsAgo = 60, ...roots: string[]): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  const walk = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      utimesSync(path, when, when);
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      utimesSync(full, when, when);
    }
    utimesSync(path, when, when);
  };
  for (const root of roots.length > 0 ? roots : [join(dir, ".jaira", "workflows"), baseDir]) walk(root);
}

function write(root: string, relPath: string, content: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

const workflows = (): string => join(dir, ".jaira", "workflows");

function promptState(label: string, prompt: unknown): unknown {
  return {
    label,
    operation: { kind: "prompt", prompt, config: { model: "anthropic/claude-sonnet-5" }, output: { notes: { kind: "text" } } },
  };
}

beforeEach(() => {
  forgetKeptLints();
  dir = mkdtempSync(join(tmpdir(), "jaira-keptlint-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-keptlint-base-"));
  initProject(dir, baseDir);
  write(workflows(), "review.json", promptState("Review", "Look it over."));
  project = openProject(dir, { baseDir });
});

afterEach(() => {
  project.close();
  forgetKeptLints();
  rmSync(dir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

describe("a kept lint", () => {
  it("is kept while nothing it read has changed", () => {
    settle();
    const first = browseWorkflows(project).workflows[0]!;
    const second = browseWorkflows(project).workflows[0]!;
    expect(second.rootId).toBe("review");
    // The lint's own parts, handed out again; the entry itself is the caller's copy.
    expect(second.issues).toBe(first.issues);
    expect(second.states).toBe(first.states);
    expect(second).not.toBe(first);
  });

  it("is not kept while a file it read changed in the last moments", () => {
    const first = browseWorkflows(project).workflows[0]!;
    const second = browseWorkflows(project).workflows[0]!;
    expect(second.issues).not.toBe(first.issues);
  });

  it("reads an edited state file again", () => {
    settle();
    expect(browseWorkflows(project).workflows[0]!.label).toBe("Review");
    write(workflows(), "review.json", promptState("Second look", "Look it over."));
    // Dated back, but not to where it was: its time is what says it changed.
    settle(30, join(workflows(), "review.json"));
    expect(browseWorkflows(project).workflows[0]!.label).toBe("Second look");
  });

  it("lists a state file added beside the ones it read", () => {
    settle();
    expect(browseWorkflows(project).workflows.map((w) => w.rootId)).toEqual(["review"]);
    write(workflows(), "triage.json", promptState("Triage", "Sort them."));
    expect(browseWorkflows(project).workflows.map((w) => w.rootId)).toEqual(["review", "triage"]);
  });

  it("reads a fragment a nearer layer now supplies", () => {
    write(baseDir, "prompts/critique.md", "SHARED text.");
    write(workflows(), "review.json", promptState("Review", { $ref: "$/prompts/critique.md" }));
    settle(60, workflows(), baseDir, join(dir, ".jaira"));
    const shared = browseWorkflows(project).workflows[0]!.snapshotHash;
    expect(shared).toBeDefined();
    // The project's own copy, in a folder the lint never walks: what it read was that the project
    // had none.
    write(join(dir, ".jaira"), "prompts/critique.md", "PROJECT text.");
    settle(60, join(dir, ".jaira", "prompts"));
    const own = browseWorkflows(project).workflows[0]!.snapshotHash;
    expect(own).toBeDefined();
    expect(own).not.toBe(shared);
  });

  it("has the tasks laid over it fresh", () => {
    settle();
    expect(browseWorkflows(project).workflows[0]!.taskIds).toEqual([]);
    project.runtime.insert("t-1", 1);
    project.tasks.write({ id: "t-1", title: "Review", workflow: "review", createdAt: new Date(1).toISOString() });
    project.runtime.setSnapshot("t-1", "a-stale-hash", 2);
    const review = browseWorkflows(project).workflows[0]!;
    expect(review.taskIds).toEqual(["t-1"]);
    expect(review.driftedTasks).toEqual(["t-1"]);
  });
});
