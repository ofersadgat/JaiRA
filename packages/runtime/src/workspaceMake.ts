/**
 * Making a workspace's folder on this machine — the git half of Open's "how it gets there".
 *
 * - **From a forge:** {@link cloneRepository}, a `git clone` with the forge connection's credentials
 *   handed to git in its environment (never written into the remote URL or the config).
 * - **From a folder on another machine:** everything git does not ignore comes over AS IT IS — the
 *   branch, its commits whether pushed or not, the changes not committed (staged and not), and new
 *   files — and nothing git ignores does (`node_modules`, build output, the `.env` files: Bring picks
 *   those, the setup makes the rest). The source machine {@link packCheckout}s its folder; this
 *   machine {@link unpackCheckout}s it. Where the source has a remote, the history comes from the
 *   remote and only the commits the remote lacks travel between the machines, as a git bundle.
 * - **Bring:** {@link collectIgnored} reads the ignored files matching the setup's patterns on the
 *   machine that has them; {@link writeFiles} puts them in the new folder.
 *
 * Git is run directly on the machine (not inside WSL): these are file operations on its disk.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Exec, ExecOptions, ExecResult } from "./exec";
import { trustedHostKeys, type RemoteRoute, type RouteLadder } from "./sshAccess";

/** What a long git command says as it goes, line by line, for the person watching. */
export type MakeOutput = (text: string) => void;

export interface MakeOptions {
  exec: Exec;
  onOutput?: MakeOutput;
  abortSignal?: AbortSignal;
  /** Laid over git's environment: a forge's credentials ({@link pushCredentials}-style `GIT_CONFIG_*`). */
  env?: Record<string, string>;
}

export class MakeError extends Error {
  constructor(message: string, readonly result?: ExecResult) {
    super(message);
  }
}

