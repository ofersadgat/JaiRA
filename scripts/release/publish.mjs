/**
 * Publish one release to the releases repository (decision 0011 §3): what `plan.mjs` decided, with
 * every installer in a directory. Both CI systems run it, so a release looks the same whichever built
 * it.
 *
 *   node scripts/release/publish.mjs <installers dir> <notes file>
 *
 * - A new repository has no commit, and a release needs one to tag, so the first publish creates the
 *   README through the contents API. After that the README is there and this does nothing.
 * - The release is created as a DRAFT, every file is uploaded, and only then is it published. A run
 *   that fails halfway leaves a draft nobody's updater can see, never a release missing its installers.
 * - A nightly is a prerelease and never latest; a stable release is latest.
 *
 * Environment: RELEASES_REPO, GH_TOKEN, PLAN_TAG, PLAN_VERSION, PLAN_PRERELEASE ("true" | "false").
 * Node 22, no dependencies.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const env = process.env;
const repo = env.RELEASES_REPO ?? "ofersadgat/releases";
const [dir, notesFile] = process.argv.slice(2);
if (dir === undefined || notesFile === undefined) throw new Error("usage: publish.mjs <installers dir> <notes file>");
for (const name of ["GH_TOKEN", "PLAN_TAG", "PLAN_VERSION", "PLAN_PRERELEASE"]) {
  if (!env[name]) throw new Error(`${name} is not set`);
}

const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${env.GH_TOKEN}`,
  "x-github-api-version": "2022-11-28",
};

async function api(method, url, body, extra = {}) {
  const response = await fetch(url.startsWith("https://") ? url : `https://api.github.com${url}`, {
    method,
    headers: { ...headers, ...extra },
    body,
  });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function exists(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return true;
}

const files = readdirSync(dir)
  .map((name) => join(dir, name))
  .filter((file) => statSync(file).isFile());
if (files.length === 0) throw new Error(`no installers in ${dir}`);

if (!(await exists(`/repos/${repo}/contents/README.md`))) {
  const readme = "# JaiRA releases\n\nInstallers for JaiRA. Each release names the JaiRA and declarative-ai commits it was built from.\n";
  await api("PUT", `/repos/${repo}/contents/README.md`, JSON.stringify({ message: "Add README", content: Buffer.from(readme).toString("base64") }));
  console.log(`gave ${repo} its first commit`);
}

const prerelease = env.PLAN_PRERELEASE === "true";
const release = await api(
  "POST",
  `/repos/${repo}/releases`,
  JSON.stringify({
    tag_name: env.PLAN_TAG,
    name: `JaiRA ${env.PLAN_VERSION}`,
    body: readFileSync(notesFile, "utf8"),
    draft: true,
    prerelease,
  }),
);
console.log(`draft ${env.PLAN_TAG} created`);

const uploadBase = release.upload_url.replace(/\{.*\}$/, "");
for (const file of files) {
  const name = basename(file);
  await api("POST", `${uploadBase}?name=${encodeURIComponent(name)}`, readFileSync(file), {
    "content-type": "application/octet-stream",
  });
  console.log(`uploaded ${name} (${Math.round(statSync(file).size / 1048576)} MB)`);
}

const published = await api("PATCH", `/repos/${repo}/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: prerelease ? "false" : "true" }));
console.log(`published ${published.html_url}`);
