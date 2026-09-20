/**
 * The remote primitives (decision 0004 §2): `remote_push`, `remote_open`, `remote_comment`,
 * `remote_merge`, `remote_close`.
 *
 * Host functions, registered like the components' neighbours. Each is small on purpose — the layer
 * above (`review_artifacts.remote`) is written in these, and a workflow that wants something the
 * component does not do has them to write it in.
 *
 * ## Three rules that are not negotiable here
 *
 *  - **Publishing is a policy decision, not a side effect.** A push and a merge request leave the
 *    machine, so both pass {@link authorizePublish} first: `remote.publish` is `allow`, `deny`, or —
 *    the default — asked ONCE per task through `confirm_action`, saying exactly what will be sent and
 *    as whom. A `remote` in a workflow file is a request, never the authorization.
 *  - **JaiRA never force-pushes.** Every push is a plain fast-forward of a branch only JaiRA writes;
 *    a rejected push is an error the state sees. That is also what decides the open question the
 *    decision left: a `tree: "base"` changeset's scratch worktree is KEPT between rounds, because a
 *    rebuilt one could only reach the branch by overwriting it.
 *  - **Identity is never configured.** A commit is authored by `git config user.name/email`; the
 *    request and every comment belong to whoever owns the connection's token.
 *
 * ## What picks the forge
 *
 * The git remote's CONFIGURED url (`git config remote.<to>.url`), read raw. Not `git remote get-url`,
 * which answers after `url.<base>.insteadOf` rewriting: a rewrite says where the bytes travel, and
 * the configured url says which forge the project is on. (It is also what lets the tests push to a
 * bare repository on disk while the project still reads as one on gitlab.com.)
 */
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  failureOf,
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type JsonValue,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  DEFAULT_REMOTE_KEY,
  FORGE_LABELS,
  applyDecisions,
  connectionForHost,
  handleOfRow,
  parseRemoteUrl,
  publishModeOf,
  remoteBranchName,
  type Changeset,
  type ForgeAnchor,
  type ForgeProvider,
  type JairaIntegrationsConfig,
  type RemoteHandle,
  type RemoteHandlePort,
  type RemoteHandleRow,
} from "@jaira/shared";
import type { Exec } from "./exec";
import { forgeForHost, type ForgeHttp } from "./forge";
import { Git } from "./git";
import type { ExecEnv } from "./paths";
import type { SecretResolver } from "./secrets";

export const REMOTE_PUSH = "remote_push";
export const REMOTE_OPEN = "remote_open";
export const REMOTE_COMMENT = "remote_comment";
export const REMOTE_MERGE = "remote_merge";
export const REMOTE_CLOSE = "remote_close";
export const REMOTE_FUNCTIONS = [REMOTE_PUSH, REMOTE_OPEN, REMOTE_COMMENT, REMOTE_MERGE, REMOTE_CLOSE] as const;

/** The `$`-key the engine puts beside a scoped name's configuration: WHICH one, per instance. */
const NAME_KEY = "$key";

/** What the person is shown before anything leaves the machine — the mockup's five rows. */
export interface PublishRequest {
  taskId: string;
  provider: ForgeProvider["kind"];
  /** `origin · gitlab.com/mistlabs/jaira` */
  to: string;
  host: string;
  project: string;
  branch: string;
  target: string;
  /** `Ofer Sadgat (git config)` — who the commits will say wrote them. */
  commitsAs: string;
  /** `@ofer` — whose token opens the request, when the host would say. */
  openedBy?: string;
}

/** What adopting the forge's history did — what the gate's settled line says. */
export interface AdoptReport {
  /** What landed on the target: the merge commit, as fetched. */
  head: string;
  /** Whether the task's worktree was moved onto it. */
  reset: boolean;
  /** Where the worktree's old tip was kept, when it held anything the merge did not. */
  dropped?: string;
  /** The person's own `<target>`: moved, already there, not a branch here — or left alone, with {@link why}. */
  target: "fast-forwarded" | "up-to-date" | "absent" | "left-alone";
  why?: string;
}

/** `once` lets this task publish; `always` also grants the project; `no` refuses. */
export type PublishAnswer = "once" | "always" | "no";

