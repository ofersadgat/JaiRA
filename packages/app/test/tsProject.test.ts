/**
 * The editor's diagnostics, against the project the file is actually in.
 *
 * The bug this exists for is one wrong squiggle: Monaco's own TypeScript service runs in a web
 * worker with no disk, so `import "./other"` resolved to nothing and it said so — "Cannot find
 * module … Did you mean to set the 'moduleResolution' option to 'nodenext'" — about a file that
 * compiles. The tests below are the two halves of the fix: a relative import and a `paths` alias
 * that DO resolve produce nothing, and a real type error still does.
 *
 * Everything runs against a `tsconfig.json` on a real disk, because that is the whole subject. A
 * mocked host would prove only that the mock resolves.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { TsCheckers, TsProjects } from "../src/main/tsProject";

let dir: string;
let projects: TsProjects;

/** Write a file under the temporary project, making the directories on the way. */
function put(path: string, text: string): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-tsproject-"));
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022"],
        strict: true,
        noEmit: true,
        baseUrl: ".",
        paths: { "@app/*": ["./src/*"] },
      },
      include: ["src"],
    }),
  );
  projects = new TsProjects();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checking a file in its project", () => {
  it("says nothing about an import that resolves — the squiggle that started this", () => {
    put("src/service.ts", "export const answer = 42;\n");
    const entry = put("src/index.ts", 'export * from "./service";\n');
    return projects.check(entry).then((check) => {
      expect(check.checked).toBe(true);
      expect(check.config).toContain("tsconfig.json");
      expect(check.diagnostics).toEqual([]);
    });
  });

  it("follows the config's own `paths`, which no in-browser program can", async () => {
    put("src/deep/tool.ts", "export const tool = (): string => 'ok';\n");
    const entry = put("src/index.ts", 'import { tool } from "@app/deep/tool";\nexport const used = tool();\n');
    const check = await projects.check(entry);
    expect(check.diagnostics).toEqual([]);
  });

  it("reports a real error, where it is", async () => {
    const entry = put("src/index.ts", "export const n: number = 'no';\n");
    const check = await projects.check(entry);
    expect(check.checked).toBe(true);
    expect(check.diagnostics).toHaveLength(1);
    const [only] = check.diagnostics;
    expect(only?.severity).toBe("error");
    expect(only?.code).toBe(2322);
    expect(only?.message).toContain("not assignable");
    // 1-based, the way an editor counts. TypeScript anchors an unassignable initializer on the
    // NAME being declared, so this is the `n` at column 14 — off by one here would put every
    // squiggle in the editor one character to the left of what it is about.
    expect(only?.startLine).toBe(1);
    expect(only?.startColumn).toBe(14);
    expect(only?.endLine).toBe(1);
    expect(only?.endColumn).toBe(15);
  });

  it("checks the BUFFER, so an error appears before anything is saved", async () => {
    const entry = put("src/index.ts", "export const n: number = 1;\n");
    expect((await projects.check(entry)).diagnostics).toEqual([]);
    const typed = await projects.check(entry, "export const n: number = 'no';\n");
    expect(typed.diagnostics).toHaveLength(1);
    // And back: the buffer is authoritative in both directions, not a one-way override.
    expect((await projects.check(entry, "export const n: number = 2;\n")).diagnostics).toEqual([]);
  });

  it("sees an edit made to ANOTHER file on disk, with nothing to invalidate", async () => {
    put("src/service.ts", "export const answer: number = 42;\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n: number = answer;\n');
    expect((await projects.check(entry)).diagnostics).toEqual([]);
    // What an agent editing the worktree does. The mtime moves, so the version string moves.
    put("src/service.ts", "export const answer: string = 'forty two';\n");
    const after = await projects.check(entry);
    expect(after.diagnostics).toHaveLength(1);
    expect(after.diagnostics[0]?.code).toBe(2322);
  });

  it("checks a file the config does not include, rather than refusing it", async () => {
    // `include` is `src`, and this is beside it. The file is real, its imports resolve, and an
    // editor that went blank on it would be reporting the config's shape as an absence of errors.
    const entry = put("scratch.ts", "export const n: number = 'no';\n");
    const check = await projects.check(entry);
    expect(check.checked).toBe(true);
    expect(check.diagnostics).toHaveLength(1);
  });

  it("reports a syntax error as well as a type one — the app has no other parser", async () => {
    // Monaco's own TypeScript validation is off everywhere (see `monacoDiff.tsx`), so a missing
    // brace has to come from here or from nowhere.
    const entry = put("src/index.ts", "export const f = (: number => 1;\n");
    const check = await projects.check(entry);
    expect(check.checked).toBe(true);
    expect(check.diagnostics.length).toBeGreaterThan(0);
    expect(check.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  it("parses a .tsx file as one, so its tags are not errors", async () => {
    // The bug a model with no name used to have, on the other side of the wire: script kind comes
    // from the extension, and a `.tsx` read as `.ts` makes every tag a syntax error.
    put(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", noEmit: true },
        include: ["src"],
      }),
    );
    const entry = put("src/view.tsx", "export const tag = <div id='x' />;\n");
    const check = await projects.check(entry);
    // The JSX itself parses; what is left is the missing React runtime, which is a fact about the
    // fixture rather than about the syntax.
    expect(check.diagnostics.every((d) => d.code !== 1005 && d.code !== 1109)).toBe(true);
  });

  it("says so when no project covers the file — but still parses it", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "jaira-tsorphan-"));
    try {
      const file = join(orphan, "lonely.ts");
      // A type error needs a program and is NOT reported; a missing brace does not and is.
      writeFileSync(file, "export const n: number = 'no';\n", "utf8");
      const typed = await projects.check(file);
      expect(typed.checked).toBe(false);
      expect(typed.reason).toContain("tsconfig.json");
      expect(typed.diagnostics).toEqual([]);

      writeFileSync(file, "export const f = (: number => 1;\n", "utf8");
      const broken = await projects.check(file);
      expect(broken.checked).toBe(false);
      expect(broken.diagnostics.length).toBeGreaterThan(0);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("rebuilds when the config itself changes", async () => {
    put("src/deep/tool.ts", "export const tool = (): string => 'ok';\n");
    const entry = put("src/index.ts", 'import { tool } from "@app/deep/tool";\nexport const used = tool();\n');
    expect((await projects.check(entry)).diagnostics).toEqual([]);
    // The alias withdrawn. A held program would keep resolving it and report nothing at all.
    put(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true },
        include: ["src"],
      }),
    );
    const after = await projects.check(entry);
    expect(after.diagnostics.map((d) => d.code)).toContain(2307);
  });

  it("releases a buffer, so the file on disk is the truth again", async () => {
    const entry = put("src/index.ts", "export const n: number = 1;\n");
    expect((await projects.check(entry, "export const n: number = 'no';\n")).diagnostics).toHaveLength(1);
    await projects.release(entry);
    expect((await projects.check(entry)).diagnostics).toEqual([]);
  });
});

