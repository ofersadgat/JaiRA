/**
 * Keeping a copy's ssh remote (decision 0027 §1, amended 2026-11-20): real git and the real ssh-keygen,
 * against a stand-in `ssh` and `ssh-keyscan` on the PATH. The stand-in is a host, `fakehost`, that
 * refuses a client whose known_hosts lacks it ("Host key verification failed.") and a key that is not in
 * its authorized list ("Permission denied (publickey)."), and otherwise serves the repository under
 * $FAKE_ROOT as git's own upload-pack.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExec } from "../src/exec";
import { checkSshKeys, fingerprintOf, hostKeysIn, httpsAddressOf, knownHostName, makeSshKeyFor, noKeyLetsIn, sshAddressOf, sshLadder, trustedHostKeys, type SshLadderOptions } from "../src/sshAccess";
import { packCheckout, unpackCheckout } from "../src/workspaceMake";

const exec = new NodeExec();
const REMOTE = "git@fakehost:org/repo.git";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyFakeHostKeyFakeHostKeyFake";

const FAKE_SSH = `#!/bin/sh
key=""
[ "$1" = "-G" ] && exit 0
while [ $# -gt 2 ]; do
  case "$1" in -i) key="$2"; shift 2;; -o|-p|-l) shift 2;; *) shift;; esac
done
cmd="$2"
[ -z "$cmd" ] && [ "$FAKE_TRUST" = "no" ] && { echo "Host key verification failed." >&2; exit 255; }
grep -q "^fakehost " "$HOME/.ssh/known_hosts" 2>/dev/null || { echo "Host key verification failed." >&2; exit 255; }
if [ -n "$key" ]; then
  blob=$(cut -d" " -f2 "$key.pub")
  grep -q "$blob" "$FAKE_AUTHORIZED" 2>/dev/null || { echo "git@fakehost: Permission denied (publickey)." >&2; exit 255; }
elif [ "$FAKE_AGENT" != "yes" ]; then
  echo "git@fakehost: Permission denied (publickey)." >&2; exit 255
fi
[ -z "$cmd" ] && { echo "Welcome to GitLab, @tester!" >&2; exit 0; }
cd "$FAKE_ROOT" && exec sh -c "git \${cmd#git-}"
`;
const FAKE_KEYSCAN = `#!/bin/sh
for last; do :; done
echo "# $last:22 SSH-2.0-Fake"
echo "$last ${HOST_KEY}"
`;

const made: string[] = [];
const saved = { ...process.env };
let home = "";
let root = "";
let authorized = "";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-ssh-"));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function keygen(path: string, passphrase = ""): void {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "test", "-f", path]);
}

/** A source checkout whose origin is `git@fakehost:org/repo.git`, served from $FAKE_ROOT. */
function source(): string {
  const seed = scratch();
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  mkdirSync(join(root, "org"), { recursive: true });
  git(root, "clone", "-q", "--bare", seed, join(root, "org", "repo.git"));
  git(seed, "remote", "add", "origin", REMOTE);
  git(seed, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(seed, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return seed;
}

function ladderOptions(over: Partial<SshLadderOptions> = {}): SshLadderOptions & { said: string[] } {
  const said: string[] = [];
  return { exec, home, platform: "darwin", say: (t) => said.push(t), vouched: () => Promise.resolve([HOST_KEY]), keyTitle: "JaiRA on test", settleMs: 1, said, ...over };
}

async function copy(options: SshLadderOptions): Promise<string> {
  const pack = await packCheckout(source(), { exec });
  const target = join(scratch(), "copy");
  await unpackCheckout(pack, target, { exec, onOutput: options.say, routes: (remote) => sshLadder(remote, options) });
  return target;
}

beforeEach(() => {
  const bin = scratch();
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  writeFileSync(join(bin, "ssh-keyscan"), FAKE_KEYSCAN);
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "ssh-keyscan"), 0o755);
  home = scratch();
  root = scratch();
  authorized = join(scratch(), "authorized");
  writeFileSync(authorized, "");
  Object.assign(process.env, { PATH: `${bin}:${saved["PATH"] ?? ""}`, HOME: home, FAKE_ROOT: root, FAKE_AUTHORIZED: authorized, FAKE_AGENT: "no" });
  delete process.env["GIT_SSH_COMMAND"];
  // Never the agent of the person running the suite.
  delete process.env["SSH_AUTH_SOCK"];
  delete process.env["GIT_SSH"];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("keeping a copy's ssh remote", () => {
  it("trusts a host it has never seen for the key the source vouches for, and clones over ssh as it is", async () => {
    process.env["FAKE_AGENT"] = "yes";
    const options = ladderOptions();
    const target = await copy(options);
    expect(git(target, "remote", "get-url", "origin")).toBe(REMOTE);
    expect(readFileSync(join(home, ".ssh", "known_hosts"), "utf8")).toBe(`fakehost ${HOST_KEY}\n`);
    expect(options.said.join("")).toContain("Added fakehost's host key to ~/.ssh/known_hosts");
  });

  it("does not trust a host key on first sight that nothing vouches for, or one that differs", async () => {
    const options = ladderOptions({ vouched: () => Promise.resolve(["ssh-ed25519 AAAAsomethingElse"]) });
    await expect(copy(options)).rejects.toThrow(/^Cloning failed: Host key verification failed\.$/);
    expect(existsSync(join(home, ".ssh", "known_hosts"))).toBe(false);
    expect(options.said.join("")).toContain("None of the host keys fakehost offers this machine is one the source trusts");
    const changed = sshLadder(REMOTE, ladderOptions());
    expect(await changed!.next("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.")).toBeUndefined();
  });

  it("tries the keys ssh was not offering, skipping one that needs its passphrase, and keeps the one that works", async () => {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "known_hosts"), `fakehost ${HOST_KEY}\n`);
    keygen(join(home, ".ssh", "a_locked"), "secret");
    keygen(join(home, ".ssh", "work"));
    appendFileSync(authorized, readFileSync(join(home, ".ssh", "work.pub"), "utf8"));
    const options = ladderOptions();
    const target = await copy(options);
    expect(git(target, "remote", "get-url", "origin")).toBe(REMOTE);
    expect(git(target, "config", "core.sshCommand")).toBe(`ssh -i "${join(home, ".ssh", "work")}" -o IdentitiesOnly=yes`);
    expect(git(target, "fetch", "-q", "origin")).toBe("");
    const said = options.said.join("");
    expect(said).toContain("~/.ssh/a_locked needs its passphrase");
    expect(said).toContain("Trying git@fakehost:org/repo.git again, with the key ~/.ssh/work, which ssh was not offering.");
  });

  it("makes a key and adds it to the account when no key here is let in", async () => {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "known_hosts"), `fakehost ${HOST_KEY}\n`);
    const added: { title: string; key: string }[] = [];
    const options = ladderOptions({
      connection: "the gitlab connection (glab)",
      addKey: (title, key) => {
        added.push({ title, key });
        appendFileSync(authorized, key);
        return Promise.resolve();
      },
    });
    const target = await copy(options);
    const key = join(home, ".ssh", "jaira_fakehost_ed25519");
    expect(added).toEqual([{ title: "JaiRA on test", key: readFileSync(`${key}.pub`, "utf8") }]);
    expect(git(target, "config", "core.sshCommand")).toBe(`ssh -i "${key}" -o IdentitiesOnly=yes`);
    expect(options.said.join("")).toContain('Added ~/.ssh/jaira_fakehost_ed25519.pub to your fakehost account as "JaiRA on test", through the gitlab connection (glab).');
  });

  it("gives up on ssh, saying why, when the account will not take a key", async () => {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "known_hosts"), `fakehost ${HOST_KEY}\n`);
    const options = ladderOptions({ addKey: () => Promise.reject(new Error("the sign-in lacks the api scope")) });
    await expect(copy(options)).rejects.toThrow(/Permission denied \(publickey\)/);
    expect(options.said.join("")).toContain("failed: the sign-in lacks the api scope");
  });

  it("carries the host keys the source trusts in its pack", async () => {
    const keys = scratch();
    keygen(join(keys, "host"));
    keygen(join(keys, "other"));
    const hostKey = readFileSync(join(keys, "host.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    const otherKey = readFileSync(join(keys, "other.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "known_hosts"), `fakehost ${hostKey}\nother ${otherKey}\n`);
    expect(await trustedHostKeys(REMOTE, exec)).toEqual([hostKey]);
    expect((await packCheckout(source(), { exec })).hostKeys).toEqual([hostKey]);
    expect(await trustedHostKeys("https://fakehost/org/repo.git", exec)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("which of this machine's keys let it in to a forge", () => {
  function keys(): { on: string; off: string; locked: string } {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "known_hosts"), `fakehost ${HOST_KEY}\n`);
    keygen(join(home, ".ssh", "on"));
    keygen(join(home, ".ssh", "off"));
    keygen(join(home, ".ssh", "locked"), "secret");
    const pub = (name: string): string => readFileSync(join(home, ".ssh", `${name}.pub`), "utf8").split(" ").slice(0, 2).join(" ");
    return { on: pub("on"), off: pub("off"), locked: pub("locked") };
  }

  it("asks the account's own list first: no ssh, and a key that needs its passphrase is still told", async () => {
    const k = keys();
    const found = await checkSshKeys({ exec, home, host: "fakehost", account: "@tester's account", provider: { sshKeys: () => Promise.resolve([k.on, k.locked]) } });
    expect(found.by).toBe("account");
    expect(found.keys.map((key) => [key.path, key.valid, key.detail])).toEqual([
      ["~/.ssh/locked", "yes", "on @tester's account"],
      ["~/.ssh/off", "no", "not on @tester's account"],
      ["~/.ssh/on", "yes", "on @tester's account"],
    ]);
    expect(found.keys[2]!.fingerprint).toBe(fingerprintOf(k.on.split(" ")[1]!));
    expect(noKeyLetsIn(found)).toBe(false);
  });

  it("signs in over ssh with each key where the list cannot be read, and says why some cannot be told", async () => {
    const k = keys();
    appendFileSync(authorized, `${k.on}\n`);
    const found = await checkSshKeys({ exec, home, host: "fakehost", provider: { sshKeys: () => Promise.reject(new Error("needs read:public_key")) } });
    expect(found.by).toBe("ssh");
    expect(found.note).toContain("needs read:public_key");
    expect(found.keys.map((key) => [key.path, key.valid, key.detail])).toEqual([
      ["~/.ssh/locked", "unknown", "needs its passphrase"],
      ["~/.ssh/off", "no", "ssh refuses it"],
      ["~/.ssh/on", "yes", "ssh signs in as @tester"],
    ]);
    process.env["FAKE_TRUST"] = "no";
    const untrusted = await checkSshKeys({ exec, home, host: "fakehost" });
    expect(untrusted.keys.find((key) => key.path === "~/.ssh/on")).toMatchObject({ valid: "unknown", detail: "this machine does not trust fakehost's host key yet" });
  });

  it("makes JaiRA's key once and adds it; a second call adds the same key again", async () => {
    const added: string[] = [];
    const addKey = (_title: string, key: string): Promise<void> => (added.push(key), Promise.resolve());
    const first = await makeSshKeyFor({ exec, home, host: "fakehost", title: "JaiRA on test", addKey });
    expect(first).toMatchObject({ ok: true, key: join(home, ".ssh", "jaira_fakehost_ed25519") });
    expect(first.detail).toBe('Made the ssh key ~/.ssh/jaira_fakehost_ed25519. Added ~/.ssh/jaira_fakehost_ed25519.pub to your fakehost account as "JaiRA on test", through its connection.');
    const second = await makeSshKeyFor({ exec, home, host: "fakehost", title: "JaiRA on test", addKey });
    expect(second.detail).not.toContain("Made");
    expect(added).toHaveLength(2);
    expect(added[0]).toBe(added[1]);
    const found = await checkSshKeys({ exec, home, host: "fakehost", provider: { sshKeys: () => Promise.resolve([]) } });
    expect(found.keys).toEqual([expect.objectContaining({ path: "~/.ssh/jaira_fakehost_ed25519", jaira: true, valid: "no" })]);
    expect(noKeyLetsIn(found)).toBe(true);
  });
});

describe("reading ssh addresses and host keys", () => {
  it("reads an ssh address apart, and its https form", () => {
    expect(sshAddressOf("git@gitlab.com:mistlabs/jaira.git")).toEqual({ user: "git", host: "gitlab.com", path: "mistlabs/jaira.git" });
    expect(knownHostName(sshAddressOf("ssh://git@gitlab.example.com:2222/group/repo.git")!)).toBe("[gitlab.example.com]:2222");
    expect(httpsAddressOf("git@gitlab.com:mistlabs/jaira.git")).toBe("https://gitlab.com/mistlabs/jaira.git");
    expect(httpsAddressOf("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toBe("https://gitlab.example.com/group/sub/repo.git");
    expect(httpsAddressOf("git+ssh://git@github.com/org/repo")).toBe("https://github.com/org/repo");
    for (const other of ["https://github.com/org/repo.git", "C:\\src\\repo", "/srv/git/repo.git"]) expect(sshAddressOf(other)).toBeUndefined();
  });

  it("reads host keys from known_hosts, ssh-keygen -F, ssh-keyscan and a forge's list alike", () => {
    const text = ["# Host gitlab.com found: line 3", "|1|abc=|def= ssh-ed25519 AAAA1", "@cert-authority *.example.com ssh-rsa AAAA2", "[h]:2222 ecdsa-sha2-nistp256 AAAA3 comment", "ssh-ed25519 AAAA4"].join("\n");
    expect(hostKeysIn(text)).toEqual(["ssh-ed25519 AAAA1", "ssh-rsa AAAA2", "ecdsa-sha2-nistp256 AAAA3", "ssh-ed25519 AAAA4"]);
  });
});
