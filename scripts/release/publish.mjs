/**
 * Publish the builds a pipeline made into their release in the releases repository (decision 0011 §3,
 * 0017 §8). Both CI systems run it, and either may have built part of the release already, so it adds
 * to what is there:
 *
 *   node scripts/release/publish.mjs <builds dir> <notes file>
 *
 * - `<builds dir>` holds one folder per build job (any names): its installers, its update manifests and
 *   `build.json` (`builds.mjs mark`), which a job writes only when it succeeded. A folder without one
 *   (a failed build's leftovers) is ignored, and so is a build the release already has.
 * - The release is found or made as a draft (`github.mjs`); each build's files are uploaded, skipping
 *   any already there; the update manifests are merged with the release's own copies across
 *   architectures (`manifests.mjs`) and replaced; then each build's record; and only then is a draft
 *   published. A run that fails halfway leaves its build without a record, so the next run redoes it.
 * - A nightly is a prerelease and never latest; a stable release is latest.
 *
 * Environment: RELEASES_REPO, GH_TOKEN, PLAN_TAG, PLAN_VERSION, PLAN_PRERELEASE ("true" | "false").
 * Node 22, no dependencies.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RELEASES_REPO } from "./versions.mjs";
import { api, download, ensureRelease, recordName, reread, replace, upload } from "./github.mjs";
import { mergeManifests, parseManifest, serializeManifest } from "./manifests.mjs";

const env = process.env;
const [dir, notesFile] = process.argv.slice(2);
if (dir === undefined || notesFile === undefined) throw new Error("usage: publish.mjs <builds dir> <notes file>");
for (const name of ["GH_TOKEN", "PLAN_TAG", "PLAN_VERSION", "PLAN_PRERELEASE"]) {
  if (!env[name]) throw new Error(`${name} is not set`);
}
const isManifest = (name) => /\.yml$/.test(name) && name !== "builder-debug.yml";

/** Each build folder that holds a finished build: its record and its files. */
const builds = (existsSync(dir) ? readdirSync(dir) : [])
  .map((name) => join(dir, name))
  .filter((folder) => statSync(folder).isDirectory() && existsSync(join(folder, "build.json")))
  .map((folder) => ({
    record: JSON.parse(readFileSync(join(folder, "build.json"), "utf8")),
    files: readdirSync(folder)
      .filter((name) => name !== "build.json")
      .map((name) => join(folder, name))
      .filter((file) => statSync(file).isFile()),
  }));
if (builds.length === 0) {
  console.log("no finished build to publish");
  process.exit(0);
}

const prerelease = env.PLAN_PRERELEASE === "true";
let release = await ensureRelease({ tag: env.PLAN_TAG, version: env.PLAN_VERSION, notes: readFileSync(notesFile, "utf8"), prerelease });
const fresh = builds.filter((b) => {
  const done = release.assets.some((a) => a.name === recordName(b.record.build));
  if (done) console.log(`${b.record.build}: already in ${env.PLAN_TAG}, skipped`);
  return !done;
});

for (const build of fresh) {
  for (const file of build.files.filter((f) => !isManifest(basename(f)))) await upload(release, basename(file), readFileSync(file));
}

// The update manifests: this run's copies of each name, merged with the one the release has.
release = await reread(release);
const manifests = new Map();
for (const build of fresh) {
  for (const file of build.files.filter((f) => isManifest(basename(f)))) {
    const name = basename(file);
    manifests.set(name, [...(manifests.get(name) ?? []), parseManifest(readFileSync(file, "utf8"), `${build.record.build}/${name}`)]);
  }
}
for (const [name, copies] of manifests) {
  const existing = release.assets.find((a) => a.name === name);
  if (existing !== undefined) copies.push(parseManifest(await download(existing), `${env.PLAN_TAG}/${name}`));
  const manifest = mergeManifests(copies, name);
  if (manifest.version !== env.PLAN_VERSION) throw new Error(`${name} is for ${manifest.version}, not ${env.PLAN_VERSION}`);
  await replace(release, name, Buffer.from(serializeManifest(manifest)));
  console.log(`${name}: ${manifest.files.map((f) => f.url).join(", ")}`);
  release = await reread(release);
}

for (const build of fresh) await upload(release, recordName(build.record.build), Buffer.from(`${JSON.stringify(build.record, null, 2)}\n`));

if (release.draft) {
  const published = await api("PATCH", `/repos/${RELEASES_REPO}/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: prerelease ? "false" : "true" }));
  console.log(`published ${published.html_url}`);
} else {
  console.log(`added ${fresh.map((b) => b.record.build).join(", ") || "nothing"} to ${release.html_url}`);
}