/**
 * The channel, which is the address rather than the answer.
 *
 * `file:check` is addressed exactly like the `file:read` that opened the document — a layer, a
 * project and a path — and resolves through the same containment check, so the tests worth writing
 * here are that a checkout's own source reaches the compiler and that a path pointing out of the
 * root does not. The checking itself is above, against a real `tsconfig.json`, with no service in
 * the way.
 */
describe("file:check", () => {
  let project: string;
  let service: AppService;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), "jaira-tscheck-"));
    initProject(project, testHome());
    // The real one spawns a worker that loads a bundle out of `dist/`. This is the same class the
    // worker holds, in this process — see `AppServiceOptions.typeCheck`.
    service = new AppService({ baseDir: testHome(), watchWorkflows: false, typeCheck: new TsCheckers() });
    await service.open(project);
  });

  afterEach(async () => {
    await service.close();
    rmSync(project, { recursive: true, force: true });
  });

  it("checks a file in the checkout, addressed the way the tree draws it", async () => {
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
      "utf8",
    );
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src/index.ts"), "export const n: number = 1;\n", "utf8");

    const clean = await service.checkFile({ layer: "project", path: "src/index.ts" });
    expect(clean.checked).toBe(true);
    expect(clean.diagnostics).toEqual([]);

    // The BUFFER, so an editor gets an answer about what is on screen rather than what was saved.
    const typing = await service.checkFile({
      layer: "project",
      path: "src/index.ts",
      text: "export const n: number = 'no';\n",
    });
    expect(typing.diagnostics.map((d) => d.code)).toEqual([2322]);

    // And withdrawn when the editor closes: the file on disk is the truth again.
    await service.releaseFile({ layer: "project", path: "src/index.ts" });
    expect((await service.checkFile({ layer: "project", path: "src/index.ts" })).diagnostics).toEqual([]);
  });

  it("refuses a path that climbs out of the root", async () => {
    await expect(service.checkFile({ layer: "project", path: "../../elsewhere/secret.ts" })).rejects.toThrow(
      /is not inside the project root/i,
    );
  });

  it("says no project covers a file rather than throwing, so an editor need not catch", async () => {
    writeFileSync(join(project, "loose.ts"), "export const n: number = 'no';\n", "utf8");
    const check = await service.checkFile({ layer: "project", path: "loose.ts" });
    expect(check.checked).toBe(false);
    expect(check.diagnostics).toEqual([]);
  });
});