export interface RemoteOptions {
  taskId: string;
  /** What the request is called when the workflow does not say. */
  taskTitle?: string;
  /** The branch the task was cut from — `target`'s default. A thunk, so a run that never publishes never asks git. */
  baseBranch?: string | (() => Promise<string | undefined>);
  /** The task's worktree — what is pushed when a state names no other. */
  workspaceRoot: string;
  /** Where a `tree: "base"` changeset is materialized: one kept worktree per request under here. */
  scratchDir: string;
  handles: RemoteHandlePort;
  integrations: JairaIntegrationsConfig;
  /** The project's policy document, read for `remote.publish`. */
  policy: unknown;
  secrets: SecretResolver;
  exec: Exec;
  execEnv?: ExecEnv;
  http?: ForgeHttp;
  /**
   * Ask the person. Absent ⇒ nobody can be asked (a headless run), and `ask` refuses with a sentence
   * rather than publishing on nobody's say-so.
   */
  confirmPublish?: (request: PublishRequest) => Promise<PublishAnswer>;
  /** Make `always` durable: write `policy.remote.publish = "allow"` into the project's settings. */
  grantProject?: () => void;
}

/** A failure a person reads. Thrown inside a primitive, returned as the function's `error`. */
class RemoteRefusal extends Error {}

type Result = FunctionResult<ResolvedValue, WorkflowMetrics>;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * What a call is about: the `remote` argument, read by shape.
 *
 * Three things arrive in that one position and all of them are ordinary objects — a configuration
 * (`{ to, target }`, perhaps pasted from `$/remotes`), a scoped name's configuration with the
 * engine's `$key` beside it, and a handle returned by an earlier call (which carries `key`). The key
 * is whichever of those names one; with none, the task has one request.
 */
function remoteArg(inputs: FunctionInputs): { config: Record<string, unknown>; key: string } {
  // A function op's `args` lowers to ONE input named `config`; a direct input of the same name wins.
  const bag = record(inputs["config"]);
  const config = record(inputs["remote"] ?? bag["remote"]);
  const key = text(config[NAME_KEY]) ?? text(config["key"]) ?? DEFAULT_REMOTE_KEY;
  return { config, key };
}

const arg = (inputs: FunctionInputs, name: string): unknown => inputs[name] ?? record(inputs["config"])[name];

export class RemotePrimitives {
  /** Granted for the life of this run. The durable half is a row that has already been pushed. */
  private granted = false;

  constructor(private readonly options: RemoteOptions) {}

  private git(dir: string): Git {
    return new Git({ exec: this.options.exec, repoDir: dir, ...(this.options.execEnv !== undefined ? { execEnv: this.options.execEnv } : {}) });
  }

  private provider(host: string): ForgeProvider {
    return forgeForHost(this.options.integrations, host, {
      secrets: this.options.secrets,
      ...(this.options.http !== undefined ? { http: this.options.http } : {}),
    });
  }

  /** `target`'s default: the branch the task was cut from, and `main` when nobody can say. */
  private async baseBranch(): Promise<string> {
    const base = this.options.baseBranch;
    return (typeof base === "function" ? await base() : base) ?? "main";
  }

  /** The git remote to push to: the one named, else the project's only one. */
  private async remoteName(git: Git, named: string | undefined): Promise<string> {
    const remotes = ((await git.tryRun(["remote"])) ?? "").split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
    if (named !== undefined) {
      if (!remotes.includes(named)) throw new RemoteRefusal(`this repository has no git remote called '${named}' — it has ${remotes.join(", ") || "none"}`);
      return named;
    }
    if (remotes.length === 1) return remotes[0]!;
    throw new RemoteRefusal(
      remotes.length === 0
        ? "this repository has no git remote to push to"
        : `this repository has ${remotes.length} git remotes (${remotes.join(", ")}) — say which with remote.to`,
    );
  }

