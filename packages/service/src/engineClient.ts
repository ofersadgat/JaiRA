/**
 * A client of an engine (decisions 0012 §3, 0013 §2): the desktop when another process hosts the
 * engine, the CLI when the app or `jaira serve` is running, and another machine's engine over the
 * network. It says hello with a token — `engine.json`'s on this machine, a machine token over the
 * network — then sends requests by channel and hears every push.
 */
import { createConnection } from "node:net";
import type { PushMessage } from "@jaira/shared";
import { streamChannel, wsClientChannel, type FrameChannel } from "./engineChannel";
import { ENGINE_CONTRACT, enginePipePath, readEngineFile, type EngineHostInfo, type HostFrame } from "./enginePipe";

/** Where a host listens: its pipe (or Unix socket), the loopback port, or another machine's URL. */
export type EngineAddress = { pipe: string } | { port: number } | { url: string };

export function describeAddress(address: EngineAddress): string {
  return "pipe" in address ? address.pipe : "port" in address ? `127.0.0.1:${address.port}` : address.url;
}

/** Open a channel to an address. */
export function openChannel(address: EngineAddress, timeoutMs = 10_000): Promise<FrameChannel> {
  if ("url" in address) return wsClientChannel(address.url, timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = "pipe" in address ? createConnection(address.pipe) : createConnection(address.port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EngineUnavailable(`nothing answered on ${describeAddress(address)}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(streamChannel(socket, "pipe"));
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(new EngineUnavailable(`nothing answers on ${describeAddress(address)}: ${e.message}`));
    });
  });
}

export interface EngineClientOptions {
  baseDir: string;
  /** Who is connecting, for the host's log and `jaira server status`: `desktop`, `jaira run`, … */
  client: string;
  version: string;
  /** Where to connect. Default: this base root's pipe. */
  address?: EngineAddress;
  /** The token to say hello with: `engine.json`'s by default; a machine token for a network address. */
  token?: string;
  /** Tests: another contract. */
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
    private readonly channel: FrameChannel,
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
      this.channel.send({ t: "req", id, channel, request: request === undefined ? null : request });
    });
  }

  onPush(listener: (message: PushMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The host went away (it quit, was stopped, or the network dropped). */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.channel.end();
    this.ended();
  }

  /** @internal — the channel's frames after the welcome. */
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

/**
 * Send one frame before `hello` and read the one answer: `who`, and pairing (decision 0013 §3). No token
 * is needed, and the channel is closed after.
 */
export async function askOnce(address: EngineAddress, frame: Record<string, unknown>, timeoutMs = 5000): Promise<HostFrame> {
  const channel = await openChannel(address, timeoutMs).catch((e: unknown) => {
    throw e instanceof EngineUnavailable ? e : new EngineUnavailable((e as Error).message);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.destroy();
      reject(new EngineUnavailable(`no answer from ${describeAddress(address)}`));
    }, timeoutMs);
    channel.onFrame((answer) => {
      clearTimeout(timer);
      channel.end();
      resolve(answer as HostFrame);
    });
    channel.onBroken((reason) => {
      clearTimeout(timer);
      reject(new EngineUnavailable(reason));
    });
    channel.onClose(() => {
      clearTimeout(timer);
      reject(new EngineUnavailable(`${describeAddress(address)} closed the connection`));
    });
    channel.send(frame);
  });
}

/**
 * Ask whoever listens at an address who it is — no token needed, and nothing but the host's info in
 * return. Rejects when nothing answers, or something that is not a JaiRA engine does.
 */
export async function whoAt(address: EngineAddress, timeoutMs = 1500): Promise<EngineHostInfo> {
  const answer = await askOnce(address, { t: "who" }, timeoutMs);
  if (answer.t !== "info") throw new EngineUnavailable("the answer was not a JaiRA engine's");
  return answer.host;
}

/** Connect to an engine, or fail with {@link EngineUnavailable} saying why. */
export async function connectEngine(options: EngineClientOptions): Promise<EngineClient> {
  const address = options.address ?? { pipe: enginePipePath(options.baseDir) };
  const token = options.token ?? ("url" in address ? undefined : readEngineFile(options.baseDir)?.token);
  if (token === undefined) {
    throw new EngineUnavailable("url" in address ? "no token for that machine: pair with it first" : "no engine.json: nothing hosts the engine, or it cannot be read");
  }
  const channel = await openChannel(address, options.timeoutMs ?? 5000).catch((e: unknown) => {
    throw e instanceof EngineUnavailable ? e : new EngineUnavailable((e as Error).message);
  });
  return new Promise((resolve, reject) => {
    let client: EngineClient | undefined;
    const timer = setTimeout(() => {
      channel.destroy();
      reject(new EngineUnavailable(`the engine at ${describeAddress(address)} did not answer`));
    }, options.timeoutMs ?? 5000);
    channel.onFrame((raw) => {
      const frame = raw as HostFrame;
      if (client !== undefined) {
        client.handle(frame);
        return;
      }
      clearTimeout(timer);
      if (frame.t === "welcome") {
        client = new EngineClient(channel, frame.host, frame.limited === true);
        resolve(client);
      } else {
        channel.destroy();
        reject(new EngineUnavailable(frame.t === "refused" ? frame.reason : "the engine did not say welcome"));
      }
    });
    channel.onBroken((reason) => {
      clearTimeout(timer);
      if (client === undefined) reject(new EngineUnavailable(reason));
      else client.ended();
    });
    channel.onClose(() => {
      clearTimeout(timer);
      if (client === undefined) reject(new EngineUnavailable(`${describeAddress(address)} closed the connection`));
      else client.ended();
    });
    channel.send({ t: "hello", token, contract: options.contract ?? ENGINE_CONTRACT, version: options.version, client: options.client, pid: process.pid });
  });
}
