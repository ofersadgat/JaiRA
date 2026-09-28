import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { protocol } from "electron";

/**
 * The One client, served to the window from `app://jaira/` (decision 0015, S1).
 *
 * Not `loadFile`: One has no hash history, so under `file://` its router would read the file's path
 * as the route. A standard, secure scheme gives the page an ordinary origin, absolute `/assets/…`
 * URLs resolve against it, and a path that is not a file falls back to `index.html` the way a static
 * host serves an SPA.
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The window's content policy, as a header.
 *
 * The directives are the ones `packages/app/src/renderer/index.html` carries in its `<meta>`, and
 * for the same reasons (read them there). The one addition is a hash per inline `<script>` in
 * `index.html`: One's SPA shell sets four globals inline before its modules load, and a hash admits
 * exactly those four and nothing else, where `'unsafe-inline'` would admit anything injected.
 */
function policyFor(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src jaira-artifact:",
  ].join("; ");
}

/** Serve `root` (One's `dist/client`) on the client scheme. Call once, after `app` is ready. */
export function registerClientProtocol(root: string): void {
  const index = join(root, "index.html");
  protocol.handle(CLIENT_SCHEME, (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = normalize(join(root, path));
    // Nothing outside `root`, whatever `..` a URL carries.
    const inside = file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : index;
    const body = readFileSync(target);
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    if (target === index) headers["Content-Security-Policy"] = policyFor(body.toString("utf8"));
    return new Response(body, { headers });
  });
}
