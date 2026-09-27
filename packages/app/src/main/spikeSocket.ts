import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { IPC_CHANNELS, type IpcChannel, type PushMessage } from "@jaira/shared";

/**
 * THROWAWAY (decision 0013, S2): the quickest remote transport that works, so a phone or a browser on
 * another machine can drive this window's engine. The real remote step is being built elsewhere and
 * replaces this file and `socketBridge.ts` together; nothing else knows either exists.
 *
 * On when `JAIRA_SPIKE_WS=<port>` is set, and not otherwise. It listens on every interface, prints a
 * random token to the log, and trusts whoever sends that token first. No TLS, no pairing, no
 * per-connection state: every client shares this window's current project.
 *
 * The same port serves the One client over plain HTTP (`http://<desktop>:<port>/`), so a browser
 * elsewhere needs one address: the page connects back to the host it came from and asks for the token.
 *
 * Frames are JSON, one per message:
 *   → {hello: {token}}                     first, and nothing is answered before it
 *   ← {hello: {channels}}                   the contract size, a cheap version check
 *   → {id, channel, request}                ← {id, result} | {id, error}
 *   ←  {push: PushMessage}                  every push, to every client
 */
export interface SpikeSocket {
  publish(message: PushMessage): void;
}

/** The OS verbs: they act on THIS machine's screen, which a remote client is not in front of. */
const refused = (channel: string): boolean => channel.startsWith("shell:") || channel === "project:choose";
const known = new Set<string>(IPC_CHANNELS);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function startSpikeSocket(
  port: number,
  clientDir: string,
  dispatch: (channel: IpcChannel, request: unknown) => Promise<unknown>,
  log: (line: string) => void,
): SpikeSocket {
  const token = randomBytes(16).toString("hex");
  const index = join(clientDir, "index.html");
  const http = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const file = normalize(join(clientDir, path));
    const inside = file.startsWith(clientDir.endsWith(sep) ? clientDir : clientDir + sep);
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : index;
    if (!existsSync(target)) {
      response.writeHead(404).end("the One client is not built (npm --workspace @jaira/app run build:client)");
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" });
    response.end(readFileSync(target));
  });
  http.listen(port, "0.0.0.0");
  const server = new WebSocketServer({ server: http });
  const clients = new Set<WebSocket>();
  log(`spike socket (0013 S2, throwaway) on http://0.0.0.0:${port}/ — token ${token}`);

  const matches = (offered: unknown): boolean => {
    if (typeof offered !== "string" || offered.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(offered), Buffer.from(token));
  };

  server.on("connection", (socket) => {
    let admitted = false;
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (raw) => {
      let frame: { hello?: { token?: unknown }; id?: unknown; channel?: unknown; request?: unknown };
      try {
        frame = JSON.parse(String(raw)) as typeof frame;
      } catch {
        socket.close(1003, "not JSON");
        return;
      }
      if (!admitted) {
        if (!matches(frame.hello?.token)) {
          socket.close(1008, "bad token");
          return;
        }
        admitted = true;
        clients.add(socket);
        socket.send(JSON.stringify({ hello: { channels: IPC_CHANNELS.length } }));
        return;
      }
      const { id, channel, request } = frame;
      const answer = (body: { result: unknown } | { error: string }): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id, ...body }));
      };
      if (typeof channel !== "string" || !known.has(channel)) return answer({ error: `unknown channel '${String(channel)}'` });
      if (refused(channel)) return answer({ error: `'${channel}' acts on the desktop's own screen and is not offered remotely` });
      dispatch(channel as IpcChannel, request).then(
        (result) => answer({ result: result ?? null }),
        (e: unknown) => answer({ error: (e as Error)?.message ?? String(e) }),
      );
    });
  });

  return {
    publish(message) {
      if (clients.size === 0) return;
      const frame = JSON.stringify({ push: message });
      for (const client of clients) if (client.readyState === client.OPEN) client.send(frame);
    },
  };
}
