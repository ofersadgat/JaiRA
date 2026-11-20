/**
 * A forge reached through its command line (decision 0004, amended 2026-11-20): the same provider, its
 * requests sent by `gh api` / `glab api`. The command lines here are stand-ins that print what the real
 * ones print (measured 2026-11-20, gh 2.104 and glab 1.126): `--include` gives the status line, the
 * headers, a blank line and the body, a 4xx and a 304 included, and both exit 1 on those.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseIntegrations } from "@jaira/shared";
import type { Exec, ExecOptions, ExecResult } from "../src/exec";
import { ForgeCliUnavailable, checkForges, cliEndpointOf, cliForgeHttp, forgeAccess, forgeProvider, parseIncluded } from "../src/forge";
import { cliGitCredentials, pushCredentials } from "../src/gitTools";
import { SecretResolver } from "../src/secrets";

interface Ran {
  command: string;
  args: readonly string[];
  options: ExecOptions;
}

/** What one endpoint answers: a status, headers and a body, as `--include` prints them. */
type Answer = { status: number; headers?: Record<string, string>; body?: string | Uint8Array };

/** A command line signed in, answering by endpoint; or signed out (`out`), or not installed (`missing`). */
function fakeCli(answers: Record<string, Record<string, Answer>>, state: Partial<Record<"gh" | "glab", "out" | "missing">> = {}): Exec & { ran: Ran[] } {
  const ran: Ran[] = [];
  return {
    ran,
    async run(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
      ran.push({ command, args, options });
      const done = (code: number, stdout: Uint8Array, stderr: string): ExecResult => ({
        code,
        signal: null,
        stdout: new TextDecoder().decode(stdout),
        ...(options.stdoutBytes === true ? { stdoutBytes: stdout } : {}),
        stderr,
        command: [command, ...args].join(" "),
        timedOut: false,
        aborted: false,
      });
      if (state[command as "gh" | "glab"] === "missing") throw new Error(`failed to run '${command}': spawn ${command} ENOENT`);
      if (state[command as "gh" | "glab"] === "out") {
        return command === "gh"
          ? done(4, new Uint8Array(), "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n")
          : done(1, new Uint8Array(), "glab: no token found for gitlab.com. Run `glab auth login` to authenticate.\n");
      }
      const endpoint = args[args.length - 1]!;
      const answer = answers[command]?.[endpoint] ?? { status: 404, body: '{"message":"Not Found"}' };
      const head = `HTTP/2.0 ${answer.status} X\n${Object.entries(answer.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")}\r\n`;
      const body = typeof answer.body === "string" ? new TextEncoder().encode(answer.body) : (answer.body ?? new Uint8Array());
      const out = new Uint8Array([...new TextEncoder().encode(head), ...body]);
      return done(answer.status >= 200 && answer.status < 300 ? 0 : 1, out, answer.status >= 300 ? `${command}: HTTP ${answer.status}\n` : "");
    },
  };
}

const GH_USER = { status: 200, headers: { "X-Oauth-Scopes": "gist, read:org, repo, workflow", Etag: 'W/"abc"' }, body: '{"login":"octo","name":"Octo Cat"}' };
const GLAB_USER = { status: 200, body: '{"id":1,"username":"lab-person","name":"Lab Person"}' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-forge-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const secrets = (env: Record<string, string>) => new SecretResolver({ baseDir: dir, env });

describe("the endpoint a command line takes", () => {
  it("is the path under each API root, query kept, and GraphQL by name", () => {
    expect(cliEndpointOf("https://api.github.com/user/repos?per_page=100&sort=pushed", "github.com")).toBe("user/repos?per_page=100&sort=pushed");
    expect(cliEndpointOf("https://api.github.com/graphql", "github.com")).toBe("graphql");
    expect(cliEndpointOf("https://ghe.example.com/api/v3/user", "ghe.example.com")).toBe("user");
    expect(cliEndpointOf("https://ghe.example.com/api/graphql", "ghe.example.com")).toBe("graphql");
    expect(cliEndpointOf("https://gitlab.com/api/v4/projects/a%2Fb/merge_requests?state=opened", "gitlab.com")).toBe("projects/a%2Fb/merge_requests?state=opened");
    expect(cliEndpointOf("https://gitlab.com/api/graphql", "gitlab.com")).toBe("graphql");
  });

  it("is none for a URL off the host's API", () => {
    expect(cliEndpointOf("https://github.com/login/oauth/access_token", "github.com")).toBeUndefined();
    expect(cliEndpointOf("https://objects.githubusercontent.com/x", "github.com")).toBeUndefined();
    expect(cliEndpointOf("https://gitlab.com/oauth/token", "gitlab.com")).toBeUndefined();
  });
});

describe("what --include printed", () => {
  it("reads as fetch would hand it over: status, lower-cased headers, the body parsed", () => {
    const bytes = new TextEncoder().encode('HTTP/2.0 200 OK\nContent-Type: application/json\r\nEtag: W/"x"\r\n\r\n{"a":1}');
    expect(parseIncluded(bytes)).toEqual({ status: 200, headers: { "content-type": "application/json", etag: 'W/"x"' }, body: { a: 1 } });
  });

  it("keeps a 304's empty body as null and a refusal's message", () => {
    expect(parseIncluded(new TextEncoder().encode("HTTP/2.0 304 Not Modified\nEtag: x\r\n\r\n"))).toMatchObject({ status: 304, body: null });
    expect(parseIncluded(new TextEncoder().encode('HTTP/2.0 404 Not Found\nX: y\r\n\r\n{"message":"Not Found"}'))).toMatchObject({ status: 404, body: { message: "Not Found" } });
  });

  it("hands over bytes as bytes, and text as text, when asked", () => {
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0x0d, 0x0a, 0xff]);
    const bytes = new Uint8Array([...new TextEncoder().encode("HTTP/2.0 200 OK\nContent-Type: application/zip\r\n\r\n"), ...archive]);
    expect(parseIncluded(bytes, "bytes")?.body).toEqual(archive);
    expect(parseIncluded(new TextEncoder().encode('HTTP/2.0 200 OK\nA: b\r\n\r\n{"log":1}'), "text")?.body).toBe('{"log":1}');
  });

  it("is nothing when the command line printed no response", () => {
    expect(parseIncluded(new TextEncoder().encode("gh: not logged in"))).toBeUndefined();
  });
});

