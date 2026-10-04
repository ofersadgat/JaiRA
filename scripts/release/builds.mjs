/**
 * Whether one build of a release is done, and the record that says it is (decision 0017 §8). Every
 * build job asks first and stops when its build is already in the release, whichever CI system made
 * it; a job that builds writes the record beside its files, and publishing uploads it after them.
 *
 *   node scripts/release/builds.mjs check <build>        prints true if the release has <build>
 *   node scripts/release/builds.mjs mark <build> <dir>   writes <dir>/build.json for publish.mjs
 *
 * `<build>` is a machine's name, the same on both systems: linux-x64, linux-arm64, win-x64, win-arm64,
 * mac-arm64, mac-x64, ios. Environment: PLAN_TAG, PLAN_VERSION, PLAN_COMMIT, RELEASES_REPO, GH_TOKEN.
 * Node 22, no dependencies.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasRecord, record } from "./github.mjs";

const [command, build, dir] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(build ?? "")) throw new Error("usage: builds.mjs check <build> | mark <build> <dir>");
if (!process.env.PLAN_TAG) throw new Error("PLAN_TAG is not set");

if (command === "check") {
  const done = await hasRecord(process.env.PLAN_TAG, build);
  // The answer on stdout, the reason on stderr, so `$(…)` captures only the answer.
  console.error(done ? `${build} is already in ${process.env.PLAN_TAG}: nothing to build` : `${build} is not in ${process.env.PLAN_TAG} yet`);
  console.log(String(done));
} else if (command === "mark" && dir !== undefined) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "build.json"), `${JSON.stringify(record(build), null, 2)}\n`);
  console.log(`${build}: recorded in ${dir}`);
} else {
  throw new Error("usage: builds.mjs check <build> | mark <build> <dir>");
}