/**
 * The other side of a diff — the tree as it was before the changeset.
 *
 * A review shows two texts and they belong to two different trees. The proposed side is on a disk
 * and is the ordinary case. The base side is a git revision, which nothing holds a tree of — so
 * {@link TsCheckers} makes one by putting the changed files back and reading everything else off the
 * same disk. What these pin is that the two answers can DIFFER, because that difference is the whole
 * point: it is how a reviewer tells an error the change introduced from one that was already there.
 */
describe("the baseline — a second program, for the before-side", () => {
  let checkers: TsCheckers;

  beforeEach(() => {
    checkers = new TsCheckers();
  });

  afterEach(async () => {
    await checkers.close();
  });

  it("answers about the before-text while the disk holds the after", async () => {
    // The worktree as the agent left it: `answer` is a string now, and `index.ts` was updated to
    // match. Both files on disk are the proposed side.
    put("src/service.ts", "export const answer: string = 'forty two';\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n: string = answer;\n');

    // The proposed side, in the tree it is in: nothing wrong with it.
    expect((await checkers.check(entry)).diagnostics).toEqual([]);

    // The same file at the base revision, in a tree where `answer` was still a number. The error is
    // real and was there before this changeset — which is exactly what the reviewer needs told.
    const before = await checkers.check(entry, 'import { answer } from "./service";\nexport const n: string = answer;\n', [
      { file: join(dir, "src/service.ts"), text: "export const answer: number = 42;\n" },
    ]);
    expect(before.baseline).toBe(true);
    expect(before.diagnostics.map((d) => d.code)).toEqual([2322]);

    // And the live program is untouched by having been asked: two programs, not one re-seeded.
    expect((await checkers.check(entry)).diagnostics).toEqual([]);
  });

  it("makes a file the changeset CREATED not exist in the baseline", async () => {
    put("src/made.ts", "export const made = 1;\n");
    const entry = put("src/index.ts", 'import { made } from "./made";\nexport const n = made;\n');
    expect((await checkers.check(entry)).diagnostics).toEqual([]);

    // `null`, not "": at the base revision there was no such file, so the import does not resolve.
    // An empty string would resolve and export nothing, which is a different — and wrong — error.
    const before = await checkers.check(entry, 'import { made } from "./made";\nexport const n = made;\n', [
      { file: join(dir, "src/made.ts"), text: null },
      { file: join(dir, "src/index.ts"), text: 'import { made } from "./made";\nexport const n = made;\n' },
    ]);
    expect(before.diagnostics.map((d) => d.code)).toEqual([2307]);
    expect(before.diagnostics[0]?.message).toContain("Cannot find module");
  });

  it("brings back a file the changeset DELETED, so the before-side resolves", async () => {
    // Deleted in the worktree: it is not on disk at all.
    const entry = put("src/index.ts", 'import { gone } from "./gone";\nexport const n: number = gone;\n');
    expect((await checkers.check(entry)).diagnostics.map((d) => d.code)).toEqual([2307]);

    const before = await checkers.check(entry, 'import { gone } from "./gone";\nexport const n: number = gone;\n', [
      { file: join(dir, "src/gone.ts"), text: "export const gone = 7;\n" },
    ]);
    expect(before.diagnostics).toEqual([]);
  });

  it("forgets the previous changeset when it is re-seeded for another", async () => {
    put("src/service.ts", "export const answer: string = 'forty two';\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n: string = answer;\n');
    const text = 'import { answer } from "./service";\nexport const n: string = answer;\n';

    expect(
      (await checkers.check(entry, text, [{ file: join(dir, "src/service.ts"), text: "export const answer: number = 42;\n" }]))
        .diagnostics,
    ).toHaveLength(1);
    // A second review, touching nothing this file depends on. The first changeset's overlay must be
    // gone, or every later review would be answered against the first one's tree.
    const other = await checkers.check(entry, text, [{ file: join(dir, "src/unrelated.ts"), text: "export const x = 1;\n" }]);
    expect(other.diagnostics).toEqual([]);
  });

  it("says a created file has nothing wrong with it when asked about it in the baseline", async () => {
    // The left-hand side of a `create` is empty and the file was not there. Nothing to report, and
    // certainly not "cannot find module" about the file itself.
    const entry = put("src/made.ts", "export const made = 1;\n");
    const before = await checkers.check(entry, "", [{ file: entry, text: null }]);
    expect(before.checked).toBe(true);
    expect(before.diagnostics).toEqual([]);
  });
});

/**
 * A review's two sides, over the channel, in the tree each one belongs to.
 *
 * The proposed side is in the agent's WORKTREE — a whole tree with its own `tsconfig.json` and its
 * own copy of every sibling — and answering out of the checkout instead would be answering about the
 * version the agent started from, which is worse than not answering because it looks like an answer.
 * The base side is a revision nothing holds a tree of, and is reached by putting the changeset's
 * files back.
 */
describe("file:check, in a task's worktree", () => {
  let project: string;
  let worktree: string;
  let service: AppService;

  /** A task whose worktree is `worktree` — the shape, without materialising a git worktree. */
  function worktreeTask(at?: string): string {
    const taskId = service.createTask({ title: "Do the work", workflow: "feature/plan", inputs: { issue: "x" } }).taskId;
    if (at === undefined) return taskId;
    const db = new Database(join(project, ".jaira", "system", "jaira.db"));
    try {
      db.prepare(`UPDATE task_runtime SET worktree_path = ? WHERE task_id = ?`).run(at, taskId);
    } finally {
      db.close();
    }
    return taskId;
  }

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), "jaira-tsworktree-"));
    initProject(project, testHome());
    // Two trees that differ, so an answer proves WHICH one it came from. The checkout's copy is the
    // version the agent started from; the worktree's is what it proposes.
    for (const [root, answer] of [
      [project, "export const answer: number = 42;\n"],
      [join(project, "wt"), "export const answer: string = 'forty two';\n"],
    ] as const) {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
        "utf8",
      );
      writeFileSync(join(root, "src/service.ts"), answer, "utf8");
      writeFileSync(
        join(root, "src/index.ts"),
        'import { answer } from "./service";\nexport const n: string = answer;\n',
        "utf8",
      );
    }
    worktree = join(project, "wt");
    service = new AppService({ baseDir: testHome(), watchWorkflows: false, typeCheck: new TsCheckers() });
    await service.open(project);
  });

  afterEach(async () => {
    await service.close();
    rmSync(project, { recursive: true, force: true });
  });

  it("checks the proposed side in the worktree, not in the checkout", async () => {
    const taskId = worktreeTask(worktree);
    // In the worktree `answer` is a string, so `const n: string = answer` is fine. In the checkout
    // it is a number and the same file does not compile — which is how we know where this came from.
    expect((await service.checkFile({ layer: "project", path: "src/index.ts", taskId })).diagnostics).toEqual([]);
    expect(
      (await service.checkFile({ layer: "project", path: "src/index.ts" })).diagnostics.map((d) => d.code),
    ).toEqual([2322]);
  });

  it("checks the base side against the changeset's before-side", async () => {
    const taskId = worktreeTask(worktree);
    const before = await service.checkFile({
      layer: "project",
      path: "src/index.ts",
      taskId,
      text: 'import { answer } from "./service";\nexport const n: string = answer;\n',
      // What `baselineOf` produces for a changeset that changed `service.ts`: the file put back.
      baseline: [{ path: "src/service.ts", text: "export const answer: number = 42;\n" }],
    });
    expect(before.baseline).toBe(true);
    expect(before.diagnostics.map((d) => d.code)).toEqual([2322]);
    // The proposed side is unaffected by having asked — two programs, not one re-seeded.
    expect((await service.checkFile({ layer: "project", path: "src/index.ts", taskId })).diagnostics).toEqual([]);
  });

  it("refuses a task with no worktree instead of answering about the checkout", async () => {
    const taskId = worktreeTask();
    await expect(service.checkFile({ layer: "project", path: "src/index.ts", taskId })).rejects.toThrow(/no worktree/i);
  });

  it("keeps a baseline path inside the tree it names", async () => {
    const taskId = worktreeTask(worktree);
    await expect(
      service.checkFile({
        layer: "project",
        path: "src/index.ts",
        taskId,
        baseline: [{ path: "../../elsewhere/secret.ts", text: "" }],
      }),
    ).rejects.toThrow(/is not inside the project root/i);
  });
});

