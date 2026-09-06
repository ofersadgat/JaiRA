/**
 * Prove, in the real app, that the editor's squiggles come from the real project.
 *
 *   npx tsx packages/app/shots/verifyTypeCheck.mts
 *
 * Not a photograph and not a unit test: the two things this covers are the two the other kinds
 * cannot reach. `file:check` has to survive the whole wire — preload, IPC, main, a worker thread
 * spawned from `dist/` — and the markers have to be DRAWN, which needs a Monaco with a model in a
 * window. Everything in between is `tsProject.test.ts`.
 *
 * Four scenes. The Files editor, where there is one text and one tree; the three GESTURES a program
 * makes possible — go to definition, peek, find all references, hover — whose results are a
 * navigation and a floating widget rather than a mark on the text, and which therefore no unit test
 * can see at all; and a REVIEW, where there are two texts and two trees — the proposed side in the
 * agent's worktree, the base side in a program built by putting the changeset's files back — and
 * where the whole value is that the two answers can differ.
 *
 * The world is a small TypeScript project made here rather than the checkout, so what "correct"
 * means is a fact about the fixture instead of about whatever is on the branch today.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { Git, NodeExec, happyRules } from "@jaira/runtime";
import { writeWorkflowFiles, specPlanningFiles } from "@jaira/runtime";
import { App } from "./driver.mjs";

/**
 * A world of its own per run, under one git-ignored parent.
 *
 * Not `.verify` itself, because `App.close()` kills the app and returns before Windows has finished
 * releasing its handles — so a rebuild of the same directory raced the previous run's processes and
 * came back as `EPERM` from a snapshot rename, which reads as a bug in the app and is not one.
 */
const ROOT = join(import.meta.dirname, ".verify", `run-${Date.now().toString(36)}`);
const OUT = join(import.meta.dirname, "out");

function put(project: string, path: string, text: string): void {
  const file = join(project, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/** A project with one file that is fine and one that is not, and imports that do resolve. */
async function build(): Promise<{ home: string; project: string }> {
  const home = join(ROOT, "home");
  const project = join(ROOT, "project");
  rmSync(ROOT, { recursive: true, force: true });
  const paths = initProject(project, home);
  // The planning workflow, so a task can be started — which is what makes a worktree.
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles() as Record<string, unknown>);
  put(
    project,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          baseUrl: ".",
          // A dependency that lives OUTSIDE the project — the shape a workspace junction has, and
          // the one this repository is full of: `@declarative-ai/*` resolves to a sibling checkout.
          // Its definitions are real and the Files view cannot open any of them.
          paths: { "@outside/*": ["../outside/*"] },
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );
  // Two lines, so a jump lands on a line that is not the first — which is the difference between
  // "it opened the right file" and "it went to the right place".
  put(project, "src/service.ts", "export const spare = 0;\n/** The one true answer. */\nexport const answer = 42;\n");
  // The file the bug was about: a relative import that resolves, and nothing else wrong with it.
  put(project, "src/clean.ts", 'import { answer } from "./service";\nexport const twice = answer * 2;\n');
  put(project, "src/broken.ts", 'import { answer } from "./service";\nexport const n: string = answer;\n');
  // The outside dependency, and a file that uses it.
  mkdirSync(join(ROOT, "outside"), { recursive: true });
  writeFileSync(join(ROOT, "outside", "far.ts"), "export const faraway = 'over there';\n", "utf8");
  put(project, "src/uses-outside.ts", 'import { faraway } from "@outside/far";\nexport const f = faraway;\n');
  // A file that is FINE at the base revision and is what the agent will change — the review scene.
  put(project, "src/reviewed.ts", 'import { answer } from "./service";\nexport const n: number = answer;\n');

  // Committed, because a review is against a revision. `changeset:review` diffs the worktree
  // against HEAD, so everything above is the "before" and everything the agent writes is the "after".
  const git = new Git({ exec: new NodeExec(), repoDir: project });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "verify@example.com"]);
  await git.run(["config", "user.name", "Verify"]);
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "base"]);
  return { home, project };
}

