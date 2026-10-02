/**
 * The CI tools (decision 0016): `list_pipelines`, `read_pipeline`, `read_pipeline_job`,
 * `download_pipeline_artifact` — the pipelines that ran on the repository's commits, their jobs, and
 * what the jobs left, through the connection the workspace's remote picks (as the Git tools reach it,
 * {@link reachForge}).
 *
 * Every input is a value an API call takes or an id an earlier answer gave under the same name
 * (`./ciViews`). Nothing here changes anything on the forge; a download is kept as the task's artifact
 * in its central folder (`./ciArtifacts`), never in the worktree.
 */
import { gunzipSync } from "node:zlib";
import type { Tool } from "@declarative-ai/exec";
import { PIPELINE_SOURCES, PIPELINE_STATUSES, type ArtifactRef, type ForgeProvider, type PipelineQuery, type PipelineSource, type PipelineStatus } from "@jaira/shared";
import { CI_ARTIFACTS_ROOT, type SavedArtifact } from "./ciArtifacts";
import { cleanGithubLog, cleanGitlabLog, machineFromLog, type CiMachine } from "./ciLog";
import { artifactView, jobView, pipelineView, statusView, testsView } from "./ciViews";
import { forgeTool, GitToolRefusal, reachForge, REMOTE_PROPERTY, type GitToolHost, type Reached } from "./gitTools";
import { isZip, readZip, ZipError } from "./zip";

export const CI_TOOL_NAMES = ["list_pipelines", "read_pipeline", "read_pipeline_job", "download_pipeline_artifact"] as const;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
const id = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const set = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value !== undefined ? ({ [key]: value } as { [P in K]: V }) : {});

const STATUS_SCHEMA = { type: "string", enum: [...PIPELINE_STATUSES] } as const;

/** At most this many saved files are listed in an answer; the rest are there all the same. */
const LISTED_FILES = 200;

