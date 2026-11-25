/**
 * Claude's long-lived sign-in (`claude setup-token`): read out of what the command printed, handed to
 * every `claude` JaiRA starts, and what the sign-in check asks about while there is one.
 */
import { describe, expect, it } from "vitest";
import type { ExecResult, ExecOptions, Exec } from "../src/exec";
// executors before agents: the two import each other, and this is the order the package loads them in.
import { claudeTokenIn, listExecutors, probeExecutor, setUpClaudeToken } from "../src/executors";
import { CLAUDE_TOKEN_VARIABLE, spawnWithKey } from "../src/agents";

type SpawnProcess = Parameters<typeof spawnWithKey>[0];
import { claudeTokenOf } from "../src/modelRoutes";
import { SecretResolver } from "../src/secrets";

const TOKEN = `sk-ant-oat01-${"Ab3_-x".repeat(16)}AA`;
const cli = () => listExecutors().find((info) => info.name === "claude-cli")!;

function result(answer: Partial<ExecResult>): ExecResult {
  return { code: 0, signal: null, stdout: "", stderr: "", command: "claude", timedOut: false, aborted: false, ...answer };
}

describe("the token in what `claude setup-token` printed", () => {
  it("is read from a line of its own, through a terminal's escapes", () => {
    const printed = `\u001b[1m✓ Long-lived authentication token created\u001b[22m\n\nYour OAuth token (valid for 1 year):\n\n\u001b[33m${TOKEN}\u001b[39m\n\nStore this token securely. You won't be able to see it again.\n`;
    expect(claudeTokenIn(printed)).toBe(TOKEN);
  });

  it("is put back together when a narrow screen wrapped it, box edges and all", () => {
    const wrapped = `│ ${TOKEN.slice(0, 60)}│\n│ ${TOKEN.slice(60)}    │\n│                  │\n│ Store this token securely. │`;
    expect(claudeTokenIn(wrapped)).toBe(TOKEN);
  });

  it("stops at the next sentence, which is not token", () => {
    expect(claudeTokenIn(`${TOKEN}\nStore this token securely.`)).toBe(TOKEN);
    expect(claudeTokenIn(`${TOKEN}\n\nexport`)).toBe(TOKEN);
  });

  it("is nothing when there is none — the example in its instructions included", () => {
    expect(claudeTokenIn("Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>")).toBeUndefined();
    expect(claudeTokenIn("sk-ant-oat01-short")).toBeUndefined();
  });
});

describe("making a token with `claude setup-token`", () => {
  it("answers with the token once it is printed, stopping a command that holds its screen open", async () => {
    let stopped = false;
    const exec: Exec = {
      run: (_command, args, options?: ExecOptions) => {
        expect(args).toEqual(["setup-token"]);
        options?.onOutput?.("stdout", `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n`);
        // Waits for a key that never comes, until it is stopped.
        return new Promise((resolve) =>
          options?.abortSignal?.addEventListener("abort", () => {
            stopped = true;
            resolve(result({ code: null, aborted: true }));
          }),
        );
      },
    };
    expect(await setUpClaudeToken(cli(), { exec })).toEqual({ ok: true, token: TOKEN });
    expect(stopped).toBe(true);
  });

  it("says why when the command ends with no token, and that it was cancelled when it was", async () => {
    const failing: Exec = { run: () => Promise.resolve(result({ code: 1, stderr: "Raw mode is not supported\n" })) };
    const failed = await setUpClaudeToken(cli(), { exec: failing });
    expect(failed).toMatchObject({ ok: false });
    expect(!failed.ok && failed.reason).toContain("Raw mode is not supported");

    const cancel = new AbortController();
    const waiting: Exec = {
      run: (_command, _args, options?: ExecOptions) =>
        new Promise((resolve) => options?.abortSignal?.addEventListener("abort", () => resolve(result({ code: null, aborted: true })))),
    };
    const running = setUpClaudeToken(cli(), { exec: waiting, abortSignal: cancel.signal });
    cancel.abort();
    expect(await running).toEqual({ ok: false, reason: "the sign-in was cancelled" });
  });

  it("is refused for an agent that takes no token", async () => {
    const codex = listExecutors().find((info) => info.name === "codex-cli")!;
    expect(await setUpClaudeToken(codex, { exec: { run: () => Promise.reject(new Error("not run")) } })).toMatchObject({ ok: false });
  });
});

describe("a token JaiRA keeps for claude", () => {
  it("is handed to each claude started, looked up at each start", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawn = ((_argv: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      seen.push(opts.env);
      return undefined as never;
    }) as unknown as SpawnProcess;
    let held: string | undefined;
    const handed = spawnWithKey(spawn, claudeTokenOf((name) => (name === CLAUDE_TOKEN_VARIABLE ? held : undefined)));

    handed(["claude"], {} as never);
    held = TOKEN;
    handed(["claude"], {} as never);

    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.[CLAUDE_TOKEN_VARIABLE]).toBe(TOKEN);
  });

  it("is what the sign-in check asks about, and names itself as the token", async () => {
    const asked: Array<Record<string, string> | undefined> = [];
    const exec: Exec = {
      run: (command, args, options?: ExecOptions) => {
        const line = [command, ...args].join(" ");
        if (line === "claude --version") return Promise.resolve(result({ stdout: "2.1.329 (Claude Code)\n" }));
        asked.push(options?.env);
        const token = options?.env?.[CLAUDE_TOKEN_VARIABLE] !== undefined;
        return Promise.resolve(
          token
            ? result({ stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }) })
            : result({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) }),
        );
      },
    };

    const without = await probeExecutor(cli(), { exec, secrets: new SecretResolver({ env: {} }) });
    expect(without.status).toBe("needs-sign-in");

    const kept = await probeExecutor(cli(), { exec, secrets: new SecretResolver({ env: { [CLAUDE_TOKEN_VARIABLE]: TOKEN } }) });
    expect(kept.status).toBe("ok");
    expect(kept.accounts).toEqual([{ label: "Long-lived token", method: "setup-token", active: true }]);
    expect(asked.at(-1)?.[CLAUDE_TOKEN_VARIABLE]).toBe(TOKEN);
  });
});