/**
 * Go to Definition, which is the same fact about the program read a different way.
 *
 * Monaco ships a definition provider of its own, backed by the in-browser service whose program is
 * the one file on screen — so a symbol that came from an import resolved nowhere and the menu item
 * did nothing. A symbol defined in the SAME file worked, which is what made it read as broken rather
 * than as absent, and is why the first test below is the cross-file one.
 */
describe("where a symbol is defined", () => {
  it("follows a relative import into the file that defines it", async () => {
    const target = put("src/service.ts", "export const answer = 42;\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n = answer;\n');
    // The `answer` on line 2, column 19.
    const found = await projects.definitions(entry, { line: 2, column: 19 });
    expect(found.checked).toBe(true);
    expect(found.definitions).toHaveLength(1);
    const [only] = found.definitions;
    expect(only?.file.toLowerCase()).toBe(target.split("\\").join("/").toLowerCase());
    expect(only?.name).toBe("answer");
    expect(only?.startLine).toBe(1);
  });

  it("follows the config's own `paths`, which no in-browser program can", async () => {
    const target = put("src/deep/tool.ts", "export const tool = (): string => 'ok';\n");
    const entry = put("src/index.ts", 'import { tool } from "@app/deep/tool";\nexport const used = tool();\n');
    const found = await projects.definitions(entry, { line: 2, column: 21 });
    expect(found.definitions.map((d) => d.file.toLowerCase())).toEqual([target.split("\\").join("/").toLowerCase()]);
  });

  it("finds a definition in the same file, at the place it is", async () => {
    const entry = put("src/index.ts", "const answer = 42;\nexport const n = answer;\n");
    const found = await projects.definitions(entry, { line: 2, column: 18 });
    expect(found.definitions).toHaveLength(1);
    expect(found.definitions[0]?.startLine).toBe(1);
    // 1-based, the way an editor counts: `answer` starts at column 7 of `const answer = 42;`.
    expect(found.definitions[0]?.startColumn).toBe(7);
  });

  it("reads the BUFFER, so a definition can be followed before anything is saved", async () => {
    const target = put("src/service.ts", "export const answer = 42;\n");
    const entry = put("src/index.ts", "export const n = 1;\n");
    const found = await projects.definitions(entry, { line: 2, column: 19 }, 'import { answer } from "./service";\nexport const n = answer;\n');
    expect(found.definitions.map((d) => d.file.toLowerCase())).toEqual([target.split("\\").join("/").toLowerCase()]);
  });

  it("answers nothing where there is nothing under the caret", async () => {
    const entry = put("src/index.ts", "export const n = 1;\n");
    expect((await projects.definitions(entry, { line: 1, column: 1 })).definitions).toEqual([]);
  });

  it("refuses to guess when no project covers the file", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "jaira-tsdef-"));
    try {
      const file = join(orphan, "lonely.ts");
      writeFileSync(file, "const answer = 1;\nexport const n = answer;\n", "utf8");
      const found = await projects.definitions(file, { line: 2, column: 18 });
      // A parse could have found this one — it is in the same file — but a program is what tells the
      // difference between that and an import, and answering only the easy half is how a feature
      // becomes untrustworthy.
      expect(found.checked).toBe(false);
      expect(found.definitions).toEqual([]);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

/**
 * The other two questions a program can answer about a position.
 *
 * Both were already offered by Monaco and both were answered from its one-file program, so both were
 * wrong in the same way: "Find All References" found only the uses in the file you were looking at,
 * and a hover over an imported name said `any` — which is worse than nothing, because `any` is a
 * specific claim and it was false.
 */
describe("what else a program knows about a position", () => {
  it("finds references across the files that import a symbol", async () => {
    put("src/service.ts", "export const answer = 42;\n");
    put("src/one.ts", 'import { answer } from "./service";\nexport const a = answer;\n');
    const entry = put("src/two.ts", 'import { answer } from "./service";\nexport const b = answer;\n');
    // From the use in `two.ts`: the declaration, both imports, and both uses.
    const found = await projects.references(entry, { line: 2, column: 18 });
    expect(found.checked).toBe(true);
    const files = new Set(found.references.map((r) => r.file.toLowerCase().split("/").pop()));
    expect([...files].sort()).toEqual(["one.ts", "service.ts", "two.ts"]);
    expect(found.truncated).toBeUndefined();
  });

  it("says a symbol used in one file is used in one file", async () => {
    const entry = put("src/index.ts", "const answer = 42;\nexport const n = answer;\n");
    const found = await projects.references(entry, { line: 1, column: 7 });
    expect(found.references.map((r) => r.startLine).sort()).toEqual([1, 2]);
  });

  it("says what a symbol IS, with the type the project gives it", async () => {
    put("src/service.ts", "/** The one true answer. */\nexport const answer: number = 42;\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n = answer;\n');
    const hover = await projects.hover(entry, { line: 2, column: 18 });
    expect(hover.checked).toBe(true);
    // The whole point: `number`, not `any`. An in-browser program that never read `service.ts` can
    // only say `any`, and it said it with confidence.
    expect(hover.info?.signature).toContain("number");
    expect(hover.info?.documentation).toBe("The one true answer.");
    expect(hover.info?.startLine).toBe(2);
  });

  it("serves the text of a file the program resolved, and only that", async () => {
    // What a peek previews. The bound is the PROGRAM rather than a directory, which is the whole
    // reason this is not `file:read`: a definition can resolve outside the tree, and in this
    // repository most do. A path the compiler never resolved is simply not there to be asked for.
    const target = put("src/service.ts", "export const answer = 42;\n");
    const entry = put("src/index.ts", 'import { answer } from "./service";\nexport const n = answer;\n');
    await projects.check(entry);
    expect(await projects.sourceOf(entry, target)).toBe("export const answer = 42;\n");

    // On disk, beside the sources, and not part of this program: no answer.
    const unresolved = put("stranger.ts", "export const secret = 1;\n");
    expect(await projects.sourceOf(entry, unresolved)).toBeUndefined();
    // And nothing at all for a path that does not exist.
    expect(await projects.sourceOf(entry, join(dir, "src/nowhere.ts"))).toBeUndefined();
  });

  it("has nothing to say about whitespace", async () => {
    const entry = put("src/index.ts", "export const n = 1;\n\n\n");
    expect((await projects.hover(entry, { line: 3, column: 1 })).info).toBeUndefined();
  });

  it("answers neither question without a project, rather than answering half of it", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "jaira-tsask-"));
    try {
      const file = join(orphan, "lonely.ts");
      writeFileSync(file, "const answer = 1;\nexport const n = answer;\n", "utf8");
      expect((await projects.references(file, { line: 2, column: 18 })).checked).toBe(false);
      expect((await projects.hover(file, { line: 2, column: 18 })).checked).toBe(false);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
