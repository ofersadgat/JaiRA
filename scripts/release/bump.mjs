/**
 * Start a release from a checkout (decision 0011 §3):
 *
 *   npm run release-major-version      # X.Y.Z → (X+1).0.0
 *   npm run release-minor-version      # X.Y.Z → X.(Y+1).0
 *   npm run release-patch-version      # X.Y.Z → X.Y.(Z+1)
 *   npm run release-nightly-version    # a nightly of this commit, X.Y.(Z+1)-nightly.YYYYMMDD.N
 *
 * append `-- --gitlab` to release through GitLab's pipeline instead of GitHub's, and `-- --dry-run`
 * to see what would happen without changing anything.
 *
 * A stable release bumps the version in every workspace `package.json` (they move together) and the
 * lockfile, commits `release: X.Y.Z`, tags `vX.Y.Z`, and pushes both, atomically. A nightly changes no
 * file: its version is worked out the way CI works it out (`versions.mjs`) and only the tag is pushed.
 * The pushed tag is what starts the release — both CI systems run a release pipeline for a pushed
 * `vX.Y.Z` or `vX.Y.Z-nightly.YYYYMMDD.N` tag — so this needs no token, only the push access the
 * checkout already has.
 *
 * `npm version` is npm's own convention for this, and it does not fit: in a workspace it bumps the root
 * package only, while the app's version is `packages/app`'s and the CI plan reads it there.
 *
 * Refuses unless the checkout is on `main`, has no uncommitted changes to tracked files, and is not
 * behind the remote it pushes to.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bump, nextNightly, releasedVersions } from "./versions.mjs";

const [kind, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const onGitLab = flags.includes("--gitlab");
const remote = onGitLab ? "gitlab" : "origin";
if (!["major", "minor", "patch", "nightly"].includes(kind ?? "")) {
  console.error("usage: node scripts/release/bump.mjs <major|minor|patch|nightly> [--gitlab] [--dry-run]");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

// The checkout must be exactly what gets released.
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("check out main first");
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty !== "") fail(`commit or stash these first:\n${dirty}`);
git("fetch", "--quiet", remote, "main");
try {
  execFileSync("git", ["merge-base", "--is-ancestor", `${remote}/main`, "HEAD"]);
} catch {
  fail(`main is behind ${remote}/main — pull first`);
}

/** Every package.json that carries the version: the root and each workspace. */
const manifests = ["package.json", ...readdirSync("packages").map((p) => join("packages", p, "package.json")).filter((f) => existsSync(f))];
const appVersion = JSON.parse(readFileSync("packages/app/package.json", "utf8")).version;
const released = await releasedVersions();
const version = kind === "nightly" ? nextNightly(appVersion, released) : bump(appVersion, kind);
const tag = `v${version}`;

if (released.includes(version)) fail(`${tag} is already released`);
if (git("tag", "--list", tag) !== "") fail(`${tag} already exists here — delete it or pick another version`);

const where = onGitLab ? "GitLab (gitlab.com/mistlabs/jaira → Build → Pipelines)" : "GitHub (github.com/ofersadgat/JaiRA/actions)";
console.log(`${kind === "nightly" ? "nightly" : "stable"} ${version} from ${git("rev-parse", "--short", "HEAD")}, released through ${where}`);
if (dryRun) {
  if (kind !== "nightly") console.log(`would set ${version} in ${manifests.join(", ")} and package-lock.json, and commit`);
  console.log(`would tag ${tag} and push main and ${tag} to ${remote}`);
  process.exit(0);
}

/**
 * A dependency on a sibling workspace pinned to the old version (the unscoped `jaira` package pins
 * `@jaira/cli` exactly) moves with it; a range such as `*` is left alone.
 */
function repin(deps) {
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (name.startsWith("@jaira/") && spec === appVersion) deps[name] = version;
  }
}

if (kind !== "nightly") {
  for (const file of manifests) {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (typeof json.version !== "string") continue;
    json.version = version;
    repin(json.dependencies);
    repin(json.devDependencies);
    repin(json.optionalDependencies);
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  // The lockfile records each workspace's version too; rewritten in place, so nothing else in it moves.
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lock.version = version;
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if ((path === "" || /^packages\/[^/]+$/.test(path)) && typeof entry.version === "string") {
      entry.version = version;
      repin(entry.dependencies);
      repin(entry.devDependencies);
      repin(entry.optionalDependencies);
    }
  }
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  git("add", ...manifests, "package-lock.json");
  git("commit", "--quiet", "-m", `release: ${version}`);
}
git("tag", "-a", tag, "-m", `JaiRA ${version}`);
// One push for the commit and the tag: either both land or neither does, so a tag never names a
// commit the remote lacks.
execFileSync("git", ["push", "--atomic", remote, "HEAD:main", tag], { stdio: "inherit" });
console.log(`pushed ${tag}: the release pipeline on ${where} is starting`);
