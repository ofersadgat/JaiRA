/**
 * The Content-Security-Policy an artifact's frame is served under (decision 0020 §4).
 *
 * One function, because three places serve artifact bytes and must not disagree: the desktop window's
 * `jaira-artifact:` handler, the engine's HTTP route a phone loads the same page from, and the tests.
 *
 * - `static`: a page that may not run anything — the old default for an artifact nobody marked.
 * - `scripts`: inline script and nothing reachable — a value a workflow produced and marked runnable.
 * - `page`: a published page, under what a Claude Code artifact page is written for: inline script
 *   and scripts from cdnjs, unpkg, the Tailwind and jQuery CDNs and jsDelivr's `/npm/`; styles inline
 *   and from Google Fonts; fonts from Google Fonts and data URIs; images as data URIs; `fetch` to its
 *   own origin and Google Fonts; no frames, forms or base. Nothing is uploaded: the page runs here.
 * - `canvas`: an artboard of a design canvas — the page's policy, plus `'self'` for the runtime and
 *   the sibling files the frame loads by relative URL (`./support.js`, a `dc-import`ed artboard,
 *   `/_blob/` assets), and `'unsafe-eval'`, because the runtime builds each artboard's logic class from
 *   its script text with `new Function`.
 */
export type ArtifactPolicy = "static" | "scripts" | "page" | "canvas";

const CDNS = "https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com https://cdn.jsdelivr.net/npm/";
const FONTS_CSS = "https://fonts.googleapis.com";
const FONTS = "https://fonts.gstatic.com";

export function artifactPolicy(policy: ArtifactPolicy, options: { sandbox?: boolean } = {}): string {
  /*
   * `sandbox`: the engine's HTTP route (the phone's). There every grant shares the one origin a phone
   * reaches the engine at, so a grant is not an origin of its own as it is on the desktop; sandboxed
   * without `allow-same-origin`, each page is an opaque origin instead, which keeps it from every other
   * page and from the engine's own address. What it costs: no storage or cookies inside the page.
   */
  if (options.sandbox === true) return `${artifactPolicy(policy)}; sandbox${policy === "static" ? "" : " allow-scripts allow-popups"}`;
  const closed = "frame-src 'none'; form-action 'none'; base-uri 'none'";
  switch (policy) {
    case "static":
      return `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; ${closed}`;
    case "scripts":
      return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; ${closed}`;
    case "page":
      return (
        `default-src 'none'; script-src 'unsafe-inline' ${CDNS}; style-src 'unsafe-inline' ${FONTS_CSS}; ` +
        `font-src ${FONTS} data:; img-src data: blob:; connect-src 'self' ${FONTS_CSS} ${FONTS}; ${closed}`
      );
    case "canvas":
      return (
        `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CDNS}; style-src 'self' 'unsafe-inline' ${FONTS_CSS}; ` +
        `font-src 'self' ${FONTS} data:; img-src 'self' data: blob:; connect-src 'self' ${FONTS_CSS} ${FONTS}; ${closed}`
      );
  }
}

/** The media type a published artifact's file is served as. */
export function publishedMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "text/javascript";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}
