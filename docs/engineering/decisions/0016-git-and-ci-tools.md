---
id: engineering/decisions/0016-git-and-ci-tools
type: decision
status: built
updated: 2026-09-28
decides_for: [engineering/units/forge-integrations, engineering/units/tool-policy, engineering/units/host-tools]
---

# 0016. Git and CI tools

Amends decision 0010 §1–§2. Mockup (the real Settings panes, as shipped and as proposed):
https://claude.ai/artifact/5YYaJjbaVkrP2Dn87szV6o. The person's words are quoted where they settle
something; nothing below reopens them.

## Context

2026-09-27, task `t-5e7yqafzov` on mist-server (`origin` → gitlab.com/mistlabs/mist-server). Asked
"look at the mrs and tell me why the ci failed", the agent called `list_merge_requests`, then
`git_checks` once per merge request (ten approvals), and got each job's name, stage, `conclusion:
failure` and a web link — nothing that says why. It then:

- fetched `gitlab.com/…/-/jobs/<id>/raw` with `web_fetch` → 403 from Cloudflare;
- ran `curl` against `/api/v4/…/jobs/<id>/trace` with no token → 401;
- read `$env:GITLAB_TOKEN`, `$env:GL_TOKEN` and the glab config, looking for a token.

The connection JaiRA already holds (GitLab scope `api`) can read every job log. The Git tools never
asked it to. `read_merge_request` returned the same job list.

Two more problems were found while reading the code:

- `read_merge_request` asks GitLab for the pipelines of the request's HEAD sha, which misses a
  merged-result pipeline: it runs on a merge commit that is not one of the request's commits
  (measured, gitlab-org/cli !3966: head `b510fd65`, its pipeline's sha `75b91c03`).
- A GitHub commit status's `description` is dropped, and GitLab's `allow_failure` jobs and
  downstream pipelines (trigger jobs) are not shown.

## Decision

### 1. Words

The person, 2026-09-28: "I want to be very deliberate with our choice of words." A tool's name is a
verb and the thing it acts on, and that thing is the forge's own object. The rulings, in order:

- "git doesnt have comments; the mr has comments" — `git_comment` → `comment_merge_request`.
- "git_merge is a fine tool name as you can merge branches with git. we're making it a little smarter
  by having it merge a merge request … consider it an 'overload' of the tool. same for git_push." —
  both keep their names.
- CI's objects are **pipeline**, **job** and **artifact**. "Check" is GitHub's word for what CI
  reports back on a commit and is not used. The job log is an artifact (GitLab lists it as the
  artifact of `file_type` `trace`); the person chose "artifact" over "output".
- Two categories, "git + ci". Git is the repository and its merge requests; CI is the pipelines that
  ran on the repository's commits. They meet at the commit: a pipeline runs on a commit, and a merge
  request proposes commits. A merge request's own read shows its latest pipeline and nothing more.

### 2. Tools

The inputs are values an API call takes — numbers, shas, branch names, enums — or ids a previous result
returned under the SAME field name. The person: "these tools should be api functions … those inputs
look like they need another llm to translate to the correct api values." Nothing is described in prose.
Every tool also takes `remote` (a git remote's name — which host and project), optional as today.

**Git** (category `git`)

| Tool | Change |
| --- | --- |
| `list_merge_requests` | gains `include_pipelines: boolean` — each request gets `pipelines[]` for its head commit: `pipeline_id`, `status`, `url`, and `failed_jobs[]` (`job_id`, `name`, `stage`). One call, one approval, however many requests. |
| `read_merge_request` | every thread and comment gains `url`; replies return the new comment's `url`. `checks` becomes `pipelines[]` in the same shape as above. |
| `open_merge_request`, `close_merge_request`, `git_merge`, `git_push` | unchanged |
| `git_comment` | renamed `comment_merge_request`; takes `thread_id` (was `thread`) — the field name the read returns |
| `git_checks` | removed |

**CI** (new category `ci`, "the pipelines that ran on the repository's commits, through the same
connection", after Git)

`list_pipelines` — exactly one of `merge_request`, `ref`, `sha`:

| Input | GitLab | GitHub |
| --- | --- | --- |
| `merge_request: integer` | `GET /merge_requests/:iid/pipelines` | the PR's commits (GraphQL, one query) → their check suites |
| `ref: string` | `GET /pipelines?ref=` | `GET /commits/{ref}/check-suites` |
| `sha: string` | `GET /pipelines?sha=` | `GET /commits/{sha}/check-suites` and `/status` |
| `status: running\|pending\|success\|failed\|canceled\|skipped` | `status=` | `status=` |
| `source: push\|merge_request\|schedule\|trigger\|api\|web` | `source=` | `event=` (`merge_request` ↔ `pull_request`) |
| `limit: 1–100` | `per_page` | `per_page` |

Returns `pipelines[]`: `pipeline_id`, `sha`, `ref`, `source`, `status`, `attempt`, `created_at`,
`finished_at`, `url`. GitHub commit statuses have nothing more to read, so each commit's statuses come
back whole in the same list, with no `pipeline_id` — as GitLab already folds external statuses into a
pipeline of source `external`.

`read_pipeline` — `{ pipeline_id: integer, job_status?: status[], include_retried?: boolean }`

- GitLab: `GET /pipelines/:id`, `/pipelines/:id/jobs?scope[]=&include_retried=`,
  `/pipelines/:id/trigger_jobs`, `/pipelines/:id/test_report_summary`.
- GitHub: `GET /check-suites/:id` and `/check-suites/:id/check-runs`; for Actions, the workflow run
  (`GET /actions/runs?check_suite_id=`) for its attempt, event and artifacts.
- Returns `jobs[]`: `job_id`, `name`, `stage`, `status`, `failure_reason`, `allow_failure`, `url`, and
  `downstream_pipeline_id` on a trigger job; `artifacts[]` where the forge hangs them on the pipeline
  (GitHub's run artifacts): `artifact_id`, `name`, `size`, `expires_at`, `url`; `tests` (GitLab): counts
  per suite, each suite with its `job_ids`.

`read_pipeline_job` — `{ job_id: integer }`

- GitLab: `GET /jobs/:id`. GitHub: `GET /check-runs/:id` and `/check-runs/:id/annotations`, and
  `GET /actions/jobs/:id` when Actions ran it.
- Returns `runner` (`name`, `platform`, `architecture`, `version`, `tags`), `steps[]` (GitHub),
  `exit_code` where given, `annotations[]` (GitHub), and `artifacts[]`: `job_id`, `file_type`,
  `filename`, `size`, `expires_at`, `url`.
- The machine, as each forge tells it. GitLab's REST job carries `runner` and `runner_manager`
  (`platform`, `architecture`, `version`) and `tag_list`; the executor is GraphQL-only; the Docker image
  is in neither. A GitHub job carries only the `labels` it asked for (`ubuntu-latest`) and
  `runner_name`; the image and OS version are written in the log's "Set up job" section, which the
  tool reads.

`download_pipeline_artifact` — `{ job_id, file_type, path? }` or `{ artifact_id }`

| Input | GitLab | GitHub |
| --- | --- | --- |
| `job_id` + `file_type: "trace"` | `GET /jobs/:id/trace` | `GET /actions/jobs/:id/logs` |
| `job_id` + `file_type: "archive"` (+ `path` for one file) | `GET /jobs/:id/artifacts[/*path]` | — |
| `job_id` + a report type (`junit`, `codequality`, …) | `GET /jobs/:id/artifacts?file_type=` | — |
| `artifact_id` | — | `GET /actions/artifacts/:id/zip` |

`file_type` takes GitLab's own values: GitLab has the complete list, and GitHub's job log is its
`trace`. Returns `path`, `files[]` when an archive was unzipped, `bytes`, `url`.

The file lands in the task's central artifact folder — `$SYSTEM/<artifacts dir>/<task>/ci/<job_id>/`,
the `$CENTRAL` placement of `runtime/artifactPath.ts` — outside the worktree, so it never shows in
`git status`. The agent reads it with `read_file`, `grep` and `bash`; JaiRA pages and searches nothing
itself. A log is saved cleaned, because the raw form costs tokens and breaks `grep`: ANSI colour codes and
GitLab's `section_start`/`section_end` markers removed, and GitLab's per-line prefix (see Verified)
removed with its continuation lines joined back to the line they continue. The built-in permission sets' file rules let every
agent read that folder.

**ids.** On GitHub `pipeline_id` is the check suite id and `job_id` the check run id — the only ids
every GitHub CI result has, including apps that are not Actions. GitHub's web links show the workflow
run id instead; `url` carries the link.

**Modes** in the built-in sets (ask-first · auto · full · read-only): all four CI tools
ask · allow · allow · allow, as `list_merge_requests`. `comment_merge_request` keeps `git_comment`'s.

### 3. Links

Every object an agent may cite comes with a `url`: a merge request, a thread, a comment, a pipeline, a
job, an artifact.

- GitLab builds a comment's link as `<merge request url>#note_<id>` (it works, but the API has no
  `web_url` for notes); an artifact's as `-/jobs/<id>/artifacts/browse` or `/file/<path>`.
- GitHub gives comments `url`/`html_url`; an artifact's page is
  `/actions/runs/<run>/artifacts/<id>` (viewers must be signed in).
- A log LINE: GitLab `<job url>#L<n>`; GitHub numbers lines per step (`#step:<n>:<line>`), so a GitHub
  log is saved as one file per step (`step-<n>.log`) and line L of `step-4.log` is `#step:4:L`. The
  split cannot use the steps' times: the API gives them to the whole second and several steps share
  one (measured below), so it must use the log's own step markers. Both link forms are verified
  (below), and each saved log file carries its `line_link` template (`…#L<line>`, `…#step:<n>:<line>`).

### 4. Events

The person: "essentially an event to match a tool use". An event is the past tense of a tool's action,
and fires whoever did it — the agent, a person on the forge, CI. "event aliases dont hurt": one
occurrence may carry two names.

| Event | Matches | Replaces |
| --- | --- | --- |
| `git.pushed` | `git_push` | `git.push` |
| `git.merged` | `git_merge` | — |
| `merge_request.opened` | `open_merge_request` | `git.merge_request.opened` |
| `merge_request.updated` | — (new commits, title, description, target, draft) | `git.merge_request.updated` |
| `merge_request.pushed` | the push `git.pushed` tells, as the merge request's | — |
| `merge_request.commented` | `comment_merge_request` | `git.merge_request.comments` |
| `merge_request.merged` | the merge `git.merged` tells, as the merge request's | `git.merge_request.merged` |
| `merge_request.closed` | `close_merge_request` | `git.merge_request.closed` |
| `pipeline.succeeded` | — | — |
| `pipeline.failed` | — | `git.checks.failed` |
| `pipeline.canceled` | — | — |
| `task.finished`, `task.failed` | unchanged | |

- "merge_request.updated is mostly git.pushed but it could encompass more" — it stays.
- "keep the pipeline events as well" — pipelines have no tool to match; they are outcomes, as
  `task.*` are. A pipeline that times out counts as failed. Their payload carries `pipeline_id` and
  `failed_jobs[]` with `job_id`, so an automation can hand them straight to the CI tools.
- An automation on both names of one occurrence runs twice; that is what listening to both means.
- Every event ships enabled — the person, 2026-09-28: "the default should be enabled for all the
  events". `builtin/settings.json` states each name above `{ "enabled": true }`, as it already does for
  0010's; a layer turns one off.

### 5. `wait_for_event`

`wait_git_event` becomes `wait_for_event` ("yes rename to wait_for_event") and waits for ANY event —
"wait for event should be able to wait for any event" — JaiRA's own `task.*` included. It moves to the
Tasks & workflows category, since it is no longer only the forge's. Its timeout rules are 0010's.

## Consequences

- **Renames are migrated, then the old names are deleted** (no back-compat readers). Checked: nothing
  under `~/.jaira` or mist-server's `.jaira` names an old tool or event (settings, permission sets,
  workflows, the events task's automations), so no file migration was needed. What the DATABASE holds is
  schema step 25 (`persistence/migrations.ts`), applied on the next open: `repo_watch_seen`'s `checks`
  rows become `pipelines` (the table is rebuilt for its CHECK constraint), the cursor's `checks` becomes
  `pipelines`, and `event_waits` names are renamed. An old name anywhere else is refused as "not an
  event" / an unknown tool, as any misspelling is. The journal keeps the names it was written with.
- The event group says WHERE an event happens: `EventGroup` is `"remote" | "task"` (was `"git" | "task"`) —
  every use of the old `git` group meant "on a project's remote", which `merge_request.*` and `pipeline.*`
  are too. Settings → Tools → Events keeps one list per remote, headed "Remotes" where there is none.
- `ToolCategoryId` gains `"ci"`. The CI tools are drawn with the Git glyph until one of their own is
  chosen.
- `RemoteState`'s threads and comments gain `url`; `CiRun`/`CiStatus` are replaced by the pipeline
  and job shapes above; `ForgeProvider` gains `pipelines`, `pipeline`, `job`, `artifact` and loses
  `checks`. The review gate (0004) reads the same shapes.
- GitHub needs "Actions: read" for logs and artifacts on a fine-grained token and on JaiRA's own
  GitHub App; a classic `repo` token has it. A refusal names that permission. GitLab `api` (JaiRA's
  device-flow scope) covers everything; `read_api` would too.
- Both forges' log and artifact download links (302) are signed and short-lived: fetched at once,
  never stored. Node's `fetch` drops `Authorization` on the cross-origin redirect, as the Fetch
  standard requires. The HTTP seam gained `expect: "text" | "bytes"` and a per-request timeout — an
  archive is a zip, which the seam's decode-as-text would have corrupted.
- REFERENCES §4.2a, tool-policy, forge-integrations and the Settings copy that names tools ("Used by 9
  Git tools") are updated.

## Verified (2026-09-28)

Read-only, against public projects and with no token — JaiRA's forge tokens live in Electron's
`safeStorage` and are readable only by the app, so nothing here used the person's connections.
GitHub: cli/cli run `26882796913`, job `79286928933`. GitLab: gitlab-org/cli pipeline `2881410858`,
job `16728223589`, merge request !3966.

- **GitHub job id = check run id.** Every job's `check_run_url` ends in the job's own id.
- **GitHub step numbers skip** (1–6, then 11–13) and step times are whole seconds; steps 6, 11 and 12
  share one second. Hence the split on log markers above.
- **GitHub Actions' failure annotation carries the exit code** — "Process completed with exit code
  1.", level `failure` — so `read_pipeline_job` has an exit code without downloading the log. The
  check run's `output` is empty for Actions.
- **GitHub runs from forks carry `pull_requests: []`**, and some failed pull-request runs have no jobs
  at all.
- **Both forges want a token for a log, even on a public project** (GitHub 403, GitLab 401).
- **GitLab redirects a finished log too**: the web route answers `302` to a signed
  `cdn.artifacts.gitlab-static.net` link. Following redirects without the token is right on both.
- **GitLab's log has a per-line prefix** the docs do not mention:
  `2026-09-25T07:33:00.992977Z 00O ` — a timestamp, a stream (`O` stdout, `E` stderr), and a space, or
  `+` when the line continues the previous one. Sections as documented: `prepare_executor`,
  `prepare_script`, `get_sources`, `download_artifacts`, `step_script`, `cleanup_file_variables`.
- **GitLab's machine is in the log's head**: "Running with gitlab-runner 19.5.0…", "on
  k8s.saas-linux-medium-amd64… system ID: r_…", and under `prepare_executor` "Using Docker executor with
  image ghcr.io/canonical/snapcraft:8_core24". The last line is "ERROR: Job failed: exit code 1".
- **GitLab's job lists the log as an artifact**: `{ file_type: "trace", filename: "job.log" }`, with
  `failure_reason: "script_failure"`. Without a token `runner_manager` is `null`; `runner.description`
  and `tag_list` name the machine class (`saas-linux-medium-amd64`).
- **Merge request refs** `refs/merge-requests/<iid>/merge` (merged results) and `…/train` (merge
  trains) are both live.
- **Corrected:** `pipelines?ref=<source branch>` DID return !3966's merge request pipeline. The miss is
  the one by sha (Context).

### In the app, through its own connections (2026-09-28)

`JAIRA_FORGE_RECORD=<spec.json>` (desktop.ts → `service/forgeRecord.ts`) runs read-only provider
calls through the app's signed-in connections — the tokens never leave the process — and writes the
traffic, with no request headers, under `~/.jaira/system/logs/forge-record-<time>/`. 26 calls; 25
answered, and the 26th is a finding (a GitHub log past retention).

- **Why mist-server's CI failed** (the question that started this): every failed job's
  `failure_reason` is `stuck_pending_no_matching_runners`. No runner with the tag `linux` (the two
  container builds) or `mac` (`build-osx`) picked them up, so they never ran: no runner, and an EMPTY
  log (200, zero bytes). The container builds were retried twice, each attempt the same. The answer was
  in one field of the job all along; there was never a log to read.
- **A merge request's list includes its branch's push pipelines**: !10's is one pipeline, source `push`.
- **`runner_manager` is `null` on gitlab.com's instance runners even to a signed-in token.** A job's
  machine on gitlab.com is its runner's description and tags (`saas-linux-medium-amd64`) and the log's
  head; `platform`/`architecture` fill in on self-managed runners only.
- **GitHub's log** (job `109083036468`, cli/cli): a UTF-8 BOM, then every line
  `<timestamp>Z <text>`. The machine is in its first lines: "Current runner version: '2.337.0'", and a
  `##[group]VM Image` group with "- OS: Linux (x64)", "- Name: ubuntu:24.04", "- Version: 20260922.6.5".
  Each user step opens with a `##[group]Run …` line; steps hold nested groups of their own; step
  numbers skip (19, then 37–39). The split into `step-<n>.log`: each `##[group]Run` line opens the next
  step whose one-second window contains its timestamp.
- **A GitHub log past retention answers `410 Gone`**, and that job's `steps` come back empty to a
  signed-in token (a no-token read of the same job the same morning listed nine).
- **A commit on a busy default branch has dozens of suites**: every scheduled run shares trunk's head
  (cli/cli `46480afb`: 20+). `list_pipelines` by sha or ref leans on `status`, `source` and `limit`.
- **GitHub pull request pipelines by GraphQL** work as written (`JairaPullPipelines`); another app's
  suite (`github-advanced-security`) comes back as source `external`.

Log-line links, checked on the forges' own pages (2026-09-28, public jobs, read only):

- **GitLab** numbers a job's log WITHOUT the lines that held only section markers and without empty
  lines, continuations joined; with both left out of the cleaned log, all 54 of gitlab-org/cli job
  `16728223589`'s lines matched `#L1`…`#L54`.
- **GitHub** numbers each step's lines from 1, WITHOUT `##[endgroup]` lines (a `##[group]` line is
  numbered, drawn without its marker). With end-groups left out, step 8 of cli/cli job `109083036468`
  matched at lines 30, 85, 191 and 193 (a folded group hides the lines between).

## Build order

1. ~~Verify against real forges~~ — Verified, above.
2. ~~Provider operations and their fixtures~~ — built 2026-09-28: `pipelines`, `pipeline`, `job`,
   `artifact` on both providers (`runtime/forge/gitlab.ts`, `github.ts`; shapes in
   `shared/forge.ts`); the seam's `expect`; `AppService.forgeProviderOver`; the recording pass;
   `runtime/test/forgeCi.test.ts` over `gitlab.ci.json` and `github.ci.json` (recorded in the app,
   public projects only, trimmed as their `_source` says) and `gitlab.ci-stuck.json` (the stuck job's
   shape, names and ids invented — mist-server's own answers are private and stay out of the
   repository). `checks` stays until step 3 replaces its callers.
3. ~~The tools~~ — built 2026-09-28:
   - `runtime/ciTools.ts`: the four CI tools over the Git tools' host (`reachForge`, `forgeTool` are
     now exported from `gitTools.ts`); `registerGitTools` registers both. Answers are shaped in
     `ciViews.ts` under the input names.
   - `list_merge_requests { include_pipelines }` and `read_merge_request`'s `pipelines`: each request's
     LATEST pipelines — GitLab's newest from the request's own list, GitHub's suites on its head — each
     with `failed_jobs` (`job_id`, name, stage, `failure_reason`) when it failed. Five requests at a
     time; a request whose read fails carries `pipelines_error` instead.
   - Comment links: `ForgeComment.url` (GitLab `<request>#note_<id>`, GitHub GraphQL `url`);
     `comment()`/`reply()` answer `ForgePosted { id, url }`, and `comment_merge_request` returns the
     `url`. The input is `thread_id`, and `read_merge_request`'s threads carry `thread_id` (was `id`)
     so the field is copied, not translated.
   - `read_pipeline_job` downloads the log of a job that STARTED to read its machine
     (`ciLog.machineFromLog`) and keeps the bytes for a following download; a job that never
     started answers a `note` saying so and reads nothing.
   - `download_pipeline_artifact` keeps files as the task's artifacts under `ci-artifacts/<job_id>/…`
     (`ci-artifacts/artifact-<id>/…` for a GitHub upload) in `$CENTRAL` (`ciArtifacts.ts`), each
     recorded in the artifact store — the record is what lets `read_file` read it by that path from
     a worktree it is not in. Answers `path` (for `read_file`) and `file` (for a shell). A log is
     cleaned (`ciLog.ts`); a GitHub log is also split into `step-<n>.log` by the rule under Verified
     (checked on the full recorded log: every step's first line is its own `Run …`, its post
     cleanup, or its completion); an archive is unpacked by a small reader on Node's `zlib`
     (`zip.ts` — no zip64, refuses names that climb out) rather than a new dependency; a GitLab
     report is gunzipped and named (`junit.xml`, …).
   - Vocabulary, built-in permission sets, change log (`comment_merge_request` steps link to the
     comment itself), the Connections forge row ("Used by 8 Git tools — …, and 4 CI tools").
   - Log-line links: each saved log file answers `line_link` (verified — see Verified). The CI tools
     draw with the Git glyph.
   - Nothing under `~/.jaira` or mist-server's `.jaira` names `git_checks` or `git_comment` (checked),
     so step 5 has no data to migrate for these two.
3. The four CI tools, `include_pipelines`, comment `url`s, the renames; vocabulary, display titles,
   built-in permission sets and their tests.
4. ~~Events~~ — built 2026-09-28: the thirteen names (`shared/events.ts`), `EventGroup` `"remote" | "task"`,
   payloads `MergeRequestPushedPayload`, `MergeRequestCommentedPayload`, `PipelinePayload`,
   `PipelineFailedPayload` (with `failed_jobs`); the watcher (`runtime/repoWatch.ts`) raises both names of
   a merge, `merge_request.pushed` beside `.updated` when the head moved, and per finished pipeline of a
   branch head its outcome (GitLab: the newest pipeline; GitHub: every suite; skipped and manual raise
   nothing), reading a failed one's failed jobs; its store kind `checks` became `pipelines`. Every event
   ships enabled. `wait_for_event` replaces `wait_git_event`, category `tasks`, any event — the forge's
   door only for a remote's. The provider's `checks()` and `CiRun`/`CiStatus`/`ciStateOf` are deleted.
5. ~~Migration and docs~~ — schema step 25 (above, tested in `persistence/test/migrations.test.ts`);
   host-tool-vocabulary, host-tools, task-file, REFERENCES §4.2a, the built-in README, and a note on
   0010 naming what changed.
