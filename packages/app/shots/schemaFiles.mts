/**
 * Prove, in the real app, that a file is held to its ecosystem's schema by its NAME.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/schemaFiles.mts
 *
 * Five files a project carries — `package.json`, a commented `tsconfig.json`, `compose.yaml`,
 * `.gitlab-ci.yml` and a GitHub Actions workflow (found by its DIRECTORY) — each with one mistake in it. Opened in the Files view, each must land on the schema-aware editor with its schema
 * already chosen, and say what is wrong. Detection, the YAML parse and the 2020-12 compile all happen
 * in main, so this is the only place the whole wire is seen at once.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";

const ROOT = join(import.meta.dirname, ".verify", `schemas-${Date.now().toString(36)}`);
const OUT = join(import.meta.dirname, "out");

function put(project: string, path: string, text: string): void {
  const file = join(project, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
}

const home = join(ROOT, "home");
const project = join(ROOT, "project");
rmSync(ROOT, { recursive: true, force: true });
initProject(project, home);
// `private` must be a boolean to npm.
put(project, "package.json", `${JSON.stringify({ name: "demo", version: "1.0.0", private: "yes", scripts: { build: "tsc" } }, null, 2)}\n`);
// JSONC, as tsconfigs are written — and `strict` must be a boolean.
put(
  project,
  "tsconfig.json",
  '{\n  // the settings every package shares\n  "compilerOptions": {\n    "strict": "yes",\n    "target": "ES2022", // a trailing comma follows\n  },\n}\n',
);
// A job with no `runs-on`.
put(project, ".github/workflows/ci.yml", "on: push\njobs:\n  build:\n    steps:\n      - run: make\n");
// `imagee` is not a service key.
put(project, "compose.yaml", "services:\n  web:\n    imagee: nginx\n    ports:\n      - \"80:80\"\n");
// `scrpt` is not a job key, and a job with no `script` cannot run.
put(project, ".gitlab-ci.yml", "stages: [build]\n\nbuild:\n  stage: build\n  scrpt: make\n");

const app = await App.launch({ home, project }, { out: OUT, port: 9243, width: 1400, height: 900 });
/**
 * Click the Files tree row named EXACTLY this. Not `clickText`, which takes the deepest element that
 * merely contains the text — once the picker lists "tsconfig.json (TypeScript)", that is its option.
 */
async function openRow(name: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const row = [...document.querySelectorAll("body *")].find(
      (e) => e.children.length === 0 && e.textContent?.trim() === ${JSON.stringify(name)} && e.closest("select") === null,
    );
    row?.click();
    return row !== undefined;
  })()`);
  if (!hit) throw new Error(`no row named ${name}`);
  await new Promise((r) => setTimeout(r, 400));
}

const problems: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

try {
  await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
  // `textContent`, not `innerText`: the sidebar draws its room names in capitals.
  await app.until(`document.body.textContent.includes("Files")`, "the Files room to be offered");
  await app.clickText("Files");

  for (const [file, label, shot, open] of [
    ["package.json", "package.json (npm)", "schema-package-json"],
    ["tsconfig.json", "tsconfig.json (TypeScript)", "schema-tsconfig"],
    ["ci.yml", "GitHub Actions workflow", "schema-github-workflow", [".github", "workflows"]],
    ["compose.yaml", "Compose file", "schema-compose"],
    [".gitlab-ci.yml", "GitLab CI/CD", "schema-gitlab-ci"],
  ] as ReadonlyArray<readonly [string, string, string, ReadonlyArray<string>?]>) {
    // The folders a file sits in, opened first: the tree starts collapsed.
    for (const folder of open ?? []) await openRow(folder);
    await openRow(file);
    await app.until(`document.querySelector(".schema-edit") !== null`, `the schema-aware editor for ${file}`);
    await app.until(
      `(() => { const s = document.querySelector(".schema-pick select"); return s !== null && s.selectedOptions[0]?.textContent === ${JSON.stringify(label)}; })()`,
      `${file} to be held to ${label}`,
    );
    check(true, `${file} opens held to ${label}`);
    await app.until(`document.querySelector(".schema-bar .chip-bad") !== null`, `${file}'s verdict`);
    const said = await app.evaluate<string>(
      `[...document.querySelectorAll(".violation")].map((e) => e.textContent).join(" | ")`,
    );
    check(said.length > 0, `${file} says what is wrong: ${said.slice(0, 160)}`);
    await app.shot(shot);
  }
} catch (error) {
  await app.shot("schema-failure");
  console.log("SELECT:", await app.evaluate<string>(`[...document.querySelectorAll(".schema-pick select")].map((s) => s.selectedOptions[0]?.textContent).join(" / ")`));
  console.log("PATH:", await app.evaluate<string>(`document.body.innerText.slice(0, 300)`));
  throw error;
} finally {
  await app.close();
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
