/**
 * Hosting the engine on the local pipe (decision 0012 §2–§3): the process that claims the pipe answers
 * every client's requests with the same dispatch Electron's IPC uses (`serviceHandlers`), and sends every
 * push to every client that has said hello. The protocol and the paths are `enginePipe.ts`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { PushMessage } from "@jaira/shared";
import {
  ENGINE_CONTRACT,
  ENGINE_PORT,
  FrameReader,
  encodeFrame,
  enginePipePath,
  homeHash,
  removeEngineFile,
  writeEngineFile,
  type ClientFrame,
  type EngineHostInfo,
  type HostFrame,
} from "./enginePipe";
import { whoAt } from "./engineClient";
import type { Handler } from "./handlers";

/** Who is on the other end of one connection, as it said in `hello`. */
export interface EngineClientInfo {
  /** Unique for this host's lifetime. */
  id: string;
  name: string;
  pid?: number;
  version: string;
  connectedAt: number;
}

/** What one connection adds over the host's handlers, and what to forget when it goes (§3, "per connection"). */
export interface EngineConnection {
  handlers?: Partial<Record<string, Handler>>;
  closed?: () => void;
}

export interface EngineHostOptions {
  baseDir: string;
  kind: EngineHostInfo["kind"];
  /** The JaiRA version this host runs. */
  version: string;
  /** What answers each channel: the service's, and whatever the host adds. */
  handlers: Partial<Record<string, Handler>>;
  /** A connection's own answers — `project:current`, `limits:watch` — over {@link handlers}. */
  connect?: (client: EngineClientInfo) => EngineConnection;
  /** A handler that threw: the IPC path records it the same way. */
  onFailure?: (channel: string, error: unknown) => void;
  log?: (level: "info" | "warn", message: string) => void;
  /** Tests: another pipe, another token, another port. */
  pipe?: string;
  token?: string;
  port?: number;
}

interface Client {
  socket: Socket;
  reader: FrameReader;
  /** Past `hello`: may send requests and hears pushes. */
  admitted: boolean;
  /** Admitted with another contract: only `engine:*` answers. */
  limited: boolean;
  info?: EngineClientInfo;
  connection?: EngineConnection;
}

let nextClient = 1;

export class EngineHost {
  readonly info: EngineHostInfo;
  private readonly clients = new Set<Client>();

  constructor(
    private readonly server: Server,
    private readonly options: EngineHostOptions,
    private readonly token: string,
    address: { pipe: string; port?: number },
  ) {
    this.info = {
      kind: options.kind,
      pid: process.pid,
      version: options.version,
      contract: ENGINE_CONTRACT,
      pipe: address.pipe,
      ...(address.port !== undefined ? { port: address.port } : {}),
      home: homeHash(options.baseDir),
      exe: process.execPath,
      startedAt: Date.now(),
    };
    server.on("connection", (socket) => this.accept(socket));
  }

  /** How many clients are past `hello`. */
  admitted(): number {
    return [...this.clients].filter((c) => c.admitted).length;
  }

  /** The clients past `hello`, for `jaira server status`. */
  connected(): EngineClientInfo[] {
    return [...this.clients].flatMap((c) => (c.admitted && c.info !== undefined ? [c.info] : []));
  }

  /** Send a push to every client past `hello` with this host's contract. */
  broadcast(message: PushMessage): void {
    const frame = encodeFrame({ t: "push", message });
    for (const client of this.clients) if (client.admitted && !client.limited && !client.socket.destroyed) client.socket.write(frame);
  }

  /** Stop answering: every client is disconnected, the pipe goes, and so does `engine.json`. */
  async close(): Promise<void> {
    for (const client of this.clients) this.drop(client);
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    removeEngineFile(this.options.baseDir, process.pid);
  }

