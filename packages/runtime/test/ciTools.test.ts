/**
 * The CI tools (decision 0016) over the answers recorded in the app (`*.ci.json`) and the stuck job's
 * shape (`gitlab.ci-stuck.json`): what each answers with, under the names the next call takes, and
 * where a download goes — the task's central folder, recorded in its artifact store, readable by
 * `read_file` at its logical path.
 *
 * The workspace here is only its remote: a git whose `origin` points at the recorded project.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@declarative-ai/exec";
import { parseIntegrations } from "@jaira/shared";
import { MemoryArtifactStore } from "../src/artifacts";
import { centralArtifactSink } from "../src/ciArtifacts";
import { CI_TOOL_NAMES, createCiTools } from "../src/ciTools";
import { createReadFileTool } from "../src/fileTools";
import { forgeAccess } from "../src/forge";
import type { Git } from "../src/git";
import type { GitToolHost } from "../src/gitTools";
import { SecretResolver } from "../src/secrets";
import { replayForge, type Replay } from "./forgeReplay";

let replay: Replay;
let dir: string;
let store: MemoryArtifactStore;
beforeEach(() => {
  replay = replayForge();
  dir = mkdtempSync(join(tmpdir(), "jaira-ci-"));
  store = new MemoryArtifactStore();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const vars = () => ({ worktree: join(dir, "work"), project: join(dir, "project"), jaira: join(dir, "project", ".jaira"), artifactDir: "artifacts", taskId: "t-1" });

/** A host whose workspace's only remote is `url`, on branch `main`. */
function host(url: string, options: { sink?: false } = {}): GitToolHost {
  const git = {
    tryRun: async (args: string[]) => (args[0] === "remote" ? "origin" : args[0] === "config" ? url : undefined),
    currentBranch: async () => "main",
  } as unknown as Git;
  return {
    taskId: "t-1",
    workspaceRoot: join(dir, "work"),
    git: () => git,
    forge: (forgeHost) =>
      forgeAccess(parseIntegrations(undefined), forgeHost, { secrets: new SecretResolver({ env: { GITLAB_TOKEN: "good", GITHUB_TOKEN: "good" } }), http: replay.http }),
    authorizePublish: async () => undefined,
    ...(options.sink === false ? {} : { artifacts: centralArtifactSink({ store, vars: vars() }) }),
  };
}

const call = async (tools: Record<string, Tool>, name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await tools[name]!.run(input as never, undefined as never)) as Record<string, unknown>;

const GITLAB_CLI = "https://gitlab.com/gitlab-org/cli.git";
const GITHUB_CLI = "https://github.com/cli/cli.git";

describe("the CI tools", () => {
  it("are the four, and all of them read", () => {
    const tools = createCiTools(host(GITLAB_CLI));
    expect(Object.keys(tools)).toEqual([...CI_TOOL_NAMES]);
    for (const name of CI_TOOL_NAMES) expect(tools[name]!.readOnly, name).toBe(true);
  });
});

describe("list_pipelines", () => {
  it("lists a merge request's pipelines under the names read_pipeline takes", async () => {
    const answer = await call(createCiTools(host(GITLAB_CLI)), "list_pipelines", { merge_request: 3966 });
    expect(answer["repository"]).toBe("gitlab.com/gitlab-org/cli");
    expect(answer["pipelines"]).toEqual([
      {
        pipeline_id: 2881470369,
        status: "failed",
        source: "merge_request",
        ref: "refs/merge-requests/3966/merge",
        sha: expect.any(String),
        created_at: expect.any(String),
        url: "https://gitlab.com/gitlab-org/cli/-/pipelines/2881470369",
      },
    ]);
    expect(answer["statuses"]).toBeUndefined();
  });

  it("takes the current branch when nothing is named", async () => {
    const answer = await call(createCiTools(host(GITLAB_CLI)), "list_pipelines", { limit: 3 });
    expect(new URL(replay.seen[0]!.url).searchParams.get("ref")).toBe("main");
    expect((answer["pipelines"] as unknown[]).length).toBe(3);
  });

  it("refuses two selectors, and a status that is not one", async () => {
    const tools = createCiTools(host(GITLAB_CLI));
    expect(await call(tools, "list_pipelines", { ref: "main", sha: "abc" })).toEqual({ error: "name one of merge_request, ref or sha — this call names ref and sha" });
    expect((await call(tools, "list_pipelines", { status: "broken" }))["error"]).toMatch(/^`status` is one of pending, running/);
    expect(replay.seen).toHaveLength(0);
  });
});