/** What the window says, flattened — the cheapest true signal that a state has been reached. */
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

const world = await build();
const app = await App.launch(world, { out: OUT, port: 9241, width: 1400, height: 900 });
const problems: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

try {
  await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");

  // 1. The channel, end to end: preload → main → worker → back.
  const clean = await app.ipc<{ checked: boolean; diagnostics: unknown[] }>("file:check", {
    layer: "project",
    project: world.project,
    path: "src/clean.ts",
  });
  check(clean.checked, "file:check reaches a real tsconfig through the packaged worker");
  check(clean.diagnostics.length === 0, `a resolving relative import is silent (got ${clean.diagnostics.length})`);

  const broken = await app.ipc<{ diagnostics: { code: number; startLine: number; message: string }[] }>("file:check", {
    layer: "project",
    project: world.project,
    path: "src/broken.ts",
  });
  check(broken.diagnostics.length === 1, `a real type error is reported (got ${broken.diagnostics.length})`);
  check(broken.diagnostics[0]?.code === 2322, `and it is the right one: ${JSON.stringify(broken.diagnostics[0])}`);

  // The buffer, which is what makes the editor follow typing.
  const typed = await app.ipc<{ diagnostics: unknown[] }>("file:check", {
    layer: "project",
    project: world.project,
    path: "src/clean.ts",
    text: 'export * from "./service";\nexport const twice: string = 84;\n',
  });
  check(typed.diagnostics.length === 1, `an unsaved edit is checked (got ${typed.diagnostics.length})`);

  // 2. The window: open each file and count what Monaco actually drew.
  await app.clickText("Files");
  // The tree opens collapsed; the sources are a folder down.
  await app.clickText("src");
  const squiggles = async (file: string): Promise<number> => {
    await app.clickText(file);
    await app.until(`document.querySelector(".monaco-host .view-lines") !== null`, `the editor for ${file}`);
    // A moment past the debounce, then let the answer land and paint.
    await app.until(
      `document.querySelectorAll(".monaco-host .view-lines").length > 0 && performance.now() > 0`,
      "the editor to settle",
    );
    await new Promise((r) => setTimeout(r, 2500));
    return app.evaluate<number>(
      `document.querySelectorAll(".monaco-host .squiggly-error, .monaco-host .squiggly-warning").length`,
    );
  };

  const drawnClean = await squiggles("clean.ts");
  check(drawnClean === 0, `clean.ts draws no squiggles (drew ${drawnClean})`);
  const drawnBroken = await squiggles("broken.ts");
  check(drawnBroken > 0, `broken.ts draws its error (drew ${drawnBroken})`);
  await app.shot("typecheck-broken");

  // 3. Go to Definition — the gesture, not the channel.
  //
  // Asked over IPC first, because a failure there and a failure in the window are different bugs and
  // the messages should say which. Then driven through the real thing: a mouse press to put the
  // caret on the imported name and F12 on it, which is exactly what the context menu's item runs.
  const found = await app.ipc<{ checked: boolean; definitions: { file: string; startLine: number; at?: unknown }[] }>(
    "file:definition",
    // Column 12 of `import { answer } from "./service";` — the `a` of `answer`.
    { layer: "project", project: world.project, path: "src/broken.ts", line: 1, column: 12 },
  );
  check(found.checked, "the compiler answers where a symbol is defined");
  check(found.definitions.length === 1, `one definition for an imported name (${found.definitions.length})`);
  const target = found.definitions[0];
  check(target?.file.endsWith("src/service.ts") === true, `in the file that declares it (${target?.file ?? "none"})`);
  check(target?.startLine === 3, `on the line it is declared on (${target?.startLine ?? 0})`);
  check(target?.at !== undefined, "with an address the Files view can open");

  // `broken.ts` is the file left open by the scene above. Find the token on screen and press on it.
  const spot = await app.evaluate<{ x: number; y: number } | { why: string }>(`(() => {
    const hosts = [...document.querySelectorAll(".monaco-host")];
    const lines = hosts.map((h) => h.querySelector(".view-lines")).filter(Boolean);
    if (lines.length === 0) return { why: "no editor: hosts=" + hosts.length };
    const first = lines[0].querySelector(".view-line");
    if (!first) return { why: "no line" };
    // Monaco groups a line into one span per token TYPE rather than per identifier, so \`{ answer }\`
    // arrives as a single span. The span is found by CONTENT and the column within it interpolated,
    // which an editor in a monospaced font makes exact.
    const spans = [...first.querySelectorAll("span")].filter((e) => e.children.length === 0);
    const token = spans.find((e) => (e.textContent ?? "").includes("answer"));
    if (!token) return { why: "spans=" + JSON.stringify(spans.map((e) => e.textContent)) };
    const text = token.textContent ?? "";
    const r = token.getBoundingClientRect();
    const per = r.width / Math.max(text.length, 1);
    const middle = text.indexOf("answer") + "answer".length / 2;
    return { x: r.left + per * middle, y: r.top + r.height / 2 };
  })()`);
  const at = "x" in spot ? spot : null;
  check(at !== null, `the imported name is on screen to click (${"why" in spot ? spot.why : "found"})`);
  if (at !== null) {
    await app.clickAt(at.x, at.y);

    // Ctrl+hover FIRST, because it is the cheapest gesture to make by accident and the one that
    // reported this as a bug. Monaco previews the definition under the pointer through
    // `startFindDefinition`, which resolves the target's model the same way Peek does — so a
    // definition in a file nobody has opened rejects with "Model not found", unhandled, straight
    // into the app's crash reporter. Nothing is asserted about what it draws; the assertion is the
    // one at the end of the run, that the app never said that.
    await app.hover(at.x, at.y, { ctrl: true });
    await app.hover(at.x + 40, at.y, { ctrl: true });
    await app.hover(at.x, at.y, { ctrl: true });

    // Peek Definition (Alt+F12). The one that needed a model for a file nobody has opened — without
    // it the widget came up empty, which is why this asserts on the PREVIEW's text rather than on
    // the widget merely existing.
    await app.press("F12", 123, { alt: true });
    await app.until(`document.querySelector(".monaco-editor .peekview-widget") !== null`, "the peek widget", 40);
    const peeked = await app.evaluate<string>(`(() => {
      const peek = document.querySelector(".peekview-widget");
      const lines = peek ? peek.querySelectorAll(".view-line") : [];
      return [...lines].map((e) => (e.textContent ?? "").replace(/\u00a0/g, " ")).join(" / ");
    })()`);
    check(peeked.includes("answer = 42"), `the peek previews the declaration (${JSON.stringify(peeked.slice(0, 80))})`);
    await app.shot("typecheck-peek");
    await app.press("Escape", 27);

    // Find All References (Shift+F12) — the same answer read the other way. `answer` is declared in
    // service.ts and used from clean.ts and broken.ts, so a result in three files is the proof that
    // this is not the one-file search Monaco used to do.
    await app.clickAt(at.x, at.y);
    await app.press("F12", 123, { shift: true });
    await app.until(`document.querySelector(".monaco-editor .peekview-widget") !== null`, "the references widget", 40);
    const referenced = await app.evaluate<{ files: string[]; title: string }>(`(() => {
      const peek = document.querySelector(".peekview-widget");
      const names = peek ? peek.querySelectorAll(".monaco-list-row .label-name") : [];
      return {
        files: [...new Set([...names].map((e) => (e.textContent ?? "").trim()))].sort(),
        title: (peek?.querySelector(".head")?.textContent ?? "").trim(),
      };
    })()`);
    // Every file that uses \`answer\`, which is the point: the one-file search this replaces could
    // only ever have found the two hits in \`broken.ts\` itself.
    check(
      referenced.files.join(",") === "broken.ts,clean.ts,reviewed.ts,service.ts",
      `references reach every file that uses it (${referenced.files.join(",")})`,
    );
    check(referenced.title.includes("References (7)"), `and are counted (${referenced.title})`);
    await app.shot("typecheck-references");
    await app.press("Escape", 27);

    // The hover. `answer` is imported here, so the type can only come from having read service.ts —
    // which is exactly what Monaco's own hover could not do, and why it used to say `any`.
    await app.hover(at.x, at.y);
    await app.until(`document.querySelector(".monaco-hover") !== null`, "the hover", 40);
    const said = await app.evaluate<string>(
      `(document.querySelector(".monaco-hover")?.textContent ?? "").replace(/\u00a0/g, " ")`,
    );
    check(said.includes("42") || said.includes("number"), `the hover says what it is (${JSON.stringify(said.slice(0, 90))})`);
    check(said.includes("The one true answer"), `and carries its doc comment (${JSON.stringify(said.slice(0, 90))})`);
    check(!said.includes("any"), `and does not say any (${JSON.stringify(said.slice(0, 90))})`);
    await app.shot("typecheck-hover");

    // A definition OUTSIDE the tree — the shape most of this repository's own imports have, since
    // `@declarative-ai/*` resolves through a workspace junction into a sibling checkout.
    //
    // Two things have to hold. It must be PREVIEWABLE, which needs the text to come from the program
    // rather than from a read contained to the project root; and it must not raise, because the
    // gesture that asks for the preview is a plain ctrl-hover — Monaco resolves the target's model
    // and rejects with "Model not found" when there is none, unhandled, into the crash reporter.
    //
    // What it cannot do is NAVIGATE there: the Files view draws the tree, and this file is not in it.
    const outside = await app.ipc<{ definitions: { file: string; at?: unknown }[] }>("file:definition", {
      layer: "project",
      project: world.project,
      path: "src/uses-outside.ts",
      line: 1,
      column: 12,
    });
    check(outside.definitions.length === 1, `the outside dependency resolves (${outside.definitions.length})`);
    check(outside.definitions[0]?.at === undefined, "and has no address, because the tree cannot open it");
    await squiggles("uses-outside.ts");
    const far = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const lines = document.querySelector(".monaco-host .view-lines");
      const first = lines ? lines.querySelector(".view-line") : null;
      if (!first) return null;
      const spans = [...first.querySelectorAll("span")].filter((e) => e.children.length === 0);
      const token = spans.find((e) => (e.textContent ?? "").includes("faraway"));
      if (!token) return null;
      const text = token.textContent ?? "";
      const r = token.getBoundingClientRect();
      const per = r.width / Math.max(text.length, 1);
      return { x: r.left + per * (text.indexOf("faraway") + 3.5), y: r.top + r.height / 2 };
    })()`);
    check(far !== null, "the outside name is on screen");
    if (far !== null) {
      // The gesture that reported this as a bug, first.
      await app.hover(far.x, far.y, { ctrl: true });
      await app.clickAt(far.x, far.y);
      await app.press("F12", 123, { alt: true });
      await app.until(`document.querySelector(".monaco-editor .peekview-widget") !== null`, "the outside peek", 40);
      const outsidePeek = await app.evaluate<string>(`(() => {
        const peek = document.querySelector(".peekview-widget");
        const lines = peek ? peek.querySelectorAll(".view-line") : [];
        return [...lines].map((e) => (e.textContent ?? "").replace(/\u00a0/g, " ")).join(" / ");
      })()`);
      check(
        outsidePeek.includes("faraway"),
        `a definition outside the tree can still be previewed (${JSON.stringify(outsidePeek.slice(0, 80))})`,
      );
      await app.shot("typecheck-peek-outside");
      await app.press("Escape", 27);
      // And going there does nothing, which is the honest answer: there is no row in the tree for it.
      await app.press("F12", 123);
      const stayed = await app.evaluate<boolean>(`document.body.innerText.includes("src/uses-outside.ts")`);
      check(stayed, "and going to it leaves the window where it was");
    }

    // Back to the file the jump is about, and go. Last, because it navigates away.
    await squiggles("broken.ts");
    await app.clickAt(at.x, at.y);
    // F12 — Monaco's own binding for the menu item, so this exercises the provider we registered and
    // the editor opener, rather than any path of this script's own.
    await app.press("F12", 123);
    await app.until(
      `document.body.innerText.includes("src/service.ts")`,
      "the window to follow the definition into service.ts",
      40,
    );
    const landed = await app.evaluate<{ file: string; line: string }>(`(() => {
      const host = document.querySelector(".monaco-host");
      const cursor = host ? host.querySelector(".cursor") : null;
      const at = cursor ? cursor.getBoundingClientRect().top : -1;
      // WHICH line the caret is on, read the way a person reads it: the line drawn where the caret is.
      const line = [...(host ? host.querySelectorAll(".view-line") : [])].find(
        (e) => Math.abs(e.getBoundingClientRect().top - at) < 2,
      );
      // Monaco renders some spaces as non-breaking, so the text it draws is not the text it holds.
      const said = line ? (line.textContent ?? "").replace(/ /g, " ") : "";
      return { file: document.body.innerText.includes("src/service.ts") ? "service.ts" : "?", line: said };
    })()`);
    check(landed.file === "service.ts", `the window opened the defining file (${landed.file})`);
    check(landed.line.includes("answer = 42"), `and put the caret on the declaration (${JSON.stringify(landed.line)})`);
    await app.shot("typecheck-definition");
  }

  // 3. A review: two sides, two trees, two answers.
  //
  // The agent's edit BREAKS one file and FIXES nothing, so the two sides must disagree in one
  // direction; and it also fixes `broken.ts`, so they disagree in the other. Both directions matter,
  // because a reviewer reads the pair rather than either half.
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title: "change the service",
    workflow: "feature/plan",
    inputs: { issue: "# change the service" },
    // A BRANCH is what makes a worktree: `ensureWorkspace` runs an unbound task in the checkout
    // itself, and a review of the checkout is a review with only one tree in it.
    branch: "work/change-the-service",
  });
  await app.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
  // Polled over IPC rather than watched in the DOM: the window is on the Files view, and a task
  // finishing is not something the Files view says anything about.
  let detail = await app.ipc<{ status: string; worktreePath?: string }>("task:detail", { taskId: made.taskId });
  for (let i = 0; i < 120 && detail.status !== "completed" && detail.status !== "failed"; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    detail = await app.ipc("task:detail", { taskId: made.taskId });
  }
  check(detail.status === "completed", `the task ran (${detail.status})`);
  const worktree = detail.worktreePath;
  check(worktree !== undefined, `the task got a worktree (${worktree ?? "none"})`);
  if (worktree !== undefined) {
    // What the agent "did": `answer` is annotated `string` and left holding a number. Three things
    // follow, and the scene turns on all three. `reviewed.ts` breaks; `broken.ts` — which wanted a
    // string all along — stops being broken; and `service.ts` ITSELF no longer compiles, which is
    // what puts a squiggle on the proposed side of the very file the diff is showing. The reviewer
    // lists changed files, so an error introduced in some other file is not one it can draw.
    writeFileSync(join(worktree, "src/service.ts"), "export const answer: string = 42;\n", "utf8");

    const proposed = await app.ipc<{ checked: boolean; diagnostics: { code: number }[] }>("file:check", {
      layer: "project",
      project: world.project,
      taskId: made.taskId,
      path: "src/reviewed.ts",
    });
    check(proposed.checked, "the proposed side is checked in the worktree");
    check(
      proposed.diagnostics.map((d) => d.code).join() === "2322",
      `the agent's change breaks reviewed.ts (${JSON.stringify(proposed.diagnostics.map((d) => d.code))})`,
    );

    const base = await app.ipc<{ baseline?: boolean; diagnostics: unknown[] }>("file:check", {
      layer: "project",
      project: world.project,
      taskId: made.taskId,
      path: "src/reviewed.ts",
      text: 'import { answer } from "./service";\nexport const n: number = answer;\n',
      baseline: [{ path: "src/service.ts", text: "export const answer: number = 42;\n" }],
    });
    check(base.baseline === true, "the base side says which program answered it");
    check(base.diagnostics.length === 0, `and it was fine before the change (${base.diagnostics.length})`);

    // The other direction: a file the change FIXED. Broken at the base, clean in the proposal.
    const fixedNow = await app.ipc<{ diagnostics: unknown[] }>("file:check", {
      layer: "project",
      project: world.project,
      taskId: made.taskId,
      path: "src/broken.ts",
    });
    check(fixedNow.diagnostics.length === 0, `broken.ts is fixed by the change (${fixedNow.diagnostics.length})`);
    const wasBroken = await app.ipc<{ diagnostics: unknown[] }>("file:check", {
      layer: "project",
      project: world.project,
      taskId: made.taskId,
      path: "src/broken.ts",
      text: 'import { answer } from "./service";\nexport const n: string = answer;\n',
      baseline: [{ path: "src/service.ts", text: "export const answer: number = 42;\n" }],
    });
    check(wasBroken.diagnostics.length === 1, `and was broken before it (${wasBroken.diagnostics.length})`);

    // And the window: the reviewer, with a squiggle on each side of the same diff.
    await app.ipc("changeset:review", { taskId: made.taskId });
    // Into the reviewed TASK, where the gate is hosted (§8.1) — the Files view is still on screen
    // from the scene above, and its tree lists the very same filenames the chooser does.
    // Title case: the sidebar labels are upper-cased by CSS, and `clickText` reads `textContent`.
    await app.clickText("Tasks");
    await app.until(says("change the service"), "the task list");
    await app.clickText("change the service");
    await app.until(`document.querySelector("[data-testid=changeset-review]") !== null`, "the reviewer to draw");
    // Scoped to the reviewer rather than `clickText`: the Files drawer is still open behind this and
    // its tree holds a row with the same name, which a page-wide search reaches first.
    const picked = await app.evaluate<boolean>(`(() => {
      const rows = [...document.querySelectorAll("[data-testid=changeset-review] button")];
      const row = rows.find((e) => (e.textContent ?? "").includes("service.ts"));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    check(picked, "the changed file is listed in the reviewer");
    await app.until(`document.querySelector(".monaco-diff-editor") !== null`, "the diff editor");
    await new Promise((r) => setTimeout(r, 4000));
    const sides = await app.evaluate<{ original: number; modified: number }>(`(() => {
      const editor = document.querySelector(".monaco-diff-editor");
      const halves = editor ? editor.querySelectorAll(".editor.original, .editor.modified") : [];
      const count = (cls) => {
        for (const half of halves) if (half.classList.contains(cls)) {
          return half.querySelectorAll(".squiggly-error, .squiggly-warning").length;
        }
        return -1;
      };
      return { original: count("original"), modified: count("modified") };
    })()`);
    check(sides.modified > 0, `the proposed side draws the error the change introduced (${sides.modified})`);
    check(sides.original === 0, `and the base side is clean, which is the whole comparison (${sides.original})`);
    await app.shot("typecheck-review");
  }
} finally {
  await app.close();
}

/**
 * Nothing may have gone wrong INSIDE the window.
 *
 * The gestures above are mostly Monaco's own machinery reaching back into ours, and its failure mode
 * is an unhandled rejection rather than a visibly broken widget — "Model not found" is what a peek
 * says when the file it wants to preview was never read. That surfaces in the app's crash reporter
 * and in nothing else, so it is asserted here rather than beside the gesture that caused it.
 */
const broke = app.complaints.filter((c) => /Model not found|Could not find source file|rejected with nobody/i.test(c));
check(broke.length === 0, `the window raised nothing while all that happened (${broke.join(" ").slice(0, 160)})`);

if (app.complaints.length > 0) console.log(`\nthe app complained:\n  ${app.complaints.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
