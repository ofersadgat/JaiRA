/**
 * What the Git and CI tools answer with about CI (decision 0016 §2): the providers' shapes, in the
 * words the tools' inputs use. Every id comes back under the name the next call takes it by —
 * `pipeline_id`, `job_id`, `artifact_id`, `file_type` — so a call is made by copying a field, never by
 * translating one.
 */
import type { ForgeArtifact, ForgeCommitStatus, ForgeJob, ForgePipeline, ForgeProvider, MergeRequestSummary, PipelineTests } from "@jaira/shared";

const set = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value !== undefined ? ({ [key]: value } as { [P in K]: V }) : {});

export function pipelineView(pipeline: ForgePipeline): Record<string, unknown> {
  return {
    pipeline_id: pipeline.id,
    ...set("name", pipeline.name),
    status: pipeline.status,
    source: pipeline.source,
    ref: pipeline.ref,
    sha: pipeline.sha,
    ...set("run_id", pipeline.runId),
    ...set("attempt", pipeline.attempt),
    created_at: pipeline.createdAt,
    ...set("finished_at", pipeline.finishedAt),
    url: pipeline.url,
  };
}

export function statusView(status: ForgeCommitStatus): Record<string, unknown> {
  return {
    sha: status.sha,
    context: status.context,
    status: status.status,
    ...set("description", status.description),
    ...set("url", status.url),
    created_at: status.createdAt,
  };
}

export function jobView(job: ForgeJob): Record<string, unknown> {
  return {
    job_id: job.id,
    name: job.name,
    ...set("stage", job.stage),
    status: job.status,
    ...set("failure_reason", job.failureReason),
    ...set("allow_failure", job.allowFailure),
    ...set("started_at", job.startedAt),
    ...set("finished_at", job.finishedAt),
    url: job.url,
    ...set("downstream_pipeline_id", job.downstreamPipelineId),
    ...set("retried", job.retried),
  };
}

export function artifactView(artifact: ForgeArtifact): Record<string, unknown> {
  return {
    ...set("job_id", artifact.jobId),
    ...set("artifact_id", artifact.artifactId),
    file_type: artifact.fileType,
    name: artifact.name,
    ...set("size", artifact.size),
    ...set("expires_at", artifact.expiresAt),
    ...set("url", artifact.url),
  };
}

export function testsView(tests: PipelineTests): Record<string, unknown> {
  return {
    total: tests.total,
    failed: tests.failed,
    skipped: tests.skipped,
    errored: tests.errored,
    suites: tests.suites.map((suite) => ({ name: suite.name, total: suite.total, failed: suite.failed, skipped: suite.skipped, errored: suite.errored, job_ids: suite.jobIds })),
  };
}

/**
 * A merge request's LATEST pipelines, each with its failed jobs when it failed: on GitLab the newest
 * of the request's own list (a merged-result pipeline included); on GitHub every suite on its head
 * commit. One call for the list, one more per failed pipeline.
 */
export async function requestPipelines(provider: ForgeProvider, project: string, request: MergeRequestSummary): Promise<Array<Record<string, unknown>>> {
  const { pipelines } = await provider.pipelines(project, { mergeRequest: request.number, limit: 100 });
  const latest = provider.kind === "gitlab" ? pipelines.slice(0, 1) : pipelines.filter((pipeline) => pipeline.sha === request.head);
  return Promise.all(
    latest.map(async (pipeline) => {
      const failed =
        pipeline.status === "failed"
          ? (await provider.pipeline(project, pipeline.id, { jobStatus: ["failed"] })).jobs.map((job) => ({
              job_id: job.id,
              name: job.name,
              ...set("stage", job.stage),
              ...set("failure_reason", job.failureReason),
            }))
          : undefined;
      return {
        pipeline_id: pipeline.id,
        ...set("name", pipeline.name),
        status: pipeline.status,
        sha: pipeline.sha,
        url: pipeline.url,
        ...set("failed_jobs", failed),
      };
    }),
  );
}

/** Run `work` over `items`, at most `width` at a time, in order. */
export async function inBatches<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}