describe("read_pipeline", () => {
  it("names each failed job and why", async () => {
    const answer = await call(createCiTools(host(GITLAB_CLI)), "read_pipeline", { pipeline_id: 2881410858, job_status: ["failed"] });
    expect(answer["pipeline"]).toMatchObject({ pipeline_id: 2881410858, status: "failed" });
    expect(answer["jobs"]).toEqual([
      {
        job_id: 16728223589,
        name: "snapcraft_release_edge",
        stage: "release",
        status: "failed",
        failure_reason: "script_failure",
        allow_failure: false,
        started_at: "2026-09-25T07:33:00.392Z",
        finished_at: "2026-09-25T07:33:41.363Z",
        url: "https://gitlab.com/gitlab-org/cli/-/jobs/16728223589",
      },
    ]);
  });

  it("lists a GitHub run's uploads by the id download_pipeline_artifact takes", async () => {
    const answer = await call(createCiTools(host(GITHUB_CLI)), "read_pipeline", { pipeline_id: 98748420420 });
    expect((answer["artifacts"] as Array<Record<string, unknown>>).find((a) => a["name"] === "safe-outputs-items")).toEqual({
      artifact_id: 10991111218,
      file_type: "archive",
      name: "safe-outputs-items",
      size: 301,
      expires_at: "2026-12-27T18:50:47Z",
      url: "https://github.com/cli/cli/actions/runs/36468061885/artifacts/10991111218",
    });
  });
});

describe("read_pipeline_job", () => {
  it("names the machine from the runner and the log's head", async () => {
    const answer = await call(createCiTools(host(GITLAB_CLI)), "read_pipeline_job", { job_id: 16728223589 });
    expect(answer["job"]).toMatchObject({ job_id: 16728223589, pipeline_id: 2881410858, failure_reason: "script_failure" });
    expect(answer["runner"]).toEqual({ name: "k8s.saas-linux-medium-amd64.runners-manager.gitlab.com/default", tags: ["saas-linux-medium-amd64"] });
    expect(answer["machine"]).toEqual({ image: "ghcr.io/canonical/snapcraft:8_core24", runner_version: "19.5.0~pre.2159.ga8432a3e", executor: "docker+machine" });
    expect(answer["artifacts"]).toEqual([{ job_id: 16728223589, file_type: "trace", name: "job.log", size: 8469, url: "https://gitlab.com/gitlab-org/cli/-/jobs/16728223589/raw" }]);
  });

  it("says a job no runner picked up never started, and reads no log for it", async () => {
    const answer = await call(createCiTools(host("https://gitlab.com/example/stuck.git")), "read_pipeline_job", { job_id: 800003 });
    expect(answer["job"]).toMatchObject({ failure_reason: "stuck_pending_no_matching_runners" });
    expect(answer["note"]).toMatch(/never started/);
    expect(answer["machine"]).toBeUndefined();
    expect(replay.seen.some((r) => r.url.endsWith("/trace"))).toBe(false);
  });

  it("reads a GitHub job's exit code, steps and annotations", async () => {
    const answer = await call(createCiTools(host(GITHUB_CLI)), "read_pipeline_job", { job_id: 79286928933 });
    expect(answer["job"]).toMatchObject({ job_id: 79286928933, exit_code: 1, pipeline_id: 72128932321 });
    expect(answer["annotations"]).toEqual([{ path: ".github", start_line: 308, end_line: 308, level: "failure", message: "Process completed with exit code 1." }]);
    // Its log is past retention (410): no machine from it, and no error either.
    expect(answer["machine"]).toBeUndefined();
    expect(answer["error"]).toBeUndefined();
  });
});

