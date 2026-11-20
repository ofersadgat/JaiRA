/**
 * Reaching a repository over ssh from a machine that has not reached it before — the copy of a folder
 * whose remote is the source machine's `git@gitlab.com:org/repo.git` (decision 0027 §1, amended
 * 2026-11-20, the person: "you should try to preserve an ssh checkout until you have no other option").
 *
 * The address works on the source with the keys it holds and the hosts it trusts. When it fails here,
 * in order, each only where the one before could not mend it:
 *
 * 1. **The host key.** A host this machine has never seen is trusted only for the keys a machine that
 *    already trusts it vouches for — the source's `known_hosts` (carried in the pack) and, for GitHub,
 *    the keys it publishes — matched against what the host offers now (`ssh-keyscan`), and written to
 *    this machine's `known_hosts`. A key that CHANGED from the one known here is never replaced.
 * 2. **Keys ssh is not offering.** On Windows, its own OpenSSH, which talks to the Windows ssh-agent that
 *    Git's bundled ssh cannot; then every private key in `~/.ssh` that needs no passphrase, each tried
 *    alone. A key that needs its passphrase is named, not asked about.
 * 3. **A new key.** An ed25519 key made at `~/.ssh/jaira_<host>_ed25519` and added to the account this
 *    machine's forge connection signs in as — through its token, or through `gh`/`glab` — and tried.
 *
 * The forge's own command line has no clone of its own to try: `gh repo clone` and `glab repo clone` run
 * `git clone` over ssh or https by their `git_protocol` setting, with no ssh credentials of their own.
 * What they add is the account, which step 3 uses. Past these, the caller falls back to https.
 *
 * A route that works with a key of its own leaves `core.sshCommand` in the copy, so its fetches and
 * pushes go the same way; nothing in the person's ssh config is changed.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ForgeSshKey, ForgeSshKeys } from "@jaira/shared";
import type { Exec, ExecOptions, ExecResult } from "./exec";

/** An ssh remote, read apart. */
export interface SshAddress {
  user?: string;
  host: string;
  /** ssh's port, when the address names one other than 22. */
  port?: number;
  path: string;
}

/**
 * `git@gitlab.com:org/repo.git` or `ssh://git@gitlab.com:2222/org/repo.git`, read apart; undefined for
 * any other address. A one-letter "host" is a Windows drive (`C:\src`), not a host.
 */
export function sshAddressOf(remote: string): SshAddress | undefined {
  const url = /^(?:git\+)?ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(remote);
  if (url !== null) {
    const port = url[3] !== undefined ? Number(url[3]) : undefined;
    return { ...(url[1] !== undefined ? { user: url[1] } : {}), host: url[2]!, ...(port !== undefined && port !== 22 ? { port } : {}), path: url[4]! };
  }
  const scp = /^(?:([^@/\\\s]+)@)?([^:/\\\s]{2,}):(?!\/)([^\\]+)$/.exec(remote);
  if (scp === null) return undefined;
  return { ...(scp[1] !== undefined ? { user: scp[1] } : {}), host: scp[2]!, path: scp[3]! };
}

/** The https address of a remote named for ssh (its port is ssh's and is dropped); undefined for any other. */
export function httpsAddressOf(remote: string): string | undefined {
  const address = sshAddressOf(remote);
  return address === undefined ? undefined : `https://${address.host}/${address.path.replace(/^\/+/, "")}`;
}

/** The name `known_hosts` keeps a host under: `gitlab.com`, or `[gitlab.example.com]:2222`. */
export function knownHostName(address: SshAddress): string {
  return address.port !== undefined ? `[${address.host}]:${String(address.port)}` : address.host;
}

/**
 * The keys in `known_hosts`-shaped text (`known_hosts` itself, `ssh-keygen -F`, `ssh-keyscan`, GitHub's
 * `/meta`), as `type blob`: comments and markers dropped, host names whether hashed or not.
 */