/** The CI tools over one host, by name. */
export function createCiTools(host: GitToolHost): Record<string, Tool> {
  const reach = (args: Record<string, unknown>, ctx: Parameters<typeof reachForge>[2]): Promise<Reached> => reachForge(host, args, ctx);
  const repository = (at: Reached): string => `${at.location.host}/${at.location.project}`;
  /** A job's log, read once per host: `read_pipeline_job` reads it for the machine, a download then keeps it. */
  const logs = new Map<string, Uint8Array>();
  const logOf = async (at: Reached, jobId: number): Promise<Uint8Array> => {
    const key = `${repository(at)}#${jobId}`;
    let bytes = logs.get(key);
    if (bytes === undefined) {
      bytes = (await at.access.provider.artifact(at.location.project, { jobId, fileType: "trace" })).bytes;
      logs.set(key, bytes);
    }
    return bytes;
  };
  const cleaned = (provider: ForgeProvider, raw: string): string => (provider.kind === "gitlab" ? cleanGitlabLog(raw) : cleanGithubLog(raw).text);

  return {
    list_pipelines: forgeTool(
      host,
      "list_pipelines",
      {
        description:
          "List the CI pipelines of a merge request, a branch or tag (`ref`), or a commit (`sha`) — exactly one; the workspace's current branch when none is given. Newest first: `pipeline_id`, status, source (push, merge_request, schedule, …), ref, commit, link. On GitHub a pipeline is a check suite — one per workflow run, one per other app — and commit statuses from outside CI come back beside them as `statuses`.",
        inputSchema: {
          type: "object",
          properties: {
            merge_request: { type: "integer", minimum: 1, description: "A merge request's number (GitLab's !iid, GitHub's #number): every pipeline that ran for it." },
            ref: { type: "string", description: "A branch or tag name." },
            sha: { type: "string", description: "A commit." },
            status: { ...STATUS_SCHEMA, description: "Only pipelines in this state." },
            source: { type: "string", enum: [...PIPELINE_SOURCES], description: "Only pipelines started this way." },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (20 when absent)." },
            ...REMOTE_PROPERTY,
          },
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const given = ["merge_request", "ref", "sha"].filter((key) => args[key] !== undefined);
        if (given.length > 1) throw new GitToolRefusal(`name one of merge_request, ref or sha — this call names ${given.join(" and ")}`);
        const status = args["status"];
        if (status !== undefined && !PIPELINE_STATUSES.includes(status as PipelineStatus)) throw new GitToolRefusal(`\`status\` is one of ${PIPELINE_STATUSES.join(", ")}`);
        const source = args["source"];
        if (source !== undefined && !PIPELINE_SOURCES.includes(source as PipelineSource)) throw new GitToolRefusal(`\`source\` is one of ${PIPELINE_SOURCES.join(", ")}`);
        const at = await reach(args, ctx);
        let which: Pick<PipelineQuery, "mergeRequest" | "ref" | "sha">;
        if (args["merge_request"] !== undefined) {
          const number = id(args["merge_request"]);
          if (number === undefined) throw new GitToolRefusal("`merge_request` is a merge request's number");
          which = { mergeRequest: number };
        } else if (text(args["sha"]) !== undefined) which = { sha: text(args["sha"])! };
        else {
          const ref = text(args["ref"]) ?? (await at.git.currentBranch());
          if (ref === undefined) throw new GitToolRefusal("the workspace is not on a branch — name the merge_request, ref or sha");
          which = { ref };
        }
        const listed = await at.access.provider.pipelines(at.location.project, {
          ...which,
          ...set("status", status as PipelineStatus | undefined),
          ...set("source", source as PipelineSource | undefined),
          ...set("limit", id(args["limit"])),
        });
        return {
          repository: repository(at),
          pipelines: listed.pipelines.map(pipelineView),
          ...(listed.statuses.length > 0 ? { statuses: listed.statuses.map(statusView) } : {}),
        };
      },
    ),

    read_pipeline: forgeTool(
      host,
      "read_pipeline",
      {
        description:
          "Read one pipeline and its jobs: each `job_id`, name, stage, status, link, and for a failed one its `failure_reason` — `script_failure` is the job's own commands failing; `stuck_pending_no_matching_runners` and other `stuck_…` reasons mean it never ran at all. Also the pipeline's own artifacts (GitHub's uploads, by `artifact_id`), trigger jobs' downstream pipelines, and its test counts when it has a test report.",
        inputSchema: {
          type: "object",
          properties: {
            pipeline_id: { type: "integer", minimum: 1, description: "From `list_pipelines`, `list_merge_requests` or `read_merge_request`." },
            job_status: { type: "array", items: STATUS_SCHEMA, description: "Only jobs in these states — `[\"failed\"]` for what went wrong." },
            include_retried: { type: "boolean", description: "Also every earlier attempt of a retried job (marked `retried`)." },
            ...REMOTE_PROPERTY,
          },
          required: ["pipeline_id"],
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const pipelineId = id(args["pipeline_id"]);
        if (pipelineId === undefined) throw new GitToolRefusal("name the pipeline: `pipeline_id`");
        const wanted = args["job_status"];
        if (wanted !== undefined && (!Array.isArray(wanted) || wanted.some((s) => !PIPELINE_STATUSES.includes(s as PipelineStatus)))) {
          throw new GitToolRefusal(`\`job_status\` is a list of ${PIPELINE_STATUSES.join(", ")}`);
        }
        const at = await reach(args, ctx);
        const pipeline = await at.access.provider.pipeline(at.location.project, pipelineId, {
          ...set("jobStatus", wanted as PipelineStatus[] | undefined),
          ...(args["include_retried"] === true ? { includeRetried: true } : {}),
        });
        return {
          repository: repository(at),
          pipeline: pipelineView(pipeline),
          jobs: pipeline.jobs.map(jobView),
          artifacts: pipeline.artifacts.map(artifactView),
          ...(pipeline.tests !== undefined ? { tests: testsView(pipeline.tests) } : {}),
        };
      },
    ),

    read_pipeline_job: forgeTool(
      host,
      "read_pipeline_job",
      {
        description:
          "Read one job: its status and `failure_reason`, exit code, the machine it ran on (the runner, its tags or labels, and from its log the OS, image and runner version), its steps (GitHub), its annotations (GitHub's error and warning notes), and its artifacts — `job_id` and `file_type` for each, `trace` being the log — to download with `download_pipeline_artifact`.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "integer", minimum: 1, description: "From `read_pipeline`." }, ...REMOTE_PROPERTY },
          required: ["job_id"],
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const jobId = id(args["job_id"]);
        if (jobId === undefined) throw new GitToolRefusal("name the job: `job_id`");
        const at = await reach(args, ctx);
        const job = await at.access.provider.job(at.location.project, jobId);
        // The machine is written in the log's first lines — only a job that started has one.
        let machine: CiMachine | undefined;
        if (job.startedAt !== undefined && job.artifacts.some((a) => a.fileType === "trace")) {
          machine = await logOf(at, jobId)
            .then((bytes) => machineFromLog(cleaned(at.access.provider, Buffer.from(bytes).toString("utf8"))))
            .catch(() => undefined);
        }
        const { pipelineId, sha, exitCode, runner, steps, annotations, artifacts, ...rest } = job;
        return {
          repository: repository(at),
          job: { ...jobView(rest), ...set("pipeline_id", pipelineId), ...set("sha", sha), ...set("exit_code", exitCode) },
          ...(runner !== undefined ? { runner } : {}),
          ...(machine !== undefined && Object.keys(machine).length > 0
            ? { machine: { ...set("os", machine.os), ...set("image", machine.image), ...set("image_version", machine.imageVersion), ...set("runner_version", machine.runnerVersion), ...set("executor", machine.executor) } }
            : {}),
          ...(steps.length > 0 ? { steps: steps.map((step) => ({ number: step.number, name: step.name, status: step.status, ...set("started_at", step.startedAt), ...set("finished_at", step.finishedAt) })) } : {}),
          ...(annotations.length > 0 ? { annotations: annotations.map((a) => ({ path: a.path, ...set("start_line", a.startLine), ...set("end_line", a.endLine), level: a.level, ...set("title", a.title), message: a.message })) } : {}),
          artifacts: artifacts.map(artifactView),
          ...(job.startedAt === undefined && job.status === "failed" ? { note: "this job never started, so it has no log and ran on no machine — its failure_reason says why" } : {}),
        };
      },
    ),

    download_pipeline_artifact: forgeTool(
      host,
      "download_pipeline_artifact",
      {
        description:
          "Download a job's artifact — `job_id` and `file_type` (`trace`, the log; `archive`, its files, or one of them by `path`; a report such as `junit`) — or a run's uploaded artifact on GitHub (`artifact_id`). It is kept with this task, outside the workspace: read each saved file with `read_file` at its `path`, or give a shell command its `file`. A log is saved cleaned — the forge's timestamps and colour codes taken out — and on GitHub also one file per step, `step-<n>.log`; an archive is unpacked. A log file's `line_link` is the page of one of its lines: put a line number in for `<line>` to link a person to it.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "integer", minimum: 1, description: "From `read_pipeline` or `read_pipeline_job`." },
            file_type: { type: "string", description: "With `job_id`: which of its artifacts, as `read_pipeline_job` lists them. `trace` (the log) when absent." },
            path: { type: "string", description: "With `file_type: \"archive\"` (GitLab): one file inside the archive rather than all of it." },
            artifact_id: { type: "integer", minimum: 1, description: "Instead of `job_id`: a GitHub run's uploaded artifact, from `read_pipeline`." },
            ...REMOTE_PROPERTY,
          },
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const jobId = id(args["job_id"]);
        const artifactId = id(args["artifact_id"]);
        if ((jobId === undefined) === (artifactId === undefined)) throw new GitToolRefusal("name either a `job_id` (with its `file_type`) or an `artifact_id`");
        const sink = host.artifacts;
        if (sink === undefined) throw new GitToolRefusal("download_pipeline_artifact is not served here — there is no task to keep the download with");
        const at = await reach(args, ctx);
        const provider = at.access.provider;
        const fileType = text(args["file_type"]) ?? "trace";
        const path = text(args["path"]);
        const folder = `${CI_ARTIFACTS_ROOT}/${jobId !== undefined ? jobId : `artifact-${artifactId}`}`;
        const saved: SavedArtifact[] = [];

        if (jobId !== undefined && fileType === "trace") {
          const raw = Buffer.from(await logOf(at, jobId)).toString("utf8");
          if (raw.length === 0) {
            return { repository: repository(at), saved: [], note: "the log is empty — the job never ran; read_pipeline_job's failure_reason says why" };
          }
          if (provider.kind === "gitlab") {
            const clean = cleanGitlabLog(raw);
            // Line N of the saved log is `#L<N>` on the job's page (measured): the link a person follows.
            const page = `https://${at.location.host}/${at.location.project}/-/jobs/${jobId}`;
            const log = { ...sink.save(`${folder}/job.log`, Buffer.from(clean, "utf8")), line_link: `${page}#L<line>` };
            return { repository: repository(at), saved: [log], lines: clean.split("\n").length, ...machineOf(clean) };
          }
          const job = await provider.job(at.location.project, jobId);
          const split = cleanGithubLog(
            raw,
            job.steps.map((step) => ({ number: step.number, name: step.name, ...set("startedAt", step.startedAt), ...set("finishedAt", step.finishedAt), skipped: step.status === "skipped" })),
          );
          saved.push(sink.save(`${folder}/job.log`, Buffer.from(split.text, "utf8")));
          // Line L of a step's file is `#step:<n>:<L>` on the job's page (measured); the whole log has no such link.
          const steps = split.steps.map((step) => ({
            ...sink.save(`${folder}/step-${step.number}.log`, Buffer.from(step.text, "utf8")),
            line_link: `${job.url}#step:${step.number}:<line>`,
          }));
          const failed = job.steps.filter((step) => step.status === "failed").map((step) => `${folder}/step-${step.number}.log`);
          return {
            repository: repository(at),
            saved: [...saved, ...steps].slice(0, LISTED_FILES),
            lines: split.text.split("\n").length,
            ...(failed.length > 0 ? { failed_steps: failed } : {}),
            ...machineOf(split.text),
          };
        }

        const which: ArtifactRef = jobId !== undefined ? { jobId, fileType, ...set("path", path) } : { artifactId: artifactId! };
        const { bytes } = await provider.artifact(at.location.project, which);
        if (isZip(bytes)) {
          let entries;
          try {
            entries = readZip(bytes);
          } catch (e) {
            if (e instanceof ZipError) throw new GitToolRefusal(`the archive could not be unpacked: ${e.message}`);
            throw e;
          }
          for (const entry of entries) saved.push(sink.save(`${folder}/${entry.name}`, entry.data));
        } else {
          // A GitLab report comes gzipped (`junit.xml.gz`); a single file of an archive comes as itself.
          const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
          const name = path ?? REPORT_FILES[fileType] ?? `${fileType}${gzipped ? "" : ".bin"}`;
          saved.push(sink.save(`${folder}/${name.replace(/^\/+/, "")}`, gzipped ? new Uint8Array(gunzipSync(bytes)) : bytes));
        }
        return {
          repository: repository(at),
          saved: saved.slice(0, LISTED_FILES),
          ...(saved.length > LISTED_FILES ? { more: `${saved.length - LISTED_FILES} more files under ${folder}` } : {}),
        };
      },
    ),
  };
}

/** What a report is saved as — GitLab sends each gzipped, under no name of its own. */
const REPORT_FILES: Record<string, string> = {
  junit: "junit.xml",
  cobertura: "cobertura.xml",
  jacoco: "jacoco.xml",
  codequality: "codequality.json",
  sast: "sast.json",
  dependency_scanning: "dependency_scanning.json",
  container_scanning: "container_scanning.json",
  secret_detection: "secret_detection.json",
  dotenv: "dotenv.env",
  annotations: "annotations.json",
  cyclonedx: "cyclonedx.json",
};

/** The machine a cleaned log names, as the answer's field. */
function machineOf(clean: string): { machine?: Record<string, string> } {
  const machine = machineFromLog(clean);
  const view = { ...set("os", machine.os), ...set("image", machine.image), ...set("image_version", machine.imageVersion), ...set("runner_version", machine.runnerVersion), ...set("executor", machine.executor) };
  return Object.keys(view).length > 0 ? { machine: view as Record<string, string> } : {};
}
