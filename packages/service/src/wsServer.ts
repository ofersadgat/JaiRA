/**
 * The server half of WebSocket (RFC 6455), as much as the engine's network transport needs (decision
 * 0013 §2): the upgrade handshake, text messages in both directions, fragments, ping and pong, and the
 * close handshake. Written here rather than taken as a dependency because that is all it is — the
 * client half is Node's own `WebSocket` — and a dependency would be one more package to bundle,
 * license and keep, for a few hundred lines of a stable standard.
 *
 * Binary messages are refused (the engine speaks JSON), as is anything not masked by the client, which
 * the standard requires of every client frame.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The largest message either side accepts, so a stray writer cannot make the other allocate without bound. */
export const MAX_WS_MESSAGE_BYTES = 256 * 1024 * 1024;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WsConnection {
  send(text: string): void;
  /** Close with a code and reason, then end the socket once the peer answers (or after a moment). */
  close(code?: number, reason?: string): void;
  destroy(): void;
  readonly closed: boolean;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/**
 * Answer an HTTP upgrade request as a WebSocket, or refuse it with 400. `head` is what arrived after
 * the headers, which the server's `upgrade` event hands over and which may already hold a frame.
 */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, options: { pingMs?: number; maxMessageBytes?: number } = {}): WsConnection | undefined {
  const key = request.headers["sec-websocket-key"];
  const upgrade = String(request.headers["upgrade"] ?? "").toLowerCase();
  if (typeof key !== "string" || upgrade !== "websocket" || request.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  return new Connection(socket, head, options.pingMs ?? 25_000, options.maxMessageBytes ?? MAX_WS_MESSAGE_BYTES);
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.alloc(2);
    head[1] = length;
  } else if (length < 65_536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  head[0] = 0x80 | opcode; // FIN, and never masked from a server
  return Buffer.concat([head, payload]);
}

class Connection implements WsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private readonly messageListeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private isClosed = false;
  private sentClose = false;
  private awaitingPong = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
    pingMs: number,
    /** The largest message taken: a listener strangers can reach takes only small ones. */
    private readonly maxBytes: number,
  ) {
    socket.on("data", (chunk: Buffer) => this.take(chunk));
    socket.on("close", () => this.finish(1006, "the connection dropped"));
    socket.on("error", () => this.finish(1006, "the connection failed"));
    // A peer behind a proxy that silently dropped the connection is only noticed by asking it.
    this.timer = setInterval(() => {
      if (this.awaitingPong) {
        this.destroy();
        return;
      }
      this.awaitingPong = true;
      this.write(frame(OP.ping, Buffer.alloc(0)));
    }, pingMs);
    this.timer.unref?.();
    if (head.length > 0) this.take(head);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(text: string): void {
    if (this.isClosed || this.sentClose) return;
    this.write(frame(OP.text, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = ""): void {
    if (this.isClosed || this.sentClose) return;
    this.sentClose = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, "utf8");
    this.write(frame(OP.close, body));
    // The peer answers with its own close; one that does not is not waited for.
    setTimeout(() => this.destroy(), 1000).unref?.();
  }

  destroy(): void {
    this.socket.destroy();
    this.finish(1006, "closed");
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners.add(listener);
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListeners.add(listener);
  }

  private write(data: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(data);
  }

  private finish(code: number, reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    clearInterval(this.timer);
    for (const listener of this.closeListeners) listener(code, reason);
  }

  /** A protocol violation: say why, and end. */
  private fail(code: number, reason: string): void {
    this.close(code, reason);
  }

  private take(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let at = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) return this.fail(1009, "message too big");
        length = Number(big);
        at = 10;
      }
      if (length > this.maxBytes) return this.fail(1009, "message too big");
      if (!masked) return this.fail(1002, "client frames must be masked");
      if (this.buffer.length < at + 4 + length) return;
      const mask = this.buffer.subarray(at, at + 4);
      const payload = Buffer.from(this.buffer.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
      this.buffer = this.buffer.subarray(at + 4 + length);
      this.frameIn(fin, opcode, payload);
      if (this.isClosed) return;
    }
  }

  private frameIn(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP.ping:
        this.write(frame(OP.pong, payload));
        return;
      case OP.pong:
        this.awaitingPong = false;
        return;
      case OP.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!this.sentClose) {
          this.sentClose = true;
          this.write(frame(OP.close, payload.subarray(0, 2)));
        }
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case OP.binary:
        return this.fail(1003, "this engine speaks text");
      case OP.text:
      case OP.continuation: {
        if (opcode === OP.text && this.fragments.length > 0) return this.fail(1002, "a new message began inside a fragmented one");
        if (opcode === OP.continuation && this.fragments.length === 0) return this.fail(1002, "a continuation with nothing to continue");
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxBytes) return this.fail(1009, "message too big");
        if (!fin) return;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        for (const listener of this.messageListeners) listener(text);
        return;
      }
      default:
        return this.fail(1002, `unknown opcode ${opcode}`);
    }
  }
}