describe("a provider through the command line", () => {
  it("is the same provider: gh sends its request, signed with gh's own sign-in, never the provider's header", async () => {
    const exec = fakeCli({ gh: { user: GH_USER } });
    const provider = forgeProvider({ provider: "github", host: "github.com" } as never, { cli: { exec } });
    expect(await provider.whoami()).toMatchObject({ login: "octo", scopes: ["gist", "read:org", "repo", "workflow"] });
    const [call] = exec.ran;
    expect(call!.command).toBe("gh");
    expect(call!.args.slice(0, 6)).toEqual(["api", "--hostname", "github.com", "--include", "--method", "GET"]);
    expect(call!.args.join(" ")).not.toMatch(/authorization/i);
    expect(call!.args.at(-1)).toBe("user");
  });

  it("sends a body on stdin, not on the command line", async () => {
    const exec = fakeCli({ gh: { graphql: { status: 200, body: '{"data":{"viewer":{"login":"octo"}}}' } } });
    const http = cliForgeHttp("github", "github.com", { exec });
    const answer = await http({ method: "POST", url: "https://api.github.com/graphql", headers: { Authorization: "Bearer secret" }, body: { query: "query{viewer{login}}" } });
    expect(answer.body).toEqual({ data: { viewer: { login: "octo" } } });
    const [call] = exec.ran;
    expect(call!.args).toContain("--input");
    expect(call!.options.stdin).toBe('{"query":"query{viewer{login}}"}');
    expect(call!.args.join(" ")).not.toContain("secret");
  });

  it("says a signed-out or missing command line is no way in, with the command that signs it in", async () => {
    const out = cliForgeHttp("github", "github.com", { exec: fakeCli({}, { gh: "out" }) });
    await expect(out({ method: "GET", url: "https://api.github.com/user", headers: {} })).rejects.toThrow(ForgeCliUnavailable);
    await expect(out({ method: "GET", url: "https://api.github.com/user", headers: {} })).rejects.toThrow(/gh auth login --hostname github.com/);
    const missing = cliForgeHttp("gitlab", "gitlab.com", { exec: fakeCli({}, { glab: "missing" }) });
    await expect(missing({ method: "GET", url: "https://gitlab.com/api/v4/user", headers: {} })).rejects.toMatchObject({ reason: "missing" });
  });
});

