/**
 * A client of the engine on the local pipe (decision 0012 §3): the desktop when another process hosts
 * the engine (step 4), and the CLI when the app or `jaira serve` is running (step 6). It says hello with
 * the token from `engine.json`, then sends requests by channel and hears every push.
 */
import { createConnection, type Socket } from "node:net";
import type { PushMessage } from "@jaira/shared";
import { ENGINE_CONTRACT, FrameReader, encodeFrame, enginePipePath, readEngineFile, type EngineHostInfo, type HostFrame } from "./enginePipe";

export interface EngineClientOptions {
  baseDir: string;
  /** Who is connecting, for the host's log: `desktop`, `jaira run`, … */
  client: string;
  version: string;
  /** Tests: another pipe, another token. Otherwise both come from the base root. */
  pipe?: string;
  token?: string;
  /** How long to wait for the host's answer to hello. */
  timeoutMs?: number;
}

/** The engine refused this client, or could not be reached. */
export class EngineUnavailable extends Error {}

export class EngineClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: PushMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    readonly host: EngineHostInfo,
  ) {}

  /** Ask the engine; the answer, or the engine's error as an Error with its message. */
  invoke(channel: string, request: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new EngineUnavailable("the engine went away"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeFrame({ t: "req", id, channel, request: request === undefined ? null : request }));
    });
  }

  onPush(listener: (message: PushMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The host went away (it quit, or was stopped). */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.ended();
  }

  /** @internal — the socket's frames after the welcome. */
  handle(frame: HostFrame): void {
    if (frame.t === "push") {
      for (const listener of this.listeners) listener(frame.message);
      return;
    }
    if (frame.t !== "res") return;
    const waiting = this.pending.get(frame.id);
    if (waiting === undefined) return;
    this.pending.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else {
      const error = new Error(frame.error.message);
      if (frame.error.name !== undefined) error.name = frame.error.name;
      waiting.reject(error);
    }
  }

  /** @internal */
  ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) waiting.reject(new EngineUnavailable("the engine went away"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}

/** Connect to the engine hosted for this base root, or fail with {@link EngineUnavailable} saying why. */
export function connectEngine(options: EngineClientOptions): Promise<EngineClient> {
  const pipe = options.pipe ?? enginePipePath(options.baseDir);
  const token = options.token ?? readEngineFile(options.baseDir)?.token;
  if (token === undefined) return Promise.reject(new EngineUnavailable("no engine.json: nothing hosts the engine, or it cannot be read"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    const reader = new FrameReader();
    let client: EngineClient | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EngineUnavailable(`the engine on ${pipe} did not answer`));
    }, options.timeoutMs ?? 5000);
    socket.once("connect", () => {
      socket.write(encodeFrame({ t: "hello", token, contract: ENGINE_CONTRACT, version: options.version, client: options.client }));
    });
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        socket.destroy();
        reject(new EngineUnavailable((e as Error).message));
        return;
      }
      for (const raw of frames) {
        const frame = raw as HostFrame;
        if (client !== undefined) {
          client.handle(frame);
          continue;
        }
        clearTimeout(timer);
        if (frame.t === "welcome") {
          client = new EngineClient(socket, frame.host);
          resolve(client);
        } else {
          socket.destroy();
          reject(new EngineUnavailable(frame.t === "refused" ? frame.reason : "the engine did not say welcome"));
        }
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      if (client === undefined) reject(new EngineUnavailable(`nothing answers on ${pipe}: ${e.message}`));
    });
    socket.on("close", () => client?.ended());
  });
}
