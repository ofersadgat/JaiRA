/**
 * Canvas paths: an artboard's file named as `canvas.json`'s `boards` names it, relative to `project/`
 * (`Main.dc.html`, `sub/Cart.dc.html`).
 *
 * Links and imports are written relative to the artboard they are in, and a leading `/` means the
 * canvas root (format.md, "Links between artboards"). Resolving them to canvas paths here, rather than
 * to URLs, is what lets the host map them onto its own addresses however it serves the files.
 */

/** `href` (a link's or an import's target) from the artboard at canvas path `from`. */
export function resolveCanvasPath(from: string, href: string): string {
  const path = href.split(/[?#]/)[0]!;
  const segments = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(decodeSegment(segment));
  }
  return segments.join("/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** True for an href that leaves the canvas: one with a scheme (`https:`, `mailto:`) or `//host`. */
export function isExternal(href: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//");
}

/** True for an href naming another artboard. */
export function isArtboardLink(href: string): boolean {
  return !isExternal(href) && !href.startsWith("#") && /\.dc\.html$/i.test(href.split(/[?#]/)[0]!);
}

/**
 * Where a page served at `pathname` sits in its canvas: the URL path of the canvas root, and the
 * page's canvas path. The root is everything through the last `/project/` when the path has one —
 * the canvas's files live under `project/` — and the page's own folder otherwise.
 */
export function pagePlace(pathname: string): { readonly root: string; readonly path: string } {
  const at = pathname.lastIndexOf("/project/");
  if (at >= 0) {
    const root = pathname.slice(0, at + "/project/".length);
    return { root, path: pathname.slice(root.length).split("/").map(decodeSegment).join("/") };
  }
  const slash = pathname.lastIndexOf("/");
  return { root: pathname.slice(0, slash + 1), path: decodeSegment(pathname.slice(slash + 1)) };
}

/** A canvas path as a URL path segment string, each segment escaped. */
export function encodeCanvasPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