  /**
   * The row for this call's request — found, adopted from a handle passed by value, or made.
   *
   * Adoption is how a request crosses an `each: "task"` boundary (NAMES.md §12): a name does not
   * reach into a sub-task, the handle does, and the sub-task's first call files it under its own id.
   */
  private async rowFor(inputs: FunctionInputs, dir: string): Promise<RemoteHandleRow> {
    const { config, key } = remoteArg(inputs);
    const { taskId, handles } = this.options;
    const existing = handles.get(taskId, key);
    if (existing !== undefined) return existing;

    const byValue = config as Partial<RemoteHandle> & { remote?: string };
    if (typeof byValue.host === "string" && typeof byValue.project === "string" && typeof byValue.branch === "string" && (byValue.provider === "gitlab" || byValue.provider === "github")) {
      const git = this.git(dir);
      const row = handles.ensure({
        taskId,
        key,
        provider: byValue.provider,
        host: byValue.host,
        project: byValue.project,
        remote: text(byValue.remote) ?? (await this.remoteName(git, text(config["to"]))),
        branch: byValue.branch,
        target: text(byValue.target) ?? (await this.baseBranch()),
      });
      return handles.update(taskId, key, {
        ...(typeof byValue.number === "number" ? { number: byValue.number } : {}),
        ...(typeof byValue.url === "string" ? { url: byValue.url } : {}),
        ...(text(byValue.head) !== undefined ? { pushedHead: byValue.head! } : {}),
      }) ?? row;
    }

    const git = this.git(dir);
    const remote = await this.remoteName(git, text(config["to"]));
    const url = await git.tryRun(["config", "--get", `remote.${remote}.url`]);
    const location = url === undefined ? undefined : parseRemoteUrl(url);
    if (location === undefined) {
      throw new RemoteRefusal(`the git remote '${remote}' is not on a forge (${url ?? "it has no url"}) — a merge request needs GitLab or GitHub behind it`);
    }
    const connection = connectionForHost(this.options.integrations, location.host);
    if (connection === undefined) {
      throw new RemoteRefusal(`no connection is set up for ${location.host} — add one under Settings → Integrations`);
    }
    return handles.ensure({
      taskId,
      key,
      provider: connection.connection.provider,
      host: location.host,
      project: location.project,
      remote,
      branch: remoteBranchName(taskId, key),
      target: text(config["target"]) ?? (await this.baseBranch()),
    });
  }

  /**
   * `remote.publish`, asked at most once per task.
   *
   * A task that has already pushed has already been answered — the row says so, and it says so after
   * a restart, which is what makes "once per task" true of a review that takes a week.
   */
  private async authorizePublish(row: RemoteHandleRow, dir: string, provider: ForgeProvider): Promise<void> {
    const mode = publishModeOf(this.options.policy);
    if (mode === "allow") return;
    if (mode === "deny") {
      throw new RemoteRefusal("this project's policy does not let a workflow publish (policy.remote.publish is deny) — nothing was pushed");
    }
    if (this.granted || this.options.handles.forTask(this.options.taskId).some((r) => r.pushedHead !== undefined)) return;
    if (this.options.confirmPublish === undefined) {
      throw new RemoteRefusal(
        "publishing needs a person's say-so and nobody can be asked here — grant it with policy.remote.publish: \"allow\", or run where the question can be answered",
      );
    }
    const identity = await this.git(dir).identity();
    const who = await provider.whoami().catch(() => undefined);
    const answer = await this.options.confirmPublish({
      taskId: this.options.taskId,
      provider: row.provider,
      to: `${row.remote} · ${row.host}/${row.project}`,
      host: row.host,
      project: row.project,
      branch: row.branch,
      target: row.target,
      commitsAs: identity.name !== undefined ? `${identity.name} (git config)` : "whoever git config names",
      ...(who !== undefined ? { openedBy: `@${who.login}` } : {}),
    });
    if (answer === "no") throw new RemoteRefusal("publishing was declined — nothing was pushed");
    if (answer === "always") this.options.grantProject?.();
    this.granted = true;
  }

  /** Where the pushed tree comes from: the named workspace, else the task's worktree. */
  private workspaceOf(inputs: FunctionInputs, ctx: unknown): string {
    const { config } = remoteArg(inputs);
    return text(config["workspace"]) ?? (ctx as { workspace?: { root?: string } } | undefined)?.workspace?.root ?? this.options.workspaceRoot;
  }