  private accept(socket: Socket): void {
    const client: Client = { socket, reader: new FrameReader(), admitted: false, limited: false };
    this.clients.add(client);
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = client.reader.push(chunk);
      } catch (e) {
        this.refuse(client, (e as Error).message);
        return;
      }
      for (const frame of frames) void this.receive(client, frame as ClientFrame);
    });
    socket.on("close", () => this.drop(client));
    socket.on("error", () => this.drop(client));
  }

  /** A client that went: its connection's state is forgotten once. */
  private drop(client: Client): void {
    if (!this.clients.delete(client) && client.connection === undefined) return;
    const connection = client.connection;
    client.connection = undefined;
    client.socket.destroy();
    try {
      connection?.closed?.();
    } catch {
      // A connection's cleanup is bookkeeping; the client is gone either way.
    }
    if (client.info !== undefined) this.options.log?.("info", `${client.info.name} disconnected from the engine`);
  }

  private send(client: Client, frame: HostFrame): void {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(frame));
  }

  private refuse(client: Client, reason: string): void {
    this.send(client, { t: "refused", reason });
    client.socket.end();
    this.clients.delete(client);
  }

  private async receive(client: Client, frame: ClientFrame): Promise<void> {
    if (!client.admitted) {
      if (frame.t === "who") {
        this.send(client, { t: "info", host: this.info });
        return;
      }
      if (frame.t !== "hello") return this.refuse(client, "say hello first");
      if (!sameToken(frame.token, this.token)) return this.refuse(client, "the token does not match this engine's");
      const limited = frame.contract !== ENGINE_CONTRACT;
      // Welcome BEFORE admitting and logging: the log line is itself a push, broadcast to the admitted,
      // and a client's first frame must be its welcome.
      this.send(client, { t: "welcome", host: this.info, ...(limited ? { limited: true as const } : {}) });
      client.admitted = true;
      client.limited = limited;
      client.info = {
        id: `c${nextClient++}`,
        name: frame.client,
        ...(typeof frame.pid === "number" ? { pid: frame.pid } : {}),
        version: frame.version,
        connectedAt: Date.now(),
      };
      if (!limited) client.connection = this.options.connect?.(client.info);
      this.options.log?.(
        "info",
        limited
          ? `${frame.client} (JaiRA ${frame.version}) connected to the engine with another contract; it may only ask about it or stop it`
          : `${frame.client} connected to the engine`,
      );
      return;
    }
    if (frame.t !== "req") return;
    if (client.limited && !frame.channel.startsWith("engine:")) {
      this.send(client, {
        t: "res",
        id: frame.id,
        ok: false,
        error: { message: `this engine runs JaiRA ${this.info.version}, which speaks another contract than ${client.info?.version ?? "yours"}` },
      });
      return;
    }
    const handler = client.connection?.handlers?.[frame.channel] ?? this.options.handlers[frame.channel];
    if (handler === undefined) {
      this.send(client, { t: "res", id: frame.id, ok: false, error: { message: `this engine does not answer '${frame.channel}'` } });
      return;
    }
    try {
      const result = await (handler as (request: unknown) => unknown)(frame.request);
      this.send(client, { t: "res", id: frame.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      this.options.onFailure?.(frame.channel, e);
      const error = e instanceof Error ? { message: e.message, name: e.name } : { message: String(e) };
      this.send(client, { t: "res", id: frame.id, ok: false, error });
    }
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether something answers on a socket path — a live host, not a file left behind by a dead one. */
function answers(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(pipe);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

type Listened = "listening" | "taken" | { failed: NodeJS.ErrnoException };

function listen(server: Server, target: string | { port: number; host: string }): Promise<Listened> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      resolve(e.code === "EADDRINUSE" ? "taken" : { failed: e });
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (typeof target === "string") server.listen(target);
    else server.listen(target.port, target.host);
  });
}

/**
 * Claim the engine for this process: listen on the pipe and write `engine.json`. Answers `undefined`
 * when another process holds it.
 *
 * - On POSIX a socket file with nobody behind it (a host that died) is removed and the claim tried once
 *   more; on Windows a pipe disappears with its process.
 * - A pipe that cannot be CREATED at all (not taken: refused, as in a sandbox without pipes) falls back
 *   to the loopback port (§4 step 3). The port is shared by every root on the machine, so a port held by
 *   another root's host is an error, not this root's claim.
 */
export async function claimEngine(options: EngineHostOptions): Promise<EngineHost | undefined> {
  const pipe = options.pipe ?? enginePipePath(options.baseDir);
  let outcome: Listened;
  let server = createServer();
  try {
    if (process.platform !== "win32") {
      mkdirSync(dirname(pipe), { recursive: true, mode: 0o700 });
      chmodSync(dirname(pipe), 0o700);
    }
    outcome = await listen(server, pipe);
    if (outcome === "taken" && process.platform !== "win32" && !(await answers(pipe))) {
      rmSync(pipe, { force: true });
      server = createServer();
      outcome = await listen(server, pipe);
    }
  } catch (e) {
    outcome = { failed: e as NodeJS.ErrnoException };
  }
  if (outcome === "taken") return undefined;
  let port: number | undefined;
  if (outcome !== "listening") {
    const reason = outcome.failed.message;
    port = options.port ?? ENGINE_PORT;
    server = createServer();
    const onPort = await listen(server, { port, host: "127.0.0.1" });
    if (onPort === "taken") {
      const there = await whoAt({ port }).catch(() => undefined);
      if (there?.home === homeHash(options.baseDir)) return undefined;
      throw new Error(`the engine's pipe could not be created (${reason}), and port ${port} is in use by ${there === undefined ? "something else" : `JaiRA for another base root (pid ${there.pid})`}`);
    }
    if (onPort !== "listening") throw new Error(`the engine's pipe could not be created (${reason}), nor port ${port} (${onPort.failed.message})`);
    options.log?.("warn", `the engine's pipe could not be created (${reason}), so it listens on 127.0.0.1:${port}`);
  }
  const token = options.token ?? randomBytes(32).toString("hex");
  const host = new EngineHost(server, options, token, { pipe, ...(port !== undefined ? { port } : {}) });
  writeEngineFile(options.baseDir, { ...host.info, token });
  options.log?.("info", `this process hosts the engine (${options.kind}) on ${port !== undefined ? `127.0.0.1:${port}` : pipe}`);
  return host;
}
