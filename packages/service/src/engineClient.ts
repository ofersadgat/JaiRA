/**
 * A client of the engine on the local pipe (decision 0012 §3): the desktop when another process hosts
 * the engine (step 4), and the CLI when the app or `jaira serve` is running (step 6). It says hello with
 * the token from `engine.json`, then sends requests by channel and hears every push.
 */
import { createConnection, type Socket } from "node:net";
import type { PushMessage } from "@jaira/shared";
import { ENGINE_CONTRACT, FrameReader, encodeFrame, enginePipePath, readEngineFile, type EngineHostInfo, type HostFrame } from "./enginePipe";

/** Where a host listens: its pipe (or Unix socket), or the loopback port. */
export type EngineAddress = { pipe: string } | { port: number };

export function describeAddress(address: EngineAddress): string {
  return "pipe" in address ? address.pipe : `127.0.0.1:${address.port}`;
}

function open(address: EngineAddress): Socket {
  return "pipe" in address ? createConnection(address.pipe) : createConnection(address.port, "127.0.0.1");
}

export interface EngineClientOptions {
  baseDir: string;
  /** Who is connecting, for the host's log and `jaira server status`: `desktop`, `jaira task start`, … */
  client: string;
  version: string;
  /** Where to connect. Default: this base root's pipe. */
  address?: EngineAddress;
  /** Tests: another token (otherwise it comes from `engine.json`), another contract. */
  token?: string;
  contract?: string;
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
    /** The host speaks another contract: only `engine:*` channels answer (see `HostFrame`). */
    readonly limited: boolean,
  ) {}

  /** Whether the host is still there. */
  get open(): boolean {
    return !this.closed;
  }

  /** Ask the engine; the answer, or the engine's error as an Error with its message and name. */
  invoke(channel: string, request?: unknown): Promise<unknown> {
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

/** Read frames off a socket until `take` settles; a malformed stream ends it. */
function frames(socket: Socket, onFrame: (frame: HostFrame) => void, onBad: (error: Error) => void): void {
  const reader = new FrameReader();
  socket.on("data", (chunk) => {
    let got: unknown[];
    try {
      got = reader.push(chunk);
    } catch (e) {
      socket.destroy();
      onBad(e as Error);
      return;
    }
    for (const frame of got) onFrame(frame as HostFrame);
  });
}

/**
 * Ask whoever listens at an address who it is — no token needed, and nothing but the host's info in
 * return (§4 steps 2–3). Rejects when nothing answers, or something that is not a JaiRA engine does.
 */
export function whoAt(address: EngineAddress, timeoutMs = 1500): Promise<EngineHostInfo> {
  return new Promise((resolve, reject) => {
    const socket = open(address);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EngineUnavailable(`nothing answered on ${describeAddress(address)}`));
    }, timeoutMs);
    const done = (outcome: () => void): void => {
      clearTimeout(timer);
      socket.destroy();
      outcome();
    };
    socket.once("connect", () => socket.write(encodeFrame({ t: "who" })));
    frames(
      socket,
      (frame) => done(() => (frame.t === "info" ? resolve(frame.host) : reject(new EngineUnavailable("the answer was not a JaiRA engine's")))),
      (e) => done(() => reject(new EngineUnavailable(e.message))),
    );
    socket.on("error", (e) => done(() => reject(new EngineUnavailable(`nothing answers on ${describeAddress(address)}: ${e.message}`))));
  });
}

/** Connect to the engine hosted for this base root, or fail with {@link EngineUnavailable} saying why. */
export function connectEngine(options: EngineClientOptions): Promise<EngineClient> {
  const address = options.address ?? { pipe: enginePipePath(options.baseDir) };
  const token = options.token ?? readEngineFile(options.baseDir)?.token;
  if (token === undefined) return Promise.reject(new EngineUnavailable("no engine.json: nothing hosts the engine, or it cannot be read"));
  return new Promise((resolve, reject) => {
    const socket = open(address);
    let client: EngineClient | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EngineUnavailable(`the engine on ${describeAddress(address)} did not answer`));
    }, options.timeoutMs ?? 5000);
    socket.once("connect", () => {
      socket.write(encodeFrame({ t: "hello", token, contract: options.contract ?? ENGINE_CONTRACT, version: options.version, client: options.client, pid: process.pid }));
    });
    frames(
      socket,
      (frame) => {
        if (client !== undefined) {
          client.handle(frame);
          return;
        }
        clearTimeout(timer);
        if (frame.t === "welcome") {
          client = new EngineClient(socket, frame.host, frame.limited === true);
          resolve(client);
        } else {
          socket.destroy();
          reject(new EngineUnavailable(frame.t === "refused" ? frame.reason : "the engine did not say welcome"));
        }
      },
      (e) => {
        clearTimeout(timer);
        if (client === undefined) reject(new EngineUnavailable(e.message));
        else client.ended();
      },
    );
    socket.on("error", (e) => {
      clearTimeout(timer);
      if (client === undefined) reject(new EngineUnavailable(`nothing answers on ${describeAddress(address)}: ${e.message}`));
    });
    socket.on("close", () => client?.ended());
  });
}
