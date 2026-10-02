/**
 * The CI reads decision 0016 adds to both providers — pipelines, one pipeline, one job, one artifact —
 * against answers RECORDED in the app through its own signed-in connections (`*.ci.json`,
 * `JAIRA_FORGE_RECORD`), and one shape built from a private project's (`gitlab.ci-stuck.json`).
 *
 * Nothing here reaches a network: `replayForge` throws on any request no fixture answers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ForgeError, forgeProvider } from "../src/forge";
import { replayForge, type Replay } from "./forgeReplay";

let replay: Replay;
beforeEach(() => {
  replay = replayForge();
});

const GITLAB = { provider: "gitlab", host: "gitlab.com" } as const;
const GITHUB = { provider: "github", host: "github.com" } as const;
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
const sent = (index: number): URL => new URL(replay.seen[index]!.url);

describe("GitLab", () => {
  const gitlab = () => forgeProvider(GITLAB, "good", { http: replay.http });

  describe("pipelines", () => {
    it("reads a merge request's own list, which holds its merged-result pipeline", async () => {
      const { pipelines, statuses } = await gitlab().pipelines("gitlab-org/cli", { mergeRequest: 3966 });
      expect(sent(0).pathname).toBe("/api/v4/projects/gitlab-org%2Fcli/merge_requests/3966/pipelines");
      expect(statuses).toEqual([]);
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0]).toMatchObject({ id: 2881470369, ref: "refs/merge-requests/3966/merge", source: "merge_request", sourceName: "merge_request_event", status: "failed" });
      expect(pipelines[0]!.url).toBe("https://gitlab.com/gitlab-org/cli/-/pipelines/2881470369");
    });

    it("asks a ref's newest first, at most the limit", async () => {
      const { pipelines } = await gitlab().pipelines("gitlab-org/cli", { ref: "main", limit: 3 });
      expect(Object.fromEntries(sent(0).searchParams)).toMatchObject({ ref: "main", order_by: "id", sort: "desc", per_page: "3" });
      expect(pipelines.map((p) => [p.id, p.status])).toEqual([
        [2890805146, "running"],
        [2890421317, "success"],
        [2889683670, "success"],
      ]);
    });

    it("hands GitLab a status that is one of its own words", async () => {
      const { pipelines } = await gitlab().pipelines("gitlab-org/cli", { ref: "main", status: "failed", limit: 2 });
      expect(sent(0).searchParams.get("status")).toBe("failed");
      expect(pipelines.map((p) => p.id)).toEqual([2881410858, 2867772771]);
    });
  });

  describe("pipeline", () => {
    it("asks for the jobs of the statuses wanted, and reads why each failed", async () => {
      const pipeline = await gitlab().pipeline("gitlab-org/cli", 2881410858, { jobStatus: ["failed"] });
      expect(replay.seen.some((r) => new URL(r.url).searchParams.get("scope[]") === "failed")).toBe(true);
      expect(pipeline).toMatchObject({ id: 2881410858, status: "failed", source: "push", ref: "main", artifacts: [] });
      expect(pipeline.jobs).toEqual([
        {
          id: 16728223589,
          name: "snapcraft_release_edge",
          stage: "release",
          status: "failed",
          failureReason: "script_failure",
          allowFailure: false,
          startedAt: "2026-09-25T07:33:00.392Z",
          finishedAt: "2026-09-25T07:33:41.363Z",
          url: "https://gitlab.com/gitlab-org/cli/-/jobs/16728223589",
        },
      ]);
    });

    it("reads every job of a merge request pipeline", async () => {
      const pipeline = await gitlab().pipeline("gitlab-org/cli", 2881470369);
      expect(pipeline.ref).toBe("refs/merge-requests/3966/merge");
      expect(pipeline.jobs).toHaveLength(11);
      expect(pipeline.jobs.every((job) => job.retried === undefined)).toBe(true);
    });
  });

  describe("job", () => {
    it("names the machine as far as gitlab.com says, and offers the log as an artifact", async () => {
      const job = await gitlab().job("gitlab-org/cli", 16728223589);
      expect(job).toMatchObject({ id: 16728223589, status: "failed", failureReason: "script_failure", pipelineId: 2881410858, steps: [], annotations: [] });
      // An instance runner on gitlab.com: `runner_manager` is null even to a signed-in token (measured).
      expect(job.runner).toEqual({ name: "k8s.saas-linux-medium-amd64.runners-manager.gitlab.com/default", tags: ["saas-linux-medium-amd64"] });
      expect(job.artifacts).toEqual([{ jobId: 16728223589, fileType: "trace", name: "job.log", size: 8469, url: "https://gitlab.com/gitlab-org/cli/-/jobs/16728223589/raw" }]);
    });
  });

  describe("artifact", () => {
    it("downloads the log as bytes, prefix and all", async () => {
      const { bytes, contentType } = await gitlab().artifact("gitlab-org/cli", { jobId: 16728223589, fileType: "trace" });
      expect(replay.seen[0]!.expect).toBe("bytes");
      expect(bytes).toHaveLength(8469);
      expect(contentType).toMatch(/^text\/plain/);
      expect(text(bytes).startsWith("2026-09-25T07:33:00.992977Z 00O ")).toBe(true);
      expect(text(bytes)).toContain("ERROR: Job failed: exit code 1");
    });

    it("refuses an artifact that names no job", async () => {
      await expect(gitlab().artifact("gitlab-org/cli", { artifactId: 1 })).rejects.toThrow(/belongs to a job/);
      expect(replay.seen).toHaveLength(0);
    });
  });

  describe("a job no runner picked up", () => {
    it("says so in its failure reason, and has no log to read", async () => {
      const job = await gitlab().job("example/stuck", 800003);
      expect(job).toMatchObject({ status: "failed", failureReason: "stuck_pending_no_matching_runners", artifacts: [] });
      expect(job.runner).toEqual({ tags: ["linux"] });
      const { bytes } = await gitlab().artifact("example/stuck", { jobId: 800003, fileType: "trace" });
      expect(bytes).toHaveLength(0);
    });

    it("marks every attempt but the last as retried", async () => {
      const pipeline = await gitlab().pipeline("example/stuck", 900001, { includeRetried: true });
      expect(pipeline.jobs.map((job) => [job.id, job.retried === true])).toEqual([
        [800001, true],
        [800002, true],
        [800003, false],
        [800004, false],
      ]);
      // A report with no tests in it is no report.
      expect(pipeline.tests).toBeUndefined();
    });
  });
});

describe("GitHub", () => {
  const github = () => forgeProvider(GITHUB, "good", { http: replay.http });

  describe("pipelines", () => {
    it("reads a pull request's commits' suites in one query — workflow runs and other apps' alike", async () => {
      const { pipelines } = await github().pipelines("cli/cli", { mergeRequest: 14543 });
      expect(replay.seen).toHaveLength(1);
      expect(replay.seen[0]!.method).toBe("POST");
      expect(pipelines.find((p) => p.name === "Unit and Integration Tests")).toMatchObject({ source: "merge_request", sourceName: "pull_request", status: "success" });
      // Another app's suite: no workflow run owns it.
      const security = pipelines.find((p) => p.name === "GitHub Advanced Security");
      expect(security).toMatchObject({ source: "external", sourceName: "github-advanced-security" });
      expect(security!.url).toContain(`/commit/${security!.sha}/checks?check_suite_id=${security!.id}`);
    });

    it("names each Actions suite's workflow run on a commit, and filters by status", async () => {
      const { pipelines, statuses } = await github().pipelines("cli/cli", { sha: "46480afb125d852c3edd2b4850a97c09b65c64cf", status: "failed" });
      expect(statuses).toEqual([]);
      expect(pipelines).toEqual([
        {
          id: 72128932321,
          sha: "46480afb125d852c3edd2b4850a97c09b65c64cf",
          ref: "trunk",
          source: "push",
          sourceName: "push",
          status: "failed",
          name: "Unit and Integration Tests",
          runId: 26882796913,
          attempt: 1,
          createdAt: expect.any(String),
          finishedAt: expect.any(String),
          url: "https://github.com/cli/cli/actions/runs/26882796913",
        },
      ]);
    });
  });

  describe("pipeline", () => {
    it("is a check suite: its check runs are the jobs, its run's uploads the artifacts", async () => {
      const pipeline = await github().pipeline("cli/cli", 72128932321);
      expect(pipeline).toMatchObject({ id: 72128932321, status: "failed", runId: 26882796913, artifacts: [] });
      expect(pipeline.jobs).toHaveLength(6);
      expect(pipeline.jobs.filter((job) => job.status === "failed").map((job) => [job.id, job.name])).toEqual([[79286928933, "build (macos-latest)"]]);
      expect(sent(2).searchParams.get("filter")).toBe("latest");
    });

    it("links each upload to its page, and asks for every attempt when retried jobs are wanted", async () => {
      const pipeline = await github().pipeline("cli/cli", 98748420420, { includeRetried: true });
      expect(replay.seen.some((r) => new URL(r.url).searchParams.get("filter") === "all")).toBe(true);
      expect(pipeline.artifacts.find((a) => a.artifactId === 10991111218)).toEqual({
        artifactId: 10991111218,
        fileType: "archive",
        name: "safe-outputs-items",
        size: 301,
        expiresAt: "2026-12-27T18:50:47Z",
        url: "https://github.com/cli/cli/actions/runs/36468061885/artifacts/10991111218",
      });
    });
  });

  describe("job", () => {
    it("reads the exit code from Actions' failure annotation", async () => {
      const job = await github().job("cli/cli", 79286928933);
      expect(job).toMatchObject({ id: 79286928933, status: "failed", exitCode: 1, pipelineId: 72128932321, sha: "46480afb125d852c3edd2b4850a97c09b65c64cf" });
      expect(job.runner).toEqual({ name: "GitHub Actions 1013646729", tags: ["macos-latest"] });
      expect(job.annotations).toEqual([{ path: ".github", startLine: 308, endLine: 308, level: "failure", message: "Process completed with exit code 1." }]);
      expect(job.artifacts).toEqual([{ jobId: 79286928933, fileType: "trace", name: "job.log", url: "https://github.com/cli/cli/actions/runs/26882796913/job/79286928933" }]);
    });

    it("keeps GitHub's step numbers, which skip", async () => {
      const job = await github().job("cli/cli", 109083036468);
      const numbers = job.steps.map((step) => step.number);
      expect(numbers).toContain(19);
      expect(numbers).toContain(37);
      expect(numbers).not.toContain(20);
      expect(job.steps[0]).toMatchObject({ number: 1, name: "Set up job", status: "success" });
    });
  });

  describe("artifact", () => {
    it("downloads a job's log, which names the machine in its first lines", async () => {
      const { bytes } = await github().artifact("cli/cli", { jobId: 109083036468, fileType: "trace" });
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(text(bytes)).toContain("- OS: Linux (x64)");
      expect(text(bytes)).toContain("- Name: ubuntu:24.04");
    });

    it("downloads a run's upload as a zip", async () => {
      const { bytes, contentType } = await github().artifact("cli/cli", { artifactId: 10991111218 });
      expect(bytes).toHaveLength(301);
      expect(text(bytes.slice(0, 2))).toBe("PK");
      expect(contentType).toBe("application/zip");
    });

    it("says a log past retention may have expired (GitHub answers 410)", async () => {
      const failure = await github().artifact("cli/cli", { jobId: 79286928933, fileType: "trace" }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ForgeError);
      expect((failure as ForgeError).status).toBe(404);
      expect((failure as ForgeError).message).toMatch(/may have expired/);
    });

    it("refuses any other file of a job — GitHub keeps only its log", async () => {
      await expect(github().artifact("cli/cli", { jobId: 1, fileType: "junit" })).rejects.toThrow(/only its log|one artifact per job/);
      expect(replay.seen).toHaveLength(0);
    });
  });
});