export function hostKeysIn(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0]?.startsWith("@") === true) fields.shift();
    // `host type blob` from a file; `type blob` alone from a forge's list.
    const at = /^(ssh-|ecdsa-|sk-)/.test(fields[0] ?? "") ? 0 : 1;
    const [type, blob] = [fields[at], fields[at + 1]];
    if (type !== undefined && blob !== undefined) keys.push(`${type} ${blob}`);
  }
  return keys;
}

/**
 * Run one of OpenSSH's tools. On Windows they are in System32's OpenSSH when that is installed, and
 * always beside Git for Windows' own ssh (`<git>/usr/bin`), which is where they are looked for when the
 * PATH has none.
 */
export async function runSshTool(exec: Exec, name: "ssh" | "ssh-add" | "ssh-keygen" | "ssh-keyscan", args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  try {
    return await exec.run(name, args, options);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const gitExec = (await exec.run("git", ["--exec-path"], { stdin: "" })).stdout.trim();
    const beside = resolve(gitExec, "..", "..", "..", "usr", "bin", `${name}.exe`);
    if (!existsSync(beside)) throw error;
    return exec.run(beside, args, options);
  }
}

/**
 * The keys this machine trusts for the host of an ssh `remote` (the source's side of step 1), from
 * `<home>/.ssh/known_hosts`; none when it is not ssh.
 */
export async function trustedHostKeys(remote: string | undefined, exec: Exec, home: string = process.env["HOME"] ?? homedir()): Promise<string[]> {
  const address = remote !== undefined ? sshAddressOf(remote) : undefined;
  const knownHosts = join(home, ".ssh", "known_hosts");
  if (address === undefined || !existsSync(knownHosts)) return [];
  try {
    const found = await runSshTool(exec, "ssh-keygen", ["-F", knownHostName(address), "-f", knownHosts], { stdin: "", timeoutMs: 10_000 });
    return found.code === 0 ? hostKeysIn(found.stdout) : [];
  } catch {
    return [];
  }
}

/** Another way to a remote from this machine: the address, git's environment for it, and the copy's config after. */
export interface RemoteRoute {
  url: string;
  env?: Record<string, string>;
  /** Set in the copy once it is cloned, so its fetches and pushes go the same way (`core.sshCommand`). */
  config?: Record<string, string>;
  /** How it gets there, after the address in a sentence: `with the key ~/.ssh/work`. */
  how: string;
}

/** The routes to try after a clone fails, one at a time: each is handed the failure of the one before. */
export interface RouteLadder {
  next(failure: string): Promise<RemoteRoute | undefined>;
}

export interface SshLadderOptions {
  exec: Exec;
  /** Whose `~/.ssh`: the home git's ssh reads. */
  home: string;
  platform?: NodeJS.Platform;
  say: (text: string) => void;
  /** The host keys machines this one trusts vouch for (`type blob`). Asked once, only when the host key is the failure. */
  vouched: () => Promise<string[]>;
  /** Add a public key to the account this machine's connection for the host signs in as; absent with no connection. */
  addKey?: (title: string, publicKey: string) => Promise<void>;
  /** The key's comment and its title on the account: `JaiRA on desktop-jlotc3r`. */
  keyTitle: string;
  /** The connection, in a sentence: `the gitlab connection`. */
  connection?: string;
  /** Why no key is made, when `addKey` is absent for a reason other than having no connection. */
  noKeyBecause?: string;
  abortSignal?: AbortSignal;
  /** Between tries of a key just added, which a forge may take a moment to honour. */
  settleMs?: number;
}

const HOST_KEY = /Host key verification failed|No \S* ?host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/i;
const REFUSED = /Permission denied|publickey|Could not read from remote repository|Too many authentication failures|could not be found or you don't have permission|Repository not found/i;
const WINDOWS_OPENSSH = "C:/Windows/System32/OpenSSH/ssh.exe";

