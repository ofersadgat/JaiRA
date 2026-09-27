/**
 * The engine's network listener (decision 0013 §2): HTTP on loopback only, which Tailscale — the
 * installed app's `tailscale serve`, or the bundled helper — publishes to the person's tailnet as HTTPS.
 * Nothing here listens on another interface.
 *
 *  - `GET /.well-known/jaira` says which machine and which JaiRA this is. No token needed.
 *  - `/engine` upgrades to a WebSocket carrying the engine's frames, one per message. A client proves
 *    it is a paired machine with the token in its `hello` (`machineTokens.ts`), never in the URL.
 */
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { ENGINE_CONTRACT } from "./enginePipe";
import { wsHostChannel } from "./engineChannel";
import type { EngineHost } from "./engineHost";
import type { MachineIdentity } from "./machine";
import { acceptWebSocket } from "./wsServer";

/** Where the listener tries first: after the local fallback port (`ENGINE_PORT`, 47317). */
export const NETWORK_PORT = 47_318;

export interface NetworkListener {
  port: number;
  close(): Promise<void>;
}

export interface NetworkListenerOptions {
  host: EngineHost;
  identity: () => MachineIdentity;
  version: string;
  /** Default {@link NETWORK_PORT}; taken, any free port is used and said. */
  port?: number;
  log?: (level: "info" | "warn", message: string) => void;
}

function listenOn(server: Server, port: number): Promise<number | "taken"> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (e.code === "EADDRINUSE") resolve("taken");
      else reject(e);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function listenNetwork(options: NetworkListenerOptions): Promise<NetworkListener> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/jaira") {
      const identity = options.identity();
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ jaira: true, machineId: identity.id, label: identity.label, os: identity.os, version: options.version, contract: ENGINE_CONTRACT }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not here\n");
  });
  // Upgraded sockets are the server's no longer, but its `close` still waits for them: kept to end them.
  const upgraded = new Set<Duplex>();
  server.on("upgrade", (request, socket, head) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    if (request.url !== "/engine") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const connection = acceptWebSocket(request, socket, head);
    if (connection !== undefined) options.host.accept(wsHostChannel(connection));
  });
  const wanted = options.port ?? NETWORK_PORT;
  let port = await listenOn(server, wanted);
  if (port === "taken") {
    port = (await listenOn(server, 0)) as number;
    options.log?.("warn", `port ${wanted} is in use, so other machines reach this one through port ${port}`);
  }
  const bound = port;
  options.log?.("info", `the engine listens for other machines on 127.0.0.1:${bound}`);
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        for (const socket of upgraded) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
