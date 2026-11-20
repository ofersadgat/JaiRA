/**
 * Where a script run as a plain program REPORTS (decision 0029, ruling 12; declarative-ai SCRIPTS.md
 * §17.4): `dai-script my-workflow.ts`, or `node my-workflow.ts` importing `@declarative-ai/script`,
 * finds this endpoint and tells it what the run does — each call and what it said, each tool an agent
 * wants to use — so the run is a task here, visible and gated, while it runs its own calls there. It
 * cannot be resumed: its program is the process that reported it.
 *
 * The engine's host starts it beside its pipe and ADVERTISES it where declarative-ai looks, through
 * declarative-ai's own `advertiseEndpoint` — `$DAI_ENDPOINTS`, else this user's directory in the system's
 * temporary one, never the home directory — as `{ name, socket, token, protocol, pid }`, written again
 * every hour while it listens and taken away when the host closes. The wire is declarative-ai's: newline-delimited
 * JSON on the socket, a request `{ id, method, params }` answered `{ id, result }` or `{ id, error }`,
 * a notification without an `id`. `hello` must come first and carry the advertised token; what the
 * service makes of the rest is `AppService`'s (`reportedRunBegin` and the methods after it).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { advertiseEndpoint, REPORT_PROTOCOL } from "@declarative-ai/script/report";

/** The protocol of declarative-ai's reporting this endpoint speaks. */
export const SCRIPT_REPORT_PROTOCOL = REPORT_PROTOCOL;

/**
 * How often the advert is written again while the endpoint listens: the system clears its temporary
 * directory of what has not changed in days, and a running engine must stay findable.
 */
const ADVERT_REFRESH_MS = 60 * 60 * 1000;

/** A run as `hello` describes it. */
export interface ReportedRunInfo {
  file: string;
  args?: JsonValue[];
  cwd: string;
  pid: number;
  meta?: { name?: string; description?: string; environment?: JsonValue };
}

/** One call, begun. */
export interface ReportedCall {
  id: string;
  kind: "llm" | "agent";
  model?: string;
  system?: string;
  prompt: string;
  /** The conversation it continues, as the script names it. */
  session?: string | null;
  schema?: JsonValue;
  cwd?: string;
}

/** One call, ended. */
export interface ReportedOutcome {
  value?: JsonValue;
  error?: string;
  session?: string;
  messages?: JsonValue[];
  costUsd?: number;
  providerSession?: string;
}

/** What the endpoint asks of the service — `AppService` answers it. */
export interface ReportedRuns {
  reportedRunBegin(run: ReportedRunInfo): Promise<{ run: string; url?: string }>;
  reportedCallStarted(run: string, call: ReportedCall): void;
  reportedCallSettled(run: string, id: string, outcome: ReportedOutcome): Promise<void>;
  reportedApprove(run: string, id: string, request: { toolName: string; input: JsonValue }): Promise<{ allow: boolean; reason?: string }>;
  reportedNote(run: string, note: Record<string, JsonValue>): void;
  /** How it ended: its value, its error, or — the connection gone before it said — nothing. */
  reportedRunEnd(run: string, outcome: { value: JsonValue } | { error: string } | { gone: true }): void;
}

