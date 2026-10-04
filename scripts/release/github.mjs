/**
 * The release on GitHub that both CI systems build into (decision 0011 §3, 0017 §8). A release is
 * filled in, not made in one go: GitHub's pipeline and GitLab's may each build some of it, in either
 * order, and run again, so every write here is safe to repeat.
 *
 * - One release per tag. It is found among drafts too (which needs the token), and a new one starts as
 *   a draft. Two pipelines that create it at once both see the two drafts afterwards and keep the older
 *   one; the other deletes its own.
 * - Each build that made it into the release has a record there, `build-<name>.json`, uploaded after its
 *   files: a build job that finds its record has nothing to do (`builds.mjs`).
 * - A file already in the release is not uploaded again.
 *
 * Environment: RELEASES_REPO, GH_TOKEN. Node 22, no dependencies.
 */
import { RELEASES_REPO } from "./versions.mjs";

const token = () => {
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is not set (a token with Contents read/write on the releases repository)");
  return process.env.GH_TOKEN;
};

/**
 * `fetch`, asked again on a dropped connection or a 5xx: a release job talks to two APIs for half an hour,
 * and one `EPIPE` (seen on GitLab's Mac, 2026-10-04, after a successful upload) must not fail it.
 */
export async function retrying(url, init) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === 4) return response;
      console.log(`${init?.method ?? "GET"} ${url}: ${response.status}, asking again`);
    } catch (error) {
      if (attempt === 4) throw error;
      console.log(`${init?.method ?? "GET"} ${url}: ${error.cause?.code ?? error.message}, asking again`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

export async function api(method, url, body, extra = {}) {
  const response = await retrying(url.startsWith("https://") ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token()}`,
      "x-github-api-version": "2022-11-28",
      ...extra,
    },
    body,
  });
  if (!response.ok) {
    const error = new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

/** Every release in the releases repository, drafts included, newest first. */
export async function allReleases() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await api("GET", `/repos/${RELEASES_REPO}/releases?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** The one release for `tag`, or undefined: the oldest, should two pipelines have made one at once. */
export async function findRelease(tag) {
  const same = (await allReleases()).filter((r) => r.tag_name === tag).sort((a, b) => a.id - b.id);
  return same[0];
}

/** The record a build leaves in the release when its files are there. */
export const recordName = (build) => `build-${build}.json`;

export async function hasRecord(tag, build) {
  const release = await findRelease(tag);
  return release !== undefined && release.assets.some((a) => a.name === recordName(build));
}

/** A new repository has no commit, and a release needs one to tag: the first publish makes a README. */
async function ensureCommit() {
  try {
    await api("GET", `/repos/${RELEASES_REPO}/contents/README.md`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const readme = "# JaiRA releases\n\nInstallers for JaiRA. Each release names the JaiRA and declarative-ai commits it was built from.\n";
    await api("PUT", `/repos/${RELEASES_REPO}/contents/README.md`, JSON.stringify({ message: "Add README", content: Buffer.from(readme).toString("base64") }));
    console.log(`gave ${RELEASES_REPO} its first commit`);
  }
}

/** The release for `tag`, made as a draft if there is none. */
export async function ensureRelease({ tag, version, notes, prerelease }) {
  const found = await findRelease(tag);
  if (found !== undefined) return found;
  await ensureCommit();
  const mine = await api(
    "POST",
    `/repos/${RELEASES_REPO}/releases`,
    JSON.stringify({ tag_name: tag, name: `JaiRA ${version}`, body: notes, draft: true, prerelease }),
  );
  // The list catches up with a new release a moment later (seen on GitHub, 2026-10-04: not listed yet).
  let kept;
  for (let tries = 0; tries < 10 && kept === undefined; tries += 1) {
    if (tries > 0) await new Promise((r) => setTimeout(r, 1000));
    kept = await findRelease(tag);
  }
  if (kept !== undefined && kept.id !== mine.id) {
    // The other pipeline made one first: build into that one.
    await api("DELETE", `/repos/${RELEASES_REPO}/releases/${mine.id}`);
    console.log(`another pipeline made ${tag} at the same time; using its release`);
    return kept;
  }
  console.log(`draft ${tag} created`);
  return mine;
}

/** The release as it is now, with its assets. */
export const reread = (release) => api("GET", `/repos/${RELEASES_REPO}/releases/${release.id}`);

/** Upload one file unless the release already has one by that name. True if it was uploaded. */
export async function upload(release, name, data) {
  if (release.assets.some((a) => a.name === name)) {
    console.log(`${name}: already in the release`);
    return false;
  }
  const base = release.upload_url.replace(/\{.*\}$/, "");
  try {
    await api("POST", `${base}?name=${encodeURIComponent(name)}`, data, { "content-type": "application/octet-stream" });
  } catch (error) {
    // Uploaded by the other pipeline since the release was read.
    if (error.status === 422 && /already_exists/.test(error.message)) {
      console.log(`${name}: already in the release`);
      return false;
    }
    throw error;
  }
  console.log(`uploaded ${name} (${Math.round(data.length / 1048576)} MB)`);
  return true;
}

/** Replace a file the release has (an update manifest, merged with more architectures). */
export async function replace(release, name, data) {
  const old = release.assets.find((a) => a.name === name);
  if (old !== undefined) await api("DELETE", `/repos/${RELEASES_REPO}/releases/assets/${old.id}`);
  await upload({ ...release, assets: release.assets.filter((a) => a.name !== name) }, name, data);
}

/** A file in the release, as text. */
export async function download(asset) {
  const response = await retrying(`https://api.github.com/repos/${RELEASES_REPO}/releases/assets/${asset.id}`, {
    headers: { accept: "application/octet-stream", authorization: `Bearer ${token()}`, "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`download ${asset.name}: ${response.status} ${await response.text()}`);
  return response.text();
}

/** What a build's record says: which build, of what, where it ran. */
export function record(build, extra = {}) {
  const env = process.env;
  const ci = env.GITHUB_ACTIONS === "true" ? "github" : env.GITLAB_CI === "true" ? "gitlab" : "local";
  const url =
    ci === "github" ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : ci === "gitlab" ? env.CI_JOB_URL : undefined;
  return { build, version: env.PLAN_VERSION, commit: env.PLAN_COMMIT, ci, url, at: new Date().toISOString(), ...extra };
}
