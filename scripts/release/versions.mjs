/**
 * What a release is called, shared by the CI plan (`plan.mjs`) and the release commands (`bump.mjs`),
 * so a version worked out on a laptop and one worked out in CI are the same (decision 0011 §3).
 *
 * - Stable is `X.Y.Z`.
 * - Nightly is `X.Y.Z-nightly.YYYYMMDD.N`: `X.Y.Z` is the next patch after both the app's own version
 *   and the newest stable release, and `N` counts that day's nightlies already in the releases
 *   repository (UTC day), so builds from GitHub, GitLab and a laptop order correctly.
 *
 * The releases live in their own repository; a release's JaiRA commit is read back from its notes
 * (`jaira-commit: <sha>`), which the plan writes. Node 22, no dependencies.
 */
export const RELEASES_REPO = process.env.RELEASES_REPO ?? "ofersadgat/releases";
export const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
export const NIGHTLY = /^(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;
const COMMIT_LINE = /^jaira-commit: ([0-9a-f]{40})$/m;

/** GET from the GitHub API; `token` is optional (the releases repository is public). */
export async function github(path, token = process.env.GH_TOKEN) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Every published release in the releases repository, newest first. An empty repository has none. */
export async function publishedReleases(token) {
  const all = await github(`/repos/${RELEASES_REPO}/releases?per_page=100`, token);
  return all.filter((r) => !r.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

export const versionOf = (release) => release.tag_name.replace(/^v/, "");
export const commitOf = (release) => COMMIT_LINE.exec(release.body ?? "")?.[1];
export const stablesOf = (published) => published.filter((r) => !r.prerelease && STABLE.test(versionOf(r)));
export const nightliesOf = (published) => published.filter((r) => NIGHTLY.test(versionOf(r)));

/** `a > b` for two `X.Y.Z`. */
export function newer(a, b) {
  const [x, y] = [STABLE.exec(a), STABLE.exec(b)];
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** `X.Y.Z` bumped by one `part`: major and minor reset what follows them. */
export function bump(version, part) {
  const match = STABLE.exec(version);
  if (match === null) throw new Error(`'${version}' is not X.Y.Z`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown part '${part}'`);
}

/**
 * The next nightly's version, from the app's version and every version already released (plain
 * strings, so a laptop can read them with `git ls-remote --tags` instead of the rate-limited API).
 */
export function nextNightly(appVersion, released, now = new Date()) {
  const base = released.filter((v) => STABLE.test(v)).reduce((best, v) => (newer(v, best) ? v : best), appVersion);
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const today = released
    .map((v) => NIGHTLY.exec(v))
    .filter((m) => m !== null && m[2] === day)
    .map((m) => Number(m[3]));
  return `${bump(base, "patch")}-nightly.${day}.${Math.max(0, ...today) + 1}`;
}

/**
 * A release's version as Apple wants it (decision 0017): `CFBundleShortVersionString` is `X.Y.Z` and
 * nothing else, and `CFBundleVersion` must be new for that `X.Y.Z` and higher than the builds before
 * it. A nightly is its own `X.Y.Z` with build `YYYYMMDD.N`, read off its version, so GitHub and GitLab
 * number it alike. A stable release is built the day it is promoted, from a nightly of the same
 * `X.Y.Z`: build `YYYYMMDD.1000` of that day stays above every nightly before it.
 */
export function appleVersionOf(version, now = new Date()) {
  const nightly = NIGHTLY.exec(version);
  if (nightly !== null) return { version: nightly[1], build: `${nightly[2]}.${Number(nightly[3])}` };
  if (!STABLE.test(version)) throw new Error(`'${version}' is neither X.Y.Z nor X.Y.Z-nightly.YYYYMMDD.N`);
  return { version, build: `${now.toISOString().slice(0, 10).replace(/-/g, "")}.1000` };
}

/** Every version tagged in the releases repository, read over git: no API, no rate limit. */
export async function releasedVersions() {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("git", ["ls-remote", "--tags", `https://github.com/${RELEASES_REPO}.git`], { encoding: "utf8" });
  return [...out.matchAll(/refs\/tags\/v([^\s^]+)$/gm)].map((m) => m[1]);
}