  /**
   * Commit what the workspace holds and push it — or, for a `tree: "base"` changeset, put the
   * proposal on a branch of its own first, because a base tree has no commit to push.
   */
  async push(inputs: FunctionInputs, ctx: unknown): Promise<{ remote: JsonValue }> {
    const workspace = this.workspaceOf(inputs, ctx);
    let row = await this.rowFor(inputs, workspace);
    const provider = this.provider(row.host);
    await this.authorizePublish(row, workspace, provider);

    const changeset = arg(inputs, "changeset") as Changeset | undefined;
    const base = arg(inputs, "tree") === "base" && changeset !== undefined;
    const dir = base ? await this.materialize(row, workspace, changeset) : workspace;
    const git = this.git(dir);

    // `.jaira/` is the recorder's own writing, not the work under review (`worktreeChangeset` makes
    // the same exclusion): committing it would put this run's journal in front of the reviewer.
    await git.run(["add", "-A", "--", ".", ":(exclude).jaira"]);
    if ((await git.tryRun(["diff", "--cached", "--quiet"])) === undefined) {
      const message = text(arg(inputs, "message")) ?? this.options.taskTitle ?? `JaiRA review ${this.options.taskId}`;
      // No `--author`, no `-c user.name`: whoever `git config` names wrote this. With nobody named,
      // git refuses and says so — which is the right error, and the person's to fix.
      await git.run(["commit", "-m", message]);
    }
    const head = await git.head();
    if (head === undefined) throw new RemoteRefusal("there is nothing to push — the workspace has no commit");

    // A plain push: a fast-forward or a refusal. There is no `--force` anywhere in this file.
    try {
      await git.run(["push", row.remote, `HEAD:refs/heads/${row.branch}`], { timeoutMs: 120_000 });
    } catch (e) {
      throw new RemoteRefusal(`the push to ${row.remote}/${row.branch} was refused — ${(e as Error).message.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-2).join(" ")}`);
    }
    row = this.options.handles.update(row.taskId, row.key, { pushedHead: head })!;
    return { remote: this.valueOf(row) };
  }

