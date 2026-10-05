/**
 * Which runners a pipeline's jobs go to: the mistlabs group's own machines while they are up, GitLab's
 * hosted runners when they are not (`.gitlab-ci.yml`). Run by the `runners` job; writes
 * `runners/pipeline.yml`, the pipeline (`.gitlab/ci/pipeline.yml`) with its runner variables set to the
 * tags chosen, which the `pipeline` job starts as a child pipeline. A job's tags are fixed when it is
 * created, so the choice has to be made before the pipeline that holds the jobs exists.
 *
 * A machine is up when GitLab has heard from it lately and it is not paused. GitLab writes a runner's
 * last contact down only every 40 to 55 minutes, so "lately" is 75 minutes: a machine that went down is
 * passed over within about an hour and a quarter, and until then its jobs wait for it. `RUNNERS = own` or
 * `hosted` on Run pipeline settles it by hand.
 *
 * It asks GitLab's API with RUNNERS_TOKEN (a personal access token with read_api, a group variable: the
 * job token cannot see runners). Without one, or when the API does not answer, the machines are taken
 * to be up.
 *
 * Tag & Restart has the same script (scripts/ci/runners.mjs there); a change here belongs there too.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Each runner variable: the tag of the group's own machine, and of GitLab's hosted runner instead. */
const RUNNERS = {
  RUNNER_LINUX: { own: "linux", hosted: "saas-linux-small-amd64" },
  RUNNER_WINDOWS: { own: "windows", hosted: "saas-windows-medium-amd64" },
};
const LATELY_MS = 75 * 60_000;

const env = process.env;
const choice = env.RUNNERS ?? "auto";

/** Whether one of the group's own runners with this tag is up, or why it cannot be told. */
async function up(tag) {
  if (choice === "own" || choice === "hosted") return { up: choice === "own", why: `RUNNERS = ${choice}` };
  if (!env.RUNNERS_TOKEN) return { up: true, why: "no RUNNERS_TOKEN to ask with: taken to be up" };
  const get = async (path) => {
    const response = await fetch(`${env.CI_API_V4_URL}/${path}`, { headers: { "PRIVATE-TOKEN": env.RUNNERS_TOKEN }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
    return response.json();
  };
  try {
    const listed = await get(`groups/${env.CI_PROJECT_ROOT_NAMESPACE}/runners?type=group_type&paused=false&tag_list=${tag}&per_page=100`);
    const heard = [];
    for (const { id } of listed) {
      const runner = await get(`runners/${id}`);
      const ago = Date.now() - Date.parse(runner.contacted_at ?? 0);
      heard.push(`${runner.description} ${runner.status}, heard from ${Math.round(ago / 60_000)} min ago`);
      if (!runner.paused && runner.status === "online" && ago < LATELY_MS) return { up: true, why: heard.at(-1) };
    }
    return { up: false, why: heard.length > 0 ? heard.join("; ") : "none in the group" };
  } catch (e) {
    return { up: true, why: `the API did not answer (${e.message}): taken to be up` };
  }
}

let pipeline = readFileSync(".gitlab/ci/pipeline.yml", "utf8");
/** Sets one of the pipeline's variables, where it has it. */
const set = (name, value) => {
  const line = new RegExp(`^  ${name}: .*$`, "m");
  if (!line.test(pipeline)) return false;
  pipeline = pipeline.replace(line, `  ${name}: ${JSON.stringify(value)}`);
  return true;
};
for (const [name, tags] of Object.entries(RUNNERS)) {
  if (!new RegExp(`^  ${name}: `, "m").test(pipeline)) continue;
  const own = await up(tags.own);
  const tag = own.up ? tags.own : tags.hosted;
  console.log(`${name} = ${tag}  (${own.up ? "own" : "hosted"}: ${own.why})`);
  set(name, tag);
}
// What started this pipeline, as `.gitlab-ci.yml`'s workflow rules named it: written in rather than
// passed down, which would also pass down this pipeline's defaults over what was asked for.
set("RELEASE_EVENT", env.RELEASE_EVENT ?? "");
console.log(`RELEASE_EVENT = ${JSON.stringify(env.RELEASE_EVENT ?? "")}`);
mkdirSync("runners", { recursive: true });
writeFileSync("runners/pipeline.yml", pipeline);
