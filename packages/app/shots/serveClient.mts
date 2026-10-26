/**
 * The built client over plain HTTP, for a browser standing in for the phone: the engine serves no client
 * (decision 0022 §6), so the phone rigs serve `dist/client` themselves, as the window's own protocol
 * resolves it — without its policy header, whose `connect-src 'self'` would keep the page off the
 * engine's port.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { clientFile } from "@jaira/service/clientFiles";

const CLIENT = join(import.meta.dirname, "..", "dist", "client");

export function serveClient(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const found = clientFile(CLIENT, (request.url ?? "/").split(/[?#]/)[0] ?? "/");
    if ("status" in found) {
      response.writeHead(found.status);
      response.end(found.reason);
      return;
    }
    response.writeHead(200, { "content-type": found.html ? "text/html; charset=utf-8" : found.type });
    response.end(readFileSync(found.file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}