export interface ScriptEndpointOptions {
  /** The service, built when the first report arrives if it was not already. */
  engine: () => ReportedRuns;
  /** The engine's home, which names its socket and its advert. */
  baseDir: string;
  version: string;
  /** Where to advertise. Default: declarative-ai's `endpointsDir()`. */
  advertDir?: string;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface ScriptEndpoint {
  readonly socket: string;
  readonly advert: string;
  close(): Promise<void>;
}

/** Start listening for reports, and advertise where. */
export async function startScriptEndpoint(options: ScriptEndpointOptions): Promise<ScriptEndpoint> {
  const hash = createHash("sha256").update(options.baseDir).digest("hex").slice(0, 12);
  // Short, because a Unix socket's path is: the OS temp directory, named by the engine's home.
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\jaira-script-${hash}` : join(tmpdir(), `jaira-script-${hash}.sock`);
  // Only one engine holds a home at a time, and this one does: a socket left by one that died is stale.
  if (process.platform !== "win32" && existsSync(socket)) rmSync(socket, { force: true });
  const token = randomBytes(24).toString("hex");
  const connections = new Set<Socket>();
  const server: Server = createServer((conn) => serve(conn, token, options, connections));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const env = options.advertDir !== undefined ? { ...process.env, DAI_ENDPOINTS: options.advertDir } : process.env;
  const name = `jaira-${hash}`;
  const advertise = (): string =>
    advertiseEndpoint(name, { name: "JaiRA", socket, token, protocol: SCRIPT_REPORT_PROTOCOL, pid: process.pid, version: options.version }, env);
  let advert: string;
  try {
    advert = advertise();
  } catch (e) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(socket, { force: true });
    throw e;
  }
  if (env["DAI_ENDPOINTS"] === undefined) forgetHomeAdvert(name);
  const refresh = setInterval(() => {
    try {
      advertise();
    } catch (e) {
      options.log?.("warn", `could not advertise where scripts run as programs report: ${(e as Error).message}`);
    }
  }, ADVERT_REFRESH_MS);
  refresh.unref();
  options.log?.("info", `scripts run as programs report to this engine at ${socket}`);
  return {
    socket,
    advert,
    close: async () => {
      clearInterval(refresh);
      rmSync(advert, { force: true });
      for (const conn of connections) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(socket, { force: true });
    },
  };
}

/**
 * Until 2026-11-20 the advert was kept in `~/.declarative-ai/endpoints`, a folder in the person's home
 * that only this app ever wrote. Take this engine's old advert away, and the two folders when that leaves
 * them empty. Drop this once the builds that wrote there are gone.
 */
function forgetHomeAdvert(name: string): void {
  const old = join(homedir(), ".declarative-ai");
  rmSync(join(old, "endpoints", `${name}.json`), { force: true });
  for (const dir of [join(old, "endpoints"), old]) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** One reporting connection: `hello` first, then the run's reports, in the order they were sent. */
function serve(conn: Socket, token: string, options: ScriptEndpointOptions, connections: Set<Socket>): void {
  connections.add(conn);
  conn.setEncoding("utf8");
  let buffer = "";
  let run: string | undefined;
  let ended = false;
  // In order: a call is begun before it is settled, and the run ends after its last call.
  let chain: Promise<void> = Promise.resolve();
  const answer = (id: unknown, result: unknown): void => {
    if (typeof id === "number" && !conn.destroyed) conn.write(`${JSON.stringify({ id, result: result ?? {} })}\n`);
  };
  const refuse = (id: unknown, message: string): void => {
    if (typeof id === "number" && !conn.destroyed) conn.write(`${JSON.stringify({ id, error: { message } })}\n`);
  };
  const handle = async (frame: { id?: unknown; method?: unknown; params?: unknown }): Promise<void> => {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (run === undefined) {
      if (frame.method !== "hello") return refuse(frame.id, "say hello first");
      if (params["token"] !== token) return refuse(frame.id, "the token does not match this engine's");
      if (params["protocol"] !== SCRIPT_REPORT_PROTOCOL) return refuse(frame.id, `this engine speaks reporting protocol ${SCRIPT_REPORT_PROTOCOL}`);
      try {
        const begun = await options.engine().reportedRunBegin(params["run"] as ReportedRunInfo);
        run = begun.run;
        return answer(frame.id, { run: begun.run, name: "JaiRA", version: options.version, ...(begun.url !== undefined ? { url: begun.url } : {}) });
      } catch (e) {
        return refuse(frame.id, (e as Error).message);
      }
    }
    const engine = options.engine();
    try {
      switch (frame.method) {
        case "call.started":
          engine.reportedCallStarted(run, params["call"] as ReportedCall);
          return answer(frame.id, {});
        case "call.settled":
          await engine.reportedCallSettled(run, String(params["id"]), (params["outcome"] ?? {}) as ReportedOutcome);
          return answer(frame.id, {});
        case "approve":
          return answer(frame.id, await engine.reportedApprove(run, String(params["id"]), { toolName: String(params["toolName"]), input: (params["input"] ?? {}) as JsonValue }));
        case "note":
          engine.reportedNote(run, params as Record<string, JsonValue>);
          return answer(frame.id, {});
        case "end":
          ended = true;
          engine.reportedRunEnd(run, "error" in params ? { error: String(params["error"]) } : { value: (params["value"] ?? null) as JsonValue });
          return answer(frame.id, {});
        default:
          return refuse(frame.id, `this endpoint does not answer '${String(frame.method)}'`);
      }
    } catch (e) {
      options.log?.("warn", `a reported run's '${String(frame.method)}' could not be taken: ${(e as Error).message}`);
      return refuse(frame.id, (e as Error).message);
    }
  };
  conn.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim().length === 0) continue;
      let frame: { id?: unknown; method?: unknown; params?: unknown };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue;
      }
      chain = chain.then(() => handle(frame)).catch(() => undefined);
    }
  });
  const gone = (): void => {
    connections.delete(conn);
    void chain.then(() => {
      if (run !== undefined && !ended) {
        ended = true;
        options.engine().reportedRunEnd(run, { gone: true });
      }
    });
  };
  conn.on("close", gone);
  conn.on("error", () => conn.destroy());
}