describe("download_pipeline_artifact", () => {
  it("keeps a GitLab log cleaned, with the task, where read_file finds it", async () => {
    const answer = await call(createCiTools(host(GITLAB_CLI)), "download_pipeline_artifact", { job_id: 16728223589, file_type: "trace" });
    const [saved] = answer["saved"] as Array<{ path: string; file: string; bytes: number; line_link?: string }>;
    expect(saved!.path).toBe("ci-artifacts/16728223589/job.log");
    // Line N of the saved log is #L<N> on the job's page (checked against gitlab.com, 54 of 54 lines).
    expect(saved!.line_link).toBe("https://gitlab.com/gitlab-org/cli/-/jobs/16728223589#L<line>");
    // The central folder, not the worktree.
    expect(saved!.file).toBe(join(dir, "project", ".jaira", "system", "artifacts", "t-1", "ci-artifacts", "16728223589", "job.log"));
    const text = readFileSync(saved!.file, "utf8");
    expect(text.split("\n")[0]).toBe("Running with gitlab-runner 19.5.0~pre.2159.ga8432a3e (a8432a3e)");
    expect(text).not.toMatch(/^\d{4}-\d\d-\d\dT/m);
    expect(text).not.toContain("section_start");
    expect(text.split("\n").at(-1)).toBe("ERROR: Job failed: exit code 1");
    expect(answer["machine"]).toMatchObject({ image: "ghcr.io/canonical/snapcraft:8_core24" });
    // read_file reads it by its logical path, through the store.
    const read = (await createReadFileTool({ store, vars: vars() }).run({ path: saved!.path } as never, undefined as never)) as { content?: string };
    expect(read.content).toBe(text);
  });

  it("splits a GitHub log into its steps", async () => {
    const answer = await call(createCiTools(host(GITHUB_CLI)), "download_pipeline_artifact", { job_id: 109083036468 });
    const saved = answer["saved"] as Array<{ path: string; file: string }>;
    expect(saved[0]!.path).toBe("ci-artifacts/109083036468/job.log");
    const step1 = saved.find((s) => s.path.endsWith("/step-1.log")) as { path: string; file: string; line_link?: string } | undefined;
    expect(step1!.line_link).toBe("https://github.com/cli/cli/actions/runs/36468061885/job/109083036468#step:1:<line>");
    // The whole log's lines have no page of their own.
    expect((saved[0] as { line_link?: string }).line_link).toBeUndefined();
    expect(readFileSync(step1!.file, "utf8")).toContain("Current runner version: '2.337.0'");
    expect(readFileSync(saved[0]!.file, "utf8").charCodeAt(0)).not.toBe(0xfeff);
    expect(answer["machine"]).toEqual({ os: "Linux (x64)", image: "ubuntu:24.04", image_version: "20260922.6.5", runner_version: "2.337.0" });
  });

  it("unpacks a GitHub upload", async () => {
    const answer = await call(createCiTools(host(GITHUB_CLI)), "download_pipeline_artifact", { artifact_id: 10991111218 });
    const saved = answer["saved"] as Array<{ path: string; file: string; bytes: number }>;
    expect(saved.length).toBeGreaterThan(0);
    for (const file of saved) {
      expect(file.path.startsWith("ci-artifacts/artifact-10991111218/")).toBe(true);
      expect(existsSync(file.file)).toBe(true);
    }
  });

  it("says an empty log is a job that never ran", async () => {
    const answer = await call(createCiTools(host("https://gitlab.com/example/stuck.git")), "download_pipeline_artifact", { job_id: 800003 });
    expect(answer).toEqual({ repository: "gitlab.com/example/stuck", saved: [], note: expect.stringMatching(/never ran/) });
  });

  it("wants one of job_id and artifact_id, and a task to keep the download with", async () => {
    expect((await call(createCiTools(host(GITLAB_CLI)), "download_pipeline_artifact", {}))["error"]).toMatch(/either a `job_id`/);
    expect((await call(createCiTools(host(GITLAB_CLI, { sink: false })), "download_pipeline_artifact", { job_id: 1 }))["error"]).toMatch(/not served here/);
    expect(replay.seen).toHaveLength(0);
  });
});
