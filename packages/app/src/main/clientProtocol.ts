import { readFileSync } from "node:fs";
import { protocol } from "electron";
import { clientFile, clientHeaders } from "@jaira/service";

/**
 * The One client, served to the window from `app://jaira/` (decision 0015, S1).
 *
 * Not `loadFile`: One has no hash history, so under `file://` its router would read the file's path
 * as the route. A standard, secure scheme gives the page an ordinary origin, absolute `/assets/…`
 * URLs resolve against it, and a path that is not a file falls back to `index.html` the way a static
 * host serves an SPA.
 *
 * Which file a path means, and the content policy a page goes out with, are `@jaira/service`'s
 * (`clientFiles.ts`): the engine's listener serves the same client to a browser by the same rules.
 */
export const CLIENT_SCHEME = "app";
export const CLIENT_URL = `${CLIENT_SCHEME}://jaira/`;

/** For `protocol.registerSchemesAsPrivileged`, which Electron accepts once, before `ready`. */
export const CLIENT_SCHEME_PRIVILEGES = {
  scheme: CLIENT_SCHEME,
  // `supportFetchAPI` because Vite's worker and chunk loading fetch same-origin URLs. `stream` so
  // large chunks (Monaco is ~4 MB) are not buffered twice.
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
} as const;

/** Serve `root` (One's `dist/client`) on the client scheme. Call once, after `app` is ready. */
export function registerClientProtocol(root: string): void {
  protocol.handle(CLIENT_SCHEME, (request) => {
    const found = clientFile(root, new URL(request.url).pathname);
    if ("status" in found) return new Response(found.reason, { status: found.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const body = readFileSync(found.file);
    return new Response(body, { headers: clientHeaders(found, body) });
  });
}