async function git(args: string[], cwd: string | undefined, options: MakeOptions, extra: Partial<ExecOptions> = {}): Promise<ExecResult> {
  const env = { GIT_TERMINAL_PROMPT: "0", ...(options.env ?? {}), ...(extra.env ?? {}) };
  const result = await options.exec.run("git", args, {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    stdin: "",
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    ...(extra.onOutput !== undefined ? { onOutput: extra.onOutput } : {}),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return result;
}

async function gitOk(args: string[], cwd: string | undefined, options: MakeOptions, what: string, extra: Partial<ExecOptions> = {}): Promise<string> {
  const result = await git(args, cwd, options, extra);
  if (result.aborted) throw new MakeError(`Stopped while ${what}.`, result);
  if (result.code !== 0) throw new MakeError(`${what[0]!.toUpperCase()}${what.slice(1)} failed: ${reasonOf(result.stderr || result.stdout) ?? `git exited ${String(result.code)}`}`, result);
  return result.stdout;
}

/** What git says it said beside the reason: the step it began, its progress, and the advice it closes with. */
const NOT_A_REASON = [/^Cloning into /, /^warning: /, /\d+%/, /^Please make sure you have the correct access rights$/, /^and the repository exists\.$/];

/**
 * Why git failed, in its own first line that says so. `Host key verification failed.` comes before
 * `fatal: Could not read from remote repository.` and the advice after it, and the advice's last line,
 * `and the repository exists.`, is no reason at all.
 */
function reasonOf(text: string): string | undefined {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => !NOT_A_REASON.some((rx) => rx.test(line))) ?? lines.pop();
}

/** Lines git prints while it works (`Receiving objects: 45%`), passed on as they come. */
function streaming(options: MakeOptions): Partial<ExecOptions> {
  if (options.onOutput === undefined) return {};
  const say = options.onOutput;
  return { onOutput: (_stream, chunk) => say(chunk) };
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// From a forge
// ---------------------------------------------------------------------------------------------

/** `git clone` `url` into `dir` (which must be missing or empty), at `branch` when given. */
export async function cloneRepository(request: { url: string; dir: string; branch?: string }, options: MakeOptions): Promise<void> {
  if (!(await isEmptyOrMissing(request.dir))) throw new MakeError(`${request.dir} is already there and not empty.`);
  await mkdir(dirname(request.dir), { recursive: true });
  options.onOutput?.(`$ git clone ${request.branch !== undefined ? `--branch ${request.branch} ` : ""}${request.url} ${request.dir}\n`);
  await gitOk(["clone", "--progress", ...(request.branch !== undefined ? ["--branch", request.branch] : []), request.url, request.dir], undefined, options, "cloning", {
    ...streaming(options),
  });
}

// ---------------------------------------------------------------------------------------------
// A folder on another machine, as it is
// ---------------------------------------------------------------------------------------------

/** The git state of a checkout, as Open describes the folder it would copy. */
export interface CheckoutState {
  /** The remote a clone would fetch from: `upstream` over `origin`, else the first. */
  remote?: string;
  remoteName?: string;
  /** The branch checked out; absent on a detached HEAD. */
  branch?: string;
  head: string;
  /** `origin/main`: the branch's upstream, when it has one. */
  upstream?: string;
  /** Commits the remote does not have. */
  ahead: number;
  /** Files changed and not committed (staged or not). */
  changed: number;
  /** New files git does not ignore. */
  untracked: number;
}

/** Read a checkout's git state — nothing is changed. */
export async function checkoutState(dir: string, options: MakeOptions): Promise<CheckoutState> {
  const out = (args: string[]): Promise<string | undefined> =>
    git(args, dir, options).then((r) => (r.code === 0 ? r.stdout.trim() : undefined));
  const head = await out(["rev-parse", "HEAD"]);
  if (head === undefined) throw new MakeError(`${dir} is not a git checkout with a commit.`);
  const remotes = ((await out(["remote"])) ?? "").split(/\r?\n/).filter((r) => r.length > 0);
  const remoteName = remotes.includes("upstream") ? "upstream" : remotes.includes("origin") ? "origin" : remotes[0];
  const remote = remoteName !== undefined ? await out(["remote", "get-url", remoteName]) : undefined;
  const branchName = await out(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const upstream = branchName !== undefined ? await out(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) : undefined;
  const aheadText =
    upstream !== undefined
      ? await out(["rev-list", "--count", `${upstream}..HEAD`])
      : remotes.length > 0
        ? await out(["rev-list", "--count", "HEAD", "--not", "--remotes"])
        : await out(["rev-list", "--count", "HEAD"]);
  const status = (await out(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) ?? "";
  let changed = 0;
  let untracked = 0;
  for (const entry of status.split("\0")) {
    if (entry.length < 3) continue;
    if (entry.startsWith("??")) untracked++;
    else changed++;
  }
  return {
    ...(remote !== undefined ? { remote, remoteName: remoteName! } : {}),
    ...(branchName !== undefined ? { branch: branchName } : {}),
    head,
    ...(upstream !== undefined ? { upstream } : {}),
    ahead: Number(aheadText ?? "0") || 0,
    changed,
    untracked,
  };
}

/** A checkout packed to travel: what git does not ignore, and the commits the remote lacks. */
export interface CheckoutPack {
  format: 1;
  state: CheckoutState;
  /** A git bundle (base64) of the commits the remote lacks — or of everything, with `bundleAll`, where there is no remote. */
  bundle?: string;
  bundleAll?: boolean;
  /** `git diff --binary --cached`: what is staged. */
  staged?: string;
  /** `git diff --binary`: what is changed and not staged. */
  unstaged?: string;
  /** New files git does not ignore, base64, with their modes. */
  untracked: { path: string; data: string; mode: number }[];
  bytes: number;
  /**
   * The host keys the source trusts for its remote's ssh host (`type blob`, from its `known_hosts`) —
   * public, and what lets a machine that has never seen the host trust it (`sshLadder`).
   */
  hostKeys?: string[];
}

/** The most a pack may weigh: past this a folder is not something to send through the engine link. */
export const PACK_LIMIT_BYTES = 512 * 1024 * 1024;

/** Pack the checkout at `dir` (this machine is the source). Nothing in it changes. */
export async function packCheckout(dir: string, options: MakeOptions): Promise<CheckoutPack> {
  const state = await checkoutState(dir, options);
  const hostKeys = await trustedHostKeys(state.remote, options.exec);
  const pack: CheckoutPack = { format: 1, state, untracked: [], bytes: 0, ...(hostKeys.length > 0 ? { hostKeys } : {}) };
  const scratch = await mkdtemp(join(tmpdir(), "jaira-pack-"));
  try {
    const bundleFile = join(scratch, "commits.bundle");
    const ref = state.branch !== undefined ? state.branch : "HEAD";
    let made = false;
    if (state.remote === undefined) {
      await gitOk(["bundle", "create", bundleFile, "--all"], dir, options, "packing the commits");
      pack.bundleAll = true;
      made = true;
    } else if (state.ahead > 0) {
      const not = state.upstream !== undefined ? [`^${state.upstream}`] : ["--not", "--remotes"];
      await gitOk(["bundle", "create", bundleFile, ref, ...not], dir, options, "packing the commits the remote lacks");
      made = true;
    }
    if (made) pack.bundle = (await readFile(bundleFile)).toString("base64");
    const staged = await gitOk(["diff", "--binary", "--cached"], dir, options, "reading the staged changes");
    const unstaged = await gitOk(["diff", "--binary"], dir, options, "reading the changes");
    if (staged.length > 0) pack.staged = staged;
    if (unstaged.length > 0) pack.unstaged = unstaged;
    const listed = await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], dir, options, "listing the new files");
    let bytes = (pack.bundle?.length ?? 0) + staged.length + unstaged.length;
    for (const path of listed.split("\0").filter((p) => p.length > 0)) {
      const file = join(dir, path);
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      const data = (await readFile(file)).toString("base64");
      bytes += data.length;
      if (bytes > PACK_LIMIT_BYTES) throw new MakeError(`The folder's new files come to more than ${PACK_LIMIT_BYTES / 1024 / 1024} MB; commit or ignore the large ones first.`);
      pack.untracked.push({ path: path.split(sep).join("/"), data, mode: info.mode & 0o777 });
    }
    pack.bytes = bytes;
    return pack;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Make `dir` from a pack (this machine is the target): the same branch, commits, changes and new files.
 *
 * The history comes from the source's remote as the source names it. That name is the source's: an ssh
 * address works there with its keys and the hosts it trusts, and this machine may have neither. When the
 * clone fails, `routes` is asked, failure by failure, for another way to the same repository (`sshLadder`,
 * then its https address); a route that works is kept in the copy (its remote, its `core.sshCommand`).
 */
export async function unpackCheckout(
  pack: CheckoutPack,
  dir: string,
  options: MakeOptions & { routes?: (remote: string) => RouteLadder | undefined },
): Promise<void> {
  if (!(await isEmptyOrMissing(dir))) throw new MakeError(`${dir} is already there and not empty.`);
  const { state } = pack;
  const scratch = await mkdtemp(join(tmpdir(), "jaira-unpack-"));
  const say = options.onOutput;
  try {
    const bundleFile = join(scratch, "commits.bundle");
    if (pack.bundle !== undefined) await writeFile(bundleFile, Buffer.from(pack.bundle, "base64"));
    await mkdir(dirname(dir), { recursive: true });
    if (state.remote === undefined || pack.bundleAll === true) {
      say?.("$ git clone <the copied commits>\n");
      await gitOk(["clone", "--progress", bundleFile, dir], undefined, options, "making the folder from the copied commits", streaming(options));
      await git(["remote", "remove", "origin"], dir, options);
      if (state.branch !== undefined) await gitOk(["checkout", state.branch], dir, options, `switching to ${state.branch}`);
    } else {
      const upstreamBranch = state.upstream?.replace(/^[^/]+\//, "");
      const clone = (url: string, env?: Record<string, string>): Promise<string> => {
        say?.(`$ git clone ${upstreamBranch !== undefined ? `--branch ${upstreamBranch} ` : ""}${url} ${dir}\n`);
        const args = ["clone", "--progress", ...(upstreamBranch !== undefined ? ["--branch", upstreamBranch] : []), url, dir];
        return gitOk(args, undefined, env !== undefined ? { ...options, env: { ...(options.env ?? {}), ...env } } : options, "cloning", streaming(options));
      };
      const ladder = options.routes?.(state.remote);
      let attempt: RemoteRoute | undefined;
      const failures: string[] = [];
      for (let tries = 0; ; tries++) {
        try {
          await clone(attempt?.url ?? state.remote, attempt?.env);
          break;
        } catch (error) {
          if (!(error instanceof MakeError) || error.result === undefined || error.result.aborted || ladder === undefined) throw error;
          failures.push(attempt === undefined ? error.message : `${attempt.url} ${attempt.how} failed too: ${error.message.replace(/^Cloning failed: /, "")}`);
          if (attempt === undefined) say?.(`${state.remote} cannot be reached from this machine as the source names it (${error.message.replace(/^Cloning failed: /, "")})\n`);
          const next = tries < 8 ? await ladder.next(`${error.result.stderr}\n${error.result.stdout}`) : undefined;
          if (next === undefined) throw new MakeError(failures.join(" "), error.result);
          say?.(next.url === state.remote ? `Trying ${next.url} again, ${next.how}.\n` : `Cloning ${next.url} ${next.how} instead.\n`);
          attempt = next;
        }
      }
      for (const [key, value] of Object.entries(attempt?.config ?? {})) await gitOk(["config", key, value], dir, options, `setting ${key}`);
      const branch = state.branch;
      if (pack.bundle !== undefined) {
        say?.("$ git fetch <the commits not pushed>\n");
        await gitOk(["fetch", bundleFile, branch ?? "HEAD"], dir, options, "adding the commits not pushed");
        await gitOk(["checkout", "-B", branch ?? "jaira-copied", "FETCH_HEAD"], dir, options, "switching to the copied branch");
      } else if (branch !== undefined && branch !== upstreamBranch) {
        await gitOk(["checkout", "-B", branch, state.upstream ?? "HEAD"], dir, options, `switching to ${branch}`);
      }
      if (branch !== undefined && upstreamBranch !== undefined) await git(["branch", `--set-upstream-to=origin/${upstreamBranch}`, branch], dir, options);
    }
    const head = (await git(["rev-parse", "HEAD"], dir, options)).stdout.trim();
    if (head !== state.head) say?.(`The copy is at ${head.slice(0, 9)}, not ${state.head.slice(0, 9)} as on the source.\n`);
    for (const [patch, index] of [
      [pack.staged, true],
      [pack.unstaged, false],
    ] as const) {
      if (patch === undefined) continue;
      const file = join(scratch, index ? "staged.patch" : "unstaged.patch");
      await writeFile(file, patch);
      await gitOk(["apply", "--binary", ...(index ? ["--index"] : []), file], dir, options, index ? "putting back the staged changes" : "putting back the changes");
    }
    await writeFiles(dir, pack.untracked);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Bring: files git ignores
// ---------------------------------------------------------------------------------------------

/** A file read to travel: its path from the workspace root, its content (base64) and mode. */
export interface CarriedFile {
  path: string;
  data: string;
  mode: number;
}

/** The most Bring carries in one go — these are `.env` files, not build output. */
export const BRING_LIMIT_BYTES = 50 * 1024 * 1024;

/** A gitignore-style pattern as a test on a path: one without a `/` matches a name at any depth. */
export function patternTest(pattern: string): (path: string) => boolean {
  const anchored = pattern.includes("/");
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*") {
      if (body[i + 1] === "*") {
        re += ".*";
        i++;
        if (body[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  return (path) => (anchored ? rx.test(path) : rx.test(path.split("/").pop()!));
}

/** The files git ignores at `dir` that match `patterns`, read to travel. */
export async function collectIgnored(dir: string, patterns: readonly string[], options: MakeOptions): Promise<CarriedFile[]> {
  const tests = patterns.map(patternTest);
  const matches = (path: string): boolean => tests.some((t) => t(path));
  const listed = await gitOk(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], dir, options, "listing the files git ignores");
  const paths: string[] = [];
  for (const entry of listed.split("\0").filter((p) => p.length > 0)) {
    if (!entry.endsWith("/")) {
      if (matches(entry)) paths.push(entry);
      continue;
    }
    // A whole folder git ignores: only walked when a pattern could reach inside it.
    const folder = entry.replace(/\/$/, "");
    if (!patterns.some((p) => p.replace(/^\//, "").startsWith(`${folder}/`) || p.startsWith("**/"))) continue;
    for (const path of await walk(join(dir, folder), dir)) if (matches(path)) paths.push(path);
  }
  const out: CarriedFile[] = [];
  let bytes = 0;
  for (const path of paths.sort()) {
    const file = join(dir, path);
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    bytes += info.size;
    if (bytes > BRING_LIMIT_BYTES) throw new MakeError(`The files to bring come to more than ${BRING_LIMIT_BYTES / 1024 / 1024} MB; narrow the patterns.`);
    out.push({ path, data: (await readFile(file)).toString("base64"), mode: info.mode & 0o777 });
  }
  return out;
}

async function walk(folder: string, root: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root, depth + 1)));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Write carried files under `dir`, making their folders; an existing file is replaced. */
export async function writeFiles(dir: string, files: readonly CarriedFile[]): Promise<void> {
  for (const file of files) {
    if (file.path.split("/").some((part) => part === ".." || part === "") || file.path.startsWith("/")) throw new MakeError(`Refusing to write ${file.path} outside the folder.`);
    const target = join(dir, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.data, "base64"));
    if (process.platform !== "win32") await chmod(target, file.mode || 0o644);
  }
}

/** The texts of the files Open reads before choosing how a folder gets set up (`.jaira/setup.json`, lockfiles, …). */
export async function readCheckoutFiles(dir: string, paths: readonly string[], textFor: (path: string) => boolean): Promise<Record<string, string | true>> {
  const out: Record<string, string | true> = {};
  for (const path of paths) {
    const file = join(dir, ...path.split("/"));
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    out[path] = textFor(path) && info.size < 1024 * 1024 ? await readFile(file, "utf8") : true;
  }
  return out;
}