  /**
   * A `tree: "base"` changeset, as a commit-able tree: a worktree of the target branch with every
   * proposed file written into it.
   *
   * KEPT between rounds (the decision's open question). A revise round then writes the revision over
   * round one's files and commits on top, which pushes as a fast-forward; a rebuilt worktree would
   * start again from the target and could only reach the branch by force — which JaiRA never does.
   */
  private async materialize(row: RemoteHandleRow, repoDir: string, changeset: Changeset): Promise<string> {
    const dir = join(this.options.scratchDir, row.taskId, row.branch.split("/").pop() ?? "review");
    const repo = this.git(repoDir);
    const listed = await repo.listWorktrees();
    const resolved = resolve(dir);
    if (!listed.some((entry) => resolve(entry.path) === resolved)) {
      await mkdir(dirname(dir), { recursive: true });
      const local = `jaira-scratch/${row.taskId}/${row.key.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      await repo.addWorktree(dir, local, row.target);
    }
    const everything = changeset.changes.map((change) => ({ id: change.id, decision: "merged" as const }));
    for (const write of applyDecisions(changeset, everything, "base")) {
      const target = resolve(dir, write.path);
      if (target !== resolved && !target.startsWith(resolved + sep)) throw new RemoteRefusal(`'${write.path}' escapes the workspace root`);
      if (write.content === undefined) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, write.content, "utf8");
      if (write.mode !== undefined) await chmod(target, write.mode === "executable" ? 0o755 : 0o644).catch(() => undefined);
    }
    return dir;
  }

  async open(inputs: FunctionInputs, ctx: unknown): Promise<{ remote: JsonValue }> {
    const workspace = this.workspaceOf(inputs, ctx);
    let row = await this.rowFor(inputs, workspace);
    const provider = this.provider(row.host);
    if (row.number !== undefined) return { remote: this.valueOf(row) };
    if (row.pushedHead === undefined) {
      throw new RemoteRefusal(`nothing has been pushed to ${row.branch} yet — a ${FORGE_LABELS[row.provider].request} needs a branch; call remote_push first`);
    }
    await this.authorizePublish(row, workspace, provider);
    const { config } = remoteArg(inputs);
    const handle = await provider.open({
      host: row.host,
      project: row.project,
      branch: row.branch,
      target: row.target,
      title: text(config["title"]) ?? text(arg(inputs, "title")) ?? this.options.taskTitle ?? `Review ${this.options.taskId}`,
      description: text(config["description"]) ?? text(arg(inputs, "description")) ?? "",
      draft: (config["draft"] ?? arg(inputs, "draft")) === true,
    });
    row = this.options.handles.update(row.taskId, row.key, { number: handle.number, url: handle.url })!;
    return { remote: this.valueOf(row) };
  }

  /** A row whose request exists, or a sentence about why it does not. */
  private async opened(inputs: FunctionInputs, ctx: unknown): Promise<{ row: RemoteHandleRow; handle: RemoteHandle }> {
    const row = await this.rowFor(inputs, this.workspaceOf(inputs, ctx));
    const handle = handleOfRow(row);
    if (handle === undefined) throw new RemoteRefusal(`no ${FORGE_LABELS[row.provider].request} has been opened for ${row.branch} — call remote_open first`);
    return { row, handle };
  }

  async comment(inputs: FunctionInputs, ctx: unknown): Promise<Record<string, never>> {
    const { row, handle } = await this.opened(inputs, ctx);
    const body = text(arg(inputs, "body"));
    if (body === undefined) throw new RemoteRefusal("remote_comment needs a body");
    const provider = this.provider(row.host);
    const thread = text(arg(inputs, "thread"));
    if (thread !== undefined) {
      await provider.reply(handle, thread, body, arg(inputs, "resolve") === true);
      return {};
    }
    const anchor = record(arg(inputs, "anchor"));
    const placed: ForgeAnchor | undefined =
      typeof anchor["path"] === "string" && typeof anchor["line"] === "number"
        ? { path: anchor["path"], line: anchor["line"], side: anchor["side"] === "before" ? "before" : "after" }
        : undefined;
    await provider.comment(handle, body, placed);
    return {};
  }

  async merge(inputs: FunctionInputs, ctx: unknown): Promise<{ remote: JsonValue }> {
    const { row, handle } = await this.opened(inputs, ctx);
    const provider = this.provider(row.host);
    await provider.merge(handle);
    // What landed is the forge's to say: a squash or a merge commit is not the head that was pushed.
    const state = await provider.read(handle).catch(() => undefined);
    return { remote: { ...(this.valueOf(row) as Record<string, JsonValue>), ...(state?.mergeCommit !== undefined ? { head: state.mergeCommit } : {}) } };
  }

  async close(inputs: FunctionInputs, ctx: unknown): Promise<{ remote: JsonValue }> {
    const { row, handle } = await this.opened(inputs, ctx);
    await this.provider(row.host).close(handle);
    return { remote: this.valueOf(row) };
  }

  /**
   * Push and open in one step, for the gate — the same two primitives, the same publish question.
   * Returns the row, which by then says where the request lives.
   */
  async publish(inputs: FunctionInputs, ctx: unknown): Promise<RemoteHandleRow> {
    await this.push(inputs, ctx);
    await this.open(inputs, ctx);
    const { key } = remoteArg(inputs);
    return this.options.handles.get(this.options.taskId, key)!;
  }

  /** Reach the forge for a request this task already has — the gate's closing comment, its notes. */
  providerFor(row: RemoteHandleRow): ForgeProvider {
    return this.provider(row.host);
  }

  /**
   * After a remote merge, the forge's history IS the history (decision 0004).
   *
   * The reviewer may have squashed, rebased, or pushed a fixup of their own, so what landed is not
   * necessarily what was pushed, and nothing here tries to reconcile the two. In order:
   *
   *  1. `git fetch <to> <target>`.
   *  2. The task's worktree drops what it holds and moves to the fetched target. First the old tip —
   *     and a commit of any uncommitted drift, if the worktree was edited while the gate was parked —
   *     is kept under `refs/jaira/dropped/<task>/<n>`, so "drop" never destroys the only copy of
   *     anything.
   *  3. The local `<target>` is fast-forwarded, and ONLY fast-forwarded. Checked out somewhere with a
   *     dirty tree, or holding commits the forge does not, it is left alone and the report says so:
   *     JaiRA never merges or rebases a branch the person owns.
   *
   * A task with no worktree of its own runs in the person's checkout, on a branch that is theirs —
   * so step 2 is skipped there and said so, for the same reason step 3 is careful.
   */
  async adopt(row: RemoteHandleRow, workspace: string, isWorktree: boolean): Promise<AdoptReport> {
    const git = this.git(workspace);
    const upstream = `${row.remote}/${row.target}`;
    await git.run(["fetch", row.remote, row.target], { timeoutMs: 120_000 });
    const landed = (await git.revParse(upstream)) ?? "";
    const report: AdoptReport = { head: landed, reset: false, target: "left-alone" };

    if (isWorktree) {
      // Drift first, as a commit: what is kept under the ref has to include it.
      await git.run(["add", "-A", "--", ".", ":(exclude).jaira"]);
      if ((await git.tryRun(["diff", "--cached", "--quiet"])) === undefined) {
        await git.run(["commit", "-m", `jaira: work in ${row.taskId} that was not part of the merged request`]);
      }
      const tip = await git.head();
      if (tip !== undefined && tip !== landed) {
        const kept = ((await git.tryRun(["for-each-ref", "--format=%(refname)", `refs/jaira/dropped/${row.taskId}/`])) ?? "").split(/\r?\n/).filter((r) => r.length > 0).length;
        report.dropped = `refs/jaira/dropped/${row.taskId}/${kept + 1}`;
        await git.run(["update-ref", report.dropped, tip]);
      }
      await git.run(["reset", "--hard", upstream]);
      report.reset = true;
    } else {
      report.why = "this task has no worktree of its own, so the checkout it ran in was left as it is";
    }

    // The person's own `<target>`: fast-forward, or leave alone and say why.
    const local = await git.revParse(`refs/heads/${row.target}`);
    if (local === undefined) {
      report.target = "absent";
    } else if (local === landed) {
      report.target = "up-to-date";
    } else if ((await git.tryRun(["merge-base", "--is-ancestor", local, landed])) === undefined) {
      report.why = `your ${row.target} has commits ${upstream} does not, so it was left alone`;
    } else {
      const holder = (await git.listWorktrees()).find((entry) => entry.branch === row.target || entry.branch === `refs/heads/${row.target}`);
      if (holder === undefined) {
        await git.run(["update-ref", `refs/heads/${row.target}`, landed, local]);
        report.target = "fast-forwarded";
      } else if (resolve(holder.path) === resolve(workspace) && report.reset) {
        report.target = "up-to-date"; // the reset above already moved it
      } else {
        const there = this.git(holder.path);
        // Dirty means the PERSON's work. `.jaira/` is the recorder's own writing — task records, a
        // snapshot per run — and counting it would make a checked-out target look dirty almost
        // always, which would quietly turn "fast-forward when clean" into "never".
        const dirty = ((await there.tryRun(["status", "--porcelain", "--", ".", ":(exclude).jaira"])) ?? "x").length > 0;
        if (dirty) {
          report.why = `your ${row.target} is checked out with uncommitted changes, so it was left alone`;
        } else {
          await there.run(["merge", "--ff-only", landed]);
          report.target = "fast-forwarded";
        }
      }
    }
    return report;
  }

  /**
   * The handle as data. Before the request is opened it is the same object without `id`, `number`
   * and `url` — still enough for `remote_open` to find the row, here or across a task boundary.
   */
  private valueOf(row: RemoteHandleRow): JsonValue {
    const opened = handleOfRow(row);
    return {
      ...(opened ?? { provider: row.provider, host: row.host, project: row.project, branch: row.branch, target: row.target, head: row.pushedHead ?? "" }),
      key: row.key,
      remote: row.remote,
    } as unknown as JsonValue;
  }
}

/** Register the five primitives for ONE run — a registry is built per run, so the task is known. */
export function registerRemoteFunctions(registry: CapabilityRegistry<WorkflowMetrics>, options: RemoteOptions): RemotePrimitives {
  const primitives = new RemotePrimitives(options);
  const wrap = (name: string, run: (inputs: FunctionInputs, ctx: unknown) => Promise<unknown>) =>
    hostFunction(
      async (inputs: FunctionInputs, ctx: unknown): Promise<Result> => {
        try {
          return { value: (await run(inputs, ctx)) as ResolvedValue };
        } catch (e) {
          // A refusal is already a sentence for a person; anything else is named for where it came from.
          return { error: e instanceof RemoteRefusal ? failureOf(new Error(`${name}: ${e.message}`)) : failureOf(e, name) };
        }
      },
      // Outward-facing and not repeatable: never memoized, never read-only. Not `interactive` — the
      // one question a push may ask is `confirm_action`'s, parked through the hub like any gate.
      { interactive: false, readOnly: false, memoizable: false },
    );
  registry.functions.set(REMOTE_PUSH, wrap(REMOTE_PUSH, (i, c) => primitives.push(i, c)));
  registry.functions.set(REMOTE_OPEN, wrap(REMOTE_OPEN, (i, c) => primitives.open(i, c)));
  registry.functions.set(REMOTE_COMMENT, wrap(REMOTE_COMMENT, (i, c) => primitives.comment(i, c)));
  registry.functions.set(REMOTE_MERGE, wrap(REMOTE_MERGE, (i, c) => primitives.merge(i, c)));
  registry.functions.set(REMOTE_CLOSE, wrap(REMOTE_CLOSE, (i, c) => primitives.close(i, c)));
  return primitives;
}
