/**
 * A forge reached through its own command line — `gh` for GitHub, `glab` for GitLab — as the account
 * that command line is signed in as (decision 0004, amended 2026-11-20).
 *
 * Not a second provider. A provider is the one class that knows a forge's endpoints (§1), and it talks
 * through a {@link ForgeHttp}; this is another `ForgeHttp`. `gh api -i` and `glab api -i` send the
 * request the provider built, signed with the command line's own sign-in, and print the response the
 * way a `fetch` would hand it over: the status line, the headers, a blank line, the body — a 4xx or a
 * 304 too (measured 2026-11-20, gh 2.104, glab 1.126: both exit 1 there and still print it). So the
 * same `GitHubProvider` lists repositories, reads a request or polls with an ETag whichever way it is
 * signed in, and nothing above the transport knows which.
 *
 * The provider's `Authorization` header is dropped: the command line signs the request. The body goes
 * on stdin, never on the command line, which a process list and the job record both show.
 */
import { tmpdir } from "node:os";
import { FORGE_CLIS, type ForgeProviderKind } from "@jaira/shared";
import type { Exec } from "../exec";
import type { ExecEnv } from "../paths";
import { FORGE_TIMEOUT_MS, ForgeError, NoForgeConnection, type ForgeHttp, type ForgeRequest, type ForgeResponse } from "./http";

/** What a forge's command line is run with: the same seam every child process goes through. */
export interface ForgeCliOptions {
  exec: Exec;
  execEnv?: ExecEnv;
}

/**
 * The command line cannot speak for the host: it is not installed, or not signed in to that host. A
 * {@link NoForgeConnection}, so a caller that skips a connection with no way in skips this one too.
 */
export class ForgeCliUnavailable extends NoForgeConnection {
  constructor(
    message: string,
    readonly reason: "missing" | "signed-out",
  ) {
    super(message);
    this.name = "ForgeCliUnavailable";
  }
}

/** What the command line is called in a sentence. */
const SPOKEN: Record<"gh" | "glab", string> = { gh: "gh (GitHub CLI)", glab: "glab (GitLab CLI)" };

/**
 * The endpoint `gh api` / `glab api` takes for a URL a provider built: GraphQL by name, a REST call by
 * its path under the API root (github.com's `api.github.com`, an Enterprise Server's `/api/v3`,
 * GitLab's `/api/v4`), query string kept. A URL under none of these is not one the command line sends.
 */
export function cliEndpointOf(url: string, host: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const path = parsed.pathname;
  const tail = (prefix: string): string => `${path.slice(prefix.length).replace(/^\/+/, "")}${parsed.search}`;
  if (parsed.host === "api.github.com" && host === "github.com") return path === "/graphql" ? "graphql" : tail("");
  if (parsed.host !== host) return undefined;
  if (path === "/api/graphql") return "graphql";
  if (path.startsWith("/api/v3/")) return tail("/api/v3");
  if (path.startsWith("/api/v4/")) return tail("/api/v4");
  return undefined;
}

/** The transport that sends a provider's requests through `gh` or `glab`. */
export function cliForgeHttp(provider: ForgeProviderKind, host: string, options: ForgeCliOptions): ForgeHttp {
  const cli = FORGE_CLIS[provider];
  return async (request: ForgeRequest): Promise<ForgeResponse> => {
    const endpoint = cliEndpointOf(request.url, host);
    if (endpoint === undefined) throw new ForgeError(`${SPOKEN[cli]} sends requests to ${host}'s API only, not to ${new URL(request.url).host}`, 0);
    if (request.form !== undefined) throw new ForgeError(`${SPOKEN[cli]} does not send form requests`, 0);
    const args = ["api", "--hostname", host, "--include", "--method", request.method];
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === "authorization") continue;
      args.push("--header", `${name}: ${value}`);
    }
    if (request.body !== undefined) args.push("--header", "Content-Type: application/json", "--input", "-");
    args.push(endpoint);
    let result;
    try {
      result = await options.exec.run(cli, args, {
        ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
        // Not in a repository: glab would take its host and placeholders from the folder it runs in.
        cwd: tmpdir(),
        env: { NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GLAB_CHECK_UPDATE: "false" },
        ...(request.body !== undefined ? { stdin: JSON.stringify(request.body) } : {}),
        stdoutBytes: true,
        timeoutMs: request.timeoutMs ?? FORGE_TIMEOUT_MS,
      });
    } catch (error) {
      throw new ForgeCliUnavailable(`${SPOKEN[cli]} could not be run on this machine: ${(error as Error).message}`, "missing");
    }
    if (result.timedOut) throw new ForgeError(`${host} did not answer ${cli} in time`, 0);
    const parsed = parseIncluded(result.stdoutBytes ?? new TextEncoder().encode(result.stdout), request.expect);
    if (parsed !== undefined) return parsed;
    const said = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    // gh exits 4 when it holds no sign-in (`gh help exit-codes`); both say `auth login` when they need one.
    if (result.code === 4 || said.some((line) => /auth login|not logged|not authenticated|no token/i.test(line))) {
      throw new ForgeCliUnavailable(`${SPOKEN[cli]} is not signed in to ${host} — \`${cli} auth login --hostname ${host}\` signs it in`, "signed-out");
    }
    throw new ForgeError(`${cli} api ${endpoint}: ${said[0] ?? `exited ${result.code}`}`, 0);
  };
}

/**
 * The response `--include` printed, read as `fetchForgeHttp` reads one; undefined when there is none.
 * Line by line to the first empty one — the status line ends `\n`, each header `\r\n` — and the rest is
 * the body, as bytes, so an archive is not read through a text decoder first.
 */
export function parseIncluded(bytes: Uint8Array, expect?: ForgeRequest["expect"]): ForgeResponse | undefined {
  const lines: string[] = [];
  let at = 0;
  for (;;) {
    const end = bytes.indexOf(10, at);
    if (end < 0) {
      lines.push(new TextDecoder().decode(bytes.subarray(at)).replace(/\r$/, ""));
      at = bytes.length;
      break;
    }
    const line = new TextDecoder().decode(bytes.subarray(at, end)).replace(/\r$/, "");
    at = end + 1;
    if (line === "" && lines.length > 0) break;
    lines.push(line);
  }
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? "")?.[1]);
  if (!Number.isFinite(status)) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const raw = bytes.subarray(at);
  const ok = status >= 200 && status < 300;
  if (ok && expect === "bytes") return { status, headers, body: new Uint8Array(raw) };
  const text = new TextDecoder().decode(raw);
  if (ok && expect === "text") return { status, headers, body: text };
  if (text.length === 0) return { status, headers, body: null };
  try {
    return { status, headers, body: JSON.parse(text) };
  } catch {
    return { status, headers, body: text };
  }
}
