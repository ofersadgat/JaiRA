/**
 * Decide what a release pipeline builds (decision 0011 §3): the channel, the version, the JaiRA
 * commit and the declarative-ai commit, or that there is nothing to build. Both CI systems run it —
 * GitHub's `.github/workflows/release.yml` and GitLab's `.gitlab-ci.yml` — against the one releases
 * repository, so they agree on versions and on what is already released. It prints its answer and
 * writes it to `$GITHUB_OUTPUT` (GitHub) and/or into `$PLAN_DIR` as `plan.env` (dotenv, `PLAN_*`)
 * and `notes.md` (GitLab, whose dotenv reports cannot hold the multi-line notes). It also answers what
 * the iOS app is uploaded as (`ios_version`, `ios_build`).
 *
 * - A pushed `vX.Y.Z` tag is a stable release of the tagged commit, and a pushed
 *   `vX.Y.Z-nightly.YYYYMMDD.N` tag a nightly of it (both from `npm run release-*-version`).
 * - A manual stable release promotes the latest published nightly's commit, so what ships as stable is
 *   what ran as nightly. Its version is the `version` input, or the nightly's own `X.Y.Z`.
 * - A nightly builds `main`. A commit that already has a nightly, published or still a draft, made by
 *   either system, gets that nightly again, to be filled in. Otherwise a new one; on the schedule only
 *   once the last is 20 hours old.
 * - A release is filled in, never refused (decision 0017 §8): the plan is skipped only when the release
 *   already holds every build this pipeline makes (`BUILDS`, recorded as `build-<name>.json`), and each
 *   build job checks its own again before building (`builds.mjs`).
 *
 * The releases live in another repository (`RELEASES_REPO`), so a release's JaiRA commit is read back
 * from its notes (`jaira-commit: <sha>`), which the plan writes. A nightly's last number counts that
 * day's nightlies in the releases repository, not either system's run counter, so builds from the two
 * systems order correctly.
 *
 * Environment: EVENT (push | schedule | workflow_dispatch), REF_NAME (the tag), GITHUB_SHA (the commit
 * the pipeline runs on), INPUT_CHANNEL, INPUT_VERSION, BUILDS (the builds this pipeline makes,
 * space-separated), RELEASES_REPO, GH_TOKEN (which must see drafts); UPSTREAM_COMMIT when the
 * caller resolved declarative-ai itself (GitLab clones it from GitLab); GITHUB_OUTPUT and/or PLAN_DIR.
 * Node 22, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NIGHTLY, RELEASES_REPO, STABLE, appleVersionOf, commitOf, github, nextNightly, nightliesOf, publishedReleases, stablesOf, versionOf } from "./versions.mjs";
import { allReleases, recordName } from "./github.mjs";

const env = process.env;
const UPSTREAM_REPO = "ofersadgat/declarative-ai";
/** Never two nightlies in a day, whatever a schedule does. */
const NIGHTLY_GAP_MS = 20 * 60 * 60 * 1000;
/**
 * A scheduled nightly is built at 2am in this zone, and at no other hour (the person, 2026-09-27: "once
 * a day at 2am (as they say...nothing good ever happens after 2am)"). A cron has no zone and daylight
 * saving moves 2am across UTC, so the schedules fire at both candidate hours and this picks the one.
 */
const NIGHTLY_ZONE = env.NIGHTLY_ZONE || "America/Los_Angeles";
const NIGHTLY_HOUR = Number(env.NIGHTLY_HOUR || 2);

/** The hour it is now in a zone, 0-23. */
export function hourIn(zone, at = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at));
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
  const published = await publishedReleases();
  // Drafts too: a release another pipeline has started is this version's, and its number is taken.
  const all = await allReleases();
  const stables = stablesOf(published);
  const nightlies = nightliesOf(published);
  const pushedTag = (env.REF_NAME ?? "").replace(/^v/, "");
  const channel =
    env.EVENT === "push" ? (NIGHTLY.test(pushedTag) ? "nightly" : "stable") : env.EVENT === "schedule" ? "nightly" : env.INPUT_CHANNEL || "nightly";

  let version;
  let commit;
  if (env.EVENT === "push") {
    // `npm run release-*-version` pushes the tag: a stable one after bumping, a nightly one as it is.
    version = pushedTag;
    if (!STABLE.test(version) && !NIGHTLY.test(version)) throw new Error(`tag '${env.REF_NAME}' is neither vX.Y.Z nor vX.Y.Z-nightly.YYYYMMDD.N`);
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
    if (env.EVENT === "schedule" && hourIn(NIGHTLY_ZONE) !== NIGHTLY_HOUR) {
      return skip(`a nightly is built at ${NIGHTLY_HOUR}:00 in ${NIGHTLY_ZONE}, and it is ${hourIn(NIGHTLY_ZONE)}:00 there`);
    }
    // This commit's nightly, started by either system: filled in, not made again (0017 §8).
    const same = nightliesOf(all).find((r) => commitOf(r) === commit);
    if (same !== undefined) {
      version = versionOf(same);
      console.log(`${same.tag_name} is already this commit's nightly${same.draft ? " (a draft)" : ""}`);
    } else {
      const last = nightlies[0];
      if (env.EVENT === "schedule" && last !== undefined) {
        const age = Date.now() - Date.parse(last.published_at);
        if (age < NIGHTLY_GAP_MS) return skip(`${last.tag_name} is only ${Math.round(age / 60000)} minutes old`);
      }
      version = nextNightly(appVersion, all.map(versionOf));
    }
  }

  const tag = `v${version}`;
  // A release already there is filled in: only the builds it lacks are made (each job checks again, in
  // case the other system finishes one meanwhile). With every build this pipeline makes in it, nothing is.
  const release = all.filter((r) => r.tag_name === tag).sort((a, b) => a.id - b.id)[0];
  const builds = (env.BUILDS ?? "").split(/\s+/).filter(Boolean);
  if (release !== undefined) {
    const missing = builds.filter((build) => !release.assets.some((a) => a.name === recordName(build)));
    if (builds.length > 0 && missing.length === 0) return skip(`${tag} already has ${builds.join(", ")}`);
    console.log(`${tag} is in ${RELEASES_REPO}${release.draft ? " as a draft" : ""}; still to build here: ${missing.join(", ") || "(each job checks)"}`);
  }

  const upstream = env.UPSTREAM_COMMIT || (await github(`/repos/${UPSTREAM_REPO}/commits/main`)).sha;
  const previous = (channel === "stable" ? stables : nightlies).find((r) => r.tag_name !== tag);
  const notes = [
    channel === "stable" ? `JaiRA ${version}.` : `JaiRA nightly ${version}. Nightly builds are what the next stable release is promoted from.`,
    "",
    `jaira-commit: ${commit}`,
    `declarative-ai-commit: ${upstream}`,
    "",
    previous !== undefined ? `Changes since ${previous.tag_name}:` : "Changes:",
    changes(previous !== undefined ? commitOf(previous) : undefined, commit),
  ].join("\n");

  // What the iOS build is uploaded as: Apple takes no nightly suffix in a version (decision 0017).
  const apple = appleVersionOf(version);
  output({ skip: "false", channel, version, tag, commit, upstream, prerelease: String(channel !== "stable"), ios_version: apple.version, ios_build: apple.build, notes });
}

await plan();
