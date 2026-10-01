/**
 * The built One client (decision 0015) as static files: which file a URL path means, and the headers it
 * goes out with. Two things serve it and must serve it alike — the desktop's `app://` protocol to its
 * own window (`clientProtocol.ts`), and the engine's loopback listener to a browser paired as a device
 * (`engineNet.ts`, decision 0013 amended 2026-09-30) — so the path rules and the content policy are
 * here once.
 *
 * Read-only, and files only: a path that leaves the root is refused, a folder is never listed, and a
 * path that is no file is the SPA's page, as a static host serves one.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

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
 * The page's content policy, as a header.
 *
 * The page loads only its own bundle: no remote code, no inline eval, no CDN.
 * - `script-src` carries a hash per inline `<script>` in the page: One's SPA shell sets four globals
 *   inline before its modules load, and a hash admits exactly those four and nothing else, where
 *   `'unsafe-inline'` would admit anything injected.
 * - `'wasm-unsafe-eval'` is for the TextMate tokenizer (`textmate.ts`): the grammars run on an
 *   Oniguruma WASM build, and instantiating WebAssembly is compilation, which a bare `script-src
 *   'self'` refuses — silently, the app then falling back to Monaco's own tokenizer. It is the NARROW
 *   directive for exactly that: it permits WebAssembly and nothing else, and in particular not `eval()`
 *   of JavaScript, which `'unsafe-eval'` would. The module is bundled, so this admits no remote code.
 * - `worker-src` and `font-src` are for Monaco (CHANGESETS.md §7.3): its diff computation runs in a
 *   bundled worker (`'self'`; the bundler may wrap one in a `blob:` URL), and its icons are a bundled
 *   font.
 * - `frame-src` names the artifact scheme because an interactive artifact is loaded from it, and
 *   because WITHOUT the directive it falls through to `default-src 'none'` and the frame is refused
 *   before it is fetched. It admits that scheme and nothing else: a static artifact is still shown from
 *   `srcdoc`, which needs no allowance here and gets no scripts — the page's own `script-src` is
 *   inherited by such a frame, which is precisely why an interactive one cannot use `srcdoc` at all.
 * - `connect-src 'self'` is what lets a browser's page reach the engine that served it and no other:
 *   over HTTP(S), `'self'` covers the same host's WebSocket.
 */
export function clientPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`);
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

/** The file a path means, or why there is none: `400` a path that cannot be read, `403` one that leaves the root, `404` no client built. */
export type ClientFile = { file: string; type: string; html: boolean } | { status: 400 | 403 | 404; reason: string };

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Which file under `root` (One's `dist/client`) a URL's path means. `path` is the URL's pathname, still
 * percent-encoded.
 *
 * - A file is itself.
 * - A route with a page of its own (`/native` → `native.html`) gets that page, with only the
 *   stylesheets it links.
 * - Anything else — a folder too — is `index.html`.
 * - Nothing outside `root`, whatever a path carries: an encoded `..`, a backslash Windows reads as a
 *   separator, a NUL.
 */
export function clientFile(root: string, path: string): ClientFile {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { status: 400, reason: "that path cannot be read" };
  }
  if (decoded.includes("\0")) return { status: 400, reason: "that path cannot be read" };
  const base = normalize(root);
  const file = normalize(join(base, decoded));
  const inside = file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
  if (!inside) return { status: 403, reason: "that path is outside the client" };
  const index = join(base, "index.html");
  const target = isFile(file) ? file : file !== base && isFile(`${file}.html`) ? `${file}.html` : index;
  if (target === index && !isFile(index)) return { status: 404, reason: "the One client is not built (npm --workspace @jaira/app run build:client)" };
  const extension = extname(target).toLowerCase();
  return { file: target, type: TYPES[extension] ?? "application/octet-stream", html: extension === ".html" };
}

/** The headers a client file goes out with: its type, no sniffing, and the content policy on a page. */
export function clientHeaders(found: { type: string; html: boolean }, body: Buffer): Record<string, string> {
  return {
    "Content-Type": found.type,
    "X-Content-Type-Options": "nosniff",
    ...(found.html ? { "Content-Security-Policy": clientPolicy(body.toString("utf8")) } : {}),
  };
}
