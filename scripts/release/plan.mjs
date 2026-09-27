/**
 * Decide what a release pipeline builds (decision 0011 §3): the channel, the version, the JaiRA
 * commit and the declarative-ai commit, or that there is nothing to build. Both CI systems run it —
 * GitHub's `.github/workflows/release.yml` and GitLab's `.gitlab-ci.yml` — against the one releases
 * repository, so they agree on versions and on what is already released. It prints its answer and
 * writes it to `$GITHUB_OUTPUT` (GitHub) and/or into `$PLAN_DIR` as `plan.env` (dotenv, `PLAN_*`)
 * and `notes.md` (GitLab, whose dotenv reports cannot hold the multi-line notes).
 *
 * - A pushed `vX.Y.Z` tag is a stable release of the tagged commit.
 * - A manual stable release promotes the latest published nightly's commit, so what ships as stable is
 *   what ran as nightly. Its version is the `version` input, or the nightly's own `X.Y.Z`.
 * - A nightly builds `main`. On the schedule it is skipped unless there are commits since the last
 *   nightly and at least six hours have passed since it was published; run by hand it always builds.
 *
 * The releases live in another repository (`RELEASES_REPO`), so a release's JaiRA commit is read back
 * from its notes (`jaira-commit: <sha>`), which the plan writes. A nightly's last number counts that
 * day's nightlies in the releases repository, not either system's run counter, so builds from the two
 * systems order correctly.
 *
 * Environment: EVENT (push | schedule | workflow_dispatch), REF_NAME (the tag), GITHUB_SHA (the commit
 * the pipeline runs on), INPUT_CHANNEL, INPUT_VERSION, RELEASES_REPO, GH_TOKEN; UPSTREAM_COMMIT when the
 * caller resolved declarative-ai itself (GitLab clones it from GitLab); GITHUB_OUTPUT and/or PLAN_DIR.
 * Node 22, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const RELEASES_REPO = env.RELEASES_REPO ?? "ofersadgat/releases";
const UPSTREAM_REPO = "ofersadgat/declarative-ai";
const NIGHTLY_GAP_MS = 6 * 60 * 60 * 1000;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const NIGHTLY = /^(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;
const COMMIT_LINE = /^jaira-commit: ([0-9a-f]{40})$/m;

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Every published release in the releases repository, newest first. An empty repository has none. */
async function releases() {
  const all = await github(`/repos/${RELEASES_REPO}/releases?per_page=100`);
  return all.filter((r) => !r.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

const versionOf = (release) => release.tag_name.replace(/^v/, "");
const commitOf = (release) => COMMIT_LINE.exec(release.body ?? "")?.[1];

/** `a > b` for two `X.Y.Z`. */
function newer(a, b) {
  const [x, y] = [STABLE.exec(a), STABLE.exec(b)];
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** The next patch after both the app's own version and the newest stable release. */
function nextPatch(appVersion, stables) {
  const base = stables.map(versionOf).filter((v) => STABLE.test(v)).reduce((best, v) => (newer(v, best) ? v : best), appVersion);
  const [, major, minor, patch] = STABLE.exec(base);
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value ?? "");
    return text.includes("\n") ? `${key}<<__PLAN__\n${text}\n__PLAN__` : `${key}=${text}`;
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (env.PLAN_DIR) {
    mkdirSync(env.PLAN_DIR, { recursive: true });
    const { notes, ...rest } = values;
    const dotenv = Object.entries(rest).map(([key, value]) => `PLAN_${key.toUpperCase()}=${String(value ?? "")}`);
    writeFileSync(join(env.PLAN_DIR, "plan.env"), `${dotenv.join("\n")}\n`);
    writeFileSync(join(env.PLAN_DIR, "notes.md"), `${notes ?? ""}\n`);
  }
  console.log(lines.join("\n"));
}

function skip(reason) {
  console.log(`nothing to release: ${reason}`);
  output({ skip: "true", reason });
}

/** One line per JaiRA commit in `(from, to]`, or `to` alone when there is no earlier release. */
function changes(from, to) {
  const range = from !== undefined ? [`${from}..${to}`] : ["-1", to];
  try {
    return execFileSync("git", ["log", "--format=- %h %s", ...range], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => (line.length > 160 ? `${line.slice(0, 157)}…` : line))
      .join("\n");
  } catch {
    return `- ${to.slice(0, 8)}`;
  }
}

async function plan() {
  const appVersion = JSON.parse(readFileSync("packages/app/package.json", "utf8")).version;
  const published = await releases();
  const stables = published.filter((r) => !r.prerelease && STABLE.test(versionOf(r)));
  const nightlies = published.filter((r) => NIGHTLY.test(versionOf(r)));
  const channel = env.EVENT === "push" ? "stable" : env.EVENT === "schedule" ? "nightly" : (env.INPUT_CHANNEL || "nightly");

  let version;
  let commit;
  if (env.EVENT === "push") {
    version = (env.REF_NAME ?? "").replace(/^v/, "");
    if (!STABLE.test(version)) throw new Error(`tag '${env.REF_NAME}' is not vX.Y.Z`);
    commit = env.GITHUB_SHA;
  } else if (channel === "stable") {
    const nightly = nightlies[0];
    if (nightly === undefined) throw new Error("a stable release promotes the latest nightly, and there is none yet");
    commit = commitOf(nightly);
    if (commit === undefined) throw new Error(`nightly ${nightly.tag_name} does not record its JaiRA commit`);
    version = env.INPUT_VERSION || NIGHTLY.exec(versionOf(nightly))[1];
    if (!STABLE.test(version)) throw new Error(`version '${version}' is not X.Y.Z`);
  } else {
    commit = env.GITHUB_SHA;
    const last = nightlies[0];
    if (env.EVENT === "schedule" && last !== undefined) {
      if (commitOf(last) === commit) return skip(`${last.tag_name} already built ${commit.slice(0, 8)}`);
      const age = Date.now() - Date.parse(last.published_at);
      if (age < NIGHTLY_GAP_MS) return skip(`${last.tag_name} is only ${Math.round(age / 60000)} minutes old`);
    }
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const today = nightlies.map((r) => NIGHTLY.exec(versionOf(r))).filter((m) => m[2] === day).map((m) => Number(m[3]));
    version = `${nextPatch(appVersion, stables)}-nightly.${day}.${Math.max(0, ...today) + 1}`;
  }

  const tag = `v${version}`;
  if (published.some((r) => r.tag_name === tag)) throw new Error(`${tag} is already released in ${RELEASES_REPO}`);

  const upstream = env.UPSTREAM_COMMIT || (await github(`/repos/${UPSTREAM_REPO}/commits/main`)).sha;
  const previous = (channel === "stable" ? stables : nightlies)[0];
  const notes = [
    channel === "stable" ? `JaiRA ${version}.` : `JaiRA nightly ${version}. Nightly builds are what the next stable release is promoted from.`,
    "",
    `jaira-commit: ${commit}`,
    `declarative-ai-commit: ${upstream}`,
    "",
    previous !== undefined ? `Changes since ${previous.tag_name}:` : "Changes:",
    changes(previous !== undefined ? commitOf(previous) : undefined, commit),
  ].join("\n");

  output({ skip: "false", channel, version, tag, commit, upstream, prerelease: String(channel !== "stable"), notes });
}

await plan();
