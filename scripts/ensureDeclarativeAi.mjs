#!/usr/bin/env node
// Builds the sibling declarative-ai checkout when it has not been built since
// its HEAD last moved (a clone, checkout, pull, commit or reset), so the app's
// bundle never resolves @declarative-ai/* to a missing or stale dist/.
//
// "Last moved" is the time git last wrote HEAD's reflog. "Last built" is a stamp
// this script writes after a build succeeds (tsc -b writes nothing when it finds
// the sources up to date, so its own files cannot say when a build ran). A build
// is also run when a linked package's entry file is missing, whatever the times.
// Uncommitted edits in declarative-ai do not move HEAD and so do not count.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jaira = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = join(jaira, "node_modules", "@declarative-ai");
const stamp = join(jaira, "node_modules", ".cache", "jaira", "declarative-ai.built");

const say = (line) => console.log(`declarative-ai: ${line}`);

if (!existsSync(scope)) {
  say(`no packages linked under ${scope}; run npm install first.`);
  process.exit(1);
}

// Each linked package, followed to where its file: link points.
const packages = readdirSync(scope).map((name) => realpathSync(join(scope, name)));

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

const root = git(packages[0], "rev-parse", "--show-toplevel") ?? resolve(packages[0], "..", "..");

const missing = packages.filter((dir) => {
  const { main } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return main !== undefined && !existsSync(join(dir, main));
});

const mtime = (path) => (path !== undefined && existsSync(path) ? statSync(path).mtimeMs : undefined);
const gitPath = (name) => {
  const path = git(root, "rev-parse", "--git-path", name);
  return path === undefined ? undefined : resolve(root, path);
};
// HEAD's reflog is appended whenever HEAD moves; without one (reflogs off), the
// index, which git rewrites when a checkout changes the working tree.
const checkedOut = mtime(gitPath("logs/HEAD")) ?? mtime(gitPath("index"));
const built = mtime(stamp);

const when = (ms) => new Date(ms).toLocaleString();
let why;
if (missing.length > 0) why = `${missing.map((dir) => dir.slice(root.length + 1)).join(", ")} not built`;
else if (built === undefined) why = "no build recorded";
else if (checkedOut !== undefined && checkedOut > built) why = `checked out ${when(checkedOut)}, last built ${when(built)}`;

if (why === undefined) {
  say(`built since its last checkout (${when(built)}).`);
  process.exit(0);
}

say(`${why}; building ${root}`);
try {
  // tsc -b trusts its .tsbuildinfo over what is on disk: a deleted dist/ with its
  // build info left behind reads as up to date unless the build is forced.
  execSync(missing.length > 0 ? "npm run build -- --force" : "npm run build", { cwd: root, stdio: "inherit" });
} catch {
  say("build failed.");
  process.exit(1);
}
mkdirSync(dirname(stamp), { recursive: true });
writeFileSync(stamp, `${git(root, "rev-parse", "HEAD") ?? "(not a git checkout)"}\n${new Date().toISOString()}\n`);
