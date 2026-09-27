/**
 * One connection between an engine host and a client, whatever carries it (decisions 0012 §3, 0013 §2):
 * the local pipe, where frames are length-prefixed on a byte stream, or a WebSocket from another
 * machine, where each message is one frame. The host and the client speak `ClientFrame`/`HostFrame`
 * over either and never see which.
 */
import type { Socket } from "node:net";
import { FrameReader, encodeFrame } from "./enginePipe";
import type { WsConnection } from "./wsServer";

/** How a connection arrived: the local pipe (proved by `engine.json`'s token) or the network (a machine token). */
export type EngineTransport = "pipe" | "network";

export interface FrameChannel {
  readonly transport: EngineTransport;
  send(frame: unknown): void;
  /** End after what was sent. */
  end(): void;
  destroy(): void;
  readonly destroyed: boolean;
  onFrame(listener: (frame: unknown) => void): void;
  /** A stream that cannot be read as frames. The channel is already ending. */
  onBroken(listener: (reason: string) => void): void;
  onClose(listener: () => void): void;
}

/** Frames on a byte stream: the pipe, or a Unix socket, or the loopback port's TCP. */
export function streamChannel(socket: Socket, transport: EngineTransport = "pipe"): FrameChannel {
  const reader = new FrameReader();
  const frames = new Set<(frame: unknown) => void>();
  const broken = new Set<(reason: string) => void>();
  const closed = new Set<() => void>();
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const listener of closed) listener();
  };
  socket.on("data", (chunk: Buffer) => {
    let got: unknown[];
    try {
      got = reader.push(chunk);
    } catch (e) {
      for (const listener of broken) listener((e as Error).message);
      socket.destroy();
      return;
    }
    for (const frame of got) for (const listener of frames) listener(frame);
  });
  socket.on("close", finish);
  socket.on("error", finish);
  return {
    transport,
    send: (frame) => {
      if (!socket.destroyed) socket.write(encodeFrame(frame as never));
    },
    end: () => socket.end(),
    destroy: () => socket.destroy(),
    get destroyed() {
      return socket.destroyed;
    },
    onFrame: (listener) => void frames.add(listener),
    onBroken: (listener) => void broken.add(listener),
    onClose: (listener) => void closed.add(listener),
  };
}

/** One JSON frame per WebSocket message, on the host's side of a network connection. */
export function wsHostChannel(connection: WsConnection): FrameChannel {
  const frames = new Set<(frame: unknown) => void>();
  const broken = new Set<(reason: string) => void>();
  const closed = new Set<() => void>();
  connection.onMessage((text) => {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      for (const listener of broken) listener("a message that is not JSON");
      connection.close(1007, "not JSON");
      return;
    }
    for (const listener of frames) listener(frame);
  });
  connection.onClose(() => {
    for (const listener of closed) listener();
  });
  return {
    transport: "network",
    send: (frame) => connection.send(JSON.stringify(frame)),
    end: () => connection.close(1000),
    destroy: () => connection.destroy(),
    get destroyed() {
      return connection.closed;
    },
    onFrame: (listener) => void frames.add(listener),
    onBroken: (listener) => void broken.add(listener),
    onClose: (listener) => void closed.add(listener),
  };
}

/**
 * The client's side of a network connection, over the platform's own `WebSocket` (Node 22 and
 * Electron have it). Resolves once open; rejects when it cannot be.
 */
export function wsClientChannel(url: string, timeoutMs = 10_000): Promise<FrameChannel> {
  const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (WebSocketImpl === undefined) return Promise.reject(new Error("this runtime has no WebSocket"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const frames = new Set<(frame: unknown) => void>();
    const broken = new Set<(reason: string) => void>();
    const closed = new Set<() => void>();
    let open = false;
    let done = false;
    const timer = setTimeout(() => {
      if (open) return;
      ws.close();
      reject(new Error(`nothing answered at ${url}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      open = true;
      clearTimeout(timer);
      resolve({
        transport: "network",
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
        },
        end: () => ws.close(1000),
        destroy: () => ws.close(),
        get destroyed() {
          return ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING;
        },
        onFrame: (listener) => void frames.add(listener),
        onBroken: (listener) => void broken.add(listener),
        onClose: (listener) => void closed.add(listener),
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        for (const listener of broken) listener("a message that is not JSON");
        ws.close();
        return;
      }
      for (const listener of frames) listener(frame);
    });
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!open) reject(new Error(`could not connect to ${url}`));
      for (const listener of closed) listener();
    };
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
  });
}