/** A path as git's sh reads it in `GIT_SSH_COMMAND`: forward slashes, quoted. */
function quoted(path: string): string {
  return `"${path.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

/** `ssh -i "<key>" -o IdentitiesOnly=yes`: that key alone, as `core.sshCommand` keeps it. */
export function sshCommandFor(program: string, key?: string): string {
  return [program === "ssh" ? "ssh" : quoted(program), ...(key !== undefined ? ["-i", quoted(key), "-o", "IdentitiesOnly=yes"] : [])].join(" ");
}

/** The ladder for an ssh `remote`; undefined for any other address, which has no ssh to keep. */
export function sshLadder(remote: string, options: SshLadderOptions): RouteLadder | undefined {
  const address = sshAddressOf(remote);
  if (address === undefined) return undefined;
  const { exec, say } = options;
  const sshDir = join(options.home, ".ssh");
  const shown = (path: string): string => (path.startsWith(sshDir) ? `~/.ssh/${path.slice(sshDir.length + 1).replace(/\\/g, "/")}` : path);
  const name = knownHostName(address);
  let hostKeyTried = false;
  let keysTried = false;
  let newKeyTried = false;

  /** Whether git reaches the remote with this ssh command — a listing of its heads, never asked anything. */
  const reaches = async (command: string): Promise<{ ok: boolean; reason: string }> => {
    const result = await exec.run("git", ["ls-remote", "--heads", remote], {
      env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `${command} -o BatchMode=yes` },
      stdin: "",
      timeoutMs: 60_000,
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    });
    const said = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("Warning: Permanently added"));
    return { ok: result.code === 0, reason: said.find((l) => !/^fatal: Could not read from remote|^Please make sure|^and the repository exists/.test(l)) ?? said[0] ?? `git exited ${String(result.code)}` };
  };

  const route = (program: string, how: string, key?: string): RemoteRoute => {
    const command = sshCommandFor(program, key);
    return { url: remote, env: { GIT_SSH_COMMAND: `${command} -o BatchMode=yes` }, config: { "core.sshCommand": command }, how };
  };

  /** Step 1: trust the host's key, if a machine that trusts it already vouches for what it offers. */
  const trustHostKey = async (failure: string): Promise<RemoteRoute | undefined> => {
    if (HOST_KEY_CHANGED.test(failure)) {
      say(`The host key this machine knows for ${name} is not the one it offers now. It is left as it is: ssh is not tried further.\n`);
      return undefined;
    }
    const vouched = new Set(await options.vouched().catch(() => []));
    if (vouched.size === 0) {
      say(`This machine has never seen ${name}'s host key, and no machine it trusts vouches for one (the source's known_hosts names none), so it is not trusted on first sight.\n`);
      return undefined;
    }
    const scan = await runSshTool(exec, "ssh-keyscan", [...(address.port !== undefined ? ["-p", String(address.port)] : []), address.host], { stdin: "", timeoutMs: 20_000 }).catch(
      (error: Error) => ({ code: 1, stdout: "", stderr: error.message }) as Pick<ExecResult, "code" | "stdout" | "stderr">,
    );
    const offered = scan.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.startsWith("#"));
    const matching = offered.filter((line) => hostKeysIn(line).some((key) => vouched.has(key)));
    if (matching.length === 0) {
      say(
        offered.length === 0
          ? `${name} offered this machine no host key to compare (${scan.stderr.trim() || "ssh-keyscan found none"}).\n`
          : `None of the host keys ${name} offers this machine is one the source trusts; it is not trusted here.\n`,
      );
      return undefined;
    }
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    const knownHosts = join(sshDir, "known_hosts");
    const before = await readFile(knownHosts, "utf8").catch(() => "");
    await appendFile(knownHosts, `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}${matching.join("\n")}\n`, { mode: 0o600 });
    say(`Added ${name}'s host key to ${shown(knownHosts)}: it is the key the source machine already trusts.\n`);
    return { url: remote, how: `now that this machine trusts ${name}'s host key` };
  };

  /** Step 2: what this machine holds that ssh did not offer. */
  const tryKeys = async (): Promise<RemoteRoute | undefined> => {
    if ((options.platform ?? process.platform) === "win32" && existsSync(WINDOWS_OPENSSH)) {
      const tried = await reaches(sshCommandFor(WINDOWS_OPENSSH));
      if (tried.ok) return route(WINDOWS_OPENSSH, "through Windows' own OpenSSH and its ssh-agent");
      say(`Through Windows' own OpenSSH and its ssh-agent: ${tried.reason}\n`);
    }
    for (const key of await privateKeys()) {
      const usable = await runSshTool(exec, "ssh-keygen", ["-y", "-P", "", "-f", key], { stdin: "", timeoutMs: 10_000 }).catch(() => undefined);
      if (usable?.code !== 0) {
        say(`${shown(key)} needs its passphrase, which a job cannot ask for; it was not tried.\n`);
        continue;
      }
      const tried = await reaches(sshCommandFor("ssh", key));
      if (tried.ok) return route("ssh", `with the key ${shown(key)}, which ssh was not offering`, key);
      say(`With ${shown(key)}: ${tried.reason}\n`);
    }
    return undefined;
  };

  /** The private keys in `~/.ssh`: every file with a `.pub` beside it. */
  const privateKeys = async (): Promise<string[]> => {
    const names = await readdir(sshDir).catch(() => [] as string[]);
    const out: string[] = [];
    for (const file of names.sort()) {
      if (file.endsWith(".pub") || !names.includes(`${file}.pub`)) continue;
      const path = join(sshDir, file);
      if ((await stat(path).catch(() => undefined))?.isFile() === true) out.push(path);
    }
    return out;
  };

  /** Step 3: a key of JaiRA's own, added to the account the connection signs in as. */
  const newKey = async (): Promise<RemoteRoute | undefined> => {
    if (options.addKey === undefined) {
      say(`${options.noKeyBecause ?? `No connection here signs in to ${address.host}, so no key can be added to an account there.`}\n`);
      return undefined;
    }
    const made = await makeSshKeyFor({ exec, home: options.home, host: address.host, title: options.keyTitle, addKey: options.addKey, ...(options.connection !== undefined ? { connection: options.connection } : {}) });
    say(`${made.detail}\n`);
    if (!made.ok) return undefined;
    const key = made.key;
    let tried = { ok: false, reason: "" };
    for (let attempt = 0; attempt < 3 && !tried.ok; attempt++) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, options.settleMs ?? 3000));
      tried = await reaches(sshCommandFor("ssh", key));
    }
    if (tried.ok) return route("ssh", `with the new key ${shown(key)}`, key);
    say(`With the new key ${shown(key)}: ${tried.reason}\n`);
    return undefined;
  };

  return {
    async next(failure: string): Promise<RemoteRoute | undefined> {
      if (HOST_KEY.test(failure)) {
        if (hostKeyTried) return undefined;
        hostKeyTried = true;
        return trustHostKey(failure);
      }
      if (!REFUSED.test(failure)) return undefined;
      if (!keysTried) {
        keysTried = true;
        const found = await tryKeys();
        if (found !== undefined) return found;
      }
      if (!newKeyTried) {
        newKeyTried = true;
        return newKey();
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// This machine's keys, and whether they let it in to a forge (Settings → Connections → a forge)
// ---------------------------------------------------------------------------------------------

/** `~/.ssh/…` for a path under `home`'s `.ssh`, else the path. */
function shownPath(home: string, path: string): string {
  const sshDir = join(home, ".ssh");
  return path.startsWith(sshDir) ? `~/.ssh/${path.slice(sshDir.length + 1).replace(/\\/g, "/")}` : path;
}

/** The key JaiRA makes for a host: `~/.ssh/jaira_gitlab.com_ed25519`. */
export function jairaKeyPath(home: string, host: string): string {
  return join(home, ".ssh", `jaira_${host.replace(/[^\w.-]/g, "_")}_ed25519`);
}

/** `SHA256:…` for a key's base64 blob, as `ssh-keygen -l` prints it. */
export function fingerprintOf(blob: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** One of this machine's keys, read. */
export interface LocalSshKey {
  /** The private key's file; absent for a key only the agent holds. */
  file?: string;
  /** `type blob`. */
  publicKey: string;
  comment?: string;
  fingerprint: string;
  /** Its file needs a passphrase and the agent does not hold it: nothing here can use it unasked. */
  locked: boolean;
  /** The ssh-agent holds it. */
  inAgent: boolean;
}

/** The keys in `<home>/.ssh` (a private key with its `.pub` beside it) and the ones ssh-agent holds. */
export async function localSshKeys(exec: Exec, home: string): Promise<LocalSshKey[]> {
  const agent = await runSshTool(exec, "ssh-add", ["-L"], { stdin: "", timeoutMs: 5_000 }).catch(() => undefined);
  const agentKeys = new Map<string, string | undefined>();
  if (agent?.code === 0) {
    for (const line of agent.stdout.split(/\r?\n/)) {
      const [type, blob, ...comment] = line.trim().split(/\s+/);
      if (type !== undefined && blob !== undefined && /^(ssh-|ecdsa-|sk-)/.test(type)) agentKeys.set(`${type} ${blob}`, comment.join(" ") || undefined);
    }
  }
  const sshDir = join(home, ".ssh");
  const names = await readdir(sshDir).catch(() => [] as string[]);
  const out: LocalSshKey[] = [];
  for (const name of names.sort()) {
    if (name.endsWith(".pub") || !names.includes(`${name}.pub`)) continue;
    const file = join(sshDir, name);
    if ((await stat(file).catch(() => undefined))?.isFile() !== true) continue;
    const [type, blob, ...comment] = (await readFile(`${file}.pub`, "utf8").catch(() => "")).trim().split(/\s+/);
    if (type === undefined || blob === undefined || !/^(ssh-|ecdsa-|sk-)/.test(type)) continue;
    const publicKey = `${type} ${blob}`;
    const inAgent = agentKeys.has(publicKey);
    agentKeys.delete(publicKey);
    const open = inAgent ? undefined : await runSshTool(exec, "ssh-keygen", ["-y", "-P", "", "-f", file], { stdin: "", timeoutMs: 10_000 }).catch(() => undefined);
    out.push({ file, publicKey, ...(comment.length > 0 ? { comment: comment.join(" ") } : {}), fingerprint: fingerprintOf(blob), locked: !inAgent && open?.code !== 0, inAgent });
  }
  for (const [publicKey, comment] of agentKeys) {
    out.push({ publicKey, ...(comment !== undefined ? { comment } : {}), fingerprint: fingerprintOf(publicKey.split(" ")[1]!), locked: false, inAgent: true });
  }
  return out;
}

/** Who ssh signed in as, from the forge's greeting: GitHub's `Hi octo!`, GitLab's `Welcome to GitLab, @octo!`. */
function greetedAs(text: string): string | undefined {
  return /Hi ([^!\s]+)! You've successfully authenticated/.exec(text)?.[1] ?? /Welcome to GitLab, @([^!\s]+)!/.exec(text)?.[1];
}

export interface SshCheckOptions {
  exec: Exec;
  home: string;
  host: string;
  port?: number;
  /** The connection's provider: its `sshKeys` is asked first, which needs no ssh and no trusted host key. */
  provider?: { sshKeys?(): Promise<string[]> };
  /** Whose account, in a sentence: `@octo's account`. */
  account?: string;
}

/**
 * Which of this machine's keys let it in to `host`. The account's own list answers when the sign-in may
 * read it — no ssh, no host key needed; otherwise each key signs in over ssh (`ssh -T`), which needs the
 * host's key trusted here already.
 */
export async function checkSshKeys(options: SshCheckOptions): Promise<ForgeSshKeys> {
  const { exec, home, host } = options;
  const keys = await localSshKeys(exec, home);
  const account = options.account ?? "the account";
  const base = (key: LocalSshKey): Omit<ForgeSshKey, "valid" | "detail"> => ({
    path: key.file !== undefined ? shownPath(home, key.file) : "ssh-agent",
    fingerprint: key.fingerprint,
    ...(key.comment !== undefined ? { comment: key.comment } : {}),
    ...(key.file !== undefined && /[\\/]jaira_[^\\/]*$/.test(key.file) ? { jaira: true } : {}),
  });
  let listed: Set<string> | undefined;
  let note: string | undefined;
  if (options.provider?.sshKeys !== undefined) {
    try {
      listed = new Set(await options.provider.sshKeys());
    } catch (error) {
      note = `The account's keys could not be listed (${(error as Error).message}), so each key was tried over ssh.`;
    }
  }
  if (listed !== undefined) {
    const on = listed;
    return { by: "account", keys: keys.map((key) => ({ ...base(key), valid: on.has(key.publicKey) ? "yes" : "no", detail: on.has(key.publicKey) ? `on ${account}` : `not on ${account}` })) };
  }
  const out: ForgeSshKey[] = [];
  let untrusted = false;
  for (const key of keys) {
    if (key.file === undefined) {
      out.push({ ...base(key), valid: "unknown", detail: "held by ssh-agent alone; only the account's list can say" });
      continue;
    }
    if (key.locked) {
      out.push({ ...base(key), valid: "unknown", detail: "needs its passphrase" });
      continue;
    }
    const tried = await runSshTool(
      exec,
      "ssh",
      ["-T", "-i", key.file, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(options.port !== undefined ? ["-p", String(options.port)] : []), `git@${host}`],
      { stdin: "", timeoutMs: 20_000 },
    ).catch((error: Error) => ({ code: 255, stdout: "", stderr: error.message }) as Pick<ExecResult, "code" | "stdout" | "stderr">);
    const said = `${tried.stderr}\n${tried.stdout}`;
    const who = greetedAs(said);
    if (who !== undefined || tried.code === 0) out.push({ ...base(key), valid: "yes", detail: who !== undefined ? `ssh signs in as @${who}` : "ssh signs in with it" });
    else if (HOST_KEY.test(said)) {
      untrusted = true;
      out.push({ ...base(key), valid: "unknown", detail: `this machine does not trust ${host}'s host key yet` });
    } else if (/Permission denied/i.test(said)) out.push({ ...base(key), valid: "no", detail: "ssh refuses it" });
    else out.push({ ...base(key), valid: "unknown", detail: said.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? `ssh exited ${String(tried.code)}` });
  }
  const notes = [note, untrusted ? `This machine has never connected to ${host} over ssh, so its host key is not trusted here yet; opening a project from ${host} trusts it when another of your machines vouches for it.` : undefined].filter((n) => n !== undefined);
  return { by: "ssh", keys: out, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
}

/** Whether a check found no key that lets the machine in — every key answered `no`, or there is none. */
export function noKeyLetsIn(found: ForgeSshKeys): boolean {
  return found.keys.every((key) => key.valid === "no");
}

/**
 * Make JaiRA's key for `host` (once: an existing one is kept) and add it to the account `addKey` signs
 * in to. The answer's `detail` is the sentence to say either way.
 */
export async function makeSshKeyFor(options: {
  exec: Exec;
  home: string;
  host: string;
  /** The key's comment and its title on the account: `JaiRA on desktop-jlotc3r`. */
  title: string;
  addKey: (title: string, publicKey: string) => Promise<void>;
  /** The connection, in a sentence: `the gitlab connection (glab)`. */
  connection?: string;
}): Promise<{ ok: boolean; key: string; detail: string }> {
  const { exec, home, host, title } = options;
  const key = jairaKeyPath(home, host);
  const shown = shownPath(home, key);
  let made = "";
  if (!existsSync(key)) {
    await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    const result = await runSshTool(exec, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", title, "-f", key], { stdin: "", timeoutMs: 30_000 }).catch(
      (error: Error) => ({ code: 1, stdout: "", stderr: error.message }) as Pick<ExecResult, "code" | "stdout" | "stderr">,
    );
    if (result.code !== 0) return { ok: false, key, detail: `Making an ssh key failed: ${result.stderr.trim() || `ssh-keygen exited ${String(result.code)}`}` };
    made = `Made the ssh key ${shown}. `;
  }
  const through = options.connection ?? "its connection";
  try {
    await options.addKey(title, await readFile(`${key}.pub`, "utf8"));
  } catch (error) {
    return { ok: false, key, detail: `${made}Adding ${shown}.pub to your ${host} account through ${through} failed: ${(error as Error).message}` };
  }
  return { ok: true, key, detail: `${made}Added ${shown}.pub to your ${host} account as "${title}", through ${through}.` };
}