describe("a connection with no token", () => {
  it("is checked through its command line: signed in there is signed in, and says through which", async () => {
    const exec = fakeCli({ gh: { user: GH_USER }, glab: { user: GLAB_USER } });
    const [gitlab, github] = await checkForges(parseIntegrations(undefined), { secrets: secrets({}), cli: { exec } });
    expect(gitlab).toMatchObject({ status: "ok", detail: "signed in as @lab-person through glab", identity: { login: "lab-person" }, via: "cli" });
    expect(github).toMatchObject({ status: "ok", detail: "signed in as @octo through gh", via: "cli" });
    expect(github!.credential).toBeUndefined();
  });

  it("stays not set up when the command line is signed out or not there", async () => {
    const exec = fakeCli({}, { gh: "out", glab: "missing" });
    const [gitlab, github] = await checkForges(parseIntegrations(undefined), { secrets: secrets({}), cli: { exec } });
    expect(gitlab).toMatchObject({ status: "unconfigured", detail: "no token stored under GITLAB_TOKEN", credentialMissing: "GITLAB_TOKEN" });
    expect(github).toMatchObject({ status: "unconfigured", detail: "no token stored under GITHUB_TOKEN" });
  });

  it("is not looked for through the command line when a token is stored", async () => {
    const exec = fakeCli({ gh: { user: GH_USER } });
    const seen: string[] = [];
    await checkForges(parseIntegrations({ forges: { gitlab: { enabled: false } } }), {
      secrets: secrets({ GITHUB_TOKEN: "stored" }),
      cli: { exec },
      http: async (request) => {
        seen.push(request.url);
        return { status: 200, headers: { "x-oauth-scopes": "repo" }, body: { login: "octo" } };
      },
    });
    expect(seen).toEqual(["https://api.github.com/user"]);
    expect(exec.ran).toEqual([]);
  });

  it("is reached through the command line, and git pushes with what it already signs in with", () => {
    const access = forgeAccess(parseIntegrations(undefined), "github.com", { secrets: secrets({}), cli: { exec: fakeCli({}) } });
    expect(access.via).toBe("cli");
    expect(access.token).toBeUndefined();
    expect(pushCredentials(access, "https://github.com/o/r.git")).toEqual({});
    const stored = forgeAccess(parseIntegrations(undefined), "github.com", { secrets: secrets({ GITHUB_TOKEN: "t" }), cli: { exec: fakeCli({}) } });
    expect(stored).toMatchObject({ via: "token", token: "t" });
  });

  // A copy opened on Windows from a Mac's checkout had glab signed in and no token: its https clone
  // must sign in as glab is signed in, not through a credential manager that opens a window.
  it.skipIf(process.platform === "win32")("hands git the command line as the host's only credential helper", () => {
    const bin = mkdtempSync(join(tmpdir(), "jaira-glab-"));
    try {
      writeFileSync(join(bin, "glab"), '#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] && cat >/dev/null && printf "username=oauth2\\npassword=from-glab\\n"\n');
      chmodSync(join(bin, "glab"), 0o755);
      const env = cliGitCredentials("gitlab", "https://gitlab.com/org/repo.git");
      const filled = execFileSync("git", ["credential", "fill"], {
        input: "protocol=https\nhost=gitlab.com\npath=org/repo.git\n\n",
        encoding: "utf8",
        env: { ...process.env, ...env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, GIT_TERMINAL_PROMPT: "0" },
      });
      expect(filled).toContain("password=from-glab");
      expect(env["GIT_CONFIG_VALUE_1"]).toBe("!glab auth git-credential");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("adds an ssh key to the account through the command line, and says which scope a refusal lacks", async () => {
    const glab = fakeCli({ glab: { "user/keys": { status: 201, body: '{"id":7}' } } });
    await forgeProvider({ provider: "gitlab", host: "gitlab.com" } as never, { cli: { exec: glab } }).addSshKey!("JaiRA on desk", "ssh-ed25519 AAAA desk\n");
    expect(glab.ran[0]!.args).toEqual(expect.arrayContaining(["--method", "POST", "user/keys"]));
    expect(JSON.parse(glab.ran[0]!.options.stdin!)).toEqual({ title: "JaiRA on desk", key: "ssh-ed25519 AAAA desk" });
    const gh = fakeCli({ gh: { "user/keys": { status: 404, body: '{"message":"Not Found"}' }, meta: { status: 200, body: '{"ssh_keys":["ssh-ed25519 AAAAgh"]}' } } });
    const github = forgeProvider({ provider: "github", host: "github.com" } as never, { cli: { exec: gh } });
    await expect(github.addSshKey!("JaiRA on desk", "ssh-ed25519 AAAA")).rejects.toThrow(/admin:public_key/);
    expect(await github.sshHostKeys!()).toEqual(["ssh-ed25519 AAAAgh"]);
  });

  it("lists repositories through the command line", async () => {
    const repo = { full_name: "octo/app", name: "app", default_branch: "main", clone_url: "https://github.com/octo/app.git", pushed_at: "2026-11-19T00:00:00Z", private: true };
    const exec = fakeCli({ gh: { "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member": { status: 200, body: JSON.stringify([repo]) } } });
    const provider = forgeProvider({ provider: "github", host: "github.com" } as never, { cli: { exec } });
    const repos = await provider.repositories!();
    expect(repos.map((r) => r.project)).toEqual(["octo/app"]);
  });
});
