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
  FrameReader,
  encodeFrame,
  enginePipePath,
  removeEngineFile,
  writeEngineFile,
  type ClientFrame,
  type EngineHostInfo,
  type HostFrame,
} from "./enginePipe";
import type { Handler } from "./handlers";

export interface EngineHostOptions {
  baseDir: string;
  kind: EngineHostInfo["kind"];
  /** The JaiRA version this host runs. */
  version: string;
  /** What answers each channel: the service's, and whatever the host adds. */
  handlers: Partial<Record<string, Handler>>;
  /** A handler that threw: the IPC path records it the same way. */
  onFailure?: (channel: string, error: unknown) => void;
  log?: (level: "info" | "warn", message: string) => void;
  /** Tests: another pipe, another token. */
  pipe?: string;
  token?: string;
}

interface Client {
  socket: Socket;
  reader: FrameReader;
  /** Past `hello`: may send requests and hears pushes. */
  admitted: boolean;
  name: string;
}

export class EngineHost {
  readonly info: EngineHostInfo;
  private readonly clients = new Set<Client>();

  constructor(
    private readonly server: Server,
    private readonly options: EngineHostOptions,
    private readonly token: string,
    pipe: string,
  ) {
    this.info = { kind: options.kind, pid: process.pid, version: options.version, contract: ENGINE_CONTRACT, pipe, startedAt: Date.now() };
    server.on("connection", (socket) => this.accept(socket));
  }

  /** How many clients are past `hello`. */
  admitted(): number {
    return [...this.clients].filter((c) => c.admitted).length;
  }

  /** Send a push to every client past `hello`. */
  broadcast(message: PushMessage): void {
    const frame = encodeFrame({ t: "push", message });
    for (const client of this.clients) if (client.admitted && !client.socket.destroyed) client.socket.write(frame);
  }

  /** Stop answering: every client is disconnected, the pipe goes, and so does `engine.json`. */
  async close(): Promise<void> {
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    removeEngineFile(this.options.baseDir, process.pid);
  }

  private accept(socket: Socket): void {
    const client: Client = { socket, reader: new FrameReader(), admitted: false, name: "client" };
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
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
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
      if (frame.t !== "hello") return this.refuse(client, "say hello first");
      if (!sameToken(frame.token, this.token)) return this.refuse(client, "the token does not match this engine's");
      if (frame.contract !== ENGINE_CONTRACT) {
        return this.refuse(client, `this engine speaks another contract: JaiRA ${this.info.version} here, ${frame.version} there`);
      }
      // Welcome BEFORE admitting and logging: the log line is itself a push, broadcast to the admitted,
      // and a client's first frame must be its welcome.
      this.send(client, { t: "welcome", host: this.info });
      client.admitted = true;
      client.name = frame.client;
      this.options.log?.("info", `${frame.client} connected to the engine`);
      return;
    }
    if (frame.t !== "req") return;
    const handler = this.options.handlers[frame.channel];
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

function listen(server: Server, pipe: string): Promise<"listening" | "taken"> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (e.code === "EADDRINUSE") resolve("taken");
      else reject(e);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipe);
  });
}

/**
 * Claim the engine for this process: listen on the pipe and write `engine.json`. Answers `undefined`
 * when another process holds it. On POSIX a socket file with nobody behind it (a host that died) is
 * removed and the claim tried once more; on Windows a pipe disappears with its process.
 */
export async function claimEngine(options: EngineHostOptions): Promise<EngineHost | undefined> {
  const pipe = options.pipe ?? enginePipePath(options.baseDir);
  if (process.platform !== "win32") {
    mkdirSync(dirname(pipe), { recursive: true, mode: 0o700 });
    chmodSync(dirname(pipe), 0o700);
  }
  let server = createServer();
  let outcome = await listen(server, pipe);
  if (outcome === "taken" && process.platform !== "win32" && !(await answers(pipe))) {
    rmSync(pipe, { force: true });
    server = createServer();
    outcome = await listen(server, pipe);
  }
  if (outcome === "taken") return undefined;
  const token = options.token ?? randomBytes(32).toString("hex");
  const host = new EngineHost(server, options, token, pipe);
  writeEngineFile(options.baseDir, { ...host.info, token });
  options.log?.("info", `this process hosts the engine (${options.kind}) on ${pipe}`);
  return host;
}
