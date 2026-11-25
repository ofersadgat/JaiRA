/**
 * Where the agents JaiRA signs in keep their sign-ins (decision 0026 §4): Claude Code in the macOS
 * keychain or `~/.claude/.credentials.json`, Codex in `~/.codex/auth.json` — read, written and removed
 * so a sign-in can follow the person to their other machines.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_KEYCHAIN_SERVICE, loginStateOf, macKeychainLogin, nativeAgentLogins, watchAgentLogins, type AgentLoginStore, type LoginChange, type WslRun } from "@jaira/service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "jaira-logins-"));
  dirs.push(dir);
  return dir;
};

describe("an agent's sign-in kept in a file", () => {
  it("is Claude Code's .credentials.json off a Mac and Codex's auth.json, each moved by its own variable", () => {
    const dir = home();
    const [claude, codex] = nativeAgentLogins({ platform: "linux", home: dir, env: { CODEX_HOME: join(dir, "elsewhere") } });
    expect([claude!.agent, codex!.agent]).toEqual(["claude-cli", "codex-cli"]);
    expect(claude!.read()).toBeUndefined();
    claude!.write('{"claudeAiOauth":{}}');
    codex!.write('{"tokens":{}}');
    expect(readFileSync(join(dir, ".claude", ".credentials.json"), "utf8")).toBe('{"claudeAiOauth":{}}');
    expect(readFileSync(join(dir, "elsewhere", "auth.json"), "utf8")).toBe('{"tokens":{}}');
    // Readable by its owner alone.
    if (process.platform !== "win32") expect(statSync(join(dir, ".claude", ".credentials.json")).mode & 0o777).toBe(0o600);
    expect(claude!.read()).toMatchObject({ value: '{"claudeAiOauth":{}}', at: expect.any(Number) });
    claude!.remove();
    expect(claude!.read()).toBeUndefined();
  });

});

describe("what a stored sign-in holds", () => {
  const now = 1_800_000_000_000;
  it("reads Claude Code's: a live refresh or access token is usable, and the account is its accountUuid", () => {
    expect(loginStateOf("claude-cli", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1,"refreshToken":"r","refreshTokenExpiresAt":1900000000000,"accountUuid":"u1"}}', now)).toEqual({ usable: true, account: "u1" });
    expect(loginStateOf("claude-cli", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1900000000000}}', now)).toEqual({ usable: true });
    // Both expired.
    expect(loginStateOf("claude-cli", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1,"refreshToken":"r","refreshTokenExpiresAt":2,"accountUuid":"u1"}}', now)).toEqual({ usable: false, account: "u1" });
    // Seen 2026-11-19 on Windows, after a refused refresh: tokens emptied, the account kept.
    expect(loginStateOf("claude-cli", '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"refreshTokenExpiresAt":1797485146918,"subscriptionType":"max","accountUuid":"8b3e"}}', now)).toEqual({ usable: false, account: "8b3e" });
    expect(loginStateOf("claude-cli", '{"mcpOAuth":{}}', now)).toEqual({ usable: false });
    expect(loginStateOf("claude-cli", "not json", now)).toEqual({ usable: false });
  });

  it("reads Codex's: a key, a refresh or an access token is usable, and the account is its account_id", () => {
    expect(loginStateOf("codex-cli", '{"OPENAI_API_KEY":null,"tokens":{"access_token":"a","refresh_token":"r","account_id":"acct"}}', now)).toEqual({ usable: true, account: "acct" });
    expect(loginStateOf("codex-cli", '{"OPENAI_API_KEY":"sk-1"}', now)).toEqual({ usable: true });
    expect(loginStateOf("codex-cli", '{"OPENAI_API_KEY":null,"tokens":{"access_token":"","refresh_token":"","account_id":"acct"}}', now)).toEqual({ usable: false, account: "acct" });
  });

  it("passes on an agent it does not know as it is", () => {
    expect(loginStateOf("gemini-cli", "anything", now)).toEqual({ usable: true });
  });
});

describe("an agent's sign-in inside the WSL distro the agents run in", () => {
  /**
   * A stand-in for `wsl.exe`: one distro, `Ubuntu`, whose home is a folder here. A command for the distro
   * runs the real `sh` script against that home (GNU `stat -c %Y` said the BSD way on a Mac).
   */
  function wsl(linuxHome: string, opts: { running?: boolean; env?: Record<string, string> } = {}): { run: WslRun; calls: Array<{ args: string[]; input?: string }> } {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: WslRun = (args, input) => {
      calls.push({ args, ...(input !== undefined ? { input } : {}) });
      if (args[0] === "--list") return { status: 0, stdout: opts.running === false ? "Debian\n" : "Debian\nUbuntu\n" };
      expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "-e", "sh", "-c"]);
      const script = process.platform === "darwin" ? args[5]!.replace("stat -c %Y", "stat -f %m") : args[5]!;
      try {
        const stdout = execFileSync("sh", ["-c", script], { env: { PATH: process.env["PATH"] ?? "", HOME: linuxHome, ...opts.env }, ...(input !== undefined ? { input } : {}), encoding: "utf8" });
        return { status: 0, stdout };
      } catch (e) {
        return { status: (e as { status?: number }).status ?? -1, stdout: String((e as { stdout?: unknown }).stdout ?? "") };
      }
    };
    return { run, calls };
  }

  it("is read and written in the distro's home, the value on standard input, never on a command line", () => {
    const linux = home();
    const { run, calls } = wsl(linux);
    const [claude, codex] = nativeAgentLogins({ platform: "win32", home: home(), wsl: () => "Ubuntu", runWsl: run });
    expect(claude!.where?.()).toBe("inside Ubuntu (WSL)");
    expect(claude!.read()).toBeUndefined();
    claude!.write('{"claudeAiOauth":{"accessToken":"w1"}}');
    codex!.write('{"tokens":{}}');
    expect(readFileSync(join(linux, ".claude", ".credentials.json"), "utf8")).toBe('{"claudeAiOauth":{"accessToken":"w1"}}');
    // Windows keeps no Unix mode for a file the fake distro wrote: the mode is a Linux host's to check.
    if (process.platform !== "win32") expect(statSync(join(linux, ".claude", ".credentials.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(linux, ".codex", "auth.json"), "utf8")).toBe('{"tokens":{}}');
    expect(calls.filter((c) => c.input !== undefined).every((c) => !c.args.join(" ").includes("w1"))).toBe(true);
    expect(claude!.read()).toEqual({ value: '{"claudeAiOauth":{"accessToken":"w1"}}', at: expect.any(Number) });
    expect(claude!.read()!.at).toBeGreaterThan(Date.now() - 60_000);
    claude!.remove();
    expect(existsSync(join(linux, ".claude", ".credentials.json"))).toBe(false);
  });

  it("follows the distro's own CODEX_HOME", () => {
    const linux = home();
    const { run } = wsl(linux, { env: { CODEX_HOME: join(linux, "codex-elsewhere") } });
    const [, codex] = nativeAgentLogins({ platform: "win32", home: home(), wsl: () => "Ubuntu", runWsl: run });
    codex!.write("{}");
    expect(existsSync(join(linux, "codex-elsewhere", "auth.json"))).toBe(true);
  });

  it("does not start a stopped distro to look, but is read here again once the agents run here", () => {
    const linux = home();
    const windows = home();
    const { run, calls } = wsl(linux, { running: false });
    let distro: string | undefined = "Ubuntu";
    const [claude] = nativeAgentLogins({ platform: "win32", home: windows, wsl: () => distro, runWsl: run });
    expect(claude!.read()).toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual(["--list"]);
    distro = undefined;
    claude!.write("{}");
    expect(existsSync(join(windows, ".claude", ".credentials.json"))).toBe(true);
    expect(claude!.where?.()).toBeUndefined();
  });

  it("is not looked for in WSL off Windows", () => {
    const { run, calls } = wsl(home());
    const [claude] = nativeAgentLogins({ platform: "linux", home: home(), wsl: () => "Ubuntu", runWsl: run });
    expect(claude!.read()).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("Claude Code's sign-in in the macOS keychain", () => {
  type Call = { args: string[]; input?: string };
  const fake = (answers: { value?: string; status?: number; attributes?: string }) => {
    const calls: Call[] = [];
    const run = ((_cmd: string, args: string[], opts?: { input?: string }) => {
      calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
      if (args[0] === "find-generic-password" && args.includes("-w")) {
        if (answers.value === undefined) throw Object.assign(new Error("not found"), { status: answers.status ?? 44 });
        return `${answers.value}\n`;
      }
      if (args[0] === "find-generic-password") return answers.attributes ?? "";
      return "";
    }) as never;
    return { calls, run };
  };

  it("reads the item and when it was written", () => {
    const { run } = fake({ value: '{"claudeAiOauth":{"accessToken":"x"}}', attributes: '    "mdat"<timedate>=0x3230 "20261117014400Z\\000"\n' });
    const store = macKeychainLogin("claude-cli", CLAUDE_KEYCHAIN_SERVICE, "me", undefined, run);
    expect(store.read()).toEqual({ value: '{"claudeAiOauth":{"accessToken":"x"}}', at: Date.UTC(2026, 10, 17, 1, 44, 0) });
  });

  it("writes it as hex through security's standard input, never on a command line", () => {
    const { calls, run } = fake({});
    macKeychainLogin("claude-cli", CLAUDE_KEYCHAIN_SERVICE, "me", undefined, run).write('{"a":1}');
    expect(calls).toEqual([{ args: ["-i"], input: `add-generic-password -U -a "me" -s "Claude Code-credentials" -X ${Buffer.from('{"a":1}').toString("hex")}\n` }]);
  });

  it("is signed out when the item is not there, and stops asking when the keychain says no", () => {
    const missing = macKeychainLogin("claude-cli", CLAUDE_KEYCHAIN_SERVICE, "me", undefined, fake({ status: 44 }).run);
    expect(missing.read()).toBeUndefined();
    expect(missing.unavailable()).toBeUndefined();
    const refused = macKeychainLogin("claude-cli", CLAUDE_KEYCHAIN_SERVICE, "me", undefined, fake({ status: 51 }).run);
    expect(refused.read()).toBeUndefined();
    expect(refused.unavailable()).toMatch(/keychain did not let JaiRA read/);
  });
});

describe("a sign-in changed outside JaiRA", () => {
  const live = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1, accountUuid: "acct" } });
  // What Claude Code leaves after a refused renewal: both tokens emptied, the account kept.
  const wiped = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, accountUuid: "acct" } });

  it("is reported when the file is wiped or signed in again, and not on the first look or while it stays the same", () => {
    const dir = home();
    const [claude] = nativeAgentLogins({ platform: "linux", home: dir, env: {} });
    claude!.write(live);
    const changes: LoginChange[] = [];
    const watch = watchAgentLogins(() => [claude!], (change) => changes.push(change), { everyMs: 60_000 });
    try {
      watch.check();
      watch.check();
      expect(changes).toEqual([]);
      // Written a little later, so the time on the file moves even where it is coarse.
      const file = join(dir, ".claude", ".credentials.json");
      claude!.write(wiped);
      utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
      watch.check();
      expect(changes).toEqual([{ agent: "claude-cli", usable: false }]);
      // `claude auth login` in a terminal.
      claude!.write(live);
      utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      watch.check();
      expect(changes).toEqual([
        { agent: "claude-cli", usable: false },
        { agent: "claude-cli", usable: true },
      ]);
      // Signed out entirely.
      claude!.remove();
      watch.check();
      expect(changes.at(-1)).toEqual({ agent: "claude-cli", usable: false });
    } finally {
      watch.dispose();
    }
  });

  it("reads a store with no stamp (the keychain, WSL) only now and then", () => {
    let value: string | undefined = live;
    let reads = 0;
    const store: AgentLoginStore = {
      agent: "claude-cli",
      unavailable: () => undefined,
      read: () => {
        reads += 1;
        return value === undefined ? undefined : { value, at: 0 };
      },
      write: (next) => {
        value = next;
      },
      remove: () => {
        value = undefined;
      },
    };
    const changes: LoginChange[] = [];
    const watch = watchAgentLogins(() => [store], (change) => changes.push(change), { everyMs: 60_000, slowMs: 60_000 });
    try {
      watch.check(0);
      value = wiped;
      watch.check(10_000);
      expect(reads).toBe(1);
      expect(changes).toEqual([]);
      watch.check(60_000);
      expect(changes).toEqual([{ agent: "claude-cli", usable: false }]);
    } finally {
      watch.dispose();
    }
  });

  it("does not look at a store that cannot be followed here", () => {
    let reads = 0;
    const store: AgentLoginStore = { agent: "claude-cli", unavailable: () => "the keychain said no", read: () => ((reads += 1), undefined), write: () => undefined, remove: () => undefined };
    const watch = watchAgentLogins(() => [store], () => undefined);
    watch.check(0);
    watch.dispose();
    expect(reads).toBe(0);
  });
});
